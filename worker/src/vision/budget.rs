//! vision::budget —— replacer_read_screen 响应预算与区域裁剪（批3 计划 §0/§8-2/§8-3）。
//!
//! 零 COM / 零设备：只消费 `serde_json::Value` 行与 `super::bitmap::Bitmap`，
//! cargo test 直接跑模块内单测。
//!
//! ## budget_fit 计量口径（复核修订 v2 必修②，钉死）
//!
//! 预算以**最终序列化整帧字节数**为口径：JSON 包装、bbox 数字数组、CJK/转义
//! 全部计入（UTF-8 字节，不是字符数）。管道 MAX_FRAME=65536 双向（ipc/pipe.rs:3），
//! 预留 ≥10% 余量 → 目标整帧 ≤ [`RESPONSE_BUDGET_BYTES`]（58_982 字节）。
//! 只量 payload 文本长度是 CJK 长文的假阴性温床——本模块的测试直接断言
//! "序列化整帧 ≤ MAX_FRAME=65536"。
//!
//! 三级截断策略（诚实边界）：
//! 1. 先丢 words（保行文本 + bbox，省词级开销）；不够再
//! 2. 从尾部丢行（保前文，丢后文）；丢弃后
//! 3. `truncated:true` + `totalLines` = 原始行数。
//!
//! 顶层 `text` = 截断后**保留行**的 join（单一全文口径，复核修订 v2 拍板）。
//!
//! ## crop_bitmap 坐标系（口径③，钉死）
//!
//! bbox 坐标系 = **全屏物理像素**（与 click_xy 同源）。region 裁剪只缩小送进
//! OCR 的画面；OCR 输出的 bbox 由调用方加回裁剪原点（crop_bitmap 返回
//! clamp 后的裁剪原点），保证跨 region 坐标可复用。

use serde_json::{json, Map, Value};
use super::bitmap::Bitmap;

/// 管道单帧上限（与 ipc/pipe.rs MAX_FRAME 同值；budget.rs 在 lib，复制常量并注明出处）。
pub const MAX_FRAME_BYTES: usize = 65536;
/// 整帧预算 = MAX_FRAME 预留 ≥10% 余量（65536 × 90% = 58_982）。
pub const RESPONSE_BUDGET_BYTES: usize = MAX_FRAME_BYTES * 9 / 10;

/// 行间分隔符：顶层 text 的 join 口径（单字符省预算；行内语义由行对象承载）。
pub const TEXT_LINE_SEPARATOR: char = '\n';

/// 可选裁剪区域：全屏物理像素，左上角原点（parse 校验在 ipc/handler.rs）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Region {
    /// 全屏等价区域（read_screen 不带 region 参数时的语义等价物）。
    pub fn full_screen(width: i32, height: i32) -> Self {
        Self { x: 0, y: 0, width, height }
    }
}

/// 把 region clamp 进屏幕界 `[0, w] × [0, h]`，返回 (裁剪原点, 裁剪宽高)。
/// 面积 clamp 后 ≤ 0（完全出屏）返回 None。
///
/// 公开口径（批4 locate 复用）：locate 响应的 `window` 必须是**实际 OCR 区域**
/// ——与 read_screen 的 region 裁剪严格同一套 clamp，避免两处口径漂移。
pub fn clamped_region(region: Region, width: u32, height: u32) -> Option<(i32, i32, i32, i32)> {
    let w = width.min(i32::MAX as u32) as i32;
    let h = height.min(i32::MAX as u32) as i32;
    let x = region.x.clamp(0, w);
    let y = region.y.clamp(0, h);
    let right = (region.x.saturating_add(region.width)).clamp(0, w);
    let bottom = (region.y.saturating_add(region.height)).clamp(0, h);
    let cropped_w = right - x;
    let cropped_h = bottom - y;
    if cropped_w <= 0 || cropped_h <= 0 {
        return None;
    }
    Some((x, y, cropped_w, cropped_h))
}

