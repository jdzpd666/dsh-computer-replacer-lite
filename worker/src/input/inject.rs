//! L1 injection: UI Automation Invoke, Value and Scroll patterns, plus an
//! approval-gated coordinate fallback for windows with no addressable element.
//!
//! Hard rules enforced here:
//! * the fast path still uses UIA Invoke; the coordinate fallback is one explicit
//!   SetCursorPos + SendInput click on approval, while L2 right-click posts
//!   WM_CONTEXTMENU and L2 wheel posts WM_MOUSEWHEEL through PostMessageW;
//!   neither path moves the pointer;
//! * no action is attempted when the element cannot be addressed, does not expose the
//!   needed pattern, or the desktop context no longer matches the model;
//! * an ambiguous write result is reported as INJECTION_UNCERTAIN and is never retried.
use crate::{
    context,
    panic,
    uia::Uia,
    world::{fault, Fault, Result, World},
};
use serde_json::{json, Value};
use windows::{
    core::{BSTR, BOOL, HRESULT},
    Win32::{
        Foundation::{E_ACCESSDENIED, HWND, LPARAM, POINT, WPARAM},
        Graphics::Gdi::ScreenToClient,
        UI::Accessibility::{
            IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationScrollPattern, IUIAutomationValuePattern,
            UIA_E_ELEMENTNOTAVAILABLE, UIA_InvokePatternId, UIA_ScrollPatternId, UIA_ValuePatternId,
        },
        UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT,
            MapVirtualKeyW, MAPVK_VK_TO_VSC,
        },
        UI::WindowsAndMessaging::{
            EnumChildWindows, GetClassNameW, GetCursorPos, GetGUIThreadInfo, GetSystemMetrics, GetWindowThreadProcessId,
            IsChild, PostMessageW, RealChildWindowFromPoint, SetCursorPos, GUITHREADINFO, SM_CXVIRTUALSCREEN,
            SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WHEEL_DELTA, WM_CONTEXTMENU, WM_KEYDOWN,
            WM_KEYUP, WM_MOUSEWHEEL, WM_CHAR,
        },
    },
};

fn address_error(error: windows::core::Error) -> Fault {
    let code = error.code();
    if code == HRESULT(UIA_E_ELEMENTNOTAVAILABLE as i32) {
        fault("STALE_STATE", "Element vanished before injection; nothing was performed")
    } else if code == E_ACCESSDENIED {
        fault("UIPI_BLOCKED", "Target has higher integrity; injection refused")
    } else {
        fault("ELEMENT_NOT_INVOKABLE", format!("Element exposes no usable pattern: {error}"))
    }
}

/// M7 overlay coordination file: the visual-cursor overlay reads this to show
/// where the agent is about to act. Cosmetic only.
const CURSOR_TARGET_FILE: &str = "F:/dsh-workspace/dsh-computer-replacer/cursor_target.json";

/// Serializes one overlay target. Split out so the point form and the element
/// form can never disagree about the file format, and so it is unit-testable
/// without touching the real coordination file.
fn cursor_payload(x: f64, y: f64, ts: u64) -> String {
    json!({ "x": x, "y": y, "ts": ts }).to_string()
}

/// Publishes one screen point for the M7 overlay, best-effort.
/// Purely visual feedback: any error is swallowed on purpose so a broken or
/// missing overlay can never block or fail an injection.
fn publish_point(x: f64, y: f64) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);
    let _ = std::fs::write(CURSOR_TARGET_FILE, cursor_payload(x, y, ts));
}

/// Publishes the element's bounding-box center for the M7 overlay, best-effort.
/// Purely visual feedback: any error is swallowed on purpose so a broken or
/// missing overlay can never block or fail an injection.
fn publish_cursor_target(element: &IUIAutomationElement) {
    let Ok(rect) = (unsafe { element.CurrentBoundingRectangle() }) else { return };
    publish_point(
        (f64::from(rect.left) + f64::from(rect.right)) / 2.0,
        (f64::from(rect.top) + f64::from(rect.bottom)) / 2.0,
    );
}

fn pattern_error(error: windows::core::Error, what: &str) -> Fault {
    let code = error.code();
    if code == HRESULT(UIA_E_ELEMENTNOTAVAILABLE as i32) {
        fault("STALE_STATE", format!("Element vanished before injection; nothing was performed: {error}"))
    } else {
        fault("ELEMENT_NOT_INVOKABLE", format!("Element exposes no usable {what} pattern: {error}"))
    }
}

/// Every write action first proves the desktop context still matches the model:
/// the target window is foreground and keyboard focus has not moved. A mismatch
/// fails closed before any COM write call.
fn guard(uia: &Uia, world: &World, hwnd: &str) -> Result<bool> {
    // Emergency stop first, before any UIA/COM call: click_by_id, type_text,
    // scroll_by_id, right_click_by_id and wheel_by_id all come through here.
    panic::gate()?;
    let reactivated = activate_target(hwnd)?;
    let focus = uia.focused_runtime_id()?;
    world.focus_matches(hwnd, focus.as_deref())?;
    Ok(reactivated)
}

