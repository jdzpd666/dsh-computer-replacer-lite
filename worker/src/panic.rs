//! Physical emergency-stop hotkey (panic latch).
//!
//! A dedicated thread registers one global hotkey (default `ctrl+alt+shift+p`,
//! overridable through `REPLACER_PANIC_HOTKEY="mods+key"`) and runs a GetMessageW
//! loop. WM_HOTKEY trips a process-wide `AtomicBool` latch that every injection
//! checkpoint consults before issuing any message, then gives the action thread a
//! bounded grace window to drain its queue (queued actions answer PANIC_ABORTED
//! without touching COM) and exits the process with the distinctive code 87 so the
//! supervisor's proven crash-restart path relaunches a clean, stateless worker.
//!
//! Hard rules:
//! * parse or registration failure (hotkey occupied) is only logged
//!   (`PANIC_HOTKEY_UNAVAILABLE`); the worker keeps serving without the hotkey;
//! * the latch is sticky until process exit; there is no automatic release;
//! * the hotkey thread never takes any lock and never sends input, so the
//!   emergency stop itself performs zero injection;
//! * messages already delivered cannot be recalled (honest boundary, documented
//!   in PLUGIN.md).
use crate::world::{fault, Fault};
use std::sync::atomic::{AtomicBool, Ordering};

pub static PANIC: AtomicBool = AtomicBool::new(false);

/// True once the emergency stop has fired; stays true until process exit.
pub fn tripped() -> bool {
    PANIC.load(Ordering::Acquire)
}

/// Latches the emergency stop. Idempotent: repeated trips are harmless.
pub fn trip() {
    PANIC.store(true, Ordering::Release);
}

/// The injection checkpoint itself: zero locks, zero waits. Every path that can
/// issue a message calls this before its first (and, for multi-step sequences,
/// every subsequent) message.
pub fn gate() -> Result<(), Fault> {
    if tripped() {
        Err(fault(
            "PANIC_ABORTED",
            "Panic latch tripped (emergency-stop hotkey); aborted before any message was issued; zero injection performed. Messages already sent cannot be recalled",
        ))
    } else {
        Ok(())
    }
}

/// Exit code chosen by the final review: a distinctive non-zero code that lands
/// in the supervisor's already-verified crash-restart path.
pub const PANIC_EXIT_CODE: i32 = 87;

/// Grace window during which the hotkey thread waits before exiting, so the
/// action thread (which checks the latch at the top of every loop iteration) can
/// answer queued actions with PANIC_ABORTED. The action queue is sync_channel(1),
/// so at most one action can be queued plus one in flight; 500ms covers both.
const PANIC_DRAIN_GRACE_MS: u64 = 500;

const PANIC_HOTKEY_ID: i32 = 1;
pub const DEFAULT_HOTKEY: &str = "ctrl+alt+shift+p";

/// Modifier bitflags for parse_hotkey (kept Windows-free so the parser is a pure
/// function): bit 0 ctrl, bit 1 alt, bit 2 shift, bit 3 win.
pub const MOD_CTRL: u32 = 1;
pub const MOD_ALT: u32 = 2;
pub const MOD_SHIFT: u32 = 4;
pub const MOD_WIN: u32 = 8;

/// Resolved hotkey: (modifier bitmask, virtual-key code, normalized label).
pub type HotkeySpec = (u32, u32, String);

/// Parses `"mods+key"`. Mods are case-insensitive, deduplicated and combinable;
/// the key is one ASCII letter/digit, `f1`..`f24`, or a small named-key table.
///
/// Final-review rule: the mods must contain ctrl, alt or win at least once
/// (shift may only be added). A bare key or a shift-only combination is
/// rejected: a global hotkey without a hard modifier would swallow a typing key.
pub fn parse_hotkey(spec: &str) -> Result<HotkeySpec, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("empty hotkey spec".to_owned());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("hotkey spec must not contain whitespace".to_owned());
    }
    let mut mods = 0u32;
    let segments: Vec<&str> = trimmed.split('+').collect();
    if segments.iter().any(|s| s.is_empty()) {
        return Err(format!("empty segment in hotkey spec {spec:?}"));
    }
    for segment in &segments[..segments.len() - 1] {
        let bit = match segment.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => MOD_CTRL,
            "alt" => MOD_ALT,
            "shift" => MOD_SHIFT,
            "win" | "meta" | "super" => MOD_WIN,
            other => return Err(format!("unknown modifier {other:?} in hotkey spec {spec:?}")),
        };
        mods |= bit; // duplicate modifiers dedupe naturally
    }
    let key = segments[segments.len() - 1].to_ascii_lowercase();
    let vk = named_key(&key).or_else(|| single_key(&key))
        .ok_or_else(|| format!("unknown key {key:?} in hotkey spec {spec:?}"))?;
    if mods & (MOD_CTRL | MOD_ALT | MOD_WIN) == 0 {
        return Err(format!(
            "hotkey {spec:?} needs ctrl, alt or win at least once (bare keys and shift-only combinations would swallow typing keys)"
        ));
    }
    Ok((mods, vk, label(mods, &key)))
}

