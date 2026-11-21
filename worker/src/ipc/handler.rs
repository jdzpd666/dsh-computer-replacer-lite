use replacer_worker::{context, input::inject, observer::{self, Command, InjectionGate}, panic, uia::{events, Uia}, vision::{budget::{budget_fit, budget_locate, clamped_region, crop_bitmap, Region, LOCATE_MAX_RESULTS}, bitmap::Bitmap, capability::{fault_reason, Capabilities, Channel}, capture::CaptureStream, fusion::{align, aligned_hits, extract_query_hits, physical_scale, scale_rect, uia_only_hits, FusionElement, FusionLine, Rect}, TextBbox, TextHit, WinrtOcr}, world::{fault, Capture, Fault, World, DEFAULT_LIMIT, MAX_ELEMENTS}};
use serde_json::{json, Map, Value};
use std::{collections::VecDeque, sync::{Arc, Mutex, mpsc::{self, SyncSender}}, time::{Duration, Instant}};
use windows::{core::PCWSTR, Win32::{Graphics::Gdi::{EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS}, UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN}}};

pub struct Handler {
    commands: SyncSender<Command>,
    queries: SyncSender<Query>,
    actions: SyncSender<Action>,
    vision: SyncSender<Vision>,
    world: Arc<Mutex<World>>,
    events: Arc<Mutex<VecDeque<Value>>>,
}
impl Handler {
    pub fn new() -> Result<Self, Fault> {
        let world = Arc::new(Mutex::new(World::new()?));
        let gate = Arc::new(InjectionGate::new());
        let live = world.clone();
        let queries = query_thread(gate.clone());
        let refresh = queries.clone();
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let output = events.clone();
        let (_sink, inbox) = events::channel(1);
        let (commands, _join) = observer::spawn(inbox, move |batch| {
            let Some(hwnd) = batch.hwnd.as_deref() else { return Ok(()); };
            // Serialize query + commit against explicit observe to prevent late overwrite.
            let mut world = live.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "World poisoned"))?;
            world.decay_confidence(hwnd, std::time::Instant::now());
            let refreshed = observe_now(&refresh, hwnd).and_then(|capture| observer::update(&mut world, capture));
            drop(world);
            let mut queue = output.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "Event queue poisoned"))?;
            let row = match refreshed {
                Ok((snapshot, diff)) => json!({"event":"MODEL_DIFF","hwnd":hwnd,"snapshotId":snapshot,"diff":diff.json()}),
                Err(error) => json!({"event":"MODEL_REFRESH_FAILED","hwnd":hwnd,"code":error.0,"message":error.1}),
            };
            push_event(&mut queue, row);
            for event in batch.events {
                if queue.len() >= 128 {
                    queue.clear();
                    queue.push_back(json!({"event":"EVENT_GAP","message":"Diagnostic queue overflow; resnapshot required"}));
                }
                queue.push_back(json!({"event":"UIA_EVENT","targetHwnd":batch.hwnd,
                    "senderHwnd":event.hwnd,"kind":format!("{:?}",event.kind),
                    "runtimeId":event.runtime_id,"propertyId":event.property_id}));
            }
            Ok(())
        });
        let actions = action_thread(world.clone(), gate.clone());
        let vision = vision_thread();
        Ok(Self { commands, queries, actions, vision, world, events })
    }
    fn call<T>(&self, build: impl FnOnce(SyncSender<Result<T, Fault>>) -> Command) -> Result<T, Fault> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.commands.try_send(build(tx)).map_err(|_| fault("WORKER_UNAVAILABLE", "Owner unavailable or queue full"))?;
        rx.recv_timeout(Duration::from_secs(4)).map_err(|_| fault("TIMEOUT", "Owner reply unavailable; request not replayed"))?
    }
    fn dispatch(&mut self, method: &str, params: &Map<String, Value>, sequence: u64) -> Result<Value, Fault> {
        match method {
            "ping" if params.is_empty() => Ok(json!({"reply":"pong","pid":std::process::id(),"sequence":sequence})),
            "observe" => {
                let args = parse(params)?;
                let mut world = self.world.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "World poisoned"))?;
                let id = match args.snapshot_id {
                    Some(id) => id,
                    None => {
                        let capture = observe_now(&self.queries, &args.hwnd)?;
                        world.insert(capture)?
                    }
                };
                world.page(&args.hwnd, &id, args.offset, Some(args.limit))
            }
            "watch" | "unwatch" => {
                if params.len() != 1 { return Err(fault("INVALID_ARGUMENT", "Only hwnd is accepted")); }
                let args = parse(params)?;
                self.call(|reply| if method == "watch" { Command::Watch { hwnd:args.hwnd.clone(), reply } }
                    else { Command::Unwatch { hwnd:args.hwnd.clone(), reply } })?;
                if method == "unwatch" { self.world.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "World poisoned"))?.forget(&args.hwnd); }
                Ok(json!({"hwnd":args.hwnd,"watching":method == "watch"}))
            }
            "events" if params.is_empty() => {
                let mut queue = self.events.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "Event queue poisoned"))?;
                let mut rows = Vec::new();
                let mut bytes = 0;
                while let Some(row) = queue.front() {
                    let size = row.to_string().len()+1;
                    if bytes + size > 48*1024 { break; }
                    bytes += size;
                    if let Some(row) = queue.pop_front() { rows.push(row); }
                }
                Ok(json!({"events":rows}))
            }
            "windows" if params.is_empty() => {
                // Read-only enumeration: never mutates the world model and never injects.
                let (reply, rx) = mpsc::sync_channel(1);
                self.queries.try_send(Query::Windows { reply })
                    .map_err(|_| fault("WORKER_UNAVAILABLE", "Query thread unavailable or busy"))?;
                let rows = rx.recv_timeout(Duration::from_secs(6))
                    .map_err(|_| fault("TIMEOUT", "Window enumeration did not answer in 6s; nothing was performed"))??;
                Ok(json!({"windows": rows}))
            }
            "status" if params.is_empty() => {
                let mut summary = self.world.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "World poisoned"))?.summary();
                insert_pid_and_panic(&mut summary);
                Ok(summary)
            }
            "lookup" => {
                // Read-only: resolves the node an approval card will describe. No COM, no input.
                let args = parse_click(params)?;
                self.world.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "World poisoned"))?
                    .describe(&args.hwnd, &args.element_id)
                    .ok_or_else(|| fault("STALE_STATE", "Element is unknown, expired or from another window; observe again"))
            }
            "click" => {
                let args = parse_click(params)?;
                self.write("Click", |reply| Action::Click { hwnd: args.hwnd, element_id: args.element_id, reply })
            }
            "right_click" => {
                let args = parse_click(params)?;
                self.write("Right click", |reply| Action::RightClick { hwnd: args.hwnd, element_id: args.element_id, reply })
            }
            "type" => {
                let args = parse_type(params)?;
                self.write("Type", |reply| Action::Type { hwnd: args.hwnd, element_id: args.element_id, text: args.text, reply })
            }
            "scroll" => {
                let args = parse_scroll(params)?;
                self.write("Scroll", |reply| Action::Scroll { hwnd: args.hwnd, element_id: args.element_id,
                    horizontal: args.horizontal, vertical: args.vertical, steps: args.steps, reply })
            }
            "wheel" => {
                let args = parse_wheel(params)?;
                self.write("Wheel", |reply| Action::Wheel { hwnd: args.hwnd, element_id: args.element_id,
                    vertical: args.vertical, steps: args.steps, reply })
            }
            "key" => {
                let args = parse_key(params)?;
                self.write("Key", |reply| Action::Key { hwnd: args.hwnd, combo: args.combo, reply })
            }
            "lookup_label" => {
                let args = parse_label(params)?;
                self.query_value("Label lookup", |reply| Query::LookupLabel { hwnd: args.hwnd, label: args.label, reply })
            }
            "lookup_runtime" => {
                let args = parse_runtime(params)?;
                self.query_value("Runtime lookup", |reply| Query::LookupRuntime { hwnd: args.hwnd, runtime_id: args.runtime_id, reply })
            }
            "click_runtime" => {
                let args = parse_runtime(params)?;
                self.write("Fast click", |reply| Action::ClickRuntime { hwnd: args.hwnd, runtime_id: args.runtime_id, reply })
            }
            "click_xy" => {
                let args = parse_xy(params)?;
                self.write("Coordinate click", |reply| Action::ClickXy { hwnd: args.hwnd, x: args.x, y: args.y, reply })
            }
            "read_screen" => {
                // 通道 B 只读感知（批3）：capture + OCR，零注入，不加 panic 检查
                // （急停切断注入，不切断感知——与 gated() 写路径对照，语义见
                // vision_thread 注释）。TS 层同样不拦 read_screen（只读先例）。
                let region = parse_region(params)?;
                let (reply, rx) = mpsc::sync_channel(1);
                self.vision
                    .try_send(Vision::ReadScreen { region, reply })
                    .map_err(|_| fault("WORKER_UNAVAILABLE", "Vision thread unavailable or busy; nothing was captured"))?;
                // stage 超时：capture 2s + OCR 10s + 冷启动裕量 → 14s（TS 层 15s 兑底）。
                match rx.recv_timeout(Duration::from_secs(VISION_REPLY_TIMEOUT_SECS)) {
                    Ok(result) => result,
                    Err(_) => Err(fault("VISION_TIMEOUT",
                        "Read screen (capture + OCR) did not answer within its stage budgets; zero injection was performed; retry to start a fresh OCR attempt")),
                }
            }
            "locate" => {
                // 批4 第14工具：UIA 元素 x OCR 行融合候选（只读、零注入；只给候选
                // 不点击——点击仍走既有 click_runtime / click_xy 工具）。
                self.locate(params)
            }
            _ => Err(fault("UNSUPPORTED_OPERATION", "Unsupported method; no input performed")),
        }
    }
    /// Queues one write action on the COM action thread and returns its outcome.
    /// A busy queue means the action never ran; an expired reply means it may have run.
    fn write(&self, what: &str, build: impl FnOnce(SyncSender<Result<Value, Fault>>) -> Action) -> Result<Value, Fault> {
        let (reply, rx) = mpsc::sync_channel(1);
        self.actions.try_send(build(reply))
            .map_err(|_| fault("WORKER_UNAVAILABLE", "Action thread unavailable or busy; no input performed"))?;
        match rx.recv_timeout(Duration::from_secs(8)) {
            Ok(result) => result,
            Err(_) => Err(fault("INJECTION_UNCERTAIN", format!("{what} reply timed out after dispatch; outcome unknown, not retried"))),
        }
    }
    /// Queues one JSON query on the query thread, mirroring the write timeouts.
    fn query_value(&self, what: &str, build: impl FnOnce(SyncSender<Result<Value, Fault>>) -> Query) -> Result<Value, Fault> {
        let (reply, responses) = mpsc::sync_channel(1);
        self.queries
            .try_send(build(reply))
            .map_err(|_| fault("WORKER_UNAVAILABLE", "Query thread unavailable or busy; nothing was performed"))?;
        match responses.recv_timeout(Duration::from_secs(4)) {
            Ok(result) => result,
            Err(_) => Err(fault("TIMEOUT", format!("{what} reply timed out; nothing was performed"))),
        }
    }

    /// 批4 第14工具 replacer_locate：UIA 元素 x OCR 行融合候选（计划 §2.2/§3）。
    ///
    /// 只读、零注入、只给候选不点击（点击仍走既有 click_runtime / click_xy）。
    /// 失败语义：UIA observe / world 插入失败原样报错（观察不到就不可定位）；
    /// capture/OCR 失败或超时**不**失败请求，降级到 uia_only 通道并在 degradeReason
    /// 如实返回原因（计划 §2.2/§3）。
    ///
    /// DPI 归一（lead 2026-11-21 追加口径）：worker 是 DPI-unaware 进程，UIA bbox
    /// 是虚拟化逻辑像素而 OCR bbox 是全屏物理像素，故所有 UIA bbox 先乘主屏 scale
    /// 归一物理像素；诚实边界：原型只按主屏 DPI 归一（capture 也只抓主屏），窗口在
    /// 副屏/跨屏时 bbox 可能偏差，批4 不修。
    fn locate(&self, params: &Map<String, Value>) -> Result<Value, Fault> {
        let args = parse_locate(params)?;
        let (physical, virtual_size) = display_sizes();
        let scale = physical_scale(physical, virtual_size);

        // 1) UIA observe（与 observe 工具同源、同 4s 超时）。观察失败不降级：
        //    连元素都没有就无可定位对象，原样报错。
        let capture = observe_now(&self.queries, &args.hwnd)?;
        let observed_at = capture.observed_at;
        let observe_ms = capture.pull_ms + capture.model_ms;
        // UIA observe 契约：根元素 id="0" 且 parentId 为 null、排在首位。
        // 退化（无 id="0"）取首元素；完全没有元素 → region 回退全屏。
        let root_bbox = capture.elements.iter()
            .find(|element| element.get("id").and_then(Value::as_str) == Some("0"))
            .or_else(|| capture.elements.first())
            .and_then(|element| element.get("bbox"))
            .and_then(Rect::from_json);

        // 2) 入 world 稳定模型（快照 id 进响应；OBSERVATION_LIMIT 原样返回）。
        let snapshot_id = self.world
            .lock()
            .map_err(|_| fault("WORKER_UNAVAILABLE", "World poisoned"))?
            .insert(capture)?;

        // 3) 融合输入 = world.stable_nodes（label 可能为空，control_type 来自
        //    StableNode；bbox 归一物理像素）。stable_nodes 迭代顺序不确定，
        //    fusion::align 内部确定性排序（计划 §2.3 第5条）。
        let elements: Vec<FusionElement> = {
            let world = self.world.lock().map_err(|_| fault("WORKER_UNAVAILABLE", "World poisoned"))?;
            world.stable_nodes(&args.hwnd)
                .filter_map(|node| FusionElement::from_node(&node.id, node.control_type, &node.data))
                .map(|element| FusionElement { bbox: scale_rect(element.bbox, scale), ..element })
                .collect()
        };

        // 4) OCR region = 根窗口 bbox（已物理像素）∩ 主屏 (0,0,physical)；
        //    完全出屏 → 回退全屏（None = 全屏等价）。
        let region = root_bbox
            .map(|rect| scale_rect(rect, scale))
            .and_then(|rect| clip_rect_to_screen(rect, physical));

        // 5) vision 线程跑 capture→crop→OCR（与 read_screen 同一条管线，14s
        //    总超时；vision 忙也算失败 → 降级而不是报错）。
        let (reply, rx) = mpsc::sync_channel(1);
        let frame = match self.vision.try_send(Vision::Locate { region, reply }) {
            Ok(()) => match rx.recv_timeout(Duration::from_secs(VISION_REPLY_TIMEOUT_SECS)) {
                Ok(result) => result,
                Err(_) => Err(fault("VISION_TIMEOUT",
                    "Locate (capture + OCR) did not answer within its stage budgets; zero injection was performed")),
            },
            Err(_) => Err(fault("WORKER_UNAVAILABLE", "Vision thread unavailable or busy; nothing was captured")),
        };

        // 6) 融合（dispatch 线程纯函数，零设备；fusionMs 只计融合本身）。
        let (channel, capabilities, degrade_reason, window, matches, text_only, total_matches, total_text_only, timings) =
            match frame {
                Ok(frame) => {
                    let fusion_started = Instant::now();
                    // OCR bbox 是裁剪后局部坐标 → 加 origin 还原全屏物理像素。
                    let (dx, dy) = (frame.origin.0 as f64, frame.origin.1 as f64);
                    let lines: Vec<FusionLine> = frame.hits.iter().map(|hit| FusionLine::new(
                        hit.text.clone(),
                        Rect {
                            x: hit.bbox.x as f64 + dx,
                            y: hit.bbox.y as f64 + dy,
                            width: hit.bbox.width as f64,
                            height: hit.bbox.height as f64,
                        },
                    )).collect();
                    let fused = align(&elements, &lines);
                    let (matches, text_only, total_matches, total_text_only) = match args.query.as_deref() {
                        Some(query) => extract_query_hits(&elements, &lines, &fused, query, args.min_score, args.max_results),
                        None => aligned_hits(&elements, &lines, &fused, args.max_results),
                    };
                    let fusion_ms = fusion_started.elapsed().as_secs_f64() * 1000.0;
                    // window = 实际 OCR 区域（clamp 后；无 region = 全屏监视器）。
                    let window = clamped_region(
                        region.unwrap_or_else(|| Region::full_screen(frame.monitor.0, frame.monitor.1)),
                        frame.monitor.0.max(0) as u32,
                        frame.monitor.1.max(0) as u32,
                    )
                    .map(|(x, y, width, height)| json!({"x": x, "y": y, "width": width, "height": height}))
                    .unwrap_or_else(|| full_screen_window(frame.monitor));
                    (
                        Channel::Fusion.as_str(),
                        Capabilities::fusion().json(),
                        Value::Null,
                        window,
                        matches,
                        text_only,
                        total_matches,
                        total_text_only,
                        json!({
                            "observeMs": observe_ms,
                            "captureMs": frame.capture_ms,
                            "ocrMs": frame.ocr_ms,
                            "fusionMs": fusion_ms,
                            "buildMs": frame.build_ms,
                        }),
                    )
                }
                Err(error) => {
                    // 降级：仅 UIA 侧的 label/几何相似度，无 OCR 文本（ocrText=null）。
                    let (matches, text_only, total_matches, total_text_only) =
                        uia_only_hits(&elements, args.query.as_deref(), args.min_score, args.max_results);
                    (
                        Channel::UiaOnly.as_str(),
                        Capabilities::uia_only().json(),
                        json!(fault_reason(&error.0, &error.1)),
                        full_screen_window(physical),
                        matches,
                        text_only,
                        total_matches,
                        total_text_only,
                        json!({
                            "observeMs": observe_ms,
                            "captureMs": 0.0,
                            "ocrMs": 0.0,
                            "fusionMs": 0.0,
                            "buildMs": 0.0,
                        }),
                    )
                }
            };

        let response = json!({
            "hwnd": args.hwnd,
            "snapshotId": snapshot_id,
            "observedAt": observed_at,
            "query": args.query,
            "channel": channel,
            "degraded": channel == Channel::UiaOnly.as_str(),
            "degradeReason": degrade_reason,
            "capabilities": capabilities,
            "window": window,
            "matches": matches,
            "textOnly": text_only,
            "timings": timings,
            "truncated": false,
            "totalMatches": total_matches,
            "totalTextOnly": total_text_only,
        });
        Ok(budget_locate(response, args.max_results))
    }
    pub fn handle(&mut self, v: Value, sequence: u64) -> Result<Value, &'static str> {
        let obj = v.as_object().ok_or("invalid envelope")?;
        let id = obj.get("id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len()<=128).ok_or("invalid id")?;
        let method = obj.get("method").and_then(Value::as_str).ok_or("invalid method")?;
        let params = obj.get("params").and_then(Value::as_object).ok_or("invalid params")?;
        Ok(match self.dispatch(method, params, sequence) {
            Ok(result) => json!({"id":id,"ok":true,"result":result}),
            Err(Fault(code,message)) => json!({"id":id,"ok":false,"error":{"code":code,"message":message}}),
        })
    }
}
impl Drop for Handler {
    fn drop(&mut self) { let _ = self.commands.try_send(Command::Stop); }
}

