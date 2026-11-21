//! Diagnostic: does WM_CONTEXTMENU place a popup menu at the requested screen
//! point, or does the target ignore lParam and use the physical cursor?
//!
//! This probe never drives the production worker. It only posts the same
//! messages the production path is considering, observes which top-level/child
//! windows become visible, and prints one JSON object for the test log.
//!
//! Usage:
//!   contextmenu_probe <hwnd> <screenX> <screenY> \
//!     --sequence downup|contextmenu|both [--wait-ms 700] \
//!     [--child <hwnd>] [--post-to child|top]
//!
//! Hard rules: PostMessageW only; no SendInput, no SetCursorPos, no SendMessage.

use serde_json::{json, Value};
use std::time::{Duration, Instant};
use windows::{
    core::BOOL,
    Win32::{
        Foundation::{HWND, LPARAM, POINT, RECT, WPARAM},
        Graphics::Gdi::ScreenToClient,
        UI::WindowsAndMessaging::{
            ChildWindowFromPoint, EnumChildWindows, EnumWindows, GetClassNameW, GetCursorPos,
            GetForegroundWindow, GetGUIThreadInfo, GetWindow, GetWindowLongW, GetWindowRect,
            GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, PostMessageW,
            RealChildWindowFromPoint, SetProcessDPIAware, WindowFromPoint, GWL_STYLE, GW_OWNER,
            GUITHREADINFO, WM_CONTEXTMENU, WM_RBUTTONDOWN, WM_RBUTTONUP,
        },
    },
};

const WS_POPUP_BIT: u32 = 0x8000_0000;
const MENU_PROXIMITY: f64 = 1200.0;
const POLL_MS: u64 = 25;

#[derive(Debug)]
struct Args {
    hwnd: usize,
    screen: POINT,
    sequence: String,
    wait_ms: u64,
    child: Option<usize>,
    post_to: String,
}

#[derive(Clone, Debug)]
struct RectInfo {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl RectInfo {
    fn width(self: &Self) -> i32 {
        self.right - self.left
    }
    fn height(self: &Self) -> i32 {
        self.bottom - self.top
    }
    fn json(self: &Self) -> Value {
        json!({"left": self.left, "top": self.top, "width": self.width(), "height": self.height()})
    }
}

#[derive(Clone, Debug)]
struct WindowInfo {
    hwnd: isize,
    pid: u32,
    visible: bool,
    class: String,
    title: String,
    style: u32,
    rect: Option<RectInfo>,
    owner: isize,
}

impl WindowInfo {
    fn json(self: &Self) -> Value {
        json!({
            "hwnd": self.hwnd.to_string(),
            "pid": self.pid,
            "visible": self.visible,
            "class": self.class,
            "title": self.title,
            "popup": (self.style & WS_POPUP_BIT) != 0,
            "owner": self.owner.to_string(),
            "rect": self.rect.as_ref().map(RectInfo::json),
        })
    }
}

fn parse_args() -> Result<Args, String> {
    let mut positional: Vec<String> = Vec::new();
    let mut sequence = "contextmenu".to_string();
    let mut wait_ms = 700u64;
    let mut child = None;
    let mut post_to = "child".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--sequence" => sequence = args.next().ok_or("--sequence needs a value")?,
            "--wait-ms" => {
                wait_ms = args.next().ok_or("--wait-ms needs a value")?.parse().map_err(|_| "--wait-ms must be an integer")?
            }
            "--child" => {
                child = Some(
                    args.next()
                        .ok_or("--child needs a value")?
                        .parse::<usize>()
                        .map_err(|_| "--child must be a decimal HWND")?,
                )
            }
            "--post-to" => post_to = args.next().ok_or("--post-to needs a value")?,
            value if value.starts_with("--") => return Err(format!("unknown option {value}")),
            value => positional.push(value.to_string()),
        }
    }
    if positional.len() != 3 {
        return Err("usage: contextmenu_probe <hwnd> <screenX> <screenY> [--sequence downup|contextmenu|both] [--wait-ms 700] [--child <hwnd>] [--post-to child|top]".into());
    }
    if !matches!(sequence.as_str(), "downup" | "contextmenu" | "both") {
        return Err("--sequence must be one of downup|contextmenu|both".into());
    }
    if !matches!(post_to.as_str(), "child" | "top") {
        return Err("--post-to must be child|top".into());
    }
    if !(100..=5000).contains(&wait_ms) {
        return Err("--wait-ms must be between 100 and 5000".into());
    }
    let hwnd = positional[0].parse::<usize>().map_err(|_| "hwnd must be a decimal integer")?;
    let x = positional[1].parse::<i32>().map_err(|_| "screenX must be an integer")?;
    let y = positional[2].parse::<i32>().map_err(|_| "screenY must be an integer")?;
    if x == -1 && y == -1 {
        return Err("INVALID_POINT: (-1,-1) is the keyboard WM_CONTEXTMENU sentinel; pass the element center".into());
    }
    if hwnd == 0 {
        return Err("hwnd must not be zero".into());
    }
    Ok(Args { hwnd, screen: POINT { x, y }, sequence, wait_ms, child, post_to })
}

