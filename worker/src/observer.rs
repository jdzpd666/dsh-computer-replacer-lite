use crate::{uia::{Uia, events::{Inbox, Event}}, world::{fault, Fault}};
use std::sync::{Mutex, MutexGuard};
use std::{collections::{HashSet, HashMap}, sync::mpsc::{self, Receiver, SyncSender, TryRecvError}, thread::{self, JoinHandle}, time::{Duration, Instant}};

pub fn update(
    world: &mut crate::world::World, capture: crate::world::Capture,
) -> Result<(String, crate::world::Diff), Fault> {
    world.decay_confidence(&capture.hwnd, Instant::now());
    world.publish(capture)
}

const BATCH: Duration = Duration::from_millis(30);
const SILENCE: Duration = Duration::from_secs(3);

/// Serializes every UIA write against every read-side tree walk.
///
/// A write holds the gate from before its own full-tree resolve until the
/// provider call has returned and the target window had time to settle. Readers
/// try-lock and fail fast with INJECTION_BUSY instead of nesting a second UIA
/// call inside a provider that is still servicing an Invoke - that re-entrancy
/// is the known cause of "the window flashes but the click does nothing".
pub struct InjectionGate {
    busy: Mutex<()>,
}

impl InjectionGate {
    pub fn new() -> Self {
        Self { busy: Mutex::new(()) }
    }

    /// Write path: waits for an in-flight read to finish, then owns the tree.
    pub fn enter(&self) -> MutexGuard<'_, ()> {
        self.busy.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    /// Read path: never waits. None means an injection currently owns the tree.
    pub fn try_enter(&self) -> Option<MutexGuard<'_, ()>> {
        match self.busy.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(poison)) => Some(poison.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }
}

pub enum Command {
    Watch { hwnd: String, reply: SyncSender<Result<(), Fault>> },
    Unwatch { hwnd: String, reply: SyncSender<Result<(), Fault>> },
    Stop,
}
pub struct Batch {
    pub hwnd: Option<String>,
    pub events: HashSet<Event>,
    pub full_verify: bool,
}
pub struct Schedule {
    events: HashSet<Event>,
    batch_due: Option<Instant>,
    quiet_due: Instant,
    overflow: bool,
}
impl Schedule {
    pub fn new(now: Instant) -> Self {
        Self { events: HashSet::new(), batch_due: None, quiet_due: now + SILENCE, overflow: false }
    }
    pub fn event(&mut self, event: Event, now: Instant) {
        self.events.insert(event);
        self.batch_due.get_or_insert(now + BATCH);
        self.quiet_due = now + SILENCE;
    }
    pub fn overflow(&mut self) { self.overflow = true; }
    pub fn take_due(&mut self, now: Instant) -> Option<Batch> {
        let quiet = now >= self.quiet_due;
        if !self.overflow && !quiet && !self.batch_due.is_some_and(|due| now >= due) { return None; }
        self.batch_due = None;
        if quiet { self.quiet_due = now + SILENCE; }
        // Step one has no stable node identity: all events conservatively invalidate.
        self.overflow = false;
        Some(Batch { hwnd: None, events: std::mem::take(&mut self.events), full_verify: true })
    }
}

// Factory and state execute ONLY on the owning MTA thread. Returned state need not be Send.
// Step two supplies subscription guards, World and dirty-target handling through these seams.
// COM callbacks themselves may arrive on UIA threads; only their plain events cross threads.
pub fn spawn(
    inbox: Inbox,
    update: impl FnMut(Batch) -> Result<(), Fault> + Send + 'static,
) -> (SyncSender<Command>, JoinHandle<Result<(), Fault>>) {
    let (tx, rx) = mpsc::sync_channel(128);
    let join = thread::spawn(move || {
        let result = contain_unwind(|| run(rx, inbox, update));
        if let Err(error) = &result { eprintln!("OBSERVER_STOP: {}: {}", error.0, error.1); }
        result
    });
    (tx, join)
}
// Stop after unwind; never resume partially mutated subscription state.
fn contain_unwind(action: impl FnOnce() -> Result<(), Fault>) -> Result<(), Fault> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(action)) {
        Ok(result) => result,
        Err(payload) => {
            let message = payload.downcast_ref::<String>().map(String::as_str)
                .or_else(|| payload.downcast_ref::<&str>().copied())
                .unwrap_or("non-string panic payload");
            Err(fault("OBSERVER_PANIC", message))
        }
    }
}