struct ObserveArgs {
    hwnd: String,
    snapshot_id: Option<String>,
    offset: usize,
    limit: usize,
}

fn number(params: &Map<String, Value>, key: &str, default: usize) -> Result<usize, Fault> {
    match params.get(key) {
        None => Ok(default),
        Some(value) => value.as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| fault("INVALID_ARGUMENT", format!("{key} must be an unsigned integer"))),
    }
}

struct ClickArgs { hwnd: String, element_id: String }

fn hwnd(params: &Map<String, Value>) -> Result<String, Fault> {
    let value = params.get("hwnd").and_then(Value::as_str)
        .ok_or_else(|| fault("INVALID_ARGUMENT", "hwnd must be a decimal string"))?;
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(fault("INVALID_ARGUMENT", "Invalid HWND"));
    }
    value.parse::<usize>().ok().filter(|n| *n != 0)
        .ok_or_else(|| fault("INVALID_ARGUMENT", "HWND outside supported range"))
        .map(|n| n.to_string())
}

fn node_id(params: &Map<String, Value>) -> Result<String, Fault> {
    params.get("elementId").and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| fault("INVALID_ARGUMENT", "elementId must be a node id returned by observe"))
}

// Validation only: nothing here reaches COM, so a rejected request cannot inject.
fn parse_click(params: &Map<String, Value>) -> Result<ClickArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "elementId")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown click argument"));
    }
    Ok(ClickArgs { hwnd: hwnd(params)?, element_id: node_id(params)? })
}