fn hwnd_of(raw: usize) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

fn hwnd_string(hwnd: HWND) -> Value {
    if hwnd.0.is_null() {
        Value::Null
    } else {
        json!((hwnd.0 as usize).to_string())
    }
}

fn title_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

fn class_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

fn read_window(hwnd: HWND) -> WindowInfo {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let mut rect = RECT::default();
    let rect = if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
        Some(RectInfo { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
    } else {
        None
    };
    WindowInfo {
        hwnd: hwnd.0 as isize,
        pid,
        visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
        class: class_of(hwnd),
        title: title_of(hwnd),
        style: unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32,
        rect,
        owner: unsafe { GetWindow(hwnd, GW_OWNER) }.map_or(0, |owner| owner.0 as isize),
    }
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    out.push(read_window(hwnd));
    BOOL(1)
}

fn snapshot(target: HWND) -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect_window), LPARAM(&mut windows as *mut _ as isize));
        let _ = EnumChildWindows(Some(target), Some(collect_window), LPARAM(&mut windows as *mut _ as isize));
    }
    windows.sort_by_key(|window| window.hwnd);
    windows.dedup_by_key(|window| window.hwnd);
    windows
}

fn new_windows(before: &[WindowInfo], after: &[WindowInfo]) -> Vec<WindowInfo> {
    after
        .iter()
        .filter(|window| {
            window.visible
                && before
                    .iter()
                    .find(|old| old.hwnd == window.hwnd)
                    .map_or(true, |old| !old.visible)
        })
        .cloned()
        .collect()
}

fn distance_to_rect(rect: &RectInfo, point: POINT) -> f64 {
    let dx = if point.x < rect.left {
        i64::from(rect.left - point.x)
    } else if point.x > rect.right {
        i64::from(point.x - rect.right)
    } else {
        0
    };
    let dy = if point.y < rect.top {
        i64::from(rect.top - point.y)
    } else if point.y > rect.bottom {
        i64::from(point.y - rect.bottom)
    } else {
        0
    };
    ((dx * dx + dy * dy) as f64).sqrt()
}

fn rect_contains(rect: &RectInfo, point: POINT) -> bool {
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}

fn menu_like(window: &WindowInfo, target_pid: u32, point: POINT) -> bool {
    if !window.visible || window.pid != target_pid {
        return false;
    }
    let Some(rect) = &window.rect else { return false };
    if rect.width() <= 0 || rect.height() <= 0 {
        return false;
    }
    let classic = window.class == "#32768";
    let popup = (window.style & WS_POPUP_BIT) != 0;
    classic || (popup && distance_to_rect(rect, point) <= MENU_PROXIMITY)
}

fn mouse_lparam(point: POINT) -> LPARAM {
    let low = i64::from(point.x as u16);
    let high = i64::from(point.y as u16);
    LPARAM(((high << 16) | low) as isize)
}

fn post(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, label: &str) -> Result<(), String> {
    unsafe { PostMessageW(Some(hwnd), message, wparam, lparam) }
        .map_err(|error| format!("{label} failed for hwnd {}: {error}", hwnd.0 as usize))
}

fn deepest_target(target: HWND, screen: POINT) -> (HWND, POINT) {
    let mut current = target;
    let mut client = screen;
    for _ in 0..32 {
        let mut point = screen;
        if !unsafe { ScreenToClient(current, &mut point) }.as_bool() {
            break;
        }
        client = point;
        let mut child = unsafe { RealChildWindowFromPoint(current, point) };
        if child.0.is_null() {
            child = unsafe { ChildWindowFromPoint(current, point) };
        }
        if child.0.is_null() || child.0 == current.0 {
            break;
        }
        current = child;
    }
    (current, client)
}