fn named_key(key: &str) -> Option<u32> {
    Some(match key {
        "enter" | "return" => 0x0D,
        "esc" | "escape" => 0x1B,
        "tab" => 0x09,
        "backspace" => 0x08,
        "space" => 0x20,
        "delete" | "del" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        _ => return None,
    })
}

/// One ASCII letter/digit, or f1..f24.
fn single_key(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.len() == 1 && bytes[0].is_ascii_alphanumeric() {
        return Some(u32::from(bytes[0].to_ascii_uppercase()));
    }
    if bytes.len() >= 2 && bytes[0] == b'f' && bytes[1..].iter().all(|b| b.is_ascii_digit()) {
        let n: u32 = key[1..].parse().ok()?;
        if (1..=24).contains(&n) {
            return Some(0x70 + n - 1);
        }
    }
    None
}

/// Normalized label in canonical modifier order, for logs and replacer_status.
fn label(mods: u32, key: &str) -> String {
    let mut parts = Vec::new();
    if mods & MOD_CTRL != 0 { parts.push("ctrl"); }
    if mods & MOD_ALT != 0 { parts.push("alt"); }
    if mods & MOD_SHIFT != 0 { parts.push("shift"); }
    if mods & MOD_WIN != 0 { parts.push("win"); }
    parts.push(key);
    parts.join("+")
}

fn to_windows_mods(mods: u32) -> windows::Win32::UI::Input::KeyboardAndMouse::HOT_KEY_MODIFIERS {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        HOT_KEY_MODIFIERS, MOD_ALT as WIN_MOD_ALT, MOD_CONTROL as WIN_MOD_CONTROL, MOD_SHIFT as WIN_MOD_SHIFT, MOD_WIN as WIN_MOD_WIN,
    };
    let mut out = HOT_KEY_MODIFIERS(0);
    if mods & MOD_CTRL != 0 { out |= WIN_MOD_CONTROL; }
    if mods & MOD_ALT != 0 { out |= WIN_MOD_ALT; }
    if mods & MOD_SHIFT != 0 { out |= WIN_MOD_SHIFT; }
    if mods & MOD_WIN != 0 { out |= WIN_MOD_WIN; }
    out
}

/// Label of the hotkey this process armed (empty when none), for replacer_status.
static ARMED_LABEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub fn hotkey_label() -> String {
    ARMED_LABEL.get().cloned().unwrap_or_default()
}

/// Spawns the dedicated hotkey thread. Worker mode only (the elevated-broker
/// branch never calls this). All failures are logged and non-fatal.
pub fn spawn_hotkey_thread() {
    let handle = std::thread::Builder::new().name("panic-hotkey".into()).spawn(|| unsafe { hotkey_thread() });
    if let Err(error) = handle {
        eprintln!("PANIC_HOTKEY_UNAVAILABLE: could not spawn the hotkey thread: {error}; worker continues without the panic hotkey");
    }
}