struct LabelArgs {
    hwnd: String,
    label: String,
}

fn parse_label(params: &Map<String, Value>) -> Result<LabelArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "label")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown label lookup argument"));
    }
    let label = params
        .get("label")
        .and_then(Value::as_str)
        .filter(|label| !label.is_empty() && label.chars().count() <= 512 && !label.chars().any(|character| character.is_control()))
        .ok_or_else(|| fault("INVALID_ARGUMENT", "label must contain 1..512 characters and no control characters"))?
        .to_owned();
    Ok(LabelArgs { hwnd: hwnd(params)?, label })
}

struct RuntimeArgs {
    hwnd: String,
    runtime_id: Vec<i32>,
}

fn parse_runtime(params: &Map<String, Value>) -> Result<RuntimeArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "runtimeId")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown runtime lookup argument"));
    }
    let values = params
        .get("runtimeId")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= 64)
        .ok_or_else(|| fault("INVALID_ARGUMENT", "runtimeId must be an array of 1..64 integers"))?;
    let mut runtime_id = Vec::with_capacity(values.len());
    for value in values {
        let number = value
            .as_i64()
            .filter(|number| i32::try_from(*number).is_ok())
            .ok_or_else(|| fault("INVALID_ARGUMENT", "runtimeId entries must be 32-bit integers"))?;
        runtime_id.push(number as i32);
    }
    Ok(RuntimeArgs { hwnd: hwnd(params)?, runtime_id })
}

struct XyArgs {
    hwnd: String,
    x: i32,
    y: i32,
}

fn parse_xy(params: &Map<String, Value>) -> Result<XyArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "x" | "y")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown coordinate argument"));
    }
    let coordinate = |key: &str| -> Result<i32, Fault> {
        let number = params
            .get(key)
            .and_then(Value::as_i64)
            .filter(|number| i32::try_from(*number).is_ok())
            .ok_or_else(|| fault("INVALID_ARGUMENT", format!("{key} must be a 32-bit integer")))?;
        Ok(number as i32)
    };
    Ok(XyArgs { hwnd: hwnd(params)?, x: coordinate("x")?, y: coordinate("y")? })
}

struct TypeArgs { hwnd: String, element_id: String, text: String }

fn parse_type(params: &Map<String, Value>) -> Result<TypeArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "elementId" | "text")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown type argument"));
    }
    let text = params.get("text").and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.chars().count() <= 8192 && !text.contains(char::from(0)))
        .ok_or_else(|| fault("INVALID_ARGUMENT", "text must contain 1..8192 characters and no NUL"))?
        .to_owned();
    Ok(TypeArgs { hwnd: hwnd(params)?, element_id: node_id(params)?, text })
}

struct ScrollArgs { hwnd: String, element_id: String, horizontal: String, vertical: String, steps: usize }

fn parse_scroll(params: &Map<String, Value>) -> Result<ScrollArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "elementId" | "horizontal" | "vertical" | "steps")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown scroll argument"));
    }
    let direction = |key: &str, default: &str, allowed: &[&str]| -> Result<String, Fault> {
        match params.get(key) {
            None => Ok(default.to_owned()),
            Some(Value::String(value)) if allowed.contains(&value.as_str()) => Ok(value.clone()),
            _ => Err(fault("INVALID_ARGUMENT", format!("{key} must be one of {allowed:?}"))),
        }
    };
    let horizontal = direction("horizontal", "no", &["no", "left", "right"])?;
    let vertical = direction("vertical", "no", &["no", "up", "down"])?;
    if horizontal == "no" && vertical == "no" {
        return Err(fault("INVALID_ARGUMENT", "At least one scroll direction is required"));
    }
    let steps = number(params, "steps", 1)?;
    if !(1..=10).contains(&steps) {
        return Err(fault("INVALID_ARGUMENT", "steps must be 1..10"));
    }
    Ok(ScrollArgs { hwnd: hwnd(params)?, element_id: node_id(params)?, horizontal, vertical, steps })
}

struct WheelArgs { hwnd: String, element_id: String, vertical: String, steps: usize }

struct KeyArgs { hwnd: String, combo: String }

fn parse_key(params: &Map<String, Value>) -> Result<KeyArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "combo")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown key argument"));
    }
    let combo = params.get("combo").and_then(Value::as_str)
        .filter(|combo| !combo.trim().is_empty() && combo.len() <= 32 && !combo.contains('+')
            && !combo.chars().any(char::is_whitespace))
        .ok_or_else(|| fault("INVALID_ARGUMENT", "combo must be 1..32 characters, one key name or one character, no whitespace/'+' (modifier chords cannot be delivered through PostMessageW; zero keys were sent)"))?
        .to_owned();
    Ok(KeyArgs { hwnd: hwnd(params)?, combo })
}

fn parse_wheel(params: &Map<String, Value>) -> Result<WheelArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "elementId" | "vertical" | "steps")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown wheel argument"));
    }
    let vertical = match params.get("vertical") {
        None => "down".to_owned(),
        Some(Value::String(value)) if matches!(value.as_str(), "up" | "down") => value.clone(),
        _ => return Err(fault("INVALID_ARGUMENT", "vertical must be up|down")),
    };
    let steps = number(params, "steps", 1)?;
    if !(1..=10).contains(&steps) {
        return Err(fault("INVALID_ARGUMENT", "steps must be 1..10"));
    }
    Ok(WheelArgs { hwnd: hwnd(params)?, element_id: node_id(params)?, vertical, steps })
}

