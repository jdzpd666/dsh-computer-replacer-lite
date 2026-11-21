use crate::world::{fault, timestamp, Capture, Result, MAX_ELEMENTS, MAX_SNAPSHOT_BYTES};
pub mod events;
use serde_json::{json, Value};
use std::{marker::PhantomData, rc::Rc, time::Instant};
use windows::{core::Interface, Win32::{
    Foundation::HWND,
    System::{Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
        Variant::{VariantClear, VariantToBoolean}},
    UI::{Accessibility::*, WindowsAndMessaging::IsWindow},
}};

// GetRuntimeId returns a query-owned array; callback arrays remain borrowed.
unsafe fn element_runtime_id(element: &IUIAutomationElement) -> Result<Option<Vec<i32>>> {
    let array = element.GetRuntimeId().map_err(provider)?;
    let id = events::runtime_id(array);
    if !array.is_null() { windows::Win32::System::Ole::SafeArrayDestroy(array).map_err(provider)?; }
    Ok(id)
}

unsafe fn invoke_available(element: &IUIAutomationElement) -> Result<bool> {
    let mut variant = match element.GetCachedPropertyValueEx(UIA_IsInvokePatternAvailablePropertyId, false) {
        Ok(variant) => variant,
        Err(_) => element.GetCurrentPropertyValueEx(UIA_IsInvokePatternAvailablePropertyId, false).map_err(provider)?,
    };
    let available = VariantToBoolean(&variant);
    let cleared = VariantClear(&mut variant);
    let value = available.map_err(provider)?.as_bool();
    cleared.map_err(provider)?;
    Ok(value)
}

// !Send/!Sync: create, use and drop COM objects on the owning MTA thread.
struct Apartment(PhantomData<Rc<()>>);
impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
pub struct Uia { automation: IUIAutomation, _apartment: Apartment }
fn provider(e: windows::core::Error) -> crate::world::Fault { fault("UIA_ERROR", format!("{e}")) }
impl Uia {

    /// Read-only facts for one element: identity, control type, exact name,
    /// bounds and pattern availability. Never publishes a world snapshot and
    /// never mutates the target; the caller builds an approval card from it.
    pub fn element_facts(&self, element: &IUIAutomationElement) -> Result<Value> {
        unsafe {
            let rect = element
                .CachedBoundingRectangle()
                .or_else(|_| element.CurrentBoundingRectangle())
                .unwrap_or_default();
            let label = element
                .CachedName()
                .map(|name| name.to_string())
                .or_else(|_| element.CurrentName().map(|name| name.to_string()))
                .unwrap_or_default();
            let control_type = element
                .CachedControlType()
                .map(|value| value.0)
                .or_else(|_| element.CurrentControlType().map(|value| value.0))
                .unwrap_or(0);
            let enabled = element
                .CachedIsEnabled()
                .map(|value| value.as_bool())
                .or_else(|_| element.CurrentIsEnabled().map(|value| value.as_bool()))
                .unwrap_or(true);
            let offscreen = element
                .CachedIsOffscreen()
                .map(|value| value.as_bool())
                .or_else(|_| element.CurrentIsOffscreen().map(|value| value.as_bool()))
                .unwrap_or(false);
            Ok(json!({
                "runtimeId": element_runtime_id(element)?,
                "type": control_type,
                "label": label,
                "bbox": {
                    "x": rect.left,
                    "y": rect.top,
                    "width": i64::from(rect.right) - i64::from(rect.left),
                    "height": i64::from(rect.bottom) - i64::from(rect.top),
                },
                "enabled": enabled,
                "offscreen": offscreen,
                "invokable": invoke_available(element).unwrap_or(false),
            }))
        }
    }