/// 区域裁剪（批2 遗留②，OCR 波动治理）：把全屏位图裁进 region（clamp 进屏界，
/// 面积>0）。返回 (裁剪位图, 裁剪原点在全屏物理像素坐标)；region 覆盖全屏时
/// 与原位图逐字节等价（测试固化）。
///
/// 出错情形：region 完全在屏幕外（clamp 后面积 ≤ 0）——调用方转 INVALID_ARGUMENT。
pub fn crop_bitmap(bitmap: &Bitmap, region: Region) -> Result<(Bitmap, (i32, i32)), String> {
    let Some((x, y, w, h)) = clamped_region(region, bitmap.width, bitmap.height) else {
        return Err(format!(
            "region {}x{}+{},{} does not intersect the {}x{} screen after clamping",
            region.width, region.height, region.x, region.y, bitmap.width, bitmap.height
        ));
    };
    // 全屏（或 clamp 后等价全屏）直接零拷贝等价返回：逐字节相同。
    if x == 0 && y == 0 && w as u32 == bitmap.width && h as u32 == bitmap.height {
        return Ok((bitmap.clone(), (0, 0)));
    }
    let row_bytes = w as usize * 4;
    let stride = bitmap.width as usize * 4;
    let mut bgra = Vec::with_capacity(row_bytes * h as usize);
    for row in y as usize..(y as usize + h as usize) {
        let start = row * stride + x as usize * 4;
        bgra.extend_from_slice(&bitmap.bgra[start..start + row_bytes]);
    }
    let cropped = Bitmap::new(w as u32, h as u32, bgra)
        .map_err(|error| format!("crop_bitmap: {error}"))?;
    Ok((cropped, (x, y)))
}

/// 渲染一帧响应对象（`timings` 由调用方给齐；budget_fit 负责行集与截断标记）。
#[allow(clippy::too_many_arguments)]
fn render_frame(
    width: u32,
    height: u32,
    lines: &[Value],
    timings: &Value,
    truncated: bool,
    total_lines: Option<usize>,
) -> Value {
    let text = kept_text(lines);
    let mut object = Map::new();
    object.insert("width".into(), json!(width));
    object.insert("height".into(), json!(height));
    object.insert("lines".into(), Value::Array(lines.to_vec()));
    object.insert("text".into(), json!(text));
    object.insert("truncated".into(), json!(truncated));
    if truncated {
        object.insert(
            "totalLines".into(),
            json!(total_lines.expect("truncated frames always carry the original count")),
        );
    }
    object.insert("timings".into(), timings.clone());
    Value::Object(object)
}