unsafe fn hotkey_thread() {
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::RegisterHotKey;
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    let raw = std::env::var("REPLACER_PANIC_HOTKEY").ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let spec = raw.as_deref().unwrap_or(DEFAULT_HOTKEY);
    let (mods, vk, label) = match parse_hotkey(spec) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("PANIC_HOTKEY_UNAVAILABLE: {error}; worker continues without the panic hotkey");
            return;
        }
    };
    // RegisterHotKey must precede GetMessageW: only after a successful
    // registration is the thread id meaningful for PostThreadMessageW targeting
    // (the message queue itself is created by the first GetMessageW call).
    let registered = unsafe { RegisterHotKey(None, PANIC_HOTKEY_ID, to_windows_mods(mods), vk) };
    if let Err(error) = registered {
        eprintln!("PANIC_HOTKEY_UNAVAILABLE: RegisterHotKey({label}) failed: {error} (occupied by another process?); worker continues without the panic hotkey");
        return;
    }
    let _ = ARMED_LABEL.set(label.clone());
    // Harness contract (scripts/verify-panic.mjs): thread id first, then the
    // armed label; the harness waits for this line before posting WM_HOTKEY.
    eprintln!("PANIC_HOTKEY_THREAD={}", unsafe { GetCurrentThreadId() });
    eprintln!("PANIC_HOTKEY_ARMED={label}");
    let mut message: MSG = unsafe { std::mem::zeroed() };
    loop {
        // GetMessageW returns FALSE on WM_QUIT and -1 on error; both end the loop
        // and leave the worker running without the hotkey (fail-open for the
        // hotkey feature only, never for injection safety).
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if !result.as_bool() { break; }
        if message.message == WM_HOTKEY && message.wParam.0 == PANIC_HOTKEY_ID as usize {
            trip();
            eprintln!("PANIC_HOTKEY_TRIPPED");
            // Bounded drain grace: the action thread checks the latch at the top
            // of its loop, so queued actions answer PANIC_ABORTED without
            // touching COM. Whatever is still mid-flight after this window is
            // cut off by process exit; already-sent messages cannot be recalled.
            std::thread::sleep(std::time::Duration::from_millis(PANIC_DRAIN_GRACE_MS));
            eprintln!("PANIC_HOTKEY_EXIT code={PANIC_EXIT_CODE}");
            std::process::exit(PANIC_EXIT_CODE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::Fault;

    #[test]
    fn parses_valid_hotkeys() {
        // Default: ctrl+alt+shift+p
        let (mods, vk, label) = parse_hotkey(DEFAULT_HOTKEY).expect("default");
        assert_eq!((mods, vk, label.as_str()), (MOD_CTRL | MOD_ALT | MOD_SHIFT, u32::from(b'P'), "ctrl+alt+shift+p"));
        // win combination
        let (mods, vk, label) = parse_hotkey("win+f9").expect("win+f9");
        assert_eq!((mods, vk, label.as_str()), (MOD_WIN, 0x78, "win+f9"));
        // ctrl+win combination with a digit key
        let (mods, vk, _) = parse_hotkey("ctrl+win+7").expect("ctrl+win+7");
        assert_eq!((mods, vk), (MOD_CTRL | MOD_WIN, u32::from(b'7')));
        // case-insensitive
        assert_eq!(parse_hotkey("CTRL+ALT+P").expect("upper"), parse_hotkey("ctrl+alt+p").expect("lower"));
        // duplicate modifiers dedupe
        let (mods, _, _) = parse_hotkey("ctrl+ctrl+alt+alt+p").expect("dup");
        assert_eq!(mods, MOD_CTRL | MOD_ALT);
        // f24 boundary and named keys
        assert_eq!(parse_hotkey("ctrl+f24").expect("f24").1, 0x87);
        assert_eq!(parse_hotkey("alt+enter").expect("enter").1, 0x0D);
        // control/alias modifiers and surrounding whitespace
        assert!(parse_hotkey("control+alt+x").is_ok());
        assert!(parse_hotkey(" ctrl+alt+x ").is_ok());
        // shift may be added on top of a hard modifier
        assert!(parse_hotkey("alt+shift+k").is_ok());
    }

    #[test]
    fn rejects_invalid_hotkeys() {
        for bad in [
            "",                       // empty
            "   ",                    // whitespace only
            "ctrl+",                  // no key
            "+p",                     // no modifier segment
            "ctrl++p",                // empty middle segment
            "ctrl+alt",               // no key (last segment consumed as key: unknown)
            "hyper+p",                // unknown modifier
            "p",                      // bare key: no hard modifier
            "shift+p",                // shift-only: would swallow a typing key
            "shift+enter",            // shift-only named key
            "ctrl+foo",               // unknown key
            "ctrl+f0",                // f-keys start at f1
            "ctrl+f25",               // f-keys end at f24
            "ctrl+alt+p q",           // whitespace inside
            "ctrl+é",                 // non-ASCII key
            "ctrl+a b",               // whitespace inside key
        ] {
            assert!(parse_hotkey(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn trip_is_sticky_and_gate_blocks() {
        // Must observe the clear state before any trip in this test process.
        assert!(!tripped());
        assert!(gate().is_ok());
        trip();
        trip(); // repeated trip is harmless
        assert!(tripped());
        let error = gate().expect_err("gate must block after trip");
        let Fault(code, message) = error;
        assert_eq!(code, "PANIC_ABORTED");
        assert!(!message.is_empty());
    }
}