    /// Exact-name lookup scoped to one window subtree.
    ///
    /// CreatePropertyCondition needs a hand-built VARIANT (the windows crate
    /// exposes no safe constructor here), so this caches only UIA_NamePropertyId
    /// and scans the ControlView instead. Returns the first exact match plus the
    /// number of matches so the caller can fail closed on ambiguity.
    pub fn find_by_label(&self, hwnd: &str, label: &str) -> Result<(IUIAutomationElement, usize)> {
        if label.is_empty() || label.chars().count() > 512 || label.chars().any(|character| character.is_control()) {
            return Err(fault("INVALID_ARGUMENT", "label must contain 1..512 characters and no control characters"));
        }
        let handle = window_handle(hwnd)?;
        unsafe {
            if !IsWindow(Some(handle)).as_bool() {
                return Err(fault("STALE_STATE", "Window no longer exists"));
            }
            let request = self.automation.CreateCacheRequest().map_err(provider)?;
            request.SetTreeScope(TreeScope_Element).map_err(provider)?;
            request.SetTreeFilter(&self.automation.ControlViewCondition().map_err(provider)?).map_err(provider)?;
            request.AddProperty(UIA_NamePropertyId).map_err(provider)?;
            let target = self.automation.ElementFromHandle(handle).map_err(provider)?;
            let condition = self.automation.CreateTrueCondition().map_err(provider)?;
            let nodes = target.FindAllBuildCache(TreeScope_Subtree, &condition, &request).map_err(provider)?;
            let count = nodes.Length().map_err(provider)?;
            if count as usize > MAX_ELEMENTS {
                return Err(fault("OBSERVATION_LIMIT", "Too many elements to search; observe the window and use a runtimeId"));
            }
            let mut chosen: Option<IUIAutomationElement> = None;
            let mut matches = 0usize;
            for index in 0..count {
                let Ok(element) = nodes.GetElement(index) else { continue };
                let name = element
                    .CachedName()
                    .map(|name| name.to_string())
                    .or_else(|_| element.CurrentName().map(|name| name.to_string()))
                    .unwrap_or_default();
                if name == label {
                    matches += 1;
                    if chosen.is_none() {
                        chosen = Some(element);
                    }
                }
            }
            match chosen {
                Some(element) => Ok((element, matches)),
                None => Err(fault("ELEMENT_NOT_INVOKABLE", format!("No element named {label:?} exists in this window"))),
            }
        }
    }