fn cursor_point() -> Value {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_ok() {
        json!({"x": point.x, "y": point.y})
    } else {
        Value::Null
    }
}

fn window_at(point: POINT) -> Option<WindowInfo> {
    let hwnd = unsafe { WindowFromPoint(point) };
    if hwnd.0.is_null() {
        None
    } else {
        Some(read_window(hwnd))
    }
}

fn gui_info(target: HWND) -> Value {
    let thread = unsafe { GetWindowThreadProcessId(target, None) };
    if thread == 0 {
        return Value::Null;
    }
    let mut info: GUITHREADINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    if unsafe { GetGUIThreadInfo(thread, &mut info) }.is_err() {
        return Value::Null;
    }
    json!({
        "hwndMenuOwner": hwnd_string(info.hwndMenuOwner),
        "hwndFocus": hwnd_string(info.hwndFocus),
        "hwndActive": hwnd_string(info.hwndActive),
        "hwndCapture": hwnd_string(info.hwndCapture),
    })
}

fn error_json(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

fn run(args: &Args) -> Result<Value, String> {
    let target = hwnd_of(args.hwnd);
    if !unsafe { IsWindow(Some(target)) }.as_bool() {
        return Err(format!("target hwnd {} is not a window", args.hwnd));
    }
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0 != target.0 {
        return Err(format!(
            "FOREGROUND_MISMATCH: foreground is {:?}, target is {}; focus the target and retry",
            foreground.0 as usize, args.hwnd
        ));
    }

    let (resolved_child, resolved_client) = deepest_target(target, args.screen);
    let (child, client) = match args.child {
        Some(raw) => {
            let child = hwnd_of(raw);
            if !unsafe { IsWindow(Some(child)) }.as_bool() {
                return Err(format!("--child hwnd {raw} is not a window"));
            }
            let mut point = args.screen;
            if !unsafe { ScreenToClient(child, &mut point) }.as_bool() {
                return Err(format!("ScreenToClient failed for --child {raw}"));
            }
            (child, point)
        }
        None => (resolved_child, resolved_client),
    };
    let post_target = if args.post_to == "top" { target } else { child };
    let target_pid = unsafe { GetWindowThreadProcessId(target, None) };
    if target_pid == 0 {
        return Err("GetWindowThreadProcessId returned 0".into());
    }

    let cursor_before = cursor_point();
    let gui_before = gui_info(target);
    let before = snapshot(target);
    let started = Instant::now();

    if matches!(args.sequence.as_str(), "downup" | "both") {
        let param = mouse_lparam(client);
        post(child, WM_RBUTTONDOWN, WPARAM(0x0002), param, "WM_RBUTTONDOWN")?;
        post(child, WM_RBUTTONUP, WPARAM(0), param, "WM_RBUTTONUP")?;
        if args.sequence == "both" {
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    if matches!(args.sequence.as_str(), "contextmenu" | "both") {
        post(
            post_target,
            WM_CONTEXTMENU,
            WPARAM(child.0 as usize),
            mouse_lparam(args.screen),
            "WM_CONTEXTMENU",
        )?;
    }

    let deadline = Instant::now() + Duration::from_millis(args.wait_ms);
    let mut observed: Vec<WindowInfo> = Vec::new();
    loop {
        for window in new_windows(&before, &snapshot(target)) {
            if !observed.iter().any(|seen| seen.hwnd == window.hwnd) {
                observed.push(window);
            }
        }
        let menus_seen = observed.iter().filter(|window| menu_like(window, target_pid, args.screen)).count();
        if menus_seen > 0 {
            std::thread::sleep(Duration::from_millis(150));
            for window in new_windows(&before, &snapshot(target)) {
                if !observed.iter().any(|seen| seen.hwnd == window.hwnd) {
                    observed.push(window);
                }
            }
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }

    let cursor_after = cursor_point();
    let gui_after = gui_info(target);
    let mut cursor_pos = POINT::default();
    let have_cursor = unsafe { GetCursorPos(&mut cursor_pos) }.is_ok();
    let at_target_window = window_at(args.screen);
    let at_cursor_window = if have_cursor { window_at(cursor_pos) } else { None };
    // A menu is a popup host under the point being tested; the editor child is
    // not. Probe both points so "at target" and "at physical cursor" are
    // distinguishable instead of guessing from the set of new top-level windows.
    let is_menu = |window: &WindowInfo| {
        window.visible
            && window.hwnd != child.0 as isize
            && (window.class == "#32768" || window.class.contains("PopupWindowSiteBridge"))
            && window.rect.as_ref().map_or(false, |rect| rect.width() > 0 && rect.height() > 0)
    };
    let target_menu = at_target_window
        .as_ref()
        .filter(|window| is_menu(window) && window.rect.as_ref().map_or(false, |rect| rect_contains(rect, args.screen)))
        .cloned();
    let cursor_menu = if have_cursor {
        at_cursor_window
            .as_ref()
            .filter(|window| is_menu(window) && window.rect.as_ref().map_or(false, |rect| rect_contains(rect, cursor_pos)))
            .cloned()
    } else {
        None
    };
    let (menu_point, menu_anchor) = if let Some(window) = target_menu {
        (Some(window), "target")
    } else if let Some(window) = cursor_menu {
        (Some(window), "cursor")
    } else {
        (None, "none")
    };
    let menus: Vec<WindowInfo> = menu_point.iter().cloned().collect();
    let nearest = menu_point.as_ref();
    let nearest_rect = nearest.and_then(|window| window.rect.as_ref());
    let at_target = menu_anchor == "target";
    let at_cursor = menu_anchor == "cursor";
    let verdict = if menus.is_empty() {
        if observed.is_empty() {
            "NO_NEW_WINDOW"
        } else {
            "NEW_WINDOW_NOT_MENU"
        }
    } else if at_cursor {
        "MENU_AT_CURSOR"
    } else if nearest_rect.map_or(false, |rect| {
        rect.left.abs_diff(args.screen.x) <= 5 && rect.top.abs_diff(args.screen.y) <= 5
    }) {
        "MENU_AT_TARGET"
    } else {
        "MENU_CONTAINS_TARGET"
    };

    Ok(json!({
        "ok": true,
        "sequence": args.sequence,
        "target": args.hwnd.to_string(),
        "child": (child.0 as usize).to_string(),
        "postTo": args.post_to,
        "postTarget": (post_target.0 as usize).to_string(),
        "foreground": hwnd_string(foreground),
        "screen": {"x": args.screen.x, "y": args.screen.y},
        "client": {"x": client.x, "y": client.y},
        "cursorBefore": cursor_before,
        "cursorAfter": cursor_after,
        "guiBefore": gui_before,
        "guiAfter": gui_after,
        "atTargetWindow": at_target_window.as_ref().map(WindowInfo::json),
        "atCursorWindow": at_cursor_window.as_ref().map(WindowInfo::json),
        "waitMs": args.wait_ms,
        "elapsedMs": started.elapsed().as_millis(),
        "newWindows": observed.iter().map(WindowInfo::json).collect::<Vec<_>>(),
        "menuCount": menus.len(),
        "menuAnchor": menu_anchor,
        "doubleMenu": menus.len() > 1,
        "menuHwnd": nearest.map_or(Value::Null, |window| json!(window.hwnd.to_string())),
        "menuRect": nearest_rect.map_or(Value::Null, RectInfo::json),
        "menuScreenX": nearest_rect.map_or(-1, |rect| rect.left),
        "menuScreenY": nearest_rect.map_or(-1, |rect| rect.top),
        "menus": menus.iter().map(WindowInfo::json).collect::<Vec<_>>(),
        "atTarget": at_target,
        "atCursor": at_cursor,
        "verdict": verdict,
    }))
}

fn main() {
    // Do not let Windows virtualize GetCursorPos/GetWindowRect to 1536x864:
    // the worker and UIA report physical pixels, so the probe must too.
    // SetProcessDPIAware is the system-DPI-aware call already available through
    // Win32_UI_WindowsAndMessaging; per-monitor v2 would need a new Cargo feature.
    unsafe {
        let _ = SetProcessDPIAware();
    }
    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            println!("{}", error_json(&error));
            std::process::exit(2);
        }
    };
    match run(&args) {
        Ok(result) => println!("{}", result),
        Err(error) => {
            println!("{}", error_json(&error));
            std::process::exit(2);
        }
    }
}
