// Task 3 Phase 0 probe: validate keyboard-injection techniques with PostMessageW
// before any production change. Posts messages to the focused child of <hwnd>
// (the same receiver rule the wheel path uses) and reads the editor text back
// through UIA TextPattern, so every verdict is an outside fact, not a feeling.
//
//   keyboard_probe <hwnd> <technique> [--wait-ms 700]
//
// Techniques (deliberately raw - the production combo parser comes in Phase 1):
//   text:<chars>      WM_KEYDOWN + WM_CHAR(per UTF-16 unit) + WM_KEYUP
//   enter             WM_CHAR 0x0D
//   charcode:0xNN     raw WM_CHAR control code (0x01 = Ctrl+A select-all equivalent)
//   key:0x25          WM_KEYDOWN + WM_KEYUP of one virtual key (arrows etc.)
//   chord:ctrl+0x41   modifier WM_KEYDOWN + key down/up + modifier WM_KEYUP
//   alt               WM_SYSKEYDOWN/UP of VK_MENU + WM_CANCELMODE (menu-activation probe)
use windows::{
    core::*, Win32::{
        Foundation::*, System::Com::*, System::Variant::VARIANT, UI::Accessibility::*,
        UI::Input::KeyboardAndMouse::*, UI::WindowsAndMessaging::*,
    }
};
use std::env;

const LPARAM_UP: usize = 0xC0000000;

fn post(hwnd: HWND, msg: u32, w: usize, l: usize) -> Result<()> {
    unsafe { PostMessageW(Some(hwnd), msg, WPARAM(w), LPARAM(l as isize)) }
}

fn scan_of(vk: u32) -> u32 {
    unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) }
}

fn key_seq(vk: u32) -> Vec<(u32, usize, usize)> {
    let scan = (scan_of(vk) as usize) << 16;
    vec![
        (WM_KEYDOWN, vk as usize, scan | 1),
        (WM_KEYUP, vk as usize, scan | 1 | LPARAM_UP),
    ]
}

/// Resolve the focused child of the target thread; falls back to the window
/// itself - the same receiver rule as the production wheel path.
fn focus_child(hwnd: HWND) -> HWND {
    unsafe {
        let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        let tid = GetWindowThreadProcessId(hwnd, None);
        if GetGUIThreadInfo(tid, &mut info).is_ok() && !info.hwndFocus.0.is_null() && info.hwndFocus != hwnd {
            info.hwndFocus
        } else { hwnd }
    }
}

/// Largest Edit/Document descendant by area - the Notepad text surface.
fn editor_text(uia: &IUIAutomation, hwnd: HWND) -> Result<String> {
    unsafe {
        let root = uia.ElementFromHandle(hwnd)?;
        let t_edit = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_EditControlTypeId.0))?;
        let t_doc = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_DocumentControlTypeId.0))?;
        let both = uia.CreateOrCondition(&t_edit, &t_doc)?;
        let found = root.FindAll(TreeScope_Descendants, &both)?;
        let mut best: Option<(IUIAutomationElement, f64)> = None;
        for i in 0..found.Length()? {
            let el = found.GetElement(i)?;
            let rect = el.CurrentBoundingRectangle()?;
            let area = (rect.right - rect.left) as f64 * (rect.bottom - rect.top) as f64;
            if best.as_ref().is_none_or(|(_, a)| area > *a) { best = Some((el, area)); }
        }
        let (el, _) = best.ok_or(Error::from_hresult(HRESULT(1)))?;
        if let Ok(tp) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            if let Ok(range) = tp.DocumentRange() {
                if let Ok(text) = range.GetText(-1) {
                    return Ok(text.to_string());
                }
            }
        }
        // TextPattern refused (provider state varies across Notepad builds):
        // fall back to WM_GETTEXT with a hard timeout. Diagnostic-only; the
        // production injection path never sends synchronous messages.
        let surface = input_surface(hwnd);
        let mut len = 0usize;
        let _ = SendMessageTimeoutW(surface, WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 1000, Some(&mut len));
        if len == 0 { return Ok(String::new()); }
        let mut buf = vec![0u16; (len + 1) as usize];
        let mut copied = 0usize;
        let _ = SendMessageTimeoutW(surface, WM_GETTEXT, WPARAM(buf.len()), LPARAM(buf.as_mut_ptr() as isize), SMTO_ABORTIFHUNG, 1000, Some(&mut copied));
        buf.truncate(copied as usize);
        Ok(String::from_utf16_lossy(&buf))
    }
}

/// Direct children of one window, collected via a leaked buffer (probe-grade).
fn children(hwnd: HWND) -> Vec<HWND> {
    let found: *mut Vec<HWND> = Box::leak(Box::new(Vec::new()));
    unsafe extern "system" fn cb(child: HWND, lparam: LPARAM) -> BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        out.push(child);
        BOOL(1)
    }
    unsafe { let _ = EnumChildWindows(Some(hwnd), Some(cb), LPARAM(found as isize)); }
    let taken = unsafe { Box::from_raw(found) };
    *taken
}