    pub fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(provider)?;
            let apartment = Apartment(PhantomData);
            let automation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(provider)?;
            Ok(Self { automation, _apartment: apartment })
        }
    }
    pub fn observe(&self, hwnd: &str) -> Result<Capture> {
        let value = hwnd.parse::<usize>().map_err(|_| fault("INVALID_ARGUMENT", "hwnd must be a decimal integer string"))?;
        if value == 0 { return Err(fault("INVALID_ARGUMENT", "Null HWND")); }
        let handle = HWND(value as *mut std::ffi::c_void);
        unsafe {
            if !IsWindow(Some(handle)).as_bool() { return Err(fault("INVALID_ARGUMENT", "HWND is not a window")); }
            let observed_at = timestamp()?;
            let start = Instant::now();
            let request = self.automation.CreateCacheRequest().map_err(provider)?;
            request.SetTreeScope(TreeScope_Element).map_err(provider)?;
            request.SetTreeFilter(&self.automation.ControlViewCondition().map_err(provider)?).map_err(provider)?;
            for property in [UIA_RuntimeIdPropertyId, UIA_ControlTypePropertyId, UIA_NamePropertyId,
                UIA_BoundingRectanglePropertyId, UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId,
                UIA_IsInvokePatternAvailablePropertyId] {
                request.AddProperty(property).map_err(provider)?;
            }
            let target = self.automation.ElementFromHandle(handle).map_err(provider)?;
            let condition = self.automation.CreateTrueCondition().map_err(provider)?;
            let nodes = target.FindAllBuildCache(TreeScope_Subtree, &condition, &request).map_err(provider)?;
            let count = nodes.Length().map_err(provider)?;
            if count <= 0 { return Err(fault("UIA_ERROR", "Target disappeared; no elements returned")); }
            if count as usize > MAX_ELEMENTS { return Err(fault("OBSERVATION_LIMIT", "Element limit exceeded; no snapshot published")); }
            let pull_ms = start.elapsed().as_secs_f64()*1000.0;
            let model_start = Instant::now();
            let mut elements = Vec::with_capacity(count as usize);
            let walker = self.automation.RawViewWalker().map_err(provider)?;
            let mut bytes = 2usize;
            for id in 0..count {
                // One unreadable element must not destroy the whole snapshot: the cache
                // returns null interfaces for some providers and Task Manager's XAML tree
                // is one of them. Properties fall back to the current-view getters.
                let element = match nodes.GetElement(id) { Ok(element) => element, Err(_) => continue };
                let rect = element.CachedBoundingRectangle()
                    .or_else(|_| element.CurrentBoundingRectangle())
                    .unwrap_or_default();
                let control_type = element.CachedControlType().map(|value| value.0)
                    .or_else(|_| element.CurrentControlType().map(|value| value.0))
                    .unwrap_or(0);
                let label = element.CachedName().map(|name| name.to_string())
                    .or_else(|_| element.CurrentName().map(|name| name.to_string()))
                    .unwrap_or_default();
                let enabled = element.CachedIsEnabled().map(|value| value.as_bool())
                    .or_else(|_| element.CurrentIsEnabled().map(|value| value.as_bool()))
                    .unwrap_or(true);
                let offscreen = element.CachedIsOffscreen().map(|value| value.as_bool())
                    .or_else(|_| element.CurrentIsOffscreen().map(|value| value.as_bool()))
                    .unwrap_or(false);
                let invokable = invoke_available(&element).unwrap_or(false);
                // Parents are advisory identity links: the walker returns a null interface at
                // window roots and provider boundaries, and control-view filtering can hide an
                // ancestor. Both are normal, so a missing parent leaves parentId null.
                let parent = if id == 0 { None } else {
                    walker.GetParentElement(&element).ok().and_then(|parent| element_runtime_id(&parent).ok().flatten())
                };
                let node = json!({
                    "id":id.to_string(), "parentId":null,
                    "runtimeId":element_runtime_id(&element).unwrap_or(None),
                    "parentRuntimeId":parent,
                    "type":control_type,
                    "label":label,
                    "bbox":{"x":rect.left,"y":rect.top,"width":i64::from(rect.right)-i64::from(rect.left),"height":i64::from(rect.bottom)-i64::from(rect.top)},
                    "enabled":enabled,"offscreen":offscreen,
                    "invokable":invokable,"confidence":1.0,"observedAt":observed_at
                });
                bytes += serde_json::to_vec(&node).map_err(|e| fault("UIA_ERROR", e.to_string()))?.len()+1;
                if bytes > MAX_SNAPSHOT_BYTES { return Err(fault("OBSERVATION_LIMIT", "Model byte limit exceeded")); }
                elements.push(node);
            }
            let identities: std::collections::HashMap<String, String> = elements.iter().filter_map(|v| {
                v.get("runtimeId").filter(|v| !v.is_null()).map(|rid| (rid.to_string(), v["id"].as_str().unwrap_or("").to_owned()))
            }).collect();
            for node in &mut elements {
                if let Some(parent) = node.get("parentRuntimeId").filter(|v| !v.is_null()) {
                    let mapped = identities.get(&parent.to_string()).map(|id| json!(id)).unwrap_or(Value::Null);
                    node["parentId"] = mapped;
                }
                node.as_object_mut().unwrap().remove("parentRuntimeId");
            }
            if !IsWindow(Some(handle)).as_bool() { return Err(fault("CONTEXT_CHANGED", "Window closed during capture")); }
            let focus = self.focused_runtime_id().unwrap_or(None);
            Ok(Capture { hwnd:value.to_string(), observed_at, pull_ms,
                model_ms:model_start.elapsed().as_secs_f64()*1000.0, elements, focus })
        }
    }
}