/// 可选 region 校验（批3，只验不碰 COM：拒绝即零捕获）：物理像素全屏坐标系，
/// x/y 非负、width/height > 0；越出屏界的部分由 crop_bitmap clamp 进屏界
/// （完全出屏 → 面积 0 → VISION_INVALID，见 read_screen_once）。
fn parse_region(params: &Map<String, Value>) -> Result<Option<Region>, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "region")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown read_screen argument"));
    }
    match params.get("region") {
        None => Ok(None),
        Some(Value::Object(region)) => {
            if region.keys().any(|key| !matches!(key.as_str(), "x" | "y" | "width" | "height")) {
                return Err(fault("INVALID_ARGUMENT", "Unknown region argument"));
            }
            let field = |key: &str| -> Result<i32, Fault> {
                region.get(key)
                    .and_then(Value::as_i64)
                    .filter(|n| i32::try_from(*n).is_ok())
                    .map(|n| n as i32)
                    .ok_or_else(|| fault("INVALID_ARGUMENT", format!("region.{key} must be a 32-bit integer in physical pixels")))
            };
            let (x, y, width, height) = (field("x")?, field("y")?, field("width")?, field("height")?);
            if x < 0 || y < 0 || width <= 0 || height <= 0 {
                return Err(fault("INVALID_ARGUMENT",
                    "region must carry non-negative x/y and positive width/height in physical pixels; nothing was captured"));
            }
            if width > REGION_MAX_DIM || height > REGION_MAX_DIM {
                return Err(fault("INVALID_ARGUMENT",
                    format!("region width/height exceed the supported maximum of {REGION_MAX_DIM} physical pixels")));
            }
            Ok(Some(Region { x, y, width, height }))
        }
        Some(_) => Err(fault("INVALID_ARGUMENT", "region must be an object {x,y,width,height} in physical pixels")),
    }
}

fn parse(params: &Map<String, Value>) -> Result<ObserveArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "snapshotId" | "offset" | "limit")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown observe argument"));
    }
    let hwnd = hwnd(params)?;
    let snapshot_id = match params.get("snapshotId") {
        None => None,
        Some(Value::String(id)) if !id.is_empty() && id.len() <= 128 => Some(id.clone()),
        _ => return Err(fault("INVALID_ARGUMENT", "Invalid snapshotId")),
    };
    let offset = number(params, "offset", 0)?;
    let limit = number(params, "limit", DEFAULT_LIMIT)?;
    if offset > MAX_ELEMENTS || limit == 0 || limit > DEFAULT_LIMIT {
        return Err(fault("INVALID_ARGUMENT", "offset must be 0..20000; limit must be 1..200"));
    }
    if snapshot_id.is_none() && offset != 0 {
        return Err(fault("INVALID_ARGUMENT", "Nonzero offset requires snapshotId"));
    }
    Ok(ObserveArgs { hwnd, snapshot_id, offset, limit })
}

struct LocateArgs {
    hwnd: String,
    query: Option<String>,
    max_results: usize,
    min_score: f64,
}

/// locate 参数校验（批4 计划 §2.2；只验不碰 COM/设备，拒绝即零捕获）：
/// hwnd 必填（同 observe 的十进制规则）；query 可选（≤512 字符、无控制符）；
/// maxResults 1..=50 默认 10；minScore 0..=1 默认 0.5。未知键一律拒绝。
fn parse_locate(params: &Map<String, Value>) -> Result<LocateArgs, Fault> {
    if params.keys().any(|key| !matches!(key.as_str(), "hwnd" | "query" | "maxResults" | "minScore")) {
        return Err(fault("INVALID_ARGUMENT", "Unknown locate argument"));
    }
    let hwnd = hwnd(params)?;
    let query = match params.get("query") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            if text.chars().count() > 512 {
                return Err(fault("INVALID_ARGUMENT", "query must be at most 512 characters"));
            }
            if text.chars().any(char::is_control) {
                return Err(fault("INVALID_ARGUMENT", "query must not contain control characters"));
            }
            Some(text.clone())
        }
        Some(_) => return Err(fault("INVALID_ARGUMENT", "query must be a string")),
    };
    let max_results = match params.get("maxResults") {
        None => 10,
        Some(value) => value.as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| (1..=LOCATE_MAX_RESULTS).contains(n))
            .ok_or_else(|| fault("INVALID_ARGUMENT", "maxResults must be an integer 1..=50"))?,
    };
    let min_score = match params.get("minScore") {
        None => 0.5,
        Some(value) => value.as_f64()
            .filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
            .ok_or_else(|| fault("INVALID_ARGUMENT", "minScore must be a finite number 0..=1"))?,
    };
    Ok(LocateArgs { hwnd, query, max_results, min_score })
}

/// 主屏尺寸（批4 lead 2026-11-21 追加 DPI 归一）：虚拟化尺寸走 GetSystemMetrics
/// （DPI-unaware 进程拿到逻辑值），物理尺寸走 EnumDisplaySettingsW 主屏 dmPels。
/// 物理查询失败时回退虚拟化尺寸（scale = 1.0，等于不做归一，绝不比现状更差）。
/// 不改变进程 DPI 感知（禁止 SetProcessDpiAwareness，见 lead 口径）。
fn display_sizes() -> ((i32, i32), (i32, i32)) {
    // SAFETY: GetSystemMetrics 无指针参数、无副作用；EnumDisplaySettingsW 仅写入
    // 调用方栈上的 DEVMODEW（dmSize 按本 SDK 结构大小初始化），两调用均不跨线程
    // 持有状态，也不需要 COM 初始化。
    unsafe {
        let virtual_size = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        let mut devmode = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        // windows 0.61 的 BOOL 是 newtype（.0: i32）：0 = 查询失败，回退虚拟尺寸。
        let physical = if EnumDisplaySettingsW(None::<&PCWSTR>, ENUM_CURRENT_SETTINGS, &mut devmode).0 != 0 {
            (devmode.dmPelsWidth as i32, devmode.dmPelsHeight as i32)
        } else {
            virtual_size
        };
        (physical, virtual_size)
    }
}

/// 把物理像素矩形裁进主屏 [0,physical.0] x [0,physical.1]；空交集返回 None
/// （locate 据此把 OCR region 回退为全屏）。坐标四舍五入到整数像素。
fn clip_rect_to_screen(rect: Rect, physical: (i32, i32)) -> Option<Region> {
    let (screen_width, screen_height) = physical;
    if screen_width <= 0 || screen_height <= 0 {
        return None;
    }
    let left = rect.x.max(0.0);
    let top = rect.y.max(0.0);
    let right = (rect.x + rect.width).min(screen_width as f64);
    let bottom = (rect.y + rect.height).min(screen_height as f64);
    let width = (right - left).round();
    let height = (bottom - top).round();
    if width < 1.0 || height < 1.0 {
        return None;
    }
    Some(Region {
        x: left.round() as i32,
        y: top.round() as i32,
        width: width as i32,
        height: height as i32,
    })
}

