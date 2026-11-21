//! External read-only assertion helper: ScrollPattern state of scrollable elements in a window.
//! Never injects and never changes scroll position.
//!   scroll_probe <hwnd>            first scrollable element
//!   scroll_probe <hwnd> --all      every scrollable element
//!   scroll_probe <hwnd> --id r:[..] the element with this runtime id
use replacer_worker::uia::events::runtime_id;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::{Ole::SafeArrayDestroy, Variant::{VariantClear, VariantToBoolean}};
use windows::Win32::UI::Accessibility::*;

fn main() {
    let mut args = std::env::args().skip(1);
    let hwnd = args.next().expect("usage: scroll_probe <hwnd> [--all] [--id r:[...]]");
    let handle: isize = hwnd.parse().expect("hwnd must be decimal");
    let mut all = false;
    let mut wanted: Option<String> = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--all" => all = true,
            "--id" => wanted = args.next(),
            other => panic!("unknown argument {other}"),
        }
    }
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).unwrap();
        let target = automation.ElementFromHandle(HWND(handle as *mut std::ffi::c_void)).unwrap();
        let condition = automation.CreateTrueCondition().unwrap();
        let elements = target.FindAll(TreeScope_Subtree, &condition).unwrap();
        let count = elements.Length().unwrap();
        let mut printed = 0;
        for index in 0..count {
            let element = elements.GetElement(index).unwrap();
            let mut available = element.GetCurrentPropertyValue(UIA_IsScrollPatternAvailablePropertyId).unwrap();
            let scrollable = VariantToBoolean(&available).map(|v| v.as_bool()).unwrap_or(false);
            let _ = VariantClear(&mut available);
            if !scrollable { continue; }
            let array = element.GetRuntimeId().unwrap();
            let ids = runtime_id(array).map(|v| v.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")).unwrap_or_default();
            if !array.is_null() { let _ = SafeArrayDestroy(array); }
            let id = format!("r:[{ids}]");
            if let Some(wanted) = &wanted { if wanted != &id { continue; } }
            let pattern: IUIAutomationScrollPattern = element.GetCurrentPatternAs(UIA_ScrollPatternId).unwrap();
            println!("SCROLL_PATTERN id={} horizontal=({},{}) vertical=({},{})",
                id,
                pattern.CurrentHorizontalScrollPercent().unwrap_or(-1.0),
                pattern.CurrentHorizontalViewSize().unwrap_or(-1.0),
                pattern.CurrentVerticalScrollPercent().unwrap_or(-1.0),
                pattern.CurrentVerticalViewSize().unwrap_or(-1.0));
            printed += 1;
            if !all && wanted.is_none() { return; }
        }
        if printed == 0 { println!("SCROLL_PATTERN none"); }
    }
}