/// Recursive child-tree dump: hwnd + class, so the real input island shows itself.
fn dump_tree(hwnd: HWND, depth: usize, out: &mut Vec<String>) {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut buf);
        let class = String::from_utf16_lossy(&buf[..n as usize]);
        out.push(format!("{:>16} d{} <{}>", hwnd.0 as isize, depth, class));
        for child in children(hwnd) { dump_tree(child, depth + 1, out); }
    }
}

/// Deepest descendant along the first-child chain - where WinUI islands live.
fn deepest_child(hwnd: HWND) -> HWND {
    let mut current = hwnd;
    for _ in 0..16 {
        let mut kids = children(current);
        if kids.is_empty() { break; }
        current = kids.pop().unwrap_or(current);
    }
    current
}

/// All descendants whose class contains `needle` (case-sensitive).
fn find_by_class(hwnd: HWND, needle: &str, out: &mut Vec<HWND>) {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut buf);
        if String::from_utf16_lossy(&buf[..n as usize]).contains(needle) { out.push(hwnd); }
        for child in children(hwnd) { find_by_class(child, needle, out); }
    }
}

/// The input surface: a RichEdit* descendant when present (Win11 Notepad),
/// else the deepest first-chain child.
fn input_surface(hwnd: HWND) -> HWND {
    // Priority matches production inject.rs: classic editor classes (RichEdit*/
    // Edit/_WwG - they process WM_CHAR) first; WinUI island parents like
    // NotepadTextBox second (visible but deaf to keyboard messages); the
    // deepest first-chain child last.
    let mut primary = Vec::new();
    let mut island = Vec::new();
    find_by_class(hwnd, "RichEdit", &mut primary);
    find_by_class(hwnd, "EDIT", &mut primary);
    find_by_class(hwnd, "Edit", &mut primary);
    find_by_class(hwnd, "NotepadTextBox", &mut island);
    primary.into_iter().next()
        .or_else(|| island.into_iter().next())
        .unwrap_or_else(|| deepest_child(hwnd))
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 { println!("usage: keyboard_probe <hwnd> <technique> [--wait-ms 700]"); std::process::exit(2); }
    let hwnd = HWND(args[1].parse::<isize>().unwrap_or(0) as *mut _);
    let technique = args[2].clone();
    let wait_ms: u64 = args.iter().position(|a| a == "--wait-ms")
        .and_then(|i| args.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(700);

    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()?; }
    let result = (|| -> Result<()> {
        unsafe {
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let target = input_surface(hwnd);
            let mut tid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut tid));
            let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
            let _ = GetGUIThreadInfo(tid, &mut info);
            println!("RECEIVER hwnd={} focus={}", target.0 as isize, info.hwndFocus.0 as isize);

            let text_before = editor_text(&uia, hwnd).unwrap_or_else(|e| format!("<unreadable: {e}>"));
            let mut posted: Vec<String> = Vec::new();
            let mut plog = |msg: u32, w: usize, l: usize, name: &str| -> Result<()> {
                post(target, msg, w, l)?;
                posted.push(name.to_string());
                Ok(())
            };

            if let Some(chars) = technique.strip_prefix("text:") {
                // WM_CHAR only: KEYDOWN double-inserts in RichEditD2DPT.
                for unit in chars.encode_utf16() {
                    plog(WM_CHAR, unit as usize, 0x1C0001, &format!("CHAR U+{unit:04X}"))?;
                }
            } else if technique == "enter" {
                plog(WM_CHAR, 0x0D, 0x1C0001, "CHAR CR")?;
            } else if let Some(hex) = technique.strip_prefix("char:") {
                let code = usize::from_str_radix(hex.trim_start_matches("0x"), 16)
                    .map_err(|_| Error::from_hresult(HRESULT(5)))?;
                plog(WM_CHAR, code, 0x1C0001, &format!("CHAR {code:#04x}"))?;
            } else if let Some(hex) = technique.strip_prefix("charcode:") {
                let code = usize::from_str_radix(hex.trim_start_matches("0x"), 16)
                    .map_err(|_| Error::from_hresult(HRESULT(5)))?;
                plog(WM_CHAR, code, 0x1C0001, &format!("CHAR {code:#04x}"))?;
            } else if let Some(vk) = technique.strip_prefix("key:") {
                let vk = u32::from_str_radix(vk.trim_start_matches("0x"), 16)
                    .map_err(|_| Error::from_hresult(HRESULT(5)))?;
                for (m, w, l) in key_seq(vk) { plog(m, w, l, &format!("KEY {vk:#x}"))?; }
            } else if let Some(chord) = technique.strip_prefix("chord:") {
                let (modifier, key) = chord.split_once('+').ok_or(Error::from_hresult(HRESULT(2)))?;
                let mvk = match modifier.to_ascii_lowercase().as_str() {
                    "ctrl" => 0x11u32, "alt" => 0x12, "shift" => 0x10,
                    _ => return Err(Error::from_hresult(HRESULT(3))),
                };
                let kvk = u32::from_str_radix(key.trim_start_matches("0x"), 16)
                    .map_err(|_| Error::from_hresult(HRESULT(5)))?;
                plog(WM_KEYDOWN, mvk as usize, ((scan_of(mvk) as usize) << 16) | 1, "MOD DOWN")?;
                for (m, w, l) in key_seq(kvk) { plog(m, w, l, "KEY")?; }
                plog(WM_KEYUP, mvk as usize, ((scan_of(mvk) as usize) << 16) | 1 | LPARAM_UP, "MOD UP")?;
            } else if technique == "read" {
                // Pure Win32 read: WM_GETTEXTLENGTH + WM_GETTEXT with a hard
                // timeout on the input surface. No UIA - the WinForms provider
                // answers "函数不正确" for TextPattern/FindAll from an MTA client.
                let surface = input_surface(hwnd);
                let mut len = 0usize;
                for attempt in 0..3 {
                    let _ = SendMessageTimeoutW(surface, WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 3000, Some(&mut len));
                    if len > 0 { break; }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                if len == 0 { println!("RAW_TEXT <<<>"); return Ok(()); }
                let mut buf = vec![0u16; (len + 1) as usize];
                let mut copied = 0usize;
                let _ = SendMessageTimeoutW(surface, WM_GETTEXT, WPARAM(buf.len()), LPARAM(buf.as_mut_ptr() as isize), SMTO_ABORTIFHUNG, 1000, Some(&mut copied));
                buf.truncate(copied as usize);
                let raw = String::from_utf16_lossy(&buf);
                println!("RAW_TEXT <<<{}>>>", raw.replace('\r', "\r").replace('\n', "\n"));
                return Ok(());
            } else if technique == "tree" {
                let mut out = Vec::new();
                dump_tree(hwnd, 0, &mut out);
                for line in out { println!("TREE {line}"); }
                let deep = deepest_child(hwnd);
                println!("DEEPEST {}", deep.0 as isize);
                return Ok(());
            } else if let Some(chars) = technique.strip_prefix("deep:text:") {
                let deep = input_surface(hwnd);
                println!("DEEP_RECEIVER {} class-surface", deep.0 as isize);
                for unit in chars.encode_utf16() {
                    let printable = (unit as u32) < 0x80 && (unit as u8 as char).is_ascii_graphic();
                    let vk: u32 = if printable { (unit as u8 as char).to_ascii_uppercase() as u32 } else { 0xE7 };
                    let scan = (scan_of(vk) as usize) << 16;
                    post(deep, WM_KEYDOWN, vk as usize, scan | 1)?;
                    post(deep, WM_CHAR, unit as usize, scan | 1)?;
                    post(deep, WM_KEYUP, vk as usize, scan | 1 | LPARAM_UP)?;
                    posted.push(format!("D U+{unit:04X}"));
                }
            } else if technique == "clear" {
                // Diagnostic-only: empties OUR OWN fixture textbox via WM_SETTEXT
                // (SendMessage family). Never used by the production injection path.
                let surface = input_surface(hwnd);
                let mut empty = [0u16; 1];
                let mut copied = 0usize;
                let _ = SendMessageTimeoutW(surface, WM_SETTEXT, WPARAM(0), LPARAM(empty.as_mut_ptr() as isize), SMTO_ABORTIFHUNG, 1000, Some(&mut copied));
                println!("CLEARED surface={}", surface.0 as isize);
                return Ok(());
            } else if technique == "commit" {
                // Fixture helper: PostMessage BM_CLICK to the BUTTON-class child.
                // Deterministic for harnesses; the production path never touches buttons.
                let mut buttons = Vec::new();
                find_by_class(hwnd, "BUTTON", &mut buttons);
                let button = buttons.first().copied().ok_or(Error::from_hresult(HRESULT(8)))?;
                post(button, BM_CLICK, 0, 0)?;
                println!("BM_CLICK button={}", button.0 as isize);
                return Ok(());
            } else if technique == "alt" {
                plog(WM_SYSKEYDOWN, 0x12, ((scan_of(0x12) as usize) << 16) | 1 | 0x2000_0000, "SYSKEYDOWN ALT")?;
                plog(WM_SYSKEYUP, 0x12, ((scan_of(0x12) as usize) << 16) | 1 | 0x2000_0000 | LPARAM_UP, "SYSKEYUP ALT")?;
                plog(WM_CANCELMODE, 0, 0, "CANCELMODE")?;
            } else {
                return Err(Error::from_hresult(HRESULT(4)));
            }

            std::thread::sleep(std::time::Duration::from_millis(wait_ms));
            let text_after = editor_text(&uia, hwnd).unwrap_or_else(|e| format!("<unreadable: {e}>"));
            println!("POSTED [{}]", posted.join(", "));
            println!("TEXT_BEFORE <<<{}>>>", text_before.replace('\n', "\\n").replace('\r', ""));
            println!("TEXT_AFTER  <<<{}>>>", text_after.replace('\n', "\\n").replace('\r', ""));
            println!("VERDICT changed={}", text_before != text_after);
            Ok(())
        }
    })();
    unsafe { CoUninitialize(); }
    result
}