/// One settle window after foreground was established (or restored), so the
/// target's UI thread can drain WM_ACTIVATE before a provider call is made into it.
const ACTIVATE_SETTLE_MS: u64 = 50;
/// The injection gate is held for this long after the provider returns, so a
/// follow-up tree walk never re-enters a provider that is still reacting.
const POST_INVOKE_SETTLE_MS: u64 = 120;

/// Reports a failed Invoke truthfully, including the HRESULT. The request may
/// already have been delivered, so it is reported as uncertain and never retried.
fn invoke_error(error: windows::core::Error) -> Fault {
    let hr = error.code().0;
    fault(
        "INJECTION_UNCERTAIN",
        format!("Invoke returned {error} (HRESULT 0x{hr:08X}); the request may have been delivered, so it is not retried"),
    )
}

fn resolve(uia: &Uia, world: &World, hwnd: &str, element_id: &str) -> Result<IUIAutomationElement> {
    let runtime_id = world.runtime_id(hwnd, element_id).ok_or_else(|| {
        fault("ELEMENT_NOT_INVOKABLE", "Element is unknown, expired, or has no RuntimeId identity; observe again")
    })?;
    uia.element(hwnd, &runtime_id)
}

/// Brings the target to the foreground and then yields one settle window to its
/// UI thread. Activation is retried once inside that window because the first
/// SetForegroundWindow can be undone while WM_ACTIVATE is still queued.
fn activate_target(hwnd: &str) -> Result<bool> {
    let mut reactivated = false;
    if context::check(hwnd).is_err() {
        context::activate(hwnd)?;
        context::check(hwnd)?;
        reactivated = true;
    }
    std::thread::sleep(std::time::Duration::from_millis(ACTIVATE_SETTLE_MS));
    if context::check(hwnd).is_err() {
        context::activate(hwnd)?;
        context::check(hwnd)?;
        std::thread::sleep(std::time::Duration::from_millis(ACTIVATE_SETTLE_MS));
        context::check(hwnd)?;
        reactivated = true;
    }
    Ok(reactivated)
}

/// Invokes one already-resolved element and reports the facts the approval card
/// was built from. Fast paths reach here without publishing a world snapshot.
pub fn click_element(uia: &Uia, hwnd: &str, element: &IUIAutomationElement, element_id: &str) -> Result<Value> {
    let reactivated = activate_target(hwnd)?;
    let invokable = unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .map_err(address_error)
    }?;
    let facts = uia
        .element_facts(element)
        .unwrap_or_else(|_| json!({ "label": "", "type": 0, "bbox": Value::Null }));
    publish_cursor_target(element);
    let outcome = unsafe { invokable.Invoke() };
    // Keep the injection gate held until the window had time to react.
    std::thread::sleep(std::time::Duration::from_millis(POST_INVOKE_SETTLE_MS));
    match outcome {
        Ok(()) => Ok(json!({
            "hwnd": hwnd,
            "elementId": element_id,
            "method": "l1_invoke",
            "accepted": true,
            "reactivated": reactivated,
            "label": facts.get("label").cloned().unwrap_or(Value::Null),
            "type": facts.get("type").cloned().unwrap_or(Value::Null),
            "bbox": facts.get("bbox").cloned().unwrap_or(Value::Null),
            "windowAlive": context::alive(hwnd),
        })),
        Err(error) => Err(invoke_error(error)),
    }
}

/// Resolves a raw RuntimeId without the world model and invokes it.
pub fn click_runtime(uia: &Uia, hwnd: &str, runtime_id: &[i32]) -> Result<Value> {
    panic::gate()?; // emergency stop: no UIA call before this check
    let element = uia.element(hwnd, runtime_id)?;
    let element_id = format!("r:{}", serde_json::to_string(runtime_id).unwrap_or_else(|_| "[]".to_owned()));
    click_element(uia, hwnd, &element, &element_id)
}

