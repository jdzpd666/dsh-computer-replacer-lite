//! Desktop context fingerprint: foreground window + keyboard focus.
//!
//! A write action is only allowed against the window whose model the agent just
//! observed, and only while keyboard focus has not moved elsewhere. Any mismatch
//! is rejected before COM: nothing is injected and the caller must re-observe.

use crate::world::{fault, Result};
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
    SetWindowPos, ShowWindow, SwitchToThisWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOACTIVATE, SW_RESTORE,
};

/// Current foreground window as a decimal HWND string.
pub fn foreground() -> Option<String> {
    let handle = unsafe { GetForegroundWindow() };
    if handle.0.is_null() {
        None
    } else {
        Some((handle.0 as usize).to_string())
    }
}

/// Pure comparison so the rules are testable without a desktop.
pub fn compare(target: &str, foreground: Option<&str>) -> Result<()> {
    match foreground {
        None => Err(fault("CONTEXT_CHANGED", "No foreground window; the desktop context is unknown")),
        Some(value) if value != target => Err(fault(
            "CONTEXT_CHANGED",
            format!("Foreground window is {value}, but the model belongs to {target}; switch back or observe again"),
        )),
        Some(_) => Ok(()),
    }
}

/// Fails with CONTEXT_CHANGED unless the target window is foreground right now.
pub fn check(target: &str) -> Result<()> {
    compare(target, foreground().as_deref())
}

/// True while the HWND still names an existing window. Read-only probe used to
/// report whether an Invoke closed its window; it injects nothing.
pub fn alive(target: &str) -> bool {
    handle(target).is_ok()
}

fn handle(target: &str) -> Result<HWND> {
    let value = target
        .parse::<usize>()
        .map_err(|_| fault("INVALID_ARGUMENT", "hwnd must be a decimal integer string"))?;
    let window = HWND(value as *mut core::ffi::c_void);
    if !unsafe { IsWindow(Some(window)) }.as_bool() {
        return Err(fault("CONTEXT_CHANGED", "Target window no longer exists; nothing was performed"));
    }
    Ok(window)
}

/// Bring the just-approved target window back to the foreground.
///
/// The approval card is answered in another window, so the desktop foreground
/// leaves the modelled target between the decision and the injection. Restoring
/// it is not input to the target: the caller still proves foreground and keyboard
/// focus right before the COM call. Several documented activation strategies are
/// tried because Windows blocks background focus stealing; a window that still
/// cannot be re-activated fails closed before anything is written, and the error
/// carries the per-strategy trace so the refusal is diagnosable.
pub fn activate(target: &str) -> Result<()> {
    if foreground().as_deref() == Some(target) {
        return Ok(());
    }
    let window = handle(target)?;
    let mut trace = String::new();
    unsafe {
        let _ = ShowWindow(window, SW_RESTORE);
        let front = GetForegroundWindow();
        let front_thread = GetWindowThreadProcessId(front, None);
        let target_thread = GetWindowThreadProcessId(window, None);
        let own = GetCurrentThreadId();
        let attach_front = front_thread != 0 && AttachThreadInput(front_thread, own, true).as_bool();
        let attach_target =
            target_thread != 0 && target_thread != front_thread && AttachThreadInput(target_thread, own, true).as_bool();
        let raised = BringWindowToTop(window).is_ok();
        let set = SetForegroundWindow(window).as_bool();
        if attach_target {
            let _ = AttachThreadInput(target_thread, own, false);
        }
        if attach_front {
            let _ = AttachThreadInput(front_thread, own, false);
        }
        trace.push_str(&format!(
            "front={:?}/{front_thread} targetThread={target_thread} attachFront={attach_front} attachTarget={attach_target} raise={raised} set={set}",
            front.0
        ));
        if foreground().as_deref() != Some(target) {
            keybd_event(VK_MENU.0 as u8, 0, Default::default(), 0);
            keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            let retry = SetForegroundWindow(window).as_bool();
            trace.push_str(&format!(" altTapThenSet={retry}"));
        }
        if foreground().as_deref() != Some(target) {
            let _ = SetWindowPos(window, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            let _ = SetWindowPos(window, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            SwitchToThisWindow(window, true);
            trace.push_str(" topmost+switch");
        }
    }
    for _ in 0..60 {
        if foreground().as_deref() == Some(target) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(fault(
        "CONTEXT_CHANGED",
        format!(
            "Approved target {target} could not be re-activated; nothing was performed ({trace}; now={:?})",
            foreground()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::compare;

    #[test]
    fn foreground_must_match_the_modelled_window() {
        assert!(compare("42", Some("42")).is_ok());
        assert_eq!(compare("42", Some("43")).unwrap_err().0, "CONTEXT_CHANGED");
        assert_eq!(compare("42", None).unwrap_err().0, "CONTEXT_CHANGED");
        assert!(compare("0042", Some("42")).is_err(), "no numeric normalization is guessed");
    }
}
