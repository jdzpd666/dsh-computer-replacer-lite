//! Diagnostic: read every cached property of root children and report the exact failure.
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, COINIT_MULTITHREADED, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::*;

fn main() {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).unwrap();
        let root = automation.GetRootElement().unwrap();
        let request = automation.CreateCacheRequest().unwrap();
        request.SetTreeScope(TreeScope_Element).unwrap();
        request.SetTreeFilter(&automation.ControlViewCondition().unwrap()).unwrap();
        let props = [
            (UIA_NativeWindowHandlePropertyId, "NativeWindowHandle"),
            (UIA_ControlTypePropertyId, "ControlType"),
            (UIA_NamePropertyId, "Name"),
            (UIA_BoundingRectanglePropertyId, "BoundingRectangle"),
            (UIA_IsOffscreenPropertyId, "IsOffscreen"),
            (UIA_IsEnabledPropertyId, "IsEnabled"),
        ];
        for (id, name) in props { if let Err(e) = request.AddProperty(id) { println!("add {name} failed: {e}"); } }
        let condition = automation.CreateTrueCondition().unwrap();
        let nodes = root.FindAllBuildCache(TreeScope_Children, &condition, &request).unwrap();
        let count = nodes.Length().unwrap();
        println!("children={count}");
        for index in 0..count {
            let element = nodes.GetElement(index).unwrap();
            let mut line = format!("[{index}]");
            match element.CachedNativeWindowHandle() { Ok(h) => line += &format!(" hwnd={:?}", h.0), Err(e) => line += &format!(" HWND_FAIL={e}") }
            match element.CachedControlType() { Ok(t) => line += &format!(" type={}", t.0), Err(e) => line += &format!(" TYPE_FAIL={e}") }
            match element.CachedName() { Ok(n) => line += &format!(" name={n:?}"), Err(e) => line += &format!(" NAME_FAIL={e}") }
            match element.CachedBoundingRectangle() { Ok(r) => line += &format!(" rect={},{},{}x{}", r.left, r.top, r.right - r.left, r.bottom - r.top), Err(e) => line += &format!(" RECT_FAIL={e}") }
            match element.CachedIsEnabled() { Ok(b) => line += &format!(" enabled={}", b.as_bool()), Err(e) => line += &format!(" ENABLED_FAIL={e}") }
            match element.CachedIsOffscreen() { Ok(b) => line += &format!(" offscreen={}", b.as_bool()), Err(e) => line += &format!(" OFFSCREEN_FAIL={e}") }
            println!("{line}");
        }
    }
}