/// Coordinate fallback for windows with no addressable UIA node.
///
/// SetCursorPos moves the real pointer and SendInput injects one left click.
/// The point must lie inside the virtual screen and the pointer is read back
/// before any button event, so impossible or stale coordinates never click.
pub fn click_xy(hwnd: &str, x: i32, y: i32) -> Result<Value> {
    panic::gate()?; // emergency stop: no pointer movement, no SendInput before this check
    let reactivated = activate_target(hwnd)?;
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 0 || height <= 0 {
            return Err(fault("UIA_ERROR", "Virtual screen metrics are unavailable"));
        }
        if x < left || y < top || x >= left + width || y >= top + height {
            return Err(fault("INVALID_ARGUMENT", format!("Coordinate ({x},{y}) is outside the virtual screen")));
        }
        SetCursorPos(x, y).map_err(|error| fault("INJECTION_UNCERTAIN", format!("SetCursorPos failed: {error}")))?;
        let mut landed = POINT { x: 0, y: 0 };
        GetCursorPos(&mut landed).map_err(|error| fault("INJECTION_UNCERTAIN", format!("GetCursorPos failed: {error}")))?;
        if landed.x != x || landed.y != y {
            return Err(fault(
                "INJECTION_UNCERTAIN",
                format!("Cursor landed at ({},{}) instead of ({x},{y}); no button event was sent", landed.x, landed.y),
            ));
        }
        // The dot must show where the click is actually injected, so it is
        // published from the read-back point the check above just verified.
        publish_point(f64::from(landed.x), f64::from(landed.y));
        let down = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_LEFTDOWN,
                time: 0,
                dwExtraInfo: 0,
            } },
        };
        let up = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_LEFTUP,
                time: 0,
                dwExtraInfo: 0,
            } },
        };
        let sent = SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32);
        if sent != 2 {
            return Err(fault(
                "INJECTION_UNCERTAIN",
                format!("SendInput accepted {sent}/2 mouse events; outcome unknown and not retried"),
            ));
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(POST_INVOKE_SETTLE_MS));
    Ok(json!({
        "hwnd": hwnd,
        "x": x,
        "y": y,
        "method": "l1_send_input",
        "accepted": true,
        "reactivated": reactivated,
        "windowAlive": context::alive(hwnd),
    }))
}

/// Clicks a world-model element through its UIA Invoke pattern.
///
/// Returns only after the provider accepted the request; it never claims that the
/// target reacted. Effect verification belongs to observe / MODEL_DIFF.
pub fn click_by_id(uia: &Uia, world: &World, hwnd: &str, element_id: &str) -> Result<Value> {
    let reactivated = guard(uia, world, hwnd)?;
    let element = resolve(uia, world, hwnd, element_id)?;
    let invokable = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).map_err(address_error)
    }?;
    publish_cursor_target(&element);
    let outcome = unsafe { invokable.Invoke() };
    // Keep the injection gate held until the window had time to react.
    std::thread::sleep(std::time::Duration::from_millis(POST_INVOKE_SETTLE_MS));
    match outcome {
        Ok(()) => Ok(json!({
            "hwnd": hwnd,
            "elementId": element_id,
            "method": "l1_invoke",
            "accepted": true,
            "reactivated": reactivated,
            "windowAlive": context::alive(hwnd),
        })),
        Err(error) => Err(invoke_error(error)),
    }
}

/// Writes text into one element through ValuePattern.SetValue.
///
/// This never synthesizes keystrokes: an element without a Value pattern is
/// ELEMENT_NOT_INVOKABLE rather than falling back to a keyboard-level layer.
pub fn type_text(uia: &Uia, world: &World, hwnd: &str, element_id: &str, text: &str) -> Result<Value> {
    if text.is_empty() || text.chars().count() > 8192 || text.contains(char::from(0)) {
        return Err(fault("INVALID_ARGUMENT", "text must contain 1..8192 characters and no NUL"));
    }
    let reactivated = guard(uia, world, hwnd)?;
    let element = resolve(uia, world, hwnd, element_id)?;
    let pattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).map_err(|error| pattern_error(error, "Value"))
    }?;
    let readonly = unsafe { pattern.CurrentIsReadOnly() }
        .map_err(|error| fault("ELEMENT_NOT_INVOKABLE", format!("Value.IsReadOnly unavailable; nothing was written: {error}")))?;
    if readonly.as_bool() {
        return Err(fault("ELEMENT_NOT_INVOKABLE", "Element is read-only; nothing was written"));
    }
    match unsafe { pattern.SetValue(&BSTR::from(text)) } {
        Ok(()) => Ok(json!({
            "hwnd": hwnd,
            "elementId": element_id,
            "method": "l1_value",
            "accepted": true,
            "reactivated": reactivated,
            "characters": text.chars().count(),
        })),
        Err(error) => Err(fault(
            "INJECTION_UNCERTAIN",
            format!("SetValue returned {error}; the text may have been written, so it is not retried"),
        )),
    }
}