impl Uia {
    /// RuntimeId of the element that currently owns keyboard focus, if the
    /// provider reports one. Read-only; never focuses anything.
    pub fn focused_runtime_id(&self) -> Result<Option<Vec<i32>>> {
        unsafe {
            let element = self.automation.GetFocusedElement().map_err(provider)?;
            element_runtime_id(&element)
        }
    }
    /// Read-only list of top-level windows. No focus change, no input.
    pub fn top_level_windows(&self) -> Result<Vec<Value>> {
        use serde_json::json;
        unsafe {
            let root = self.automation.GetRootElement().map_err(provider)?;
            let request = self.automation.CreateCacheRequest().map_err(provider)?;
            // Cache scope is the requested element itself; the find scope below decides which
            // elements come back. With a Children cache scope UIA caches nothing for the
            // returned children and every cached read fails as E_INVALIDARG (0x80070057).
            request.SetTreeScope(TreeScope_Element).map_err(provider)?;
            request.SetTreeFilter(&self.automation.ControlViewCondition().map_err(provider)?).map_err(provider)?;
            for property in [UIA_NativeWindowHandlePropertyId, UIA_ControlTypePropertyId, UIA_NamePropertyId,
                UIA_BoundingRectanglePropertyId, UIA_IsOffscreenPropertyId, UIA_IsEnabledPropertyId] {
                request.AddProperty(property).map_err(provider)?;
            }
            let condition = self.automation.CreateTrueCondition().map_err(provider)?;
            let nodes = root.FindAllBuildCache(TreeScope_Children, &condition, &request).map_err(provider)?;
            let count = nodes.Length().map_err(provider)?;
            if count as usize > MAX_ELEMENTS { return Err(fault("OBSERVATION_LIMIT", "Too many top-level windows")); }
            let mut windows = Vec::new();
            for index in 0..count {
                let element = nodes.GetElement(index).map_err(provider)?;
                let handle = element.CachedNativeWindowHandle().map_err(provider)?;
                if handle.0.is_null() { continue; }
                let rect = element.CachedBoundingRectangle().map_err(provider)?;
                windows.push(json!({
                    "hwnd":(handle.0 as usize).to_string(),
                    "label":element.CachedName().map_err(provider)?.to_string(),
                    "type":element.CachedControlType().map_err(provider)?.0,
                    "bbox":{"x":rect.left,"y":rect.top,"width":i64::from(rect.right)-i64::from(rect.left),"height":i64::from(rect.bottom)-i64::from(rect.top)},
                    "enabled":element.CachedIsEnabled().map_err(provider)?.as_bool(),
                    "offscreen":element.CachedIsOffscreen().map_err(provider)?.as_bool()
                }));
            }
            Ok(windows)
        }
    }
    /// Re-addresses a world-model node inside its window by UIA RuntimeId.
    ///
    /// The lookup is read-only and does not move focus; a vanished window or identity
    /// fails as STALE_STATE so no injection target is guessed.
    pub fn element(&self, hwnd: &str, runtime_id: &[i32]) -> Result<IUIAutomationElement> {
        if runtime_id.is_empty() || runtime_id.len() > 64 { return Err(fault("ELEMENT_NOT_INVOKABLE", "Invalid RuntimeId")); }
        let handle = window_handle(hwnd)?;
        unsafe {
            if !IsWindow(Some(handle)).as_bool() { return Err(fault("STALE_STATE", "Window no longer exists")); }
            let request = self.automation.CreateCacheRequest().map_err(provider)?;
            request.SetTreeScope(TreeScope_Element).map_err(provider)?;
            request.SetTreeFilter(&self.automation.ControlViewCondition().map_err(provider)?).map_err(provider)?;
            request.AddProperty(UIA_RuntimeIdPropertyId).map_err(provider)?;
            let target = self.automation.ElementFromHandle(handle).map_err(provider)?;
            let condition = self.automation.CreateTrueCondition().map_err(provider)?;
            let nodes = target.FindAllBuildCache(TreeScope_Subtree, &condition, &request).map_err(provider)?;
            for index in 0..nodes.Length().map_err(provider)? {
                let element = nodes.GetElement(index).map_err(provider)?;
                if element_runtime_id(&element)?.as_deref() == Some(runtime_id) { return Ok(element); }
            }
            Err(fault("STALE_STATE", "Element RuntimeId is no longer present; observe again"))
        }
    }
}