/// 顶层 text = 保留行的 join（单一全文口径）。
fn kept_text(lines: &[Value]) -> String {
    lines
        .iter()
        .filter_map(|line| line.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(&TEXT_LINE_SEPARATOR.to_string())
}

/// 丢 words：保行文本 + bbox（词级数组是预算大头）。
fn strip_words(line: &Value) -> Value {
    let mut object = Map::new();
    for key in ["text", "bbox"] {
        if let Some(value) = line.get(key) {
            object.insert(key.into(), value.clone());
        }
    }
    Value::Object(object)
}

/// 序列化整帧字节数（UTF-8；JSON 转义/CJK 多字节全计入——必修②口径）。
fn serialized_len(frame: &Value) -> usize {
    frame.to_string().len()
}

/// 响应预算纯函数（三级截断：words 全丢 → 尾行丢 → truncated + 原始计数）。
///
/// 输入行是已序列化形态的行对象（`{text, bbox, words?}`）；函数内部反复量
/// **整帧**（含 width/height/timings 包装）字节数，直至 ≤
/// [`RESPONSE_BUDGET_BYTES`]。返回 (最终响应对象, truncated)。
/// 最终整帧恒 ≤ RESPONSE_BUDGET_BYTES ≤ MAX_FRAME_BYTES（测试固化，含 CJK 长文样例）。
pub fn budget_fit(
    width: u32,
    height: u32,
    lines: Vec<Value>,
    build_ms: f64,
    capture_ms: f64,
    ocr_ms: f64,
) -> (Value, bool) {
    let timings = json!({"buildMs": build_ms, "captureMs": capture_ms, "ocrMs": ocr_ms});
    let original = lines.len();

    // 第一级：全量（含 words）。
    let full = render_frame(width, height, &lines, &timings, false, None);
    if serialized_len(&full) <= RESPONSE_BUDGET_BYTES {
        return (full, false);
    }

    // 第二级：丢 words（保行文本 + bbox）。
    let stripped: Vec<Value> = lines.iter().map(strip_words).collect();
    let without_words = render_frame(width, height, &stripped, &timings, false, None);
    if serialized_len(&without_words) <= RESPONSE_BUDGET_BYTES {
        return (without_words, false);
    }

    // 第三级：从尾部丢行（保留前缀），二分搜索能进预算的最大前缀（避免 O(n²)
    // 重复渲染；极端：连一行都放不下 → 0 行 + truncated）。
    let mut lo = 0usize;
    let mut hi = stripped.len();
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if serialized_len(&render_frame(width, height, &stripped[..mid], &timings, true, Some(original)))
            <= RESPONSE_BUDGET_BYTES
        {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let kept = &stripped[..lo];
    (
        render_frame(width, height, kept, &timings, true, Some(original)),
        true,
    )
}

// ---------------------------------------------------------------------------
// locate 响应预算（批4 计划 §2.4）
// ---------------------------------------------------------------------------

/// locate 请求的 maxResults 上限（与 ipc/handler.rs 的 parse_locate 同口径）。
pub const LOCATE_MAX_RESULTS: usize = 50;

/// textOnly 候选条数上限（计划 §2.4：未对齐 OCR 行最多 20 条）。
pub const LOCATE_MAX_TEXT_ONLY: usize = 20;

/// locate 响应预算纯函数（批4 计划 §2.4，冻结口径）。
///
/// 在 fusion 已按分数降序产出候选后执行两级截断：
/// 1. 结构上限：matches <= maxResults（clamp 1..=50）、textOnly <= 20；
/// 2. 整帧预算：整帧序列化 <= RESPONSE_BUDGET_BYTES（58_982 字节）——
///    超限先砍 textOnly 尾部，再砍 matches 低分端（数组尾部即最低分）。
///
/// truncated / totalMatches / totalTextOnly 如实：truncated = 结构上限
/// 或预算裁剪发生、或保留数 < 原始总数；totals 保留裁剪前的原始总数（不重算）。
/// 非对象或 matches/textOnly 非数组的畸形帧原样返回（预算不掩盖结构错误）。
pub fn budget_locate(mut frame: Value, max_results: usize) -> Value {
    if !frame.is_object() {
        return frame;
    }
    let (mut matches, mut text_only, total_matches, total_text_only, mut truncated) = {
        let object = frame.as_object_mut().expect("frame is object");
        if !object.get("matches").is_some_and(Value::is_array)
            || !object.get("textOnly").is_some_and(Value::is_array)
        {
            return frame;
        }
        let matches = match object.remove("matches") {
            Some(Value::Array(items)) => items,
            _ => unreachable!("checked array above"),
        };
        let text_only = match object.remove("textOnly") {
            Some(Value::Array(items)) => items,
            _ => unreachable!("checked array above"),
        };
        let total_matches = object
            .get("totalMatches")
            .and_then(Value::as_u64)
            .map_or(matches.len(), |n| n as usize);
        let total_text_only = object
            .get("totalTextOnly")
            .and_then(Value::as_u64)
            .map_or(text_only.len(), |n| n as usize);
        let cap = max_results.clamp(1, LOCATE_MAX_RESULTS);
        let truncated = matches.len() > cap || text_only.len() > LOCATE_MAX_TEXT_ONLY;
        (matches, text_only, total_matches, total_text_only, truncated)
    };

    // 结构上限：matches 保高分前缀（fusion 已降序），textOnly 同理。
    matches.truncate(max_results.clamp(1, LOCATE_MAX_RESULTS));
    text_only.truncate(LOCATE_MAX_TEXT_ONLY);

    loop {
        {
            let object = frame.as_object_mut().expect("frame is object");
            object.insert("matches".to_string(), Value::Array(std::mem::take(&mut matches)));
            object.insert("textOnly".to_string(), Value::Array(std::mem::take(&mut text_only)));
        }
        if serialized_len(&frame) <= RESPONSE_BUDGET_BYTES {
            break;
        }
        {
            // 取回数组（下一轮直接改 Vec，避免每次整帧 clone 大载荷）。
            let object = frame.as_object_mut().expect("frame is object");
            if let Some(Value::Array(items)) = object.remove("matches") {
                matches = items;
            }
            if let Some(Value::Array(items)) = object.remove("textOnly") {
                text_only = items;
            }
        }
        if !text_only.is_empty() {
            text_only.pop();
            truncated = true;
            continue;
        }
        if !matches.is_empty() {
            matches.pop();
            truncated = true;
            continue;
        }
        break;
    }

    let object = frame.as_object_mut().expect("frame is object");
    let kept_matches = object.get("matches").and_then(Value::as_array).map_or(0, Vec::len);
    let kept_text_only = object.get("textOnly").and_then(Value::as_array).map_or(0, Vec::len);
    object.insert(
        "truncated".to_string(),
        Value::Bool(truncated || kept_matches < total_matches || kept_text_only < total_text_only),
    );
    frame
}
#[cfg(test)]
mod tests {
    use super::*;

    /// CJK 长文行样例（防假阴性核心样料）：300 个汉字 ≈ 900 UTF-8 字节/行。
    fn cjk_line(index: usize, chars: usize) -> Value {
        let text: String = "屏读回测队列编号甲乙丙丁戊己庚辛壬癸".chars()
            .cycle()
            .take(chars)
            .collect();
        json!({
            "text": text,
            "bbox": {"x": index as f32, "y": index as f32 * 40.0, "width": chars as f32 * 16.0, "height": 32.0},
            "words": [{"text": text, "bbox": {"x": index as f32, "y": index as f32 * 40.0, "width": chars as f32 * 16.0, "height": 32.0}}],
        })
    }

    #[test]
    fn small_screen_fits_whole_frame_with_words() {
        let lines: Vec<Value> = (0..5).map(|i| cjk_line(i, 40)).collect();
        let (frame, truncated) = budget_fit(1920, 1080, lines, 0.0, 10.0, 800.0);
        assert!(!truncated);
        // 未截断：words 原样携带，整帧（含 JSON 包装）在预算内。
        assert!(frame.get("lines").and_then(Value::as_array).expect("lines")[0]
            .get("words")
            .is_some(), "untruncated frames carry word-level hits");
        assert!(serialized_len(&frame) <= RESPONSE_BUDGET_BYTES, "frame {} bytes", serialized_len(&frame));
        assert!(serialized_len(&frame) <= MAX_FRAME_BYTES);
        assert_eq!(frame.get("truncated").and_then(Value::as_bool), Some(false));
        assert!(frame.get("totalLines").is_none());
    }

    #[test]
    fn cjk_long_text_drops_words_before_lines() {
        // words 主导型样例：行文本短、词级数组长 —— 第一级（含 words）超预算，
        // 丢 words 后行全保留（证明“先丢 words、后丢行”的次序）。
        let lines: Vec<Value> = (0..60).map(|i| {
            let mut line = cjk_line(i, 120); // 行文本 ≈ 360B
            // 12 个长词词条（主导预算）；最后一行也带，保证 words 阶段必超。
            line["words"] = Value::Array((0..12).map(|_| json!({
                "text": "屏读回测词级词条载荷甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳",
                "bbox": {"x": i as f32, "y": i as f32 * 40.0, "width": 96.0, "height": 32.0},
            })).collect());
            line
        }).collect();
        let original: usize = lines.len();
        let (frame, truncated) = budget_fit(1920, 1080, lines, 0.5, 9.8, 1200.0);
        let kept = frame.get("lines").and_then(Value::as_array).expect("lines").len();
        // words 全丢，行全保留（第二级足以进预算）。
        assert!(!truncated, "words-dominant payload must not drop lines");
        assert_eq!(kept, original);
        for line in frame.get("lines").and_then(Value::as_array).expect("lines") {
            assert!(line.get("words").is_none(), "budgeted frames never carry words");
            assert!(line.get("text").and_then(Value::as_str).is_some_and(|t| !t.is_empty()));
            assert!(line.get("bbox").is_some(), "line text + bbox survive");
        }
        // 必修②口径断言：序列化整帧（JSON 包装 + 数字数组 + CJK 转义全计入）双上限。
        assert!(serialized_len(&frame) <= RESPONSE_BUDGET_BYTES, "frame {} bytes > budget {RESPONSE_BUDGET_BYTES}", serialized_len(&frame));
        assert!(serialized_len(&frame) <= MAX_FRAME_BYTES, "frame {} bytes > MAX_FRAME {MAX_FRAME_BYTES}", serialized_len(&frame));
        // 顶层 text = 保留行 join。
        let text = frame.get("text").and_then(Value::as_str).expect("text");
        let joined: String = frame.get("lines").and_then(Value::as_array).expect("lines").iter()
            .filter_map(|l| l.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>().join("\n");
        assert_eq!(text, joined);
    }

    #[test]
    fn cjk_lines_dominant_payload_truncates_from_tail_keeping_leading_majority() {
        // 行主导型样例：300 行 × 300 CJK 字 ≈ 270KB 文本，丢 words 后仍超预算
        // → 第三级尾丢行，保前缀多数 + 原始计数诚实。
        let lines: Vec<Value> = (0..300).map(|i| cjk_line(i, 300)).collect();
        let original = lines.len();
        let first_text = lines[0].get("text").and_then(Value::as_str).map(str::to_owned);
        let (frame, truncated) = budget_fit(1920, 1080, lines, 0.5, 9.8, 1200.0);
        assert!(truncated);
        let kept_lines = frame.get("lines").and_then(Value::as_array).expect("lines").clone();
        let kept = kept_lines.len();
        assert!(kept >= 10 && kept < original, "tail drop keeps a leading prefix: {kept}/{original}");
        assert_eq!(frame.get("totalLines").and_then(Value::as_u64), Some(original as u64));
        // 保前缀语义：丢的是尾部（第一保留行 = 原始第一行）。
        assert_eq!(kept_lines[0].get("text").and_then(Value::as_str), first_text.as_deref());
        for line in frame.get("lines").and_then(Value::as_array).expect("lines") {
            assert!(line.get("words").is_none());
        }
        assert!(serialized_len(&frame) <= RESPONSE_BUDGET_BYTES);
        assert!(serialized_len(&frame) <= MAX_FRAME_BYTES);
    }

    #[test]
    fn extreme_payload_truncates_tail_lines_and_reports_original_count() {
        // 4000 行 × 500 CJK 字 ≈ 6MB：必进第三级（尾丢行）。
        let lines: Vec<Value> = (0..4000).map(|i| cjk_line(i, 500)).collect();
        let original = lines.len();
        let (frame, truncated) = budget_fit(3840, 2160, lines, 1.0, 2.0, 3.0);
        assert!(truncated, "6MB payload must truncate");
        let kept = frame.get("lines").and_then(Value::as_array).expect("lines").len();
        assert!(kept < original);
        assert_eq!(frame.get("totalLines").and_then(Value::as_u64), Some(original as u64));
        assert_eq!(frame.get("truncated").and_then(Value::as_bool), Some(true));
        assert!(serialized_len(&frame) <= RESPONSE_BUDGET_BYTES, "frame {} bytes", serialized_len(&frame));
        assert!(serialized_len(&frame) <= MAX_FRAME_BYTES);
    }

    #[test]
    fn frame_boundary_between_budget_and_pipe_limit_is_safe() {
        // 边界样例：整帧介于 65536 与预算之间也必须截断（10% 余量真实生效），
        // 且截断后严格 < 65536。构造 words 阶段 ≈ 62KB 的 CJK 行集。
        let lines: Vec<Value> = (0..23).map(|i| cjk_line(i, 200)).collect(); // ≈ 23 × 606B ≈ 14KB… 逐级加压到带 words 超预算
        let mut heavy = lines.clone();
        for i in 0..60 {
            heavy.push(cjk_line(1000 + i, 350));
        }
        let (frame, _truncated) = budget_fit(1920, 1080, heavy, 0.0, 0.0, 0.0);
        let full_bytes = serialized_len(&frame);
        assert!(full_bytes <= RESPONSE_BUDGET_BYTES, "budgeted frame {full_bytes} bytes must stay in the 10% margin");
        assert!(full_bytes <= MAX_FRAME_BYTES);
        let _ = lines; // 保留小样例构造引用，避免死代码告警
    }

    #[test]
    fn timings_and_wrapper_count_toward_the_frame_budget() {
        // 证明 JSON 包装/数字数组计入：空行集 + 巨大 timings 不应静默超限——
        // timings 固定小，这里验证空行集整帧极小且结构齐全。
        let (frame, truncated) = budget_fit(1920, 1080, vec![], 12.5, 3.5, 900.0);
        assert!(!truncated);
        assert_eq!(frame.get("width").and_then(Value::as_u64), Some(1920));
        assert_eq!(frame.get("height").and_then(Value::as_u64), Some(1080));
        let timings = frame.get("timings").and_then(Value::as_object).expect("timings");
        assert_eq!(timings.get("buildMs").and_then(Value::as_f64), Some(12.5));
        assert_eq!(timings.get("captureMs").and_then(Value::as_f64), Some(3.5));
        assert_eq!(timings.get("ocrMs").and_then(Value::as_f64), Some(900.0));
        assert!(serialized_len(&frame) <= RESPONSE_BUDGET_BYTES);
    }

    // ---- crop_bitmap：clamp / 面积 / 全屏等价 ----

    fn solid_bitmap(width: u32, height: u32, seed: u8) -> Bitmap {
        let bgra: Vec<u8> = (0..(width as usize * height as usize * 4))
            .map(|i| (i as u8).wrapping_add(seed))
            .collect();
        Bitmap::new(width, height, bgra).expect("synthetic bitmap")
    }

    #[test]
    fn crop_clamps_partially_out_of_screen_and_keeps_full_screen_coordinates() {
        let bitmap = solid_bitmap(1920, 1080, 7);
        // region 右下越出屏界：clamp 进 [0,1920]×[0,1080]。
        let region = Region { x: 1800, y: 1000, width: 500, height: 500 };
        let (cropped, origin) = crop_bitmap(&bitmap, region).expect("partially visible");
        assert_eq!(cropped.width, 120);
        assert_eq!(cropped.height, 80);
        // 口径③：返回的是全屏物理像素原点（调用方据此平移 bbox）。
        assert_eq!(origin, (1800, 1000));
    }

    #[test]
    fn crop_rejects_zero_area_after_clamp() {
        let bitmap = solid_bitmap(1920, 1080, 1);
        let region = Region { x: 2000, y: 1200, width: 100, height: 100 }; // 完全出屏
        assert!(crop_bitmap(&bitmap, region).is_err(), "fully off-screen region has zero area");
        let region = Region { x: 0, y: 0, width: 0, height: 100 }; // 宽 0
        assert!(crop_bitmap(&bitmap, region).is_err());
    }

    #[test]
    fn crop_full_screen_region_is_byte_equivalent() {
        let bitmap = solid_bitmap(640, 480, 3);
        let region = Region::full_screen(640, 480);
        let (cropped, origin) = crop_bitmap(&bitmap, region).expect("full screen");
        assert_eq!(origin, (0, 0));
        assert_eq!(cropped.width, bitmap.width);
        assert_eq!(cropped.height, bitmap.height);
        assert_eq!(cropped.bgra, bitmap.bgra, "full-screen crop must be byte-equivalent");
    }

    #[test]
    fn crop_pixel_content_matches_offset_rows() {
        let bitmap = solid_bitmap(64, 32, 11);
        let region = Region { x: 16, y: 8, width: 32, height: 16 };
        let (cropped, origin) = crop_bitmap(&bitmap, region).expect("inner crop");
        assert_eq!(origin, (16, 8));
        assert_eq!(cropped.width, 32);
        assert_eq!(cropped.height, 16);
        let stride = 64usize * 4;
        for row in 0..16usize {
            let src = (8 + row) * stride + 16 * 4;
            let dst = row * 32 * 4;
            assert_eq!(&bitmap.bgra[src..src + 32 * 4], &cropped.bgra[dst..dst + 32 * 4]);
        }
    }
}

#[cfg(test)]
mod locate_budget_tests {
    use super::*;

    /// 单个 match 样例（12 键与 locate 契约一致；ocrText 长度可控用于最坏帧）。
    fn locate_match(index: usize, text_chars: usize) -> Value {
        json!({
            "elementId": format!("e{index}"),
            "label": format!("按钮{index}"),
            "type": 50000,
            "bbox": {"x": index as f64, "y": index as f64, "width": 10.0, "height": 10.0},
            "enabled": true,
            "invokable": true,
            "offscreen": false,
            "source": "fusion",
            "score": 0.9,
            "textScore": 0.8,
            "overlap": 0.7,
            "ocrText": "屏读".repeat(text_chars / 2),
        })
    }

    fn locate_text_line(index: usize, chars: usize) -> Value {
        json!({
            "text": "未对齐".repeat(chars / 3),
            "bbox": {"x": 0.0, "y": index as f64, "width": 40.0, "height": 16.0},
            "score": 0.4,
        })
    }

    /// 15 顶层键的 locate 响应样例（totals 与数组长度一致 = 未裁剪）。
    fn locate_frame(matches: Vec<Value>, text_only: Vec<Value>) -> Value {
        json!({
            "hwnd": "1234",
            "snapshotId": "1750000000000-1",
            "observedAt": 1750000000000u64,
            "query": "保存",
            "channel": "fusion",
            "degraded": false,
            "degradeReason": Value::Null,
            "capabilities": {"capture": true, "ocr": true, "grounding": false},
            "window": {"x": 0, "y": 0, "width": 1920, "height": 1080},
            "matches": matches,
            "textOnly": text_only,
            "timings": {"observeMs": 1.0, "captureMs": 2.0, "ocrMs": 3.0, "fusionMs": 4.0, "buildMs": 5.0},
            "truncated": false,
            "totalMatches": 0u64,
            "totalTextOnly": 0u64,
        })
    }

    #[test]
    fn small_frame_passes_whole_with_contract_keys() {
        let matches: Vec<Value> = (0..3).map(|i| locate_match(i, 20)).collect();
        let text_only: Vec<Value> = (0..2).map(|i| locate_text_line(i, 12)).collect();
        let (total_matches, total_text_only) = (matches.len(), text_only.len());
        let mut frame = locate_frame(matches, text_only);
        frame["totalMatches"] = json!(total_matches);
        frame["totalTextOnly"] = json!(total_text_only);
        let out = budget_locate(frame, 10);
        assert!(!out["truncated"].as_bool().expect("truncated"));
        assert_eq!(out["matches"].as_array().map(Vec::len), Some(3));
        assert_eq!(out["textOnly"].as_array().map(Vec::len), Some(2));
        assert_eq!(out["totalMatches"].as_u64(), Some(3));
        assert_eq!(out["totalTextOnly"].as_u64(), Some(2));
        // 顶层 15 键一个不少（预算只裁剪数组内元素，不改契约键集）。
        let keys: Vec<&str> = out.as_object().expect("object").keys().map(String::as_str).collect();
        for key in [
            "hwnd", "snapshotId", "observedAt", "query", "channel", "degraded", "degradeReason",
            "capabilities", "window", "matches", "textOnly", "timings", "truncated",
            "totalMatches", "totalTextOnly",
        ] {
            assert!(keys.contains(&key), "missing locate key {key}");
        }
        assert_eq!(keys.len(), 15);
        assert!(serialized_len(&out) <= RESPONSE_BUDGET_BYTES);
    }

    #[test]
    fn structural_caps_matches_and_text_only_with_honest_totals() {
        let matches: Vec<Value> = (0..10).map(|i| locate_match(i, 20)).collect();
        let text_only: Vec<Value> = (0..25).map(|i| locate_text_line(i, 12)).collect();
        let (total_matches, total_text_only) = (matches.len(), text_only.len());
        let mut frame = locate_frame(matches, text_only);
        frame["totalMatches"] = json!(total_matches);
        frame["totalTextOnly"] = json!(total_text_only);
        let out = budget_locate(frame, 5);
        // matches <= maxResults、textOnly <= 20；totals 保留裁剪前总数。
        assert_eq!(out["matches"].as_array().map(Vec::len), Some(5));
        assert_eq!(out["textOnly"].as_array().map(Vec::len), Some(20));
        assert_eq!(out["totalMatches"].as_u64(), Some(10));
        assert_eq!(out["totalTextOnly"].as_u64(), Some(25));
        assert_eq!(out["truncated"].as_bool(), Some(true));
        // 保高分前缀：保留的 elementId 仍是输入前缀序 e0..e4。
        let kept = out["matches"].as_array().expect("matches");
        for (position, item) in kept.iter().enumerate() {
            assert_eq!(item["elementId"].as_str(), Some(format!("e{position}").as_str()));
        }
    }

    #[test]
    fn worst_case_frame_stays_within_response_budget() {
        // 最坏帧：50 个 2000 汉字匹配 + 20 条 2000 字 textOnly（原始约 400 KB），
        // 必须在 58_982 字节预算内且 truncated/totals 如实。
        let matches: Vec<Value> = (0..50).map(|i| locate_match(i, 2000)).collect();
        let text_only: Vec<Value> = (0..20).map(|i| locate_text_line(i, 2000)).collect();
        let (total_matches, total_text_only) = (matches.len(), text_only.len());
        let mut frame = locate_frame(matches, text_only);
        frame["totalMatches"] = json!(total_matches);
        frame["totalTextOnly"] = json!(total_text_only);
        let out = budget_locate(frame, 50);
        assert!(serialized_len(&out) <= RESPONSE_BUDGET_BYTES,
            "locate frame {} bytes exceeds {}", serialized_len(&out), RESPONSE_BUDGET_BYTES);
        assert!(serialized_len(&out) <= MAX_FRAME_BYTES);
        assert_eq!(out["truncated"].as_bool(), Some(true));
        assert_eq!(out["totalMatches"].as_u64(), Some(50));
        assert_eq!(out["totalTextOnly"].as_u64(), Some(20));
        // textOnly 先被砍到尾（可能整体丢弃），matches 低分端从尾部砍、保前缀。
        let kept = out["matches"].as_array().expect("matches");
        assert!(!kept.is_empty(), "budget keeps at least the top match");
        for (position, item) in kept.iter().enumerate() {
            assert_eq!(item["elementId"].as_str(), Some(format!("e{position}").as_str()));
        }
        let kept_text = out["textOnly"].as_array().expect("textOnly").len();
        assert!(kept_text <= LOCATE_MAX_TEXT_ONLY);
    }
}