/// Scrolls one element through ScrollPattern.SetScrollPercent.
///
/// horizontal is no|left|right and vertical is no|up|down; each step moves one
/// viewport (clamped to 5..100 percent). An axis that is not scrollable is
/// ELEMENT_NOT_INVOKABLE and nothing is written.
pub fn scroll_by_id(
    uia: &Uia,
    world: &World,
    hwnd: &str,
    element_id: &str,
    horizontal: &str,
    vertical: &str,
    steps: usize,
) -> Result<Value> {
    if !(1..=10).contains(&steps) {
        return Err(fault("INVALID_ARGUMENT", "steps must be 1..10"));
    }
    if !matches!(horizontal, "no" | "left" | "right") || !matches!(vertical, "no" | "up" | "down") {
        return Err(fault("INVALID_ARGUMENT", "horizontal must be no|left|right and vertical no|up|down"));
    }
    if horizontal == "no" && vertical == "no" {
        return Err(fault("INVALID_ARGUMENT", "At least one scroll direction is required"));
    }
    let reactivated = guard(uia, world, hwnd)?;
    let element = resolve(uia, world, hwnd, element_id)?;
    let pattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId).map_err(|error| pattern_error(error, "Scroll"))
    }?;
    unsafe {
        let h = axis_percent(&pattern, false, horizontal, steps)?;
        let v = axis_percent(&pattern, true, vertical, steps)?;
        match pattern.SetScrollPercent(h, v) {
            Ok(()) => Ok(json!({
                "hwnd": hwnd,
                "elementId": element_id,
                "method": "l1_scroll",
                "accepted": true,
            "reactivated": reactivated,
                "horizontal": horizontal,
                "vertical": vertical,
                "steps": steps,
            })),
            Err(error) => Err(fault(
                "INJECTION_UNCERTAIN",
                format!("SetScrollPercent returned {error}; the view may have moved, so it is not retried"),
            )),
        }
    }
}

/// Target percentage for one axis, or -1.0 (UIA no-scroll) to leave it untouched.
unsafe fn axis_percent(
    pattern: &IUIAutomationScrollPattern,
    vertical: bool,
    direction: &str,
    steps: usize,
) -> Result<f64> {
    if direction == "no" {
        return Ok(-1.0);
    }
    let axis = if vertical { "vertical" } else { "horizontal" };
    let scrollable = if vertical {
        pattern.CurrentVerticallyScrollable()
            .map_err(|e| fault("ELEMENT_NOT_INVOKABLE", format!("Scroll.{axis} unavailable: {e}")))?.as_bool()
    } else {
        pattern.CurrentHorizontallyScrollable()
            .map_err(|e| fault("ELEMENT_NOT_INVOKABLE", format!("Scroll.{axis} unavailable: {e}")))?.as_bool()
    };
    if !scrollable {
        return Err(fault("ELEMENT_NOT_INVOKABLE", format!("Element cannot scroll {axis}; nothing was written")));
    }
    let (current, view) = if vertical {
        (pattern.CurrentVerticalScrollPercent(), pattern.CurrentVerticalViewSize())
    } else {
        (pattern.CurrentHorizontalScrollPercent(), pattern.CurrentHorizontalViewSize())
    };
    let current = current.map_err(|e| fault("ELEMENT_NOT_INVOKABLE", format!("Scroll.{axis} percent unavailable: {e}")))?;
    let view = view.map_err(|e| fault("ELEMENT_NOT_INVOKABLE", format!("Scroll.{axis} view size unavailable: {e}")))?;
    if !(0.0..=100.0).contains(&current) {
        return Err(fault("ELEMENT_NOT_INVOKABLE", format!("Scroll.{axis} position is unknown ({current}); nothing was written")));
    }
    let page = if (0.0..=100.0).contains(&view) { view.max(5.0) } else { 10.0 };
    let delta = page * steps as f64;
    Ok(match direction {
        "down" | "right" => (current + delta).min(100.0),
        _ => (current - delta).max(0.0),
    })
}

// ---------------------------------------------------------------------------
// L2: directed PostMessage injection for controls without UIA patterns.
//
// Nothing below calls SetCursorPos or SendInput. Each message is posted to a
// concrete HWND resolved from the element's bounding box; the physical pointer
// and the physical wheel are never touched, so these primitives cannot move the
// user's cursor. Everything still runs behind InjectionGate in the handler.
// ---------------------------------------------------------------------------

/// Resolves the modelled window handle without capturing anything.
fn window_of(hwnd: &str) -> Result<HWND> {
    let value = hwnd
        .parse::<usize>()
        .map_err(|_| fault("INVALID_ARGUMENT", "hwnd must be a decimal integer string"))?;
    if value == 0 || !context::alive(hwnd) {
        return Err(fault("STALE_STATE", format!("Window {hwnd} no longer exists; observe again")));
    }
    Ok(HWND(value as *mut core::ffi::c_void))
}

/// Screen-space center of one modelled element. The bbox is the same value the
/// approval card showed; a missing or empty bbox fails closed.
fn element_center(world: &World, hwnd: &str, element_id: &str) -> Result<POINT> {
    let detail = world
        .describe(hwnd, element_id)
        .ok_or_else(|| fault("STALE_STATE", "Element is unknown or expired; observe again"))?;
    let bbox = detail
        .get("bbox")
        .ok_or_else(|| fault("STALE_STATE", "Element has no bounding box; observe again"))?;
    let number = |key: &str| {
        bbox.get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| fault("STALE_STATE", format!("Element bbox has no finite {key}; observe again")))
    };
    let (x, y, width, height) = (number("x")?, number("y")?, number("width")?, number("height")?);
    if width <= 0.0 || height <= 0.0 {
        return Err(fault("STALE_STATE", "Element has an empty bounding box; observe again"));
    }
    let center_x = x + width / 2.0;
    let center_y = y + height / 2.0;
    screen_center(center_x, center_y)
}

