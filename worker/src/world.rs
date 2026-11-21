use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap, VecDeque}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

pub const DEFAULT_LIMIT: usize = 200;
pub const MAX_ELEMENTS: usize = 20_000;
pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const PAGE_BYTES: usize = 60 * 1024;
const MAX_SNAPSHOTS: usize = 12; // concurrent watched windows; total bytes still governed by MAX_STORE_BYTES
const MAX_STORE_BYTES: usize = 16 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct Fault(pub &'static str, pub String);
pub type Result<T> = std::result::Result<T, Fault>;
impl std::fmt::Display for Fault { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.0, self.1) } }
impl std::error::Error for Fault {}
pub fn fault(code: &'static str, message: impl Into<String>) -> Fault { Fault(code, message.into()) }

pub struct Capture { pub hwnd: String, pub observed_at: u128, pub pull_ms: f64, pub model_ms: f64, pub elements: Vec<Value>, /// RuntimeId of the keyboard-focused element at capture time, if any.
    pub focus: Option<Vec<i32>> }
pub fn timestamp() -> Result<u128> { SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis()).map_err(|e| fault("WORKER_UNAVAILABLE", e.to_string())) }

#[derive(Clone, Debug, PartialEq)]
pub struct StableNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub control_type: i64,
    pub confidence: f64,
    pub last_seen: Instant,
    base_confidence: f64,
    pub data: Value,
}
impl StableNode {
    pub fn confidence_at(&self, now: Instant) -> f64 {
        let (seconds, factor): (f64, f64) = match self.control_type {
            50004 | 50007 | 50008 => (2.0, 0.8), // Edit, ListItem, List
            50000 | 50009 | 50010 | 50011 => (10.0, 0.9), // Button/Menu
            _ => (30.0, 0.95),
        };
        self.base_confidence * factor.powf((now.saturating_duration_since(self.last_seen).as_secs_f64() / seconds).floor())
    }
    pub fn json(&self) -> Value {
        let mut data = self.data.clone();
        data["id"] = json!(self.id);
        data["parentId"] = json!(self.parent_id);
        data["confidence"] = json!(self.confidence);
        data
    }
}
#[derive(Debug, Default, PartialEq)]
pub struct Diff { pub added: Vec<Value>, pub updated: Vec<Value>, pub removed: Vec<String> }
impl Diff {
    pub fn json(&self) -> Value { json!({"added":self.added,"updated":self.updated,"removed":self.removed}) }
}
fn runtime_id(value: &Value) -> Result<Option<Vec<i32>>> {
    let Some(value) = value.get("runtimeId").or_else(|| value.get("runtime_id")).filter(|v| !v.is_null()) else { return Ok(None); };
    let values = value.as_array().filter(|a| !a.is_empty() && a.len() <= 64)
        .ok_or_else(|| fault("UIA_ERROR", "Invalid RuntimeId array"))?;
    values.iter().map(|v| v.as_i64().and_then(|v| i32::try_from(v).ok())
        .ok_or_else(|| fault("UIA_ERROR", "Invalid RuntimeId integer"))).collect::<Result<Vec<_>>>().map(Some)
}
fn raw_id(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(|| value.as_u64().map(|n| n.to_string()))
}
fn map_capture(capture: &Capture, now: Instant) -> Result<BTreeMap<String, StableNode>> {
    let mut source = HashMap::new();
    for (index, value) in capture.elements.iter().enumerate() {
        if !value.is_object() { return Err(fault("UIA_ERROR", "Element must be an object")); }
        let key = value.get("id").and_then(raw_id).unwrap_or_else(|| format!("index:{index}"));
        if source.insert(key, index).is_some() { return Err(fault("UIA_ERROR", "Duplicate source ID")); }
    }
    let mut resolved = HashMap::<usize, String>::new();
    let mut next = BTreeMap::new();
    // Iterative parent resolution avoids recursive stack growth on hostile trees.
    while resolved.len() < capture.elements.len() {
        let before = resolved.len();
        for (index, value) in capture.elements.iter().enumerate() {
            if resolved.contains_key(&index) { continue; }
            let parent = match value.get("parentId").or_else(|| value.get("parent_id")).filter(|v| !v.is_null()) {
                None => None,
                Some(parent) => {
                    let key = raw_id(parent).ok_or_else(|| fault("UIA_ERROR", "Invalid parent ID"))?;
                    let parent_index = source.get(&key).ok_or_else(|| fault("UIA_ERROR", "Unknown parent ID"))?;
                    let Some(id) = resolved.get(parent_index) else { continue; };
                    Some(id.clone())
                }
            };
            let control_type = value.get("type").and_then(Value::as_i64).ok_or_else(|| fault("UIA_ERROR", "Missing control type"))?;
            let label = value.get("label").and_then(Value::as_str).ok_or_else(|| fault("UIA_ERROR", "Missing label"))?;
            let id = match runtime_id(value)? {
                Some(id) => format!("r:{}", serde_json::to_string(&id).map_err(|e| fault("UIA_ERROR", e.to_string()))?),
                // Length-delimited JSON tuple is collision-free; ambiguous siblings fail closed.
                None => format!("f:{}", json!([parent, control_type, label])),
            };
            if id.len() > 4096 { return Err(fault("OBSERVATION_LIMIT", "Stable identity exceeds 4096 bytes")); }
            let confidence = value.get("confidence").and_then(Value::as_f64).unwrap_or(1.0);
            if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) { return Err(fault("UIA_ERROR", "Invalid confidence")); }
            let mut data = value.clone();
            for key in ["id", "parentId", "parent_id", "confidence", "observedAt"] { data.as_object_mut().unwrap().remove(key); }
            let node = StableNode { id:id.clone(), parent_id:parent, control_type, confidence, base_confidence:confidence, last_seen:now, data };
            if next.insert(id.clone(), node).is_some() { return Err(fault("AMBIGUOUS_IDENTITY", "Duplicate RuntimeId or indistinguishable fallback siblings")); }
            resolved.insert(index, id);
        }
        if before == resolved.len() { return Err(fault("UIA_ERROR", "Cyclic parent graph")); }
    }
    Ok(next)
}
struct Snapshot { id: String, version: u64, created: Instant, bytes: usize, capture: Capture }
struct Model { nodes: BTreeMap<String, StableNode>, bytes: usize, version: u64, observed_at: u128, focus: Option<Vec<i32>> }
pub struct World { snapshots: VecDeque<Snapshot>, version: u64, epoch: String, models: HashMap<String, Model> }
impl World {
    pub fn new() -> Result<Self> { Ok(Self { snapshots: VecDeque::new(), version:0, epoch:format!("{}-{}", std::process::id(), timestamp()?), models:HashMap::new() }) }
    fn expire(&mut self) { self.snapshots.retain(|s| s.created.elapsed() < TTL); }
    pub fn stable_nodes(&self, hwnd: &str) -> impl Iterator<Item=&StableNode> { self.models.get(hwnd).into_iter().flat_map(|m| m.nodes.values()) }
    /// RuntimeId of a published node, used to re-address it for L1 injection.
    /// Fallback identities have no RuntimeId and therefore cannot be injected into.
    pub fn runtime_id(&self, hwnd: &str, id: &str) -> Option<Vec<i32>> {
        let node = self.models.get(hwnd)?.nodes.get(id)?;
        runtime_id(&node.data).ok().flatten()
    }
    /// Read-only description of one published node for an approval card. The
    /// world is neither captured nor mutated here; an unknown or expired node is
    /// `None`, which the caller must treat as "`no approval may be requested`".
    pub fn describe(&self, hwnd: &str, id: &str) -> Option<Value> {
        let model = self.models.get(hwnd)?;
        let node = model.nodes.get(id)?;
        let window_label = model.nodes.values().find(|n| n.parent_id.is_none())
            .and_then(|n| n.data.get("label")).and_then(Value::as_str).unwrap_or_default();
        let mut out = node.json();
        out["confidence"] = json!(node.confidence_at(Instant::now()));
        out["windowLabel"] = json!(window_label);
        Some(out)
    }
    pub fn decay_confidence(&mut self, hwnd: &str, now: Instant) -> Vec<String> {
        let mut reground = Vec::new();
        if let Some(model) = self.models.get_mut(hwnd) {
            for node in model.nodes.values_mut() {
                node.confidence = node.confidence_at(now);
                if node.confidence < 0.5 { reground.push(node.id.clone()); }
            }
        }
        reground
    }
    pub fn forget(&mut self, hwnd: &str) { self.models.remove(hwnd); }
    /// Keyboard focus must not have moved since the capture that produced this model.
    /// A model without a recorded focus cannot prove the context and is left to the
    /// foreground check; a recorded focus that differs fails closed.
    pub fn focus_matches(&self, hwnd: &str, current: Option<&[i32]>) -> Result<()> {
        let Some(model) = self.models.get(hwnd) else { return Err(fault("STALE_STATE", "No live model for this window; observe again")); };
        match (&model.focus, current) {
            (Some(expected), Some(now)) if expected.as_slice() == now => Ok(()),
            (Some(_), _) => Err(fault("CONTEXT_CHANGED", "Keyboard focus moved since the model was captured; observe again")),
            _ => Ok(()),
        }
    }
    /// A write performed by this worker may legitimately move keyboard focus (an Invoke
    /// gives the button focus). That is not an external context change, so after a
    /// successful action the observed focus becomes the new expectation. Callers must have
    /// verified that the target window is still the foreground window.
    pub fn record_focus(&mut self, hwnd: &str, focus: Option<Vec<i32>>) {
        if let Some(model) = self.models.get_mut(hwnd) { model.focus = focus; }
    }
    /// Read-only worker status: tier reflects the actual capability tier (L2 =
    /// PostMessageW primitives right_click_by_id/wheel_by_id/key are live; L3 =
    /// SendInput keyboard route is permanently sealed) and each live model is listed
    /// with its version, element count and capture time.
    pub fn summary(&self) -> Value {
        let mut hwnds: Vec<&String> = self.models.keys().collect();
        hwnds.sort();
        let worlds: Vec<Value> = hwnds.into_iter().map(|hwnd| {
            let model = &self.models[hwnd];
            json!({"hwnd":hwnd,"version":model.version,"elements":model.nodes.len(),"observedAt":model.observed_at})
        }).collect();
        json!({"tier":"L2","l2":true,"l3":false,"worlds":worlds})
    }
    pub fn commit_diff(&mut self, capture: &Capture) -> Result<Diff> { self.commit(capture, false).map(|(_, diff)| diff) }
    pub fn insert(&mut self, capture: Capture) -> Result<String> { self.publish(capture).map(|(id, _)| id) }
    pub fn publish(&mut self, capture: Capture) -> Result<(String, Diff)> {
        let (capture, diff) = self.commit(&capture, true)?;
        let bytes = serde_json::to_vec(&capture.elements).map_err(|e| fault("OBSERVATION_LIMIT", e.to_string()))?.len();
        self.expire();
        while self.snapshots.len() >= MAX_SNAPSHOTS || self.snapshots.iter().map(|s|s.bytes).sum::<usize>() + bytes > MAX_STORE_BYTES { self.snapshots.pop_front(); }
        let id = format!("{}-{}", self.epoch, self.version);
        self.snapshots.push_back(Snapshot { id:id.clone(), version:self.version, created:Instant::now(), bytes, capture });
        Ok((id, diff))
    }
    fn commit(&mut self, capture: &Capture, snapshot: bool) -> Result<(Capture, Diff)> {
        if capture.elements.len() > MAX_ELEMENTS { return Err(fault("OBSERVATION_LIMIT", "Element limit exceeded")); }
        let version = self.version.checked_add(1).ok_or_else(|| fault("WORKER_UNAVAILABLE", "Version overflow"))?;
        let now = Instant::now();
        let next = map_capture(capture, now)?;
        let elements: Vec<Value> = next.values().map(StableNode::json).map(|mut v| { v["observedAt"] = json!(capture.observed_at); v }).collect();
        let bytes = serde_json::to_vec(&elements).map_err(|e| fault("OBSERVATION_LIMIT", e.to_string()))?.len();
        if bytes > MAX_SNAPSHOT_BYTES { return Err(fault("OBSERVATION_LIMIT", "Snapshot byte limit exceeded")); }
        let other_bytes: usize = self.models.iter().filter(|(h, _)| *h != &capture.hwnd).map(|(_,m)| m.bytes).sum();
        if (!self.models.contains_key(&capture.hwnd) && self.models.len() >= 12) || other_bytes + bytes > MAX_STORE_BYTES {
            return Err(fault("OBSERVATION_LIMIT", "Live model budget exceeded; unwatch old targets"));
        }

        let mut diff = Diff::default();
        let old = self.models.get(&capture.hwnd);
        for (id, node) in &next {
            match old.and_then(|m| m.nodes.get(id)) {
                None => diff.added.push(node.json()),
                Some(old) if old.data != node.data || old.parent_id != node.parent_id || old.confidence_at(now) != node.confidence => diff.updated.push(node.json()),
                _ => {}
            }
        }
        if let Some(old) = old { for id in old.nodes.keys() { if !next.contains_key(id) { diff.removed.push(id.clone()); } } }
        let result = Capture { hwnd:capture.hwnd.clone(), observed_at:capture.observed_at, pull_ms:capture.pull_ms, model_ms:capture.model_ms, elements, focus:capture.focus.clone() };
        // Every validation above precedes the single model replacement.
        let model_version = if snapshot { version } else { self.version };
        self.models.insert(capture.hwnd.clone(), Model { nodes:next, bytes, version:model_version, observed_at:capture.observed_at, focus:capture.focus.clone() });
        if snapshot { self.version = version; }
        Ok((result, diff))
    }
    pub fn page(&mut self, hwnd:&str, id:&str, offset:usize, limit:Option<usize>) -> Result<Value> { let limit=limit.unwrap_or(DEFAULT_LIMIT); if limit==0||limit>DEFAULT_LIMIT{return Err(fault("INVALID_ARGUMENT","limit must be 1..200"));} self.expire(); let s=self.snapshots.iter().find(|s|s.id==id).ok_or_else(||fault("STALE_STATE","Snapshot expired, evicted or unknown"))?; if s.capture.hwnd!=hwnd{return Err(fault("CONTEXT_CHANGED","Snapshot belongs to another HWND"));} let total=s.capture.elements.len(); if offset>total{return Err(fault("INVALID_ARGUMENT","offset exceeds element count"));} let mut end=offset+limit.min(total-offset); loop { let page=json!({"snapshotId":s.id,"version":s.version,"hwnd":s.capture.hwnd,"observedAt":s.capture.observed_at,"complete":true,"totalElements":total,"returnedElements":end-offset,"nextOffset":if end<total{Some(end)}else{None},"pullMs":s.capture.pull_ms,"modelMs":s.capture.model_ms,"observeMs":s.capture.pull_ms+s.capture.model_ms,"elements":&s.capture.elements[offset..end]}); if serde_json::to_vec(&page).map_err(|e|fault("OBSERVATION_LIMIT",e.to_string()))?.len()<=PAGE_BYTES{return Ok(page);} if end<=offset+1{return Err(fault("OBSERVATION_LIMIT","Single element exceeds page budget"));} end-=1; } }
}
#[cfg(test)] mod tests {
    use super::*;
    fn capture(elements: Vec<Value>) -> Capture { Capture { hwnd:"1".into(), observed_at:0, pull_ms:1.0, model_ms:2.0, elements, focus:None } }
    fn node(id: i32, label: &str) -> Value { json!({"id":id.to_string(),"runtime_id":[1,id],"type":50000,"label":label,"enabled":true,"confidence":1.0}) }
    #[test] fn stable_reorder_update_remove_and_window_isolation() {
        let mut w=World::new().unwrap();
        let a=capture(vec![node(1,"a"),node(2,"b")]);
        assert_eq!(w.commit_diff(&a).unwrap().added.len(),2);
        assert_eq!(w.commit_diff(&capture(vec![node(2,"b"),node(1,"a")])).unwrap(),Diff::default());
        let mut b=node(1,"renamed"); b["enabled"]=json!(false);
        let d=w.commit_diff(&capture(vec![b])).unwrap();
        assert_eq!(d.updated.len(),1); assert_eq!(d.removed,vec!["r:[1,2]"]);
        let mut other=capture(vec![node(1,"other window")]); other.hwnd="2".into();
        assert_eq!(w.commit_diff(&other).unwrap().added.len(),1);
        assert_eq!(w.stable_nodes("1").next().unwrap().data["label"],"renamed");
        assert_eq!(w.commit_diff(&capture(vec![])).unwrap().removed.len(),1);
    }
    #[test] fn describe_is_read_only_and_unknown_nodes_are_none() {
        let mut w=World::new().unwrap();
        let mut child=node(2,"ok"); child["parentId"]=json!("1");
        w.commit_diff(&capture(vec![node(1,"win"),child])).unwrap();
        let d=w.describe("1","r:[1,2]").unwrap();
        assert_eq!(d["label"],"ok"); assert_eq!(d["windowLabel"],"win"); assert_eq!(d["parentId"],"r:[1,1]");
        assert!((d["confidence"].as_f64().unwrap()-1.0).abs()<1e-12);
        assert!(w.describe("1","r:[9,9]").is_none()); assert!(w.describe("2","r:[1,1]").is_none());
    }
    #[test] fn fallback_resolves_parents_and_rejects_ambiguity_atomically() {
        let mut w=World::new().unwrap();
        let parent=json!({"id":"p","type":50032,"label":"window"});
        let child=json!({"id":"c","parentId":"p","type":50004,"label":"edit"});
        let c=capture(vec![child.clone(),parent.clone()]);
        let d=w.commit_diff(&c).unwrap(); assert_eq!(d.added.len(),2);
        assert!(w.stable_nodes("1").any(|n| n.parent_id.is_some()));
        let mut duplicate=child.clone(); duplicate["id"]=json!("d");
        assert!(w.commit_diff(&capture(vec![parent.clone(),child.clone(),duplicate])).is_err());
        assert_eq!(w.stable_nodes("1").count(),2);
        let mut bad=parent; bad["runtimeId"]=json!([1,"invalid"]);
        assert!(w.commit_diff(&capture(vec![bad])).is_err());
        assert_eq!(w.commit_diff(&c).unwrap(),Diff::default());
    }
    #[test] fn concurrent_window_budget_is_twelve() {
        let mut w = World::new().unwrap();
        for i in 1..=12i32 {
            let mut c = capture(vec![node(i, "w")]);
            c.hwnd = format!("{i}");
            assert!(w.commit_diff(&c).is_ok(), "window {i} should fit the live-model budget");
        }
        let mut thirteenth = capture(vec![node(13, "w")]);
        thirteenth.hwnd = "13".into();
        let err = w.commit_diff(&thirteenth).unwrap_err();
        assert_eq!(err.0, "OBSERVATION_LIMIT");
        // Re-committing an existing window still fits: it holds its slot.
        let mut again = capture(vec![node(1, "w")]);
        again.hwnd = "1".into();
        assert!(w.commit_diff(&again).is_ok());
    }
    #[test] fn confidence_uses_type_intervals_without_poll_rate_dependence() {
        let now=Instant::now();
        for (kind,secs,factor) in [(50004,2,0.8),(50008,2,0.8),(50000,10,0.9),(50020,30,0.95)] {
            let mut v=node(1,"x");v["type"]=json!(kind);
            let mut nodes=map_capture(&capture(vec![v]),now).unwrap();let n=nodes.values_mut().next().unwrap();
            assert_eq!(n.confidence_at(now+Duration::from_secs(secs-1)),1.0);
            assert!((n.confidence_at(now+Duration::from_secs(secs))-factor).abs()<1e-12);
            n.confidence=n.confidence_at(now+Duration::from_secs(secs));
            assert!((n.confidence_at(now+Duration::from_secs(secs))-factor).abs()<1e-12);
            assert!((n.confidence_at(now+Duration::from_secs(2*secs))-factor*factor).abs()<1e-12);
        }
    }
    #[test] fn paging_eviction_ttl_and_byte_limits() {
        let mut w=World::new().unwrap();let c=||capture((0..250).map(|i|node(i,"x")).collect());
        let first=w.insert(c()).unwrap();let p=w.page("1",&first,0,None).unwrap();
        assert_eq!(p["returnedElements"],200);assert_eq!(w.page("1",&first,200,None).unwrap()["returnedElements"],50);
        assert!(w.page("2",&first,0,None).is_err());assert!(w.page("1",&first,251,None).is_err());assert!(w.page("1",&first,0,Some(0)).is_err());
        for _ in 0..12 { w.insert(c()).unwrap(); } assert!(w.page("1",&first,0,None).is_err());
        let last=w.snapshots.back_mut().unwrap(); let id=last.id.clone();last.created=Instant::now()-TTL;assert!(w.page("1",&id,0,None).is_err());
        let mut oversized=node(1,"x");oversized["label"]=json!("x".repeat(MAX_SNAPSHOT_BYTES));
        let version=w.version;assert!(w.insert(capture(vec![oversized])).is_err());assert_eq!(version,w.version);
        let id=w.insert(capture((0..200).map(|i|node(i,&"中".repeat(200))).collect())).unwrap();
        let p=w.page("1",&id,0,None).unwrap();assert!(p["returnedElements"].as_u64().unwrap()<200);assert!(p.to_string().len()<=PAGE_BYTES);
    }
}