/// 主屏物理尺寸的四键 window 对象（无 OCR 降级 / 无 region 时用）。
fn full_screen_window(monitor: (i32, i32)) -> Value {
    json!({"x": 0, "y": 0, "width": monitor.0.max(0), "height": monitor.1.max(0)})
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn validates_without_com() {
        for p in [json!({}),json!({"hwnd":"0"}),json!({"hwnd":"1","offset":1}),json!({"hwnd":"1","limit":201})] {
            assert!(parse(p.as_object().unwrap()).is_err());
        }
        assert_eq!(parse(json!({"hwnd":"0001"}).as_object().unwrap()).unwrap().hwnd,"1");
    }
    #[test] fn validates_click_without_com() {
        for p in [json!({}),json!({"hwnd":"1"}),json!({"elementId":"r:[1]"}),
                  json!({"hwnd":"0","elementId":"r:[1]"}),json!({"hwnd":"1","elementId":""}),
                  json!({"hwnd":"1","elementId":"r:[1]","button":"left"}),
                  json!({"hwnd":"1","elementId":"bad\nid"})] {
            assert!(parse_click(p.as_object().unwrap()).is_err(), "{p}");
        }
        let args = parse_click(json!({"hwnd":"0001","elementId":"r:[42,7]"}).as_object().unwrap()).unwrap();
        assert_eq!((args.hwnd.as_str(), args.element_id.as_str()), ("1", "r:[42,7]"));
    }
    #[test] fn validates_type_without_com() {
        for p in [json!({}),json!({"hwnd":"1","elementId":"r:[1]"}),
                  json!({"hwnd":"1","elementId":"r:[1]","text":""}),
                  json!({"hwnd":"1","elementId":"r:[1]","text":"a\u{0}b"}),
                  json!({"hwnd":"1","elementId":"r:[1]","text":"hi","button":"left"})] {
            assert!(parse_type(p.as_object().unwrap()).is_err(), "{p}");
        }
        let args = parse_type(json!({"hwnd":"1","elementId":"r:[1]","text":"你好"}).as_object().unwrap()).unwrap();
        assert_eq!(args.text, "你好");
    }
    #[test] fn validates_scroll_without_com() {
        for p in [json!({"hwnd":"1","elementId":"r:[1]"}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"no"}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"sideways"}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"down","steps":0}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"down","steps":11})] {
            assert!(parse_scroll(p.as_object().unwrap()).is_err(), "{p}");
        }
        let args = parse_scroll(json!({"hwnd":"1","elementId":"r:[1]","vertical":"down","steps":"2"}).as_object().unwrap());
        assert!(args.is_err());
        let args = parse_scroll(json!({"hwnd":"1","elementId":"r:[1]","vertical":"down","steps":2}).as_object().unwrap()).unwrap();
        assert_eq!((args.horizontal.as_str(), args.vertical.as_str(), args.steps), ("no", "down", 2));
    }
    #[test] fn validates_wheel_without_com() {
        for p in [json!({}), json!({"hwnd":"1"}), json!({"elementId":"r:[1]"}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"no"}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"left"}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"down","steps":0}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"down","steps":11}),
                  json!({"hwnd":"1","elementId":"r:[1]","vertical":"down","button":"left"})] {
            assert!(parse_wheel(p.as_object().unwrap()).is_err(), "{p}");
        }
        let args = parse_wheel(json!({"hwnd":"0001","elementId":"r:[42,7]"}).as_object().unwrap()).unwrap();
        assert_eq!((args.hwnd.as_str(), args.element_id.as_str(), args.vertical.as_str(), args.steps), ("1", "r:[42,7]", "down", 1));
        let args = parse_wheel(json!({"hwnd":"1","elementId":"r:[1]","vertical":"up","steps":3}).as_object().unwrap()).unwrap();
        assert_eq!((args.vertical.as_str(), args.steps), ("up", 3));
    }
    #[test] fn validates_key_without_com() {
        for p in [json!({}), json!({"combo":"enter"}), json!({"hwnd":"1"}),
                  json!({"hwnd":"1","combo":""}), json!({"hwnd":"1","combo":"  "}),
                  json!({"hwnd":"1","combo":"ctrl+a"}), json!({"hwnd":"1","combo":"a b"}), json!({"hwnd":"1","combo":"enter","extra":true})] {
            assert!(parse_key(p.as_object().unwrap()).is_err(), "{p}");
        }
        let args = parse_key(json!({"hwnd":"0001","combo":"enter"}).as_object().unwrap()).unwrap();
        assert_eq!((args.hwnd.as_str(), args.combo.as_str()), ("1", "enter"));
        let args = parse_key(json!({"hwnd":"1","combo":"A"}).as_object().unwrap()).unwrap();
        assert_eq!(args.combo, "A");
    }
    #[test]
    fn status_summary_carries_pid_and_panic_fields() {
        let mut summary = json!({"tier":"L2","l2":true,"l3":false,"worlds":[]});
        insert_pid_and_panic(&mut summary);
        assert!(summary.get("pid").and_then(Value::as_u64).unwrap_or(0) > 0);
        assert!(summary.get("panic").map(Value::is_boolean).unwrap_or(false));
        assert!(summary.get("panicHotkey").map(Value::is_string).unwrap_or(false));
        // Non-object input stays untouched rather than panicking.
        let mut junk = json!("not-an-object");
        insert_pid_and_panic(&mut junk);
        assert_eq!(junk, json!("not-an-object"));
    }
    #[test]
    fn panic_checkpoint_rejects_queued_action_with_reply() {
        // Pure checkpoint, no COM: construct a real Action with a reply channel,
        // trip the (parameter, not global) latch and assert the reply answers
        // PANIC_ABORTED while the caller is told to skip the action.
        let (reply, rx) = mpsc::sync_channel(1);
        let action = Action::Key { hwnd: "1".into(), combo: "enter".into(), reply };
        assert!(!panic_reject(false, &action));
        assert!(rx.try_recv().is_err(), "clear latch must not answer the reply");
        assert!(panic_reject(true, &action), "tripped latch must abort the action");
        let Fault(code, message) = rx.try_recv().expect("reply answered").expect_err("aborted");
        assert_eq!(code, "PANIC_ABORTED");
        assert!(message.contains("zero messages"), "{message}");
    }

    // ---- 批3：region parse 校验（只验不碰 COM；负数/越界 sanity/宽高 0） ----
    #[test]
    fn read_screen_region_parses_without_com() {
        // 无 region：合法（全屏）。
        assert_eq!(parse_region(json!({}).as_object().unwrap()).unwrap(), None);
        assert_eq!(parse_region(json!({"region":{"x":0,"y":0,"width":1920,"height":1080}}).as_object().unwrap()).unwrap(),
            Some(Region { x: 0, y: 0, width: 1920, height: 1080 }));
        // 未知参数 / region 非对象 / 字段缺失 / 字段未知。
        for p in [
            json!({"hwnd":"1"}),
            json!({"region":"fullscreen"}),
            json!({"region":{"x":0,"y":0,"width":1920}}),
            json!({"region":{"x":0,"y":0,"width":1920,"height":1080,"color":"rgb"}}),
        ] {
            assert!(parse_region(p.as_object().unwrap()).is_err(), "{p}");
        }
        // 负数坐标 / 宽高 0 / 宽高越 sanity 上限。
        for p in [
            json!({"region":{"x":-1,"y":0,"width":100,"height":100}}),
            json!({"region":{"x":0,"y":-2,"width":100,"height":100}}),
            json!({"region":{"x":0,"y":0,"width":0,"height":100}}),
            json!({"region":{"x":0,"y":0,"width":100,"height":-5}}),
            json!({"region":{"x":0,"y":0,"width":200_001,"height":100}}),
            json!({"region":{"x":0,"y":0,"width":1.5,"height":100}}),
        ] {
            assert!(parse_region(p.as_object().unwrap()).is_err(), "{p}");
        }
    }
    #[test] fn locate_parses_without_com() {
        let parsed = parse_locate(json!({"hwnd":"0001"}).as_object().unwrap()).unwrap();
        assert_eq!((parsed.hwnd.as_str(), parsed.query.as_deref(), parsed.max_results, parsed.min_score),
            ("1", None, 10, 0.5));
        let parsed = parse_locate(json!({"hwnd":"42","query":"保存","maxResults":50,"minScore":1})
            .as_object().unwrap()).unwrap();
        assert_eq!((parsed.query.as_deref(), parsed.max_results, parsed.min_score), (Some("保存"), 50, 1.0));
        // 未知键 / 缺失 hwnd / hwnd 非十进制 / query 非串与控制符与超长 /
        // maxResults 越界与非数字 / minScore 越界与非数字 —— 全部拒绝。
        let long_query = "a".repeat(513);
        for p in [
            json!({"hwnd":"1","region":{"x":0,"y":0,"width":10,"height":10}}),
            json!({"query":"保存"}),
            json!({"hwnd":"0"}),
            json!({"hwnd":"0x1"}),
            json!({"hwnd":"1","query":42}),
            json!({"hwnd":"1","query":"a\nb"}),
            json!({"hwnd":"1","query":long_query}),
            json!({"hwnd":"1","maxResults":0}),
            json!({"hwnd":"1","maxResults":51}),
            json!({"hwnd":"1","maxResults":"10"}),
            json!({"hwnd":"1","minScore":-0.1}),
            json!({"hwnd":"1","minScore":1.1}),
            json!({"hwnd":"1","minScore":"oops"}),
        ] {
            assert!(parse_locate(p.as_object().unwrap()).is_err(), "{p}");
        }
    }
    #[test] fn locate_clip_rect_to_primary_screen_without_com() {
        let rect = |x: f64, y: f64, width: f64, height: f64| Rect { x, y, width, height };
        // 屏内原样 / 部分出屏裁边 / 完全出屏与非法屏界回退全屏。
        assert_eq!(clip_rect_to_screen(rect(0.0, 0.0, 1920.0, 1080.0), (1920, 1080)),
            Some(Region { x: 0, y: 0, width: 1920, height: 1080 }));
        assert_eq!(clip_rect_to_screen(rect(150.0, 150.0, 970.0, 449.0), (1920, 1080)),
            Some(Region { x: 150, y: 150, width: 970, height: 449 }));
        assert_eq!(clip_rect_to_screen(rect(1800.0, 1000.0, 400.0, 400.0), (1920, 1080)),
            Some(Region { x: 1800, y: 1000, width: 120, height: 80 }));
        assert_eq!(clip_rect_to_screen(rect(5000.0, 5000.0, 100.0, 100.0), (1920, 1080)), None);
        assert_eq!(clip_rect_to_screen(rect(-100.0, -100.0, 50.0, 50.0), (1920, 1080)), None);
        assert_eq!(clip_rect_to_screen(rect(0.0, 0.0, 100.0, 100.0), (0, 0)), None);
    }
    #[test] fn locate_pipeline_disposition_resets_only_capture_failure() {
        assert_eq!(pipeline_disposition(PipelineStage::Capture), PipelineDisposition::Reset);
        assert_eq!(pipeline_disposition(PipelineStage::Crop), PipelineDisposition::Keep);
        assert_eq!(pipeline_disposition(PipelineStage::Ocr), PipelineDisposition::Keep);
    }
    #[test] fn locate_display_sizes_are_positive_without_com() {
        // 真机/无显示环境都成立：EnumDisplaySettingsW 失败时物理尺寸回退虚拟尺寸，
        // 因此四个值恒 > 0，且归一 scale 落在 1.0..=4.0（lead 口径兜底）。
        let ((physical_width, physical_height), (virtual_width, virtual_height)) = display_sizes();
        assert!(physical_width > 0 && physical_height > 0, "physical {physical_width}x{physical_height}");
        assert!(virtual_width > 0 && virtual_height > 0, "virtual {virtual_width}x{virtual_height}");
        let scale = physical_scale((physical_width, physical_height), (virtual_width, virtual_height));
        assert!((1.0..=4.0).contains(&scale), "scale {scale}");
    }
    #[test] fn locate_full_screen_window_shape_without_com() {
        assert_eq!(full_screen_window((1920, 1080)), json!({"x":0,"y":0,"width":1920,"height":1080}));
        // 非法/负尺寸兜底成 0（JSON 仍四键 number，不出现负数宽高）。
        assert_eq!(full_screen_window((-1, -2)), json!({"x":0,"y":0,"width":0,"height":0}));
    }
}