/// Converts a computed center to integer screen coordinates. The Phase 0 probe
/// used (-1, -1) for an unset coordinate; production never treats that sentinel
/// as addressable.
fn screen_center(center_x: f64, center_y: f64) -> Result<POINT> {
    if center_x < f64::from(i32::MIN) || center_x > f64::from(i32::MAX)
        || center_y < f64::from(i32::MIN) || center_y > f64::from(i32::MAX)
    {
        return Err(fault("STALE_STATE", "Element center is outside the addressable screen range"));
    }
    let point = POINT { x: center_x.round() as i32, y: center_y.round() as i32 };
    if point.x == -1 && point.y == -1 {
        return Err(fault("STALE_STATE", "Element center is the unset screen sentinel (-1, -1); observe again"));
    }
    Ok(point)
}

/// Walks from the modelled top-level window down to the deepest visible child
/// under one screen point, returning that child and the point in its client
/// coordinates. This is what keeps a right-click from being posted only to the
/// top-level frame when the real control is a child HWND.
fn deepest_target(target: HWND, screen: POINT) -> (HWND, POINT) {
    let mut current = target;
    let mut client = screen;
    for _ in 0..32 {
        let mut point = screen;
        if !unsafe { ScreenToClient(current, &mut point) }.as_bool() {
            break;
        }
        client = point;
        let child = unsafe { RealChildWindowFromPoint(current, point) };
        if child.0.is_null() || child.0 == current.0 {
            break;
        }
        current = child;
    }
    (current, client)
}

/// The window that should receive WM_MOUSEWHEEL: the target's focused child
/// when it has one, otherwise the target itself. Most frameworks route wheel
/// messages from the focus window, not from a coordinate hit-test.
fn wheel_focus(target: HWND) -> HWND {
    let thread = unsafe { GetWindowThreadProcessId(target, None) };
    if thread != 0 {
        let mut info: GUITHREADINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        if unsafe { GetGUIThreadInfo(thread, &mut info) }.is_ok() {
            let focus = info.hwndFocus;
            if !focus.0.is_null()
                && (focus.0 == target.0 || unsafe { IsChild(target, focus) }.as_bool())
            {
                return focus;
            }
        }
    }
    target
}

/// Packs a screen point into the LPARAM layout used by mouse messages.
fn mouse_lparam(point: POINT) -> LPARAM {
    let low = i64::from(point.x as u16);
    let high = i64::from(point.y as u16);
    LPARAM(((high << 16) | low) as isize)
}

/// A first PostMessageW failure means nothing was delivered. UIPI is called out
/// explicitly so the caller is steered to the elevated broker instead of being
/// told to retry the same unprivileged worker.
fn post_failure(error: windows::core::Error, what: &str) -> Fault {
    if error.code() == E_ACCESSDENIED {
        fault(
            "UIPI_BLOCKED",
            format!("{what} was refused by UIPI: the target has higher integrity; use the elevated broker (replacer_observe_elevated + replacer_click_elevated). Nothing was posted."),
        )
    } else {
        fault("UIA_ERROR", format!("{what} failed: {error}; nothing was posted"))
    }
}

/// Right-clicks one modelled element by posting WM_CONTEXTMENU.
///
/// The message is posted to the deepest child under the bbox center, with
/// wParam set to that child and lParam set to the screen coordinates. There is
/// no fallback to a WM_RBUTTONDOWN/WM_RBUTTONUP pair: if an application ignores
/// WM_CONTEXTMENU, the caller must choose another route. No pointer movement and
/// no SendInput occur; the popup menu is produced by the target's own message
/// handling. The call returns as soon as the message is posted, without waiting
/// for a menu to appear.
pub fn right_click_by_id(uia: &Uia, world: &World, hwnd: &str, element_id: &str) -> Result<Value> {
    let reactivated = guard(uia, world, hwnd)?;
    let screen = element_center(world, hwnd, element_id)?;
    let target = window_of(hwnd)?;
    let (child, client) = deepest_target(target, screen);
    let child_param = WPARAM(child.0 as usize);
    let param = mouse_lparam(screen);
    // Published last, with every fallible lookup already done: the dot marks the
    // injection intent, and a failed post stays a best-effort visual artefact.
    publish_point(f64::from(screen.x), f64::from(screen.y));
    if let Err(error) = unsafe { PostMessageW(Some(child), WM_CONTEXTMENU, child_param, param) } {
        return Err(post_failure(error, "WM_CONTEXTMENU"));
    }
    Ok(json!({
        "hwnd": hwnd,
        "elementId": element_id,
        "method": "postmessage_right_click",
        "accepted": true,
        "reactivated": reactivated,
        "targetHwnd": (child.0 as usize).to_string(),
        "x": client.x,
        "y": client.y,
        "screenX": screen.x,
        "screenY": screen.y,
        "windowAlive": context::alive(hwnd),
    }))
}