#[test]
fn unwind_boundary_preserves_errors_and_stops_panics() {
    assert!(contain_unwind(|| Ok(())).is_ok());
    assert_eq!(contain_unwind(|| Err(fault("TEST", "original"))).unwrap_err().0, "TEST");
    let error = contain_unwind(|| panic!("probe panic")).unwrap_err();
    assert_eq!(error.0, "OBSERVER_PANIC");
    assert_eq!(error.1, "probe panic");
}

fn run(
    commands: Receiver<Command>, inbox: Inbox,
    mut update: impl FnMut(Batch) -> Result<(), Fault>,
) -> Result<(), Fault> {
    let uia = Uia::new()?;
    let mut schedule = Schedule::new(Instant::now());
    let mut watches: HashMap<String, (crate::uia::Subscription<'_>, Inbox, Schedule)> = HashMap::new();
    loop {
        // Bound draining so continuous event traffic cannot starve deadlines or commands.
        for _ in 0..256 {
            match inbox.rx.try_recv() {
                Ok(event) => schedule.event(event, Instant::now()),
                Err(_) => break,
            }
        }
        if inbox.take_overflow() { schedule.overflow(); }
        if let Some(batch) = schedule.take_due(Instant::now()) {
            update(batch)?;
        }
        for (hwnd, (guard, inbox, timer)) in &mut watches {
            let _ = guard;
            let inbox: &mut Inbox = inbox;
            let timer: &mut Schedule = timer;
            for _ in 0..256 {
                match inbox.rx.try_recv() {
                    Ok(event) => timer.event(event, Instant::now()),
                    Err(_) => break,
                }
            }
            if inbox.take_overflow() { timer.overflow(); }
            if let Some(mut batch) = timer.take_due(Instant::now()) {
                batch.hwnd = Some(hwnd.clone());
                update(batch)?;
            }
        }
        match commands.try_recv() {
            Ok(Command::Stop) | Err(TryRecvError::Disconnected) => return Ok(()),
            Ok(Command::Watch { hwnd, reply }) => {
                let result = canonical(&hwnd).and_then(|hwnd| {
                    if watches.contains_key(&hwnd) { return Ok(()); }
                    if watches.len() >= 12 { return Err(fault("OBSERVATION_LIMIT", "At most twelve watches; unwatch old targets")); }
                    let (sink, inbox) = crate::uia::events::channel(1024);
                    let guard = uia.subscribe(&hwnd, sink)?;
                    watches.insert(hwnd, (guard, inbox, Schedule::new(Instant::now())));
                    Ok(())
                });
                let _ = reply.try_send(result);
            }
            Ok(Command::Unwatch { hwnd, reply }) => {
                let result = canonical(&hwnd).and_then(|hwnd| {
                    if let Some((guard, _, _)) = watches.get_mut(&hwnd) { guard.close()?; }
                    watches.remove(&hwnd);
                    Ok(())
                });
                let _ = reply.try_send(result);
            }
            Err(TryRecvError::Empty) => {
                // Scheduling resolution only; not a guarantee of provider completion latency.
                thread::park_timeout(Duration::from_millis(2));
            }
        }
    }
}
fn canonical(hwnd: &str) -> Result<String, Fault> {
    if hwnd.is_empty() || hwnd.len() > 20 || !hwnd.bytes().all(|b| b.is_ascii_digit()) {
        return Err(fault("INVALID_ARGUMENT", "Invalid HWND"));
    }
    hwnd.parse::<usize>().ok().filter(|n| *n != 0).map(|n| n.to_string())
        .ok_or_else(|| fault("INVALID_ARGUMENT", "Invalid HWND"))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn canonical_watch_target() {
        assert_eq!(canonical("0001").unwrap(), "1");
        for value in ["", "0", "-1", "+1", "a"] { assert!(canonical(value).is_err()); }
    }
    #[test] fn fixed_batch_and_periodic_silence() {
        let t = Instant::now(); let mut s = Schedule::new(t);
        s.event(Event { kind: crate::uia::events::EventKind::Focus, hwnd: None, runtime_id: None, property_id: None }, t);
        s.event(Event { kind: crate::uia::events::EventKind::Focus, hwnd: None, runtime_id: None, property_id: None }, t + Duration::from_millis(29));
        assert!(s.take_due(t + Duration::from_millis(29)).is_none());
        assert_eq!(s.take_due(t + BATCH).unwrap().events.len(), 1);
        assert!(s.take_due(t + SILENCE).is_none());
        assert!(s.take_due(t + SILENCE + Duration::from_millis(29)).is_some());
        assert!(s.take_due(t + SILENCE * 2 + Duration::from_millis(29)).is_some());
        s.overflow(); assert!(s.take_due(t + SILENCE * 2 + BATCH).unwrap().full_verify);
    }
}