/// Adds the process id, the panic latch state and the armed hotkey label to a
/// status summary. Pure (no COM, no locks) so the shape is unit-testable.
fn insert_pid_and_panic(summary: &mut Value) {
    if let Some(object) = summary.as_object_mut() {
        object.insert("pid".into(), json!(std::process::id()));
        object.insert("panic".into(), json!(panic::tripped()));
        object.insert("panicHotkey".into(), json!(panic::hotkey_label()));
    }
}

/// Pure panic checkpoint for the action thread: given the latch state and one
/// queued action, a tripped latch rejects the action before any COM call and
/// answers its reply with PANIC_ABORTED. Returns true when the action was
/// aborted (the caller then `continue`s without entering the injection gate).
///
/// Final-review requirement: this is a pure function with no Uia dependency
/// (input: latch state + Action + reply), so the trip-vs-queue race is
/// unit-testable without COM.
fn panic_reject(tripped: bool, action: &Action) -> bool {
    if !tripped {
        return false;
    }
    let reply = match action {
        Action::Click { reply, .. } | Action::Type { reply, .. } | Action::Scroll { reply, .. }
            | Action::RightClick { reply, .. } | Action::Wheel { reply, .. } | Action::Key { reply, .. }
            | Action::ClickRuntime { reply, .. } | Action::ClickXy { reply, .. } => reply,
    };
    let _ = reply.try_send(Err(fault(
        "PANIC_ABORTED",
        "Panic latch tripped while this action was still queued; it was aborted before any injection started, zero messages were issued. Messages already sent cannot be recalled",
    )));
    true
}

fn push_event(queue: &mut VecDeque<Value>, row: Value) {
    if queue.len() >= 128 || row.to_string().len() > 47*1024 {
        queue.clear();
        queue.push_back(json!({"event":"EVENT_GAP","message":"Model diff exceeded queue budget; resnapshot required"}));
    }
    if row.to_string().len() <= 47*1024 { queue.push_back(row); }
}
fn observe_now(queries: &SyncSender<Query>, hwnd: &str) -> Result<Capture, Fault> {
    let (reply, rx) = mpsc::sync_channel(1);
    queries.try_send(Query::Observe { hwnd: hwnd.to_owned(), reply })
        .map_err(|_| fault("WORKER_UNAVAILABLE", "Query thread unavailable or busy"))?;
    rx.recv_timeout(Duration::from_secs(4)).map_err(|_| fault("TIMEOUT", "Query timed out; not replayed"))?
}

enum Action {
    Click { hwnd: String, element_id: String, reply: SyncSender<Result<Value, Fault>> },
    Type { hwnd: String, element_id: String, text: String, reply: SyncSender<Result<Value, Fault>> },
    Scroll { hwnd: String, element_id: String, horizontal: String, vertical: String, steps: usize, reply: SyncSender<Result<Value, Fault>> },
    RightClick { hwnd: String, element_id: String, reply: SyncSender<Result<Value, Fault>> },
    Wheel { hwnd: String, element_id: String, vertical: String, steps: usize, reply: SyncSender<Result<Value, Fault>> },
    Key { hwnd: String, combo: String, reply: SyncSender<Result<Value, Fault>> },
    ClickRuntime { hwnd: String, runtime_id: Vec<i32>, reply: SyncSender<Result<Value, Fault>> },
    ClickXy { hwnd: String, x: i32, y: i32, reply: SyncSender<Result<Value, Fault>> },
}

// The action thread owns its own COM apartment and never shares UIA objects with the
// query or observer threads. The world lock is released before the reply is sent.
fn action_thread(world: Arc<Mutex<World>>, gate: Arc<InjectionGate>) -> SyncSender<Action> {
    let (tx, rx) = mpsc::sync_channel::<Action>(1);
    std::thread::spawn(move || {
        let uia = Uia::new();
        while let Ok(action) = rx.recv() {
            // Emergency stop first: a queued action that wakes up after the latch
            // tripped is rejected here, before the injection gate is even entered,
            // so it never touches COM, the world lock or any UIA object.
            if panic_reject(panic::tripped(), &action) {
                continue;
            }
            // Pause every read-side tree walk before this action starts. The guard
            // stays alive through the foreground settle, the provider call and the
            // post-invoke settle, so a shadow observation cannot re-enter the busy
            // provider while the click is in flight.
            let _injection = gate.enter();
            let target = match &action {
                Action::Click { hwnd, .. } | Action::Type { hwnd, .. } | Action::Scroll { hwnd, .. }
                    | Action::RightClick { hwnd, .. } | Action::Wheel { hwnd, .. } | Action::Key { hwnd, .. }
                    | Action::ClickRuntime { hwnd, .. } | Action::ClickXy { hwnd, .. } => hwnd.clone(),
            };
            let result = match &uia {
                Ok(uia) => match world.lock() {
                    Ok(world) => match &action {
                        Action::Click { hwnd, element_id, .. } => inject::click_by_id(uia, &world, hwnd, element_id),
                        Action::Type { hwnd, element_id, text, .. } => inject::type_text(uia, &world, hwnd, element_id, text),
                        Action::Scroll { hwnd, element_id, horizontal, vertical, steps, .. } =>
                            inject::scroll_by_id(uia, &world, hwnd, element_id, horizontal, vertical, *steps),
                        Action::RightClick { hwnd, element_id, .. } =>
                            inject::right_click_by_id(uia, &world, hwnd, element_id),
                        Action::Wheel { hwnd, element_id, vertical, steps, .. } =>
                            inject::wheel_by_id(uia, &world, hwnd, element_id, vertical, *steps),
                        Action::Key { hwnd, combo, .. } => inject::send_key(hwnd, combo),
                        Action::ClickRuntime { hwnd, runtime_id, .. } => inject::click_runtime(uia, hwnd, runtime_id),
                        Action::ClickXy { hwnd, x, y, .. } => inject::click_xy(hwnd, *x, *y),
                    },
                    Err(_) => Err(fault("WORKER_UNAVAILABLE", "World poisoned")),
                },
                Err(error) => Err(fault(error.0, error.1.clone())),
            };
            // Our own Invoke may move keyboard focus. If the target window is still in front,
            // that is our side effect, not a context change: adopt the new focus.
            if result.is_ok() {
                if let (Ok(uia), Ok(mut world)) = (&uia, world.lock()) {
                    if context::foreground().as_deref() == Some(target.as_str()) {
                        if let Ok(focus) = uia.focused_runtime_id() { world.record_focus(&target, focus); }
                    }
                }
            }
            let reply = match action {
                Action::Click { reply, .. } | Action::Type { reply, .. } | Action::Scroll { reply, .. }
                    | Action::RightClick { reply, .. } | Action::Wheel { reply, .. } | Action::Key { reply, .. }
                    | Action::ClickRuntime { reply, .. } | Action::ClickXy { reply, .. } => reply,
            };
            let _ = reply.try_send(result);
        }
    });
    tx
}