/// Sends one WM_MOUSEWHEEL per step to the focused window of the modelled
/// element. Delta is WHEEL_DELTA * 3 per step (positive up, negative down), and
/// lParam carries screen coordinates as the message contract requires.
pub fn wheel_by_id(
    uia: &Uia,
    world: &World,
    hwnd: &str,
    element_id: &str,
    vertical: &str,
    steps: usize,
) -> Result<Value> {
    if !matches!(vertical, "up" | "down") {
        return Err(fault("INVALID_ARGUMENT", "vertical must be up|down"));
    }
    if !(1..=10).contains(&steps) {
        return Err(fault("INVALID_ARGUMENT", "steps must be 1..10"));
    }
    let reactivated = guard(uia, world, hwnd)?;
    let screen = element_center(world, hwnd, element_id)?;
    let target = window_of(hwnd)?;
    let receiver = wheel_focus(target);
    let delta = i32::try_from(WHEEL_DELTA * 3).unwrap_or(360);
    let delta = if vertical == "up" { delta } else { -delta };
    let param = mouse_lparam(screen);
    let wparam = WPARAM((((delta as u32) & 0xffff) << 16) as usize);
    publish_point(f64::from(screen.x), f64::from(screen.y));
    let mut posted = 0usize;
    for _ in 0..steps {
        // C-1（批3）：多步循环内逐步重查闩锁（镜像 send_key 的逐步检查模式），
        // 堵住入口检查之后的微秒窗口：panic 中途触发时剩余步立即丢弃。
        // 已发出的消息无法撤回（诚实边界，PLUGIN.md）。
        if panic::tripped() {
            return Err(fault(
                "PANIC_ABORTED",
                format!("Panic latch tripped mid-sequence after {posted}/{steps} wheel message(s); the remaining steps were dropped; already-sent messages cannot be recalled"),
            ));
        }
        match unsafe { PostMessageW(Some(receiver), WM_MOUSEWHEEL, wparam, param) } {
            Ok(()) => posted += 1,
            Err(error) if posted == 0 => return Err(post_failure(error, "WM_MOUSEWHEEL")),
            Err(error) => {
                let hr = error.code().0;
                return Err(fault(
                    "INJECTION_UNCERTAIN",
                    format!("WM_MOUSEWHEEL failed after {posted}/{steps} messages were posted: {error} (HRESULT 0x{hr:08X}); outcome unknown and not retried"),
                ));
            }
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(POST_INVOKE_SETTLE_MS));
    Ok(json!({
        "hwnd": hwnd,
        "elementId": element_id,
        "method": "postmessage_wheel",
        "accepted": true,
        "reactivated": reactivated,
        "targetHwnd": (receiver.0 as usize).to_string(),
        "screenX": screen.x,
        "screenY": screen.y,
        "vertical": vertical,
        "steps": steps,
        "delta": delta,
        "windowAlive": context::alive(hwnd),
    }))
}

// ---------------------------------------------------------------------------
// L2 keyboard (task 3). Phase 0 conclusions from worker/examples/keyboard_probe.rs
// against Win11 Notepad (RichEditD2DPT), all empirically verified:
//   - Pure WM_CHAR inserts text (ASCII + Unicode); a WM_KEYDOWN of a letter
//     ALSO inserts in this control, so text must be CHAR-only or it doubles.
//   - WM_KEYDOWN/WM_KEYUP of non-character keys (Enter, arrows, F-keys) works.
//   - Modifier chords cannot work: posted messages carry no thread key state,
//     so "ctrl+a" arrives as a literal "a". Chords are rejected up front.
//   - GetGUIThreadInfo focus is empty for WinUI frames (focus=0) and the top
//     window swallows keyboard messages, so the receiver is the descendant
//     input control (class RichEdit*/Edit) or the deepest first-chain child.
// ---------------------------------------------------------------------------

/// One parsed combo step: a raw character to post as WM_CHAR, or a virtual
/// key to post as WM_KEYDOWN + WM_KEYUP.
#[derive(Debug, PartialEq)]
enum ComboStep {
    Char(u16),
    Key(u32),
}

const LPARAM_KEYUP: usize = 0xC000_0000;

fn key_scan(vk: u32) -> usize {
    (unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) } as usize) << 16
}

