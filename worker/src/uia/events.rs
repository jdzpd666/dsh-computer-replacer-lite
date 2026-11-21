use std::sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{sync_channel, Receiver, SyncSender, TrySendError}};
use windows::{core::{implement, Ref, Result}, Win32::{System::{Com::SAFEARRAY, Ole::{SafeArrayGetDim, SafeArrayGetVartype, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayGetElement}, Variant::{VARIANT, VT_I4}}, UI::Accessibility::*}};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum EventKind { Structure(i32), Property, Focus }

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Event {
    pub kind: EventKind,
    pub hwnd: Option<String>,
    pub runtime_id: Option<Vec<i32>>,
    pub property_id: Option<i32>,
}

#[derive(Clone)]
pub struct Sink { tx: SyncSender<Event>, overflow: Arc<AtomicBool> }
pub struct Inbox { pub rx: Receiver<Event>, overflow: Arc<AtomicBool> }

pub fn channel(capacity: usize) -> (Sink, Inbox) {
    let (tx, rx) = sync_channel(capacity);
    let overflow = Arc::new(AtomicBool::new(false));
    (Sink { tx, overflow: overflow.clone() }, Inbox { rx, overflow })
}
impl Sink {
    pub fn push(&self, event: Event) {
        if let Err(TrySendError::Full(_)) = self.tx.try_send(event) {
            self.overflow.store(true, Ordering::Release);
        }
    }
}
impl Inbox { pub fn take_overflow(&self) -> bool { self.overflow.swap(false, Ordering::AcqRel) } }

// SAFEARRAY is borrowed for the duration of the callback. Copy only bounded VT_I4 data;
// never destroy or retain the provider-owned array.
pub unsafe fn runtime_id(array: *const SAFEARRAY) -> Option<Vec<i32>> {
    if array.is_null() || SafeArrayGetDim(array) != 1 || SafeArrayGetVartype(array).ok()? != VT_I4 { return None; }
    let lo = SafeArrayGetLBound(array, 1).ok()?;
    let hi = SafeArrayGetUBound(array, 1).ok()?;
    let len = i64::from(hi) - i64::from(lo) + 1;
    if !(1..=64).contains(&len) { return None; }
    let mut result = Vec::with_capacity(len as usize);
    for index in lo..=hi {
        let mut value = 0i32;
        SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast()).ok()?;
        result.push(value);
    }
    Some(result)
}

#[implement(IUIAutomationStructureChangedEventHandler, IUIAutomationPropertyChangedEventHandler, IUIAutomationFocusChangedEventHandler)]
pub struct Callbacks { pub sink: Sink }

impl IUIAutomationStructureChangedEventHandler_Impl for Callbacks_Impl {
    fn HandleStructureChangedEvent(&self, _: Ref<'_, IUIAutomationElement>, kind: StructureChangeType, array: *const SAFEARRAY) -> Result<()> {
        self.sink.push(Event { kind: EventKind::Structure(kind.0), hwnd: None, runtime_id: unsafe { runtime_id(array) }, property_id: None });
        Ok(())
    }
}
impl IUIAutomationPropertyChangedEventHandler_Impl for Callbacks_Impl {
    fn HandlePropertyChangedEvent(&self, _: Ref<'_, IUIAutomationElement>, property: UIA_PROPERTY_ID, _: &VARIANT) -> Result<()> {
        self.sink.push(Event { kind: EventKind::Property, hwnd: None, runtime_id: None, property_id: Some(property.0) });
        Ok(())
    }
}
impl IUIAutomationFocusChangedEventHandler_Impl for Callbacks_Impl {
    fn HandleFocusChangedEvent(&self, _: Ref<'_, IUIAutomationElement>) -> Result<()> {
        self.sink.push(Event { kind: EventKind::Focus, hwnd: None, runtime_id: None, property_id: None });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event() -> Event { Event { kind: EventKind::Focus, hwnd: None, runtime_id: None, property_id: None } }
    #[test] fn overflow_is_sticky_and_bounded() {
        let (sink, inbox) = channel(1); sink.push(event()); sink.push(event());
        assert!(inbox.take_overflow()); assert!(!inbox.take_overflow());
        assert_eq!(inbox.rx.try_recv().unwrap(), event()); assert!(inbox.rx.try_recv().is_err());
    }
    #[test] fn callbacks_accept_null_sender() {
        use windows::core::Interface;
        let (sink, inbox) = channel(4);
        let structure: IUIAutomationStructureChangedEventHandler = Callbacks { sink }.into();
        let property: IUIAutomationPropertyChangedEventHandler = structure.cast().unwrap();
        let focus: IUIAutomationFocusChangedEventHandler = structure.cast().unwrap();
        unsafe {
            structure.HandleStructureChangedEvent(None, StructureChangeType_ChildAdded, std::ptr::null()).unwrap();
            property.HandlePropertyChangedEvent(None, UIA_NamePropertyId, &VARIANT::default()).unwrap();
            focus.HandleFocusChangedEvent(None).unwrap();
        }
        for _ in 0..3 {
            let e = inbox.rx.try_recv().unwrap();
            assert!(e.hwnd.is_none()); assert!(e.runtime_id.is_none());
        }
    }
    #[test] fn missing_identity_is_unknown() { assert_eq!(unsafe { runtime_id(std::ptr::null()) }, None); }
}