enum Query {
    Observe { hwnd: String, reply: SyncSender<Result<Capture, Fault>> },
    Windows { reply: SyncSender<Result<Vec<Value>, Fault>> },
    LookupLabel { hwnd: String, label: String, reply: SyncSender<Result<Value, Fault>> },
    LookupRuntime { hwnd: String, runtime_id: Vec<i32>, reply: SyncSender<Result<Value, Fault>> },
}

fn injection_busy() -> Fault {
    fault(
        "INJECTION_BUSY",
        "Injection in progress; observation is paused until the target window settles. Retry after the click returns.",
    )
}

fn query_thread(gate: Arc<InjectionGate>) -> SyncSender<Query> {
    let (tx, rx) = mpsc::sync_channel::<Query>(1);
    std::thread::spawn(move || {
        let uia = Uia::new();
        while let Ok(query) = rx.recv() {
            match query {
                Query::Observe { hwnd, reply } => {
                    let Some(_paused) = gate.try_enter() else {
                        let _ = reply.try_send(Err(injection_busy()));
                        continue;
                    };
                    let result = match &uia {
                        Ok(uia) => uia.observe(&hwnd),
                        Err(error) => Err(fault(error.0, error.1.clone())),
                    };
                    let _ = reply.try_send(result);
                }
                Query::LookupLabel { hwnd, label, reply } => {
                    let Some(_paused) = gate.try_enter() else {
                        let _ = reply.try_send(Err(injection_busy()));
                        continue;
                    };
                    let result = match &uia {
                        Ok(uia) => uia
                            .find_by_label(hwnd.as_str(), label.as_str())
                            .and_then(|(element, matches)| {
                                let facts = uia.element_facts(&element)?;
                                if facts.get("runtimeId").map_or(true, Value::is_null) {
                                    return Err(fault(
                                        "ELEMENT_NOT_INVOKABLE",
                                        "Element has no UIA RuntimeId and cannot be invoked",
                                    ));
                                }
                                if matches > 1 {
                                    return Err(fault(
                                        "AMBIGUOUS_IDENTITY",
                                        format!("{matches} elements share the exact name {label:?}; use one runtimeId instead"),
                                    ));
                                }
                                Ok(json!({
                                    "hwnd": hwnd.clone(),
                                    "label": label.clone(),
                                    "matches": matches,
                                    "element": facts,
                                }))
                            }),
                        Err(error) => Err(fault(error.0, error.1.clone())),
                    };
                    let _ = reply.try_send(result);
                }
                Query::LookupRuntime { hwnd, runtime_id, reply } => {
                    let Some(_paused) = gate.try_enter() else {
                        let _ = reply.try_send(Err(injection_busy()));
                        continue;
                    };
                    let result = match &uia {
                        Ok(uia) => uia
                            .element(hwnd.as_str(), runtime_id.as_slice())
                            .and_then(|element| uia.element_facts(&element))
                            .map(|facts| json!({ "hwnd": hwnd.clone(), "element": facts })),
                        Err(error) => Err(fault(error.0, error.1.clone())),
                    };
                    let _ = reply.try_send(result);
                }
                Query::Windows { reply } => {
                    let result = match &uia {
                        Ok(uia) => uia.top_level_windows(),
                        Err(error) => Err(fault(error.0, error.1.clone())),
                    };
                    let _ = reply.try_send(result);
                }
            }
        }
    });
    tx
}

// ---------------------------------------------------------------------------
// 通道 B：replacer_read_screen 的专用视觉线程（批3，计划 §0/§2/§8）。
//
// 镜像 query_thread/action_thread 的 SyncSender 镜像模式：独立线程 + 独立 COM
// 套间（CoInitializeEx MTA 前置，与 b1/b2 探针、uia 模块同款写法），不污染既
// 有线程的 COM 状态。capture/OCR 全链只读：零 SendInput/keybd_event/SendMessage、
// 零窗口消息注入，因此不加 panic 检查点（急停 = 切断注入，不切断感知）。
//
// 惰性初始化（拍板①摊销逻辑）：worker 启动不建管线；首次 read_screen 才建
// CaptureStream + WinrtOcr，该次请求吃 cold 并如实返回 buildMs；后续请求吃
// warm（批2 实测 ≈10ms capture + 0.6-1.5s OCR）。init 失败回 VISION_UNAVAILABLE
//（可重试，vision 线程存活，下次重建）。
// ---------------------------------------------------------------------------

/// region 宽高 sanity 上限（parse 层拒绝异常值；真实屏界 clamp 在 crop_bitmap）。
const REGION_MAX_DIM: i32 = 100_000;
/// capture 阶段超时（拍板口径：2s；next_frame 原生 timeout 参数）。
const VISION_CAPTURE_TIMEOUT_SECS: u64 = 2;
/// OCR 阶段超时（口径④ 方案 a：真超时，recv_timeout）。
const VISION_OCR_TIMEOUT_SECS: u64 = 10;
/// dispatch 对 vision 线程的总回复上限（2+10+冷启动裕量；TS 层 15s 兑底）。
const VISION_REPLY_TIMEOUT_SECS: u64 = 14;

enum Vision {
    ReadScreen { region: Option<Region>, reply: SyncSender<Result<Value, Fault>> },
    /// 批4 locate：同一条 capture→crop→OCR 管线，但回原始 OcrFrame（融合在
    /// dispatch 线程用纯函数做，vision 线程不感知 query/预算）。
    Locate { region: Option<Region>, reply: SyncSender<Result<OcrFrame, Fault>> },
}

fn vision_unavailable(message: String) -> Fault {
    fault("VISION_UNAVAILABLE", format!(
        "{message}; the vision pipeline is retryable: the next read_screen request rebuilds it. Zero injection was performed"))
}

fn vision_timeout(stage: &str) -> Fault {
    fault("VISION_TIMEOUT", format!(
        "{stage} exceeded its stage budget; zero injection was performed and the vision thread keeps serving. A timed-out OCR attempt may linger until process exit (bounded by the retry count; cleared on panic or restart)"))
}

/// OCR 子线程任务：位图进，命中出。引擎创建成本只在首个任务上如实上报。
struct OcrJob {
    image: Bitmap,
    reply: SyncSender<Result<(Vec<TextHit>, f64), String>>,
}

/// OCR 子线程句柄。WinRT 接口非 Send（windows 0.61 不为 COM 接口实现 Send），
/// 引擎不能在 vision 线程与 OCR 线程间搬运——子线程自己创建并常驻引擎，
/// recognize 阻塞调用隔离在子线程内，vision 线程 recv_timeout 实现真超时。
///
/// 诚实边界（口径④ + PLUGIN.md）：WinRT OCR 挂死概率极低；一旦超时，本句柄
/// 被丢弃、超时的 OCR 子线程可能阻塞滞留至进程退出（泄漏上限 = 用户重试次数，
/// 急停/重启即清零）；下一个请求起新 OCR 尝试（新子线程 + 新引擎，重建成本
/// 如实计入该次 buildMs）。
struct OcrWorker {
    jobs: SyncSender<OcrJob>,
    ready: mpsc::Receiver<Result<f64, String>>,
}

fn spawn_ocr_worker() -> OcrWorker {
    let (jobs, job_rx) = mpsc::sync_channel::<OcrJob>(1);
    let (ready_tx, ready) = mpsc::channel();
    std::thread::spawn(move || {
        let started = Instant::now();
        let engine = match WinrtOcr::create() {
            Ok(engine) => engine,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("OCR engine init failed: {error}")));
                return;
            }
        };
        let engine_ms = started.elapsed().as_secs_f64() * 1000.0;
        if ready_tx.send(Ok(engine_ms)).is_err() {
            return; // vision 线程已放弃本次请求
        }
        while let Ok(job) = job_rx.recv() {
            let result = WinrtOcr::recognize_full(&engine, &job.image)
                .map(|(hits, _raw_full)| (hits, 0.0)) // 后续任务引擎成本为零（常驻复用）
                .map_err(|error| format!("OCR recognize failed: {error}"));
            let _ = job.reply.try_send(result);
        }
    });
    OcrWorker { jobs, ready }
}

struct VisionPipeline {
    stream: CaptureStream,
    /// 全屏物理像素尺寸（bbox 坐标系口径③：width/height 与 click_xy 同源）。
    monitor_size: (i32, i32),
    ocr: Option<OcrWorker>,
}

/// bbox 进 JSON（口径③：region 裁剪后 bbox 保持全屏物理像素坐标——裁剪原点
/// (dx,dy) 由调用方加回，跨 region 可复用，与 click_xy 同源）。
fn bbox_json(bbox: TextBbox, dx: f32, dy: f32) -> Value {
    json!({"x": bbox.x + dx, "y": bbox.y + dy, "width": bbox.width, "height": bbox.height})
}