fn window_handle(hwnd: &str) -> Result<HWND> {
    if hwnd.is_empty() || hwnd.len() > 20 || !hwnd.bytes().all(|b| b.is_ascii_digit()) {
        return Err(fault("INVALID_ARGUMENT", "Invalid HWND"));
    }
    hwnd.parse::<usize>().ok().filter(|value| *value != 0)
        .map(|value| HWND(value as *mut std::ffi::c_void))
        .ok_or_else(|| fault("INVALID_ARGUMENT", "HWND outside supported range"))
}

pub struct Subscription<'a> {
    owner: &'a Uia,
    target: IUIAutomationElement,
    structure: IUIAutomationStructureChangedEventHandler,
    property: IUIAutomationPropertyChangedEventHandler,
    focus: IUIAutomationFocusChangedEventHandler,
    registered: [bool; 3],
}
impl Subscription<'_> {
    pub fn close(&mut self) -> Result<()> {
        let mut first = None;
        unsafe {
            // Attempt every removal even if one fails; retain failed flags for Drop retry.
            for index in (0..3).rev() {
                if !self.registered[index] { continue; }
                let result = match index {
                    0 => self.owner.automation.RemoveStructureChangedEventHandler(&self.target, &self.structure),
                    1 => self.owner.automation.RemovePropertyChangedEventHandler(&self.target, &self.property),
                    _ => self.owner.automation.RemoveFocusChangedEventHandler(&self.focus),
                };
                match result {
                    Ok(()) => self.registered[index] = false,
                    Err(e) => { if first.is_none() { first = Some(provider(e)); } }
                }
            }
        }
        first.map_or(Ok(()), Err)
    }
}
impl Drop for Subscription<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("UIA subscription cleanup failed: {error}");
        }
    }
}
impl Uia {
    pub fn subscribe(&self, hwnd: &str, sink: events::Sink) -> Result<Subscription<'_>> {
        let value = if !hwnd.is_empty() && hwnd.len() <= 20 && hwnd.bytes().all(|b| b.is_ascii_digit()) {
            hwnd.parse::<usize>().ok().filter(|v| *v != 0)
        } else { None }.ok_or_else(|| fault("INVALID_ARGUMENT", "Invalid HWND"))?;
        unsafe {
            let handle = HWND(value as *mut std::ffi::c_void);
            if !IsWindow(Some(handle)).as_bool() { return Err(fault("INVALID_ARGUMENT", "HWND is not a window")); }
            let target = self.automation.ElementFromHandle(handle).map_err(provider)?;
            let cache = self.automation.CreateCacheRequest().map_err(provider)?;
            cache.SetTreeScope(TreeScope_Subtree).map_err(provider)?;
            cache.SetTreeFilter(&self.automation.RawViewCondition().map_err(provider)?).map_err(provider)?;
            for id in [UIA_RuntimeIdPropertyId, UIA_NativeWindowHandlePropertyId] {
                cache.AddProperty(id).map_err(provider)?;
            }
            let structure: IUIAutomationStructureChangedEventHandler = events::Callbacks { sink }.into();
            let property = structure.cast().map_err(provider)?;
            let focus = structure.cast().map_err(provider)?;
            let mut guard = Subscription { owner: self, target, structure, property, focus, registered: [false; 3] };
            self.automation.AddStructureChangedEventHandler(&guard.target, TreeScope_Subtree, &cache, &guard.structure).map_err(provider)?;
            guard.registered[0] = true;
            // Exclude SAFEARRAY-valued properties (BoundingRectangle/RuntimeId) from event delivery.
            // RuntimeId comes from StructureChanged payloads, not property callbacks.
            self.automation.AddPropertyChangedEventHandlerNativeArray(&guard.target, TreeScope_Subtree, &cache, &guard.property,
                &[UIA_NamePropertyId, UIA_IsEnabledPropertyId,
                  UIA_IsOffscreenPropertyId, UIA_ControlTypePropertyId, UIA_IsInvokePatternAvailablePropertyId]).map_err(provider)?;
            guard.registered[1] = true;
            // UIA focus registration is global, not HWND-scoped. Routing remains conservative.
            self.automation.AddFocusChangedEventHandler(&cache, &guard.focus).map_err(provider)?;
            guard.registered[2] = true;
            Ok(guard)
        }
    }
}