/// Parses one combo. Grammar (case-insensitive): a single key name, a single
/// character, or one of f1..f12. Modifier chords ("ctrl+a") are rejected
/// explicitly — see the Phase 0 notes above.
fn parse_combo(combo: &str) -> Result<Vec<ComboStep>> {
    let trimmed = combo.trim();
    if trimmed.is_empty() || trimmed.len() > 32 || trimmed.chars().any(|c| c.is_whitespace() || c == ',') {
        return Err(fault("INVALID_ARGUMENT", "combo must be one key name or one character (1..32, no whitespace/comma)"));
    }
    let lowered = trimmed.to_ascii_lowercase();
    for banned in ["ctrl+", "alt+", "shift+", "meta+", "win+", "cmd+"] {
        if lowered.starts_with(banned) || lowered.contains(&format!("+{banned}")) {
            return Err(fault("INVALID_ARGUMENT", format!(
                "combo \"{combo}\": modifier chords cannot be delivered through PostMessageW (no thread key state; a chord arrives as its literal keys). Selection/copy scenarios belong to UIA patterns (replacer_type) or the elevated broker; zero keys were sent"
            )));
        }
    }
    let step = match lowered.as_str() {
        "enter" | "return" => ComboStep::Key(0x0D),
        "esc" | "escape" => ComboStep::Key(0x1B),
        "tab" => ComboStep::Key(0x09),
        "backspace" => ComboStep::Key(0x08),
        "delete" | "del" => ComboStep::Key(0x2E),
        "home" => ComboStep::Key(0x24),
        "end" => ComboStep::Key(0x23),
        "pageup" => ComboStep::Key(0x21),
        "pagedown" | "pgdn" => ComboStep::Key(0x22),
        "up" => ComboStep::Key(0x26),
        "down" => ComboStep::Key(0x28),
        "left" => ComboStep::Key(0x25),
        "right" => ComboStep::Key(0x27),
        "space" => ComboStep::Char(0x20),
        name if name.len() == 2 && name.as_bytes()[0] == b'f' && name.as_bytes()[1].is_ascii_digit() => {
            ComboStep::Key(0x70 + (name.as_bytes()[1] - b'0') as u32 - 1)
        }
        name if name.len() == 3 && name.as_bytes()[0] == b'f' && name.as_bytes()[1..].iter().all(|b| b.is_ascii_digit()) => {
            let n: u32 = name[1..].parse().map_err(|_| fault("INVALID_ARGUMENT", format!("combo \"{combo}\": unknown key name")))?;
            (1..=12).contains(&n).then_some(ComboStep::Key(0x70 + n - 1))
                .ok_or_else(|| fault("INVALID_ARGUMENT", format!("combo \"{combo}\": unknown key name")))?
        }
        _ => {
            let mut units = trimmed.encode_utf16();
            let first = units.next().unwrap_or(0);
            if units.next().is_some() {
                return Err(fault("INVALID_ARGUMENT", format!(
                    "combo \"{combo}\" is more than one character; post it with replacer_type (ValuePattern) instead, zero keys were sent"
                )));
            }
            if (first as u32) == 0 || (0x80..0xA0).contains(&(first as u32)) {
                return Err(fault("INVALID_ARGUMENT", format!("combo \"{combo}\": control characters are not sendable, zero keys were sent")));
            }
            ComboStep::Char(first)
        }
    };
    Ok(vec![step])
}

/// All descendants of one window in z-order (EnumChildWindows walks the whole
/// subtree, not just direct children). Collected through a leak-taken buffer:
/// the callback cannot borrow, and this runs only on the single action thread.
fn child_windows(top: HWND) -> Vec<HWND> {
    let found: *mut Vec<HWND> = Box::leak(Box::new(Vec::new()));
    unsafe extern "system" fn collect(child: HWND, lparam: LPARAM) -> BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        out.push(child);
        BOOL(1)
    }
    unsafe { let _ = EnumChildWindows(Some(top), Some(collect), LPARAM(found as isize)); }
    let taken = unsafe { Box::from_raw(found) };
    *taken
}

fn class_of(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n as usize])
    }
}

/// The descendant input control: a class anchored on RichEdit*/Edit when one
/// exists (Win11 Notepad = RichEditD2DPT), else the deepest first-chain child
/// (WinUI islands), else the top window itself. Phase 0 measured that neither
/// GetGUIThreadInfo focus nor the top window process keyboard messages on WinUI.
fn input_surface(top: HWND) -> HWND {
    // Two-priority flat walk over the z-ordered descendant list (task 3 review
    // P2-1): 1. classic editor classes - they actually process WM_CHAR (Win11
    // Notepad = RichEditD2DPT; WinForms multiline TextBox = *EDIT*); 2. WinUI
    // island hosts like NotepadTextBox - visible in the tree but deaf to
    // keyboard messages, so only a fallback; 3. the last childless descendant;
    // the top window itself last.
    let nodes = child_windows(top);
    let mut primary = None;
    let mut island = None;
    let mut leaf = None;
    for node in &nodes {
        let class = class_of(*node);
        let lower = class.to_ascii_lowercase();
        if primary.is_none() && (lower.contains("richedit") || lower.contains("edit") || lower == "_wwg") {
            primary = Some(*node);
        }
        if island.is_none() && (class == "NotepadTextBox" || class.ends_with("InputSite.WindowClass")) {
            island = Some(*node);
        }
        if child_windows(*node).is_empty() { leaf = Some(*node); }
    }
    primary.or(island).or(leaf).unwrap_or(top)
}

