use windows::{core::Result, Win32::{System::Com::*, UI::Accessibility::*}};
fn main() -> Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let result = (|| -> Result<()> {
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let root = uia.GetRootElement()?;
            println!("UIA_PROBE_OK control_type={}", root.CurrentControlType()?.0);
            Ok(())
        })();
        CoUninitialize();
        result
    }
}