fn hit_json(hit: &TextHit, dx: f32, dy: f32) -> Value {
    json!({
        "text": hit.text,
        "bbox": bbox_json(hit.bbox, dx, dy),
        "words": hit.words.iter().map(|word| json!({
            "text": word.text,
            "bbox": bbox_json(word.bbox, dx, dy),
        })).collect::<Vec<Value>>(),
    })
}

/// 一次视觉管线全链的产物（批4 §2.1 抽取）：read_screen 与 locate 共用
/// capture → crop → OCR 管线；hits 的 bbox 是裁剪后的局部坐标，调用方加上
/// origin 还原全屏物理像素（口径③）。
struct OcrFrame {
    hits: Vec<TextHit>,
    origin: (i32, i32),
    monitor: (i32, i32),
    build_ms: f64,
    capture_ms: f64,
    ocr_ms: f64,
}

/// 管线阶段标签（批4 §2.5 失败处置的输入；纯数据，无设备依赖，可单测）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PipelineStage {
    Capture,
    Crop,
    Ocr,
}

/// 阶段失败后的管线处置（批4 §2.5，遗留②修复）：capture 失败 = CaptureStream
/// 已不可用（设备丢失/会话断开），整体重建以兑现 VISION_UNAVAILABLE 文案里
/// "下一个请求重建"的承诺；crop 的 INVALID_ARGUMENT 是纯参数问题（流仍健康），
/// OCR 失败已有子线程重建路径（pipeline.ocr = None），两者都保留 capture 流。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PipelineDisposition {
    Reset,
    Keep,
}

fn pipeline_disposition(stage: PipelineStage) -> PipelineDisposition {
    match stage {
        PipelineStage::Capture => PipelineDisposition::Reset,
        PipelineStage::Crop | PipelineStage::Ocr => PipelineDisposition::Keep,
    }
}

fn apply_disposition(pipeline: &mut Option<VisionPipeline>, stage: PipelineStage) {
    if pipeline_disposition(stage) == PipelineDisposition::Reset {
        *pipeline = None;
    }
}

/// capture → crop → OCR 全链（批4 §2.1 抽取）：惰性 init（cold 计入 build_ms）→
/// capture(2s) → 可选 region 裁剪 → OCR(10s 真超时)。每个失败点都保持 vision
/// 线程存活（可重试），零注入；capture 失败按 pipeline_disposition 整体重置。
fn run_ocr_pipeline(pipeline: &mut Option<VisionPipeline>, region: Option<Region>) -> Result<OcrFrame, Fault> {
    let mut build_ms = 0.0f64;

    // 1) 惰性 init：capture 流（首次吃 cold，如实返回 buildMs）。
    if pipeline.is_none() {
        let started = Instant::now();
        let stream = CaptureStream::new()
            .map_err(|error| vision_unavailable(format!("capture pipeline init: {error}")))?;
        let monitor_size = stream.item_size;
        *pipeline = Some(VisionPipeline { stream, monitor_size, ocr: None });
        build_ms += started.elapsed().as_secs_f64() * 1000.0;
    }
    let monitor = pipeline.as_ref().expect("pipeline ensured above").monitor_size;

    // 2) capture（2s；静止屏走缓存帧路径，见 capture.rs 帧语义注释）。临时借用
    //    收窄到本语句：失败后才能整体重置 pipeline（§2.5）。
    let capture_started = Instant::now();
    let captured = pipeline
        .as_mut()
        .expect("pipeline ensured above")
        .stream
        .next_frame(Duration::from_secs(VISION_CAPTURE_TIMEOUT_SECS));
    let capture_ms = capture_started.elapsed().as_secs_f64() * 1000.0;
    let frame = match captured {
        Ok(frame) => frame,
        Err(error) => {
            apply_disposition(pipeline, PipelineStage::Capture);
            return Err(vision_unavailable(format!("capture: {error}")));
        }
    };

    // 3) region 裁剪：只缩小送 OCR 的画面；bbox 由 (dx,dy) 加回全屏坐标（口径③）。
    //    完全出屏 → 面积 0 → INVALID_ARGUMENT（crop 失败不重置 capture 流）。
    let (image, origin) = match region {
        Some(region) => match crop_bitmap(&frame, region) {
            Ok((cropped, origin)) => (cropped, origin),
            Err(error) => {
                apply_disposition(pipeline, PipelineStage::Crop);
                return Err(fault("INVALID_ARGUMENT", error));
            }
        },
        None => (frame, (0, 0)),
    };

    // 4) OCR 子线程 ensure（惰性；超时/致命错误后下一个请求起新尝试）。
    //    §2.5 三态：进入 OCR 阶段不重置 capture 流（Ocr → Keep，此处为显式 no-op；
    //    仅 capture 失败会 Reset 整条管线）。
    apply_disposition(pipeline, PipelineStage::Ocr);
    let pipeline = pipeline.as_mut().expect("pipeline ensured above");
    if pipeline.ocr.is_none() {
        let started = Instant::now();
        let worker = spawn_ocr_worker();
        match worker.ready.recv_timeout(Duration::from_secs(VISION_OCR_TIMEOUT_SECS)) {
            Ok(Ok(_engine_ms)) => {
                build_ms += started.elapsed().as_secs_f64() * 1000.0; // 引擎创建成本如实计入
                pipeline.ocr = Some(worker);
            }
            Ok(Err(message)) => return Err(vision_unavailable(message)), // 引擎不可用：可重试
            Err(_) => return Err(vision_timeout("OCR engine init")), // 句柄丢弃，子线程滞留
        }
    }
    let worker = pipeline.ocr.as_ref().expect("ocr worker ensured above");
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    worker.jobs.try_send(OcrJob { image, reply: reply_tx })
        .map_err(|error| {
            pipeline.ocr = None; // 子线程意外退出：下个请求重建
            vision_unavailable(format!("OCR worker unavailable: {error}"))
        })?;

    // 5) OCR 真超时（口径④ 方案 a）：vision 线程 recv_timeout(10s)，超时回
    //    VISION_TIMEOUT 并继续服务；超时子线程可能滞留至进程退出（诚实边界，
    //    PLUGIN.md 同步声明；急停/重启清零）。
    let ocr_started = Instant::now();
    let hits = match reply_rx.recv_timeout(Duration::from_secs(VISION_OCR_TIMEOUT_SECS)) {
        Ok(Ok((hits, _engine_ms))) => hits,
        Ok(Err(message)) => {
            pipeline.ocr = None;
            return Err(vision_unavailable(message));
        }
        Err(_) => {
            pipeline.ocr = None; // 丢弃句柄；子线程滞留（诚实边界），下个请求新尝试
            return Err(vision_timeout("OCR recognize"));
        }
    };
    let ocr_ms = ocr_started.elapsed().as_secs_f64() * 1000.0;

    Ok(OcrFrame { hits, origin, monitor, build_ms, capture_ms, ocr_ms })
}

/// 一次 read_screen：run_ocr_pipeline + bbox 平移 + budget_fit。外部行为与批3
/// 完全一致（批4 §2.1 只做内部调用抽取：响应字段/顺序/内容零变化）。
fn read_screen_once(pipeline: &mut Option<VisionPipeline>, region: Option<Region>) -> Result<Value, Fault> {
    let frame = run_ocr_pipeline(pipeline, region)?;
    // 零图像字段（PNG 红线）：返回结构只有文字/bbox/计时，无任何图像字节。
    let (dx, dy) = (frame.origin.0 as f32, frame.origin.1 as f32);
    let lines: Vec<Value> = frame.hits.iter().map(|hit| hit_json(hit, dx, dy)).collect();
    let (response, _truncated) = budget_fit(
        frame.monitor.0.max(0) as u32,
        frame.monitor.1.max(0) as u32,
        lines,
        frame.build_ms,
        frame.capture_ms,
        frame.ocr_ms,
    );
    Ok(response)
}

fn vision_thread() -> SyncSender<Vision> {
    let (tx, rx) = mpsc::sync_channel::<Vision>(1);
    std::thread::spawn(move || {
        // CoInitializeEx MTA 前置（capture.rs 契约）：DXGI/WinRT 都要求 COM 已初始化。
        // 初始化失败不提前退出：CaptureStream::new 会报错 → VISION_UNAVAILABLE（可重试）。
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            );
        }
        let mut pipeline: Option<VisionPipeline> = None;
        while let Ok(request) = rx.recv() {
            match request {
                Vision::ReadScreen { region, reply } => {
                    let _ = reply.try_send(read_screen_once(&mut pipeline, region));
                }
                Vision::Locate { region, reply } => {
                    // 批4：locate 复用同一条 capture→crop→OCR 管线，命中原始
                    // OcrFrame（bbox 局部坐标 + 裁剪原点 + 监视器/计时），融合在
                    // dispatch 线程做（纯函数，零设备）。
                    let _ = reply.try_send(run_ocr_pipeline(&mut pipeline, region));
                }
            }
        }
    });
    tx
}