/// Sends one combo to the input surface of `hwnd` via PostMessageW only. No
/// SendInput/keybd_event, no thread key state is touched, the physical keyboard
/// is never involved. Zero keys are posted when the combo is invalid.
pub fn send_key(hwnd: &str, combo: &str) -> Result<Value> {
    panic::gate()?; // emergency stop: no key posted before this check
    let reactivated = activate_target(hwnd)?;
    let steps = parse_combo(combo)?;
    let top = window_of(hwnd)?;
    let surface = input_surface(top);
    let mut posted = 0usize;
    for step in &steps {
        // Multi-step sequences re-check the latch before every step, so a panic
        // mid-sequence stops the remaining keys immediately. Already-posted
        // messages cannot be recalled (honest boundary, PLUGIN.md).
        if panic::tripped() {
            return Err(fault(
                "PANIC_ABORTED",
                format!("Panic latch tripped mid-sequence after {posted} posted message(s); the remaining steps were dropped; already-sent messages cannot be recalled"),
            ));
        }
        let outcome = match *step {
            ComboStep::Char(unit) => unsafe { PostMessageW(Some(surface), WM_CHAR, WPARAM(unit as usize), LPARAM(0x1C0001_isize)) }
                .map(|_| 1usize),
            ComboStep::Key(vk) => {
                let scan = key_scan(vk);
                (|| -> windows::core::Result<usize> {
                    unsafe { PostMessageW(Some(surface), WM_KEYDOWN, WPARAM(vk as usize), LPARAM((scan | 1) as isize)) }?;
                    unsafe { PostMessageW(Some(surface), WM_KEYUP, WPARAM(vk as usize), LPARAM((scan | 1 | LPARAM_KEYUP) as isize)) }?;
                    Ok(2)
                })()
            }
        };
        match outcome {
            Ok(count) => posted += count,
            Err(error) if posted == 0 => return Err(post_failure(error, "keyboard message")),
            Err(error) => {
                let hr = error.code().0;
                return Err(fault(
                    "INJECTION_UNCERTAIN",
                    format!("keyboard message failed after {posted} of {} were posted: {error} (HRESULT 0x{hr:08X}); outcome unknown and not retried",
                        steps.iter().map(|step| match step { ComboStep::Char(_) => 1, ComboStep::Key(_) => 2 }).sum::<usize>()),
                ));
            }
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(POST_INVOKE_SETTLE_MS));
    Ok(json!({
        "hwnd": hwnd,
        "combo": combo,
        "method": "postmessage_key",
        "accepted": true,
        "keysPosted": posted,
        "focusHwnd": (surface.0 as usize).to_string(),
        "reactivated": reactivated,
        "windowAlive": context::alive(hwnd),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_screen_point_into_lparam() {
        let packed = mouse_lparam(POINT { x: 223, y: 285 }).0 as u32;
        assert_eq!(packed & 0xffff, 223);
        assert_eq!((packed >> 16) & 0xffff, 285);
        let negative = mouse_lparam(POINT { x: -2, y: -3 }).0 as u32;
        assert_eq!(negative, 0xFFFD_FFFE);
    }

    #[test]
    fn parses_combo_grammar() {
        assert_eq!(parse_combo("enter").unwrap(), vec![ComboStep::Key(0x0D)]);
        assert_eq!(parse_combo("A").unwrap(), vec![ComboStep::Char(b'A' as u16)]);
        assert_eq!(parse_combo("space").unwrap(), vec![ComboStep::Char(0x20)]);
        assert_eq!(parse_combo("f12").unwrap(), vec![ComboStep::Key(0x7B)]);
        assert_eq!(parse_combo("锥").unwrap(), vec![ComboStep::Char(0x9525)]);
        for bad in ["", "ctrl+a", "alt+f4", "a b", "ab", "f13", "键键", "ctrl+alt"] {
            assert!(parse_combo(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_unset_screen_center() {
        assert!(screen_center(-1.0, -1.0).is_err());
        let center = screen_center(223.4, 285.2).expect("screen center");
        assert_eq!((center.x, center.y), (223, 285));
    }

    #[test]
    fn serializes_point_payload() {
        let parsed: Value = serde_json::from_str(&cursor_payload(223.5, -3.0, 7)).expect("payload");
        assert_eq!(parsed["x"], 223.5);
        assert_eq!(parsed["y"], -3.0);
        assert_eq!(parsed["ts"], 7);
    }
}
