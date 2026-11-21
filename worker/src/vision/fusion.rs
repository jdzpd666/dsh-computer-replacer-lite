//! vision::fusion —— UIA 元素与 OCR 文本行的融合打分（批4 计划 §2.3）。
//!
//! 零 COM / 零设备：纯函数 + 纯数据，`cargo test` 直接跑模块内单测。
//!
//! ## 契约冻结（公式 / 常量 / 排序不得改动，见 docs/plan-batch4-locate-20261121.md §2.3）
//!
//! - [`normalize`]：trim → 全角空格转半角 → 连续空白折叠为单空格 → ASCII
//!   小写 → 去首尾引号 → 去尾部分隔符（`:` `：` `。` `．` `,` `，` `、` `…`）。
//! - [`similarity`]：相等 1.0；任一空 0.0；包含 = 0.6 + 0.4 × (minChars/maxChars)；
//!   否则 bigram Dice = 2|A∩B| / (|A|+|B|)，单字符退化为字符集 Dice。
//! - [`overlap`]：交集面积 / min(面积a, 面积b)（包含度）；无交集 0.0。
//! - [`align`]：score = 0.65×similarity + 0.35×overlap；接受条件 label 非空、
//!   元素面积 > 0、score ≥ 0.55；每条 OCR 行最多命中一个元素（取最高分，同分
//!   overlap 高者，再元素 id 字典序最小）；同一元素只保留最高分行，其余行
//!   **不**重复计入 text_only；输出排序 score 降 → bbox.y 升 → bbox.x 升 → id
//!   升（world.stable_nodes 迭代顺序不确定，确定性排序是本层契约）。
//! - query 模式 [`extract_query_hits`]：元素 sim = max(sim(query,label),
//!   sim(query,命中的 OCR 行))；score = 0.7×sim + 0.3×命中行 overlap（无命中行
//!   overlap = 0）；保留 score ≥ minScore；textOnly = 未接受行中
//!   sim(query,行文本) ≥ minScore 者。
//!
//! 降级链（OCR/capture 不可用时的 uia_only 通道）用 [`uia_only_hits`]：同一
//! 打分公式但 overlap 恒 0、source 恒 `uia`、ocrText 恒 null。

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// 对齐打分权重（§2.3 契约冻结）。
pub const LABEL_WEIGHT: f64 = 0.65;
/// 对齐打分权重（§2.3 契约冻结）。
pub const OVERLAP_WEIGHT: f64 = 0.35;
/// 对齐接受阈值（§2.3 契约冻结）。
pub const ACCEPT_SCORE: f64 = 0.55;
/// query 模式文本权重（§2.3 契约冻结）。
pub const QUERY_TEXT_WEIGHT: f64 = 0.7;
/// query 模式几何权重（§2.3 契约冻结）。
pub const QUERY_OVERLAP_WEIGHT: f64 = 0.3;
/// textOnly 结构上限（§2.4，防预算浪费）。
pub const TEXT_ONLY_CAP: usize = 20;

/// 融合用矩形：全屏物理像素（f64 复用同一套几何函数；输出时四舍五入为整数像素）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// 从 JSON `{x,y,width,height}`（UIA bbox / OCR bbox）构造；四键必须都是
    /// 有限数字，否则 None（缺失 bbox 的元素不进入融合，避免输出无坐标命中）。
    pub fn from_json(value: &Value) -> Option<Rect> {
        let field = |key: &str| -> Option<f64> {
            value.get(key)?.as_f64().filter(|number| number.is_finite())
        };
        Some(Rect { x: field("x")?, y: field("y")?, width: field("width")?, height: field("height")? })
    }

    /// 面积（宽高为负时按 0 计：契约的"元素面积 > 0"闸门）。
    pub fn area(&self) -> f64 {
        self.width.max(0.0) * self.height.max(0.0)
    }

    /// 输出 bbox：全屏物理像素整数（模型直接用坐标，避免 0.5px 噪声）。
    pub fn json(&self) -> Value {
        json!({
            "x": pixel(self.x),
            "y": pixel(self.y),
            "width": pixel(self.width),
            "height": pixel(self.height),
        })
    }
}

/// 像素值：四舍五入到整数（与 click_xy 同源的全屏物理像素口径）。
fn pixel(value: f64) -> Value {
    json!(value.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64)
}

/// 引号集合（normalize 去首尾引号）。
const QUOTES: [char; 6] = ['"', '\'', '“', '”', '‘', '’'];
/// 尾部分隔符集合（normalize 去尾部分隔符；注意不含 ASCII 句点，契约如此）。
const TRAILING_SEPARATORS: [char; 8] = [':', '：', '。', '．', ',', '，', '、', '…'];

/// 归一化（§2.3 第1条，契约冻结）：trim → 全角空格转半角 → 连续空白折叠为单
/// 空格 → ASCII 小写（仅 ASCII，非 ASCII 大小写保持原样）→ 去首尾引号 → 去尾
/// 部分隔符。分隔符与引号可能交替出现（`“确定”： `），循环到稳定。
pub fn normalize(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    for character in text.chars() {
        let character = if character == '\u{3000}' { ' ' } else { character };
        if character.is_whitespace() {
            // 折叠：跳过开头空白与连续空白（全角空格已在上一步转为半角）。
            if !folded.is_empty() && !folded.ends_with(' ') {
                folded.push(' ');
            }
        } else if character.is_ascii() {
            folded.push(character.to_ascii_lowercase());
        } else {
            folded.push(character);
        }
    }
    let mut result = folded.trim().to_owned();
    loop {
        let before = result.len();
        result = result.trim_matches(|character| QUOTES.contains(&character)).trim().to_owned();
        result = result.trim_end_matches(|character| TRAILING_SEPARATORS.contains(&character))
            .trim_end()
            .to_owned();
        if result.len() == before {
            return result;
        }
    }
}

/// bigram 集合（单字符字符串为空集）。
fn bigrams(text: &str) -> HashSet<(char, char)> {
    text.chars().collect::<Vec<char>>().windows(2).map(|pair| (pair[0], pair[1])).collect()
}

/// 相似度（§2.3 第2条，契约冻结）。比较前双方都过 [`normalize`]。
pub fn similarity(left: &str, right: &str) -> f64 {
    let left = normalize(left);
    let right = normalize(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    if left == right {
        return 1.0;
    }
    // 包含：0.6 + 0.4 × (短/长) 字符数比。
    if left.contains(&right) || right.contains(&left) {
        let left_len = left.chars().count();
        let right_len = right.chars().count();
        let (short, long) = if left_len <= right_len { (left_len, right_len) } else { (right_len, left_len) };
        return 0.6 + 0.4 * (short as f64 / long as f64);
    }
    let left_bigrams = bigrams(&left);
    let right_bigrams = bigrams(&right);
    // 单字符退化：bigram 集合为空 → 用字符集 Dice（契约边界）。
    if left_bigrams.is_empty() || right_bigrams.is_empty() {
        let left_chars: HashSet<char> = left.chars().collect();
        let right_chars: HashSet<char> = right.chars().collect();
        let shared = left_chars.intersection(&right_chars).count();
        return 2.0 * shared as f64 / (left_chars.len() + right_chars.len()) as f64;
    }
    let shared = left_bigrams.intersection(&right_bigrams).count();
    2.0 * shared as f64 / (left_bigrams.len() + right_bigrams.len()) as f64
}

/// 包含度（§2.3 第2条后半，契约冻结）：交集面积 / min(面积a, 面积b)；任一面积
/// 为 0 或无交集 → 0.0。
pub fn overlap(left: Rect, right: Rect) -> f64 {
    let width = (left.x + left.width).min(right.x + right.width) - left.x.max(right.x);
    let height = (left.y + left.height).min(right.y + right.height) - left.y.max(right.y);
    let intersection = width.max(0.0) * height.max(0.0);
    let smallest = left.area().min(right.area());
    if smallest <= 0.0 || intersection <= 0.0 {
        return 0.0;
    }
    (intersection / smallest).clamp(0.0, 1.0)
}

/// UIA 稳定节点（融合输入）。`id` 是 world 稳定 id（`r:[…]` / `f:[…]`，即
/// observe 返回的 elementId，可被 click 复用）；label 可能为空。
#[derive(Clone, Debug, PartialEq)]
pub struct FusionElement {
    pub id: String,
    pub label: String,
    pub control_type: i64,
    pub bbox: Rect,
    pub enabled: bool,
    pub invokable: bool,
    pub offscreen: bool,
}

impl FusionElement {
    /// 从 world::StableNode 的三元输入构造（保持 vision 不依赖 world 类型，便于
    /// 单测；bbox 缺失的退化元素返回 None——没有坐标就无法输出候选）。
    pub fn from_node(id: &str, control_type: i64, data: &Value) -> Option<FusionElement> {
        let bbox = Rect::from_json(data.get("bbox")?)?;
        Some(FusionElement {
            id: id.to_owned(),
            label: data.get("label").and_then(Value::as_str).unwrap_or_default().to_owned(),
            control_type,
            bbox,
            enabled: data.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            invokable: data.get("invokable").and_then(Value::as_bool).unwrap_or(false),
            offscreen: data.get("offscreen").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// OCR 文本行（text 保留原文；bbox 已由调用方平移回全屏物理像素）。
#[derive(Clone, Debug, PartialEq)]
pub struct FusionLine {
    pub text: String,
    pub bbox: Rect,
}

impl FusionLine {
    pub fn new(text: impl Into<String>, bbox: Rect) -> FusionLine {
        FusionLine { text: text.into(), bbox }
    }
}

/// 一条"OCR 行 ↔ 元素"的对齐结果（`element_index`/`line_index` 指向入参下标）。
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub element_index: usize,
    pub line_index: usize,
    /// similarity(label, 行文本)。
    pub text_score: f64,
    /// 包含度 overlap(元素 bbox, 行 bbox)。
    pub overlap: f64,
    /// 0.65 × text_score + 0.35 × overlap。
    pub score: f64,
}

/// align 的产物：已排序、已去重的对齐结果 + 未对齐行下标（OCR 行序）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fused {
    pub matches: Vec<Match>,
    pub text_only: Vec<usize>,
}

/// 候选 f64 比较（NaN 不会出现；total_cmp 保证全序与确定性）。
fn best(first: std::cmp::Ordering) -> bool {
    first == std::cmp::Ordering::Greater
}

/// 行内候选择优（§2.3 第4条）：score 降 → overlap 降 → 元素 id 升。
fn line_candidate_better(candidate: &Match, current: &Match, elements: &[FusionElement]) -> bool {
    best(candidate
        .score
        .total_cmp(&current.score)
        .then_with(|| candidate.overlap.total_cmp(&current.overlap))
        // id 字典序小者胜：current > candidate ⇒ candidate 更小。
        .then_with(|| elements[current.element_index].id.cmp(&elements[candidate.element_index].id)))
}

/// 元素内候选择优（§2.3 第5条）：score 降 → overlap 降 → 行号升（确定性）。
fn element_candidate_better(candidate: &Match, current: &Match) -> bool {
    best(candidate
        .score
        .total_cmp(&current.score)
        .then_with(|| candidate.overlap.total_cmp(&current.overlap))
        .then_with(|| current.line_index.cmp(&candidate.line_index)))
}

/// 全量对齐（§2.3 第3–5条，契约冻结）。复杂度 O(行 × 元素)，上限由调用方
/// control（元素 ≤ MAX_ELEMENTS=20000、OCR 行受预算约束）。
pub fn align(elements: &[FusionElement], lines: &[FusionLine]) -> Fused {
    // 1) 每条 OCR 行 × 每个可接受元素（label 非空 ∧ 元素面积 > 0）算候选，
    //    行内取最优（最多命中一个元素）。
    let mut best_per_line: Vec<Option<Match>> = vec![None; lines.len()];
    for (line_index, line) in lines.iter().enumerate() {
        for (element_index, element) in elements.iter().enumerate() {
            if normalize(&element.label).is_empty() || element.bbox.area() <= 0.0 {
                continue;
            }
            let text_score = similarity(&element.label, &line.text);
            let overlap = overlap(element.bbox, line.bbox);
            let score = LABEL_WEIGHT * text_score + OVERLAP_WEIGHT * overlap;
            if score < ACCEPT_SCORE {
                continue;
            }
            let candidate = Match { element_index, line_index, text_score, overlap, score };
            if best_per_line[line_index].as_ref().is_none_or(|current| line_candidate_better(&candidate, current, elements)) {
                best_per_line[line_index] = Some(candidate);
            }
        }
    }
    // 2) 每个元素只保留最高分行；被顶掉的行**不**转 textOnly（§2.3 第5条，
    //    避免同一元素的重复文字浪费预算）。
    let mut best_per_element: HashMap<usize, Match> = HashMap::new();
    for candidate in best_per_line.iter().flatten() {
        let replace = match best_per_element.get(&candidate.element_index) {
            None => true,
            Some(current) => element_candidate_better(candidate, current),
        };
        if replace {
            best_per_element.insert(candidate.element_index, candidate.clone());
        }
    }
    // 3) 未对齐行：行内没有任何被接受候选（行序保真）。
    let text_only: Vec<usize> = (0..lines.len()).filter(|index| best_per_line[*index].is_none()).collect();
    // 4) 确定性排序（契约）：score 降 → 元素 bbox.y 升 → bbox.x 升 → id 升。
    let mut matches: Vec<Match> = best_per_element.into_values().collect();
    matches.sort_by(|left, right| {
        let left_element = &elements[left.element_index];
        let right_element = &elements[right.element_index];
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left_element.bbox.y.total_cmp(&right_element.bbox.y))
            .then_with(|| left_element.bbox.x.total_cmp(&right_element.bbox.x))
            .then_with(|| left_element.id.cmp(&right_element.id))
    });
    Fused { matches, text_only }
}

/// 一个命中元素的 12 键响应对象（§3 契约，键序不敏感、键集合精确）。
fn element_hit(
    element: &FusionElement,
    source: &str,
    score: f64,
    text_score: f64,
    overlap: f64,
    ocr_text: Option<&str>,
) -> Value {
    json!({
        "elementId": element.id,
        "label": element.label,
        "type": element.control_type,
        "bbox": element.bbox.json(),
        "enabled": element.enabled,
        "invokable": element.invokable,
        "offscreen": element.offscreen,
        "source": source,
        "score": score,
        "textScore": text_score,
        "overlap": overlap,
        "ocrText": ocr_text,
    })
}

/// 无 query 模式（§3：matches = 全部对齐结果、textOnly = 未对齐行前 20）。
/// 返回 (matches, textOnly, totalMatches, totalTextOnly)；total 是截断前计数。
pub fn aligned_hits(
    elements: &[FusionElement],
    lines: &[FusionLine],
    fused: &Fused,
    max_results: usize,
) -> (Vec<Value>, Vec<Value>, usize, usize) {
    let total_matches = fused.matches.len();
    let matches: Vec<Value> = fused
        .matches
        .iter()
        .take(max_results)
        .map(|matched| {
            let element = &elements[matched.element_index];
            element_hit(
                element,
                "fusion",
                matched.score,
                matched.text_score,
                matched.overlap,
                Some(&lines[matched.line_index].text),
            )
        })
        .collect();
    let total_text_only = fused.text_only.len();
    let text_only: Vec<Value> = fused
        .text_only
        .iter()
        .take(TEXT_ONLY_CAP)
        .map(|line_index| {
            let line = &lines[*line_index];
            // 无 query 时没有相关性可算：可见但未对齐的每一行等价，score 固定 1.0。
            json!({"text": line.text, "bbox": line.bbox.json(), "score": 1.0})
        })
        .collect();
    (matches, text_only, total_matches, total_text_only)
}

/// query 模式（§2.3 第6条 + §3）：元素与 query 的相关性取 label 与命中 OCR 行的
/// 较大者，几何项用命中行的包含度；textOnly 只留未对齐行里和 query 够像的。
pub fn extract_query_hits(
    elements: &[FusionElement],
    lines: &[FusionLine],
    fused: &Fused,
    query: &str,
    min_score: f64,
    max_results: usize,
) -> (Vec<Value>, Vec<Value>, usize, usize) {
    let aligned: HashMap<usize, &Match> = fused.matches.iter().map(|matched| (matched.element_index, matched)).collect();
    // 1) 元素候选：sim = max(label, 命中行)，score = 0.7×sim + 0.3×命中行 overlap。
    let mut candidates: Vec<(Match, Value)> = Vec::new();
    for (element_index, element) in elements.iter().enumerate() {
        let hit = aligned.get(&element_index).copied();
        let label_score = similarity(query, &element.label);
        let (line_score, line_overlap, ocr_text) = match hit {
            Some(matched) => {
                let line = &lines[matched.line_index];
                (similarity(query, &line.text), matched.overlap, Some(line.text.as_str()))
            }
            None => (0.0, 0.0, None),
        };
        let text_score = label_score.max(line_score);
        let score = QUERY_TEXT_WEIGHT * text_score + QUERY_OVERLAP_WEIGHT * line_overlap;
        if score < min_score {
            continue;
        }
        let source = if hit.is_some() { "fusion" } else { "uia" };
        let value = element_hit(element, source, score, text_score, line_overlap, ocr_text);
        candidates.push((
            Match { element_index, line_index: hit.map(|matched| matched.line_index).unwrap_or(usize::MAX), text_score, overlap: line_overlap, score },
            value,
        ));
    }
    // 2) 确定性排序（契约，与 align 同口径）：score 降 → bbox.y 升 → bbox.x 升 → id 升。
    candidates.sort_by(|(left, _), (right, _)| {
        let left_element = &elements[left.element_index];
        let right_element = &elements[right.element_index];
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left_element.bbox.y.total_cmp(&right_element.bbox.y))
            .then_with(|| left_element.bbox.x.total_cmp(&right_element.bbox.x))
            .then_with(|| left_element.id.cmp(&right_element.id))
    });
    let total_matches = candidates.len();
    let matches: Vec<Value> = candidates.into_iter().take(max_results).map(|(_, value)| value).collect();
    // 3) textOnly：未对齐行中 sim(query, 行文本) ≥ minScore，score 降 → 行序。
    let mut text_candidates: Vec<(usize, f64)> = fused
        .text_only
        .iter()
        .filter_map(|line_index| {
            let score = similarity(query, &lines[*line_index].text);
            (score >= min_score).then_some((*line_index, score))
        })
        .collect();
    text_candidates.sort_by(|(left_line, left_score), (right_line, right_score)| {
        let left = &lines[*left_line];
        let right = &lines[*right_line];
        right_score
            .total_cmp(left_score)
            .then_with(|| left.bbox.y.total_cmp(&right.bbox.y))
            .then_with(|| left.bbox.x.total_cmp(&right.bbox.x))
            .then_with(|| left.text.cmp(&right.text))
    });
    let total_text_only = text_candidates.len();
    let text_only: Vec<Value> = text_candidates
        .into_iter()
        .take(TEXT_ONLY_CAP)
        .map(|(line_index, score)| {
            let line = &lines[line_index];
            json!({"text": line.text, "bbox": line.bbox.json(), "score": score})
        })
        .collect();
    (matches, text_only, total_matches, total_text_only)
}

/// 降级通道（OCR/capture 不可用）：只用 UIA label 与 query 比对，overlap 恒 0、
/// source 恒 `uia`、ocrText 恒 null。打分沿用冻结公式（0.7×sim + 0.3×0）。
/// 无 query 时没有相关性可算 → 空候选（调用方以 degradeReason 说明原因）。
pub fn uia_only_hits(
    elements: &[FusionElement],
    query: Option<&str>,
    min_score: f64,
    max_results: usize,
) -> (Vec<Value>, Vec<Value>, usize, usize) {
    let Some(query) = query else {
        return (Vec::new(), Vec::new(), 0, 0);
    };
    let mut candidates: Vec<(f64, &FusionElement, f64)> = elements
        .iter()
        .filter_map(|element| {
            let text_score = similarity(query, &element.label);
            let score = QUERY_TEXT_WEIGHT * text_score;
            (score >= min_score).then_some((score, element, text_score))
        })
        .collect();
    candidates.sort_by(|(left_score, left, _), (right_score, right, _)| {
        right_score
            .total_cmp(left_score)
            .then_with(|| left.bbox.y.total_cmp(&right.bbox.y))
            .then_with(|| left.bbox.x.total_cmp(&right.bbox.x))
            .then_with(|| left.id.cmp(&right.id))
    });
    let total_matches = candidates.len();
    let matches: Vec<Value> = candidates
        .into_iter()
        .take(max_results)
        .map(|(score, element, text_score)| element_hit(element, "uia", score, text_score, 0.0, None))
        .collect();
    (matches, Vec::new(), total_matches, 0)
}

// ---------------------------------------------------------------------------
// DPI 坐标归一（批4 lead 2026-11-21 追加口径，内部实现细节，不改 IPC 契约）
// ---------------------------------------------------------------------------

/// 主屏 DPI 归一系数：物理像素尺寸 / 虚拟化（逻辑）像素尺寸。
///
/// worker 进程 DPI-unaware（无 manifest）：UIA observe 的 bbox 是虚拟化逻辑像素，
/// 而 DXGI capture / OCR bbox 是全屏物理像素。locate 在比较/裁剪/响应前必须用
/// 本系数把 UIA 侧 bbox 归一到物理像素，否则 125%/150% 缩放下两套坐标零相交。
///
/// 口径（lead 钉死）：任一维 <= 0 或结果非有限 -> 1.0；宽高比不一致时取宽度比
/// （主屏宽度是 100%/125%/150% 最常见的判别维度）；clamp 1.0..=4.0（更极端的
/// 读数视为不可信，按 1.0 兜底而非放大）。
pub fn physical_scale(physical: (i32, i32), virtual_size: (i32, i32)) -> f64 {
    if physical.0 <= 0 || physical.1 <= 0 || virtual_size.0 <= 0 || virtual_size.1 <= 0 {
        return 1.0;
    }
    let scale = physical.0 as f64 / virtual_size.0 as f64;
    if !scale.is_finite() {
        return 1.0;
    }
    scale.clamp(1.0, 4.0)
}

/// 把虚拟化（逻辑）像素矩形换算成物理像素矩形，四边分别四舍五入到整数像素。
/// scale 非有限或 <= 0 时原样返回（调用方已由 physical_scale 兜底，这里防御）。
pub fn scale_rect(rect: Rect, scale: f64) -> Rect {
    if !scale.is_finite() || scale <= 0.0 {
        return rect;
    }
    Rect {
        x: (rect.x * scale).round(),
        y: (rect.y * scale).round(),
        width: (rect.width * scale).round(),
        height: (rect.height * scale).round(),
    }
}

#[cfg(test)]
mod dpi_tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn physical_scale_same_size_is_one() {
        assert_eq!(physical_scale((1920, 1080), (1920, 1080)), 1.0);
    }

    #[test]
    fn physical_scale_125_percent() {
        // 125% 缩放：物理 1920x1080，DPI-unaware 进程看到 1536x864。
        assert_eq!(physical_scale((1920, 1080), (1536, 864)), 1.25);
    }

    #[test]
    fn physical_scale_150_percent() {
        assert_eq!(physical_scale((1920, 1080), (1280, 720)), 1.5);
    }

    #[test]
    fn physical_scale_zero_dimension_falls_back_to_one() {
        assert_eq!(physical_scale((1920, 1080), (0, 0)), 1.0);
        assert_eq!(physical_scale((0, 0), (1920, 1080)), 1.0);
        assert_eq!(physical_scale((1920, 1080), (-1536, 864)), 1.0);
    }

    #[test]
    fn physical_scale_non_uniform_uses_width_ratio() {
        // 宽高比不一致（高度比 1.2）时取宽度比 1.25。
        assert_eq!(physical_scale((1920, 1080), (1536, 900)), 1.25);
    }

    #[test]
    fn physical_scale_clamped_to_four() {
        // 1920/100 = 19.2 -> clamp 上限 4.0（异常小虚拟宽度不可信）。
        assert_eq!(physical_scale((1920, 1080), (100, 1080)), 4.0);
        // scale < 1（物理反而更小）-> 下限 1.0。
        assert_eq!(physical_scale((1000, 800), (1920, 1080)), 1.0);
    }

    #[test]
    fn scale_rect_scales_all_four_edges_with_rounding() {
        // C-doc 真机实测根 bbox 120,120,776x359（逻辑）-> x1.25 后 150,150,970,449。
        assert_eq!(scale_rect(rect(120.0, 120.0, 776.0, 359.0), 1.25), rect(150.0, 150.0, 970.0, 449.0));
        // 0.5 进位：10.5 -> 11，10.4 -> 10（四舍五入，不是截断）。
        assert_eq!(scale_rect(rect(10.5, 10.4, 10.5, 10.4), 1.0), rect(11.0, 10.0, 11.0, 10.0));
    }

    #[test]
    fn scale_rect_defensive_passthrough() {
        let original = rect(7.0, 8.0, 9.0, 10.0);
        assert_eq!(scale_rect(original, 0.0), original);
        assert_eq!(scale_rect(original, -1.0), original);
        assert_eq!(scale_rect(original, f64::NAN), original);
        assert_eq!(scale_rect(original, 1.0), original);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn element(id: &str, label: &str, x: f64, y: f64, width: f64, height: f64) -> FusionElement {
        FusionElement {
            id: id.into(),
            label: label.into(),
            control_type: 50000,
            bbox: Rect { x, y, width, height },
            enabled: true,
            invokable: true,
            offscreen: false,
        }
    }

    fn line(text: &str, x: f64, y: f64, width: f64, height: f64) -> FusionLine {
        FusionLine::new(text, Rect { x, y, width, height })
    }

    // ---- normalize（§2.3 第1条） ----

    #[test]
    fn normalize_folds_contract_whitespace_case_quotes_and_separators() {
        assert_eq!(normalize("  Hello   World  "), "hello world");
        assert_eq!(normalize("\u{3000}\u{3000}确定："), "确定");
        assert_eq!(normalize("“保存”：  "), "保存");
        assert_eq!(normalize("OK: "), "ok");
        assert_eq!(normalize("A\u{3000}\u{3000}B"), "a b");
        assert_eq!(normalize("   "), "");
        assert_eq!(normalize(""), "");
        // 非 ASCII 大小写保持原样（契约：只做 ASCII 小写）。
        assert_eq!(normalize("ÄBC"), "Äbc");
        // 尾部分隔符连续出现（含全角）全部去掉。
        assert_eq!(normalize("保存。，、…"), "保存");
    }

    #[test]
    fn normalize_strips_quotes_and_separators_in_alternating_order() {
        assert_eq!(normalize("“确定”：。"), "确定");
        assert_eq!(normalize("' 保存 '"), "保存");
        // 尾部引号一律去掉（即使去掉后与开头引号不再配对）。
        assert_eq!(normalize("保存: “x”"), "保存: “x");
    }

    // ---- similarity（§2.3 第2条） ----

    #[test]
    fn similarity_is_one_after_normalization() {
        assert_eq!(similarity("保存", "保存"), 1.0);
        assert_eq!(similarity("  “Save”  ", "save"), 1.0);
        assert_eq!(similarity("Save   As", "save as"), 1.0);
        assert_eq!(similarity("保存：", "保存"), 1.0);
    }

    #[test]
    fn similarity_empty_side_is_zero() {
        assert_eq!(similarity("", "保存"), 0.0);
        assert_eq!(similarity("保存", ""), 0.0);
        assert_eq!(similarity("   ", "保存"), 0.0);
    }

    #[test]
    fn similarity_containment_reports_length_ratio() {
        assert!((similarity("确定按钮", "确定") - 0.8).abs() < 1e-9);
        assert!((similarity("保存", "保存文件") - 0.8).abs() < 1e-9);
        assert!((similarity("保存", "保存文件夹") - (0.6 + 0.4 * 2.0 / 5.0)).abs() < 1e-9);
    }

    #[test]
    fn similarity_uses_bigram_dice_for_partial_overlap() {
        // A={ab,bc,cd,de,ef} B={ab,bc,cx,xy,yz} → 2×2/10。
        assert!((similarity("abcdef", "abcxyz") - 0.4).abs() < 1e-9);
        // CJK 无交集 bigram → 0。
        assert_eq!(similarity("保存", "取消"), 0.0);
    }

    // ---- overlap（§2.3 第2条后半） ----

    #[test]
    fn overlap_measures_containment_and_disjoint_is_zero() {
        let outer = Rect { x: 0.0, y: 0.0, width: 100.0, height: 100.0 };
        let inner = Rect { x: 10.0, y: 10.0, width: 20.0, height: 20.0 };
        assert_eq!(overlap(outer, inner), 1.0, "contained rect has containment 1.0");
        assert_eq!(overlap(inner, outer), 1.0, "overlap is symmetric on containment");
        let shifted = Rect { x: 50.0, y: 50.0, width: 100.0, height: 100.0 };
        assert!((overlap(outer, shifted) - 0.25).abs() < 1e-9);
        assert_eq!(overlap(outer, Rect { x: 200.0, y: 0.0, width: 10.0, height: 10.0 }), 0.0);
        assert_eq!(overlap(outer, Rect { x: 0.0, y: 0.0, width: 0.0, height: 100.0 }), 0.0);
    }

    // ---- align（§2.3 第3–5条） ----

    #[test]
    fn align_accepts_label_hit_with_geometry_gate() {
        let elements = vec![element("r:[1]", "保存", 0.0, 0.0, 100.0, 100.0)];
        let lines = vec![line("保存", 10.0, 10.0, 40.0, 20.0)];
        let fused = align(&elements, &lines);
        assert_eq!(fused.matches.len(), 1);
        assert!(fused.text_only.is_empty());
        let matched = &fused.matches[0];
        assert_eq!((matched.element_index, matched.line_index), (0, 0));
        assert!((matched.text_score - 1.0).abs() < 1e-9);
        assert!((matched.overlap - 1.0).abs() < 1e-9, "line inside element is full containment");
        assert!((matched.score - (LABEL_WEIGHT + OVERLAP_WEIGHT)).abs() < 1e-9);
    }

    #[test]
    fn align_rejects_low_score_and_reports_text_only() {
        let elements = vec![element("r:[1]", "保存", 0.0, 0.0, 100.0, 100.0)];
        // 无共同 bigram，且行在元素外：score = 0 < 0.55。
        let lines = vec![line("取消", 200.0, 0.0, 100.0, 100.0)];
        let fused = align(&elements, &lines);
        assert!(fused.matches.is_empty());
        assert_eq!(fused.text_only, vec![0]);
    }

    #[test]
    fn align_threshold_separates_near_miss_from_accepted() {
        // sim=0.8 且 overlap=0.1：0.65×0.8 + 0.35×0.1 = 0.555 ≥ 0.55（接受）。
        let elements = vec![element("r:[1]", "保存", 0.0, 0.0, 100.0, 100.0)];
        let line_overlap_point_one = line("保存文件", 90.0, 0.0, 10.0, 1000.0);
        let fused = align(&elements, &[line_overlap_point_one]);
        assert_eq!(fused.matches.len(), 1, "0.555 must pass the 0.55 gate");
        assert!((fused.matches[0].score - 0.555).abs() < 1e-9);
        // 同 sim 但 overlap=0：0.52 < 0.55（拒绝）。
        let fused = align(&elements, &[line("保存文件", 200.0, 0.0, 10.0, 1000.0)]);
        assert!(fused.matches.is_empty(), "0.52 must fail the 0.55 gate");
        assert_eq!(fused.text_only, vec![0]);
    }

    #[test]
    fn align_ignores_empty_label_and_zero_area_elements() {
        let elements = vec![
            element("r:[1]", "", 0.0, 0.0, 100.0, 100.0),
            element("r:[2]", "保存", 0.0, 0.0, 0.0, 100.0),
        ];
        let lines = vec![line("保存", 0.0, 0.0, 100.0, 100.0)];
        let fused = align(&elements, &lines);
        assert!(fused.matches.is_empty(), "empty label / zero area are not accepted");
        assert_eq!(fused.text_only, vec![0]);
    }

    #[test]
    fn align_keeps_highest_line_per_element_and_excludes_its_losers_from_text_only() {
        let elements = vec![element("r:[1]", "保存", 0.0, 0.0, 100.0, 100.0)];
        // 两行文本都能命中同一元素：score 相同 → 保留行号小者，另一行不转 textOnly。
        let lines = vec![
            line("保存", 10.0, 10.0, 40.0, 20.0),
            line("保存", 10.0, 40.0, 40.0, 20.0),
        ];
        let fused = align(&elements, &lines);
        assert_eq!(fused.matches.len(), 1);
        assert_eq!(fused.matches[0].line_index, 0);
        assert!(fused.text_only.is_empty(), "loser of the same element must not be counted as textOnly");
    }

    #[test]
    fn align_orders_matches_by_score_then_geometry_deterministically() {
        let elements = vec![
            element("r:[3]", "保存", 0.0, 100.0, 100.0, 100.0),
            element("r:[1]", "保存", 0.0, 0.0, 100.0, 100.0),
            element("r:[2]", "保存", 50.0, 0.0, 100.0, 100.0),
        ];
        let lines = vec![
            line("保存", 0.0, 100.0, 100.0, 100.0),
            line("保存", 0.0, 0.0, 100.0, 100.0),
            line("保存", 50.0, 0.0, 100.0, 100.0),
        ];
        let fused = align(&elements, &lines);
        let ids: Vec<&str> = fused.matches.iter().map(|matched| elements[matched.element_index].id.as_str()).collect();
        assert_eq!(ids, vec!["r:[1]", "r:[2]", "r:[3]"], "equal scores sort by bbox.y then bbox.x");
    }

    #[test]
    fn align_output_is_stable_under_element_permutation() {
        let elements = vec![
            element("r:[1]", "保存", 0.0, 0.0, 100.0, 100.0),
            element("r:[2]", "取消", 0.0, 200.0, 100.0, 100.0),
            element("r:[3]", "保存", 300.0, 0.0, 100.0, 100.0),
        ];
        let lines = vec![
            line("保存", 0.0, 0.0, 100.0, 100.0),
            line("取消", 0.0, 200.0, 100.0, 100.0),
            line("保存", 300.0, 0.0, 100.0, 100.0),
        ];
        let forward = align(&elements, &lines);
        let mut reversed_elements = elements.clone();
        reversed_elements.reverse();
        let mut reversed_lines = lines.clone();
        reversed_lines.reverse();
        let reversed = align(&reversed_elements, &reversed_lines);
        let forward_hits = aligned_hits(&elements, &lines, &forward, 10);
        let reversed_hits = aligned_hits(&reversed_elements, &reversed_lines, &reversed, 10);
        assert_eq!(forward_hits.0, reversed_hits.0, "JSON output must not depend on input order");
        assert_eq!(forward_hits.2, reversed_hits.2);
    }

    #[test]
    fn align_empty_inputs_are_empty() {
        let fused = align(&[], &[]);
        assert!(fused.matches.is_empty() && fused.text_only.is_empty());
        let fused = align(&[element("r:[1]", "保存", 0.0, 0.0, 10.0, 10.0)], &[]);
        assert!(fused.matches.is_empty() && fused.text_only.is_empty());
        let fused = align(&[], &[line("保存", 0.0, 0.0, 10.0, 10.0)]);
        assert!(fused.matches.is_empty());
        assert_eq!(fused.text_only, vec![0]);
    }

    // ---- FusionElement::from_node ----

    #[test]
    fn element_from_node_reads_world_stable_node_data() {
        let data = json!({
            "label": "保存",
            "bbox": {"x": 1, "y": 2, "width": 3, "height": 4},
            "enabled": false,
            "invokable": true,
            "offscreen": true,
        });
        let element = FusionElement::from_node("r:[42,7]", 50000, &data).expect("valid node data");
        assert_eq!(element.id, "r:[42,7]");
        assert_eq!(element.label, "保存");
        assert_eq!(element.control_type, 50000);
        assert_eq!(element.bbox, Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 });
        assert!(!element.enabled && element.invokable && element.offscreen);
        // label 可空（契约：label 可能为空）。
        let empty_label = json!({"label": "", "bbox": {"x": 0, "y": 0, "width": 1, "height": 1}});
        assert_eq!(FusionElement::from_node("f:[...]", 50000, &empty_label).expect("label empty is fine").label, "");
        // bbox 缺失 → 无法输出候选坐标 → None。
        assert!(FusionElement::from_node("r:[1]", 50000, &json!({"label": "保存"})).is_none());
    }

    // ---- 无 query：aligned_hits ----

    #[test]
    fn aligned_hits_caps_matches_and_text_only_with_honest_totals() {
        let elements: Vec<FusionElement> = (0..25)
            .map(|index| element(&format!("r:[{index}]"), "保存", 0.0, index as f64 * 20.0, 100.0, 15.0))
            .collect();
        let lines: Vec<FusionLine> = (0..25)
            .map(|index| line("保存", 0.0, index as f64 * 20.0, 100.0, 15.0))
            .collect();
        let fused = align(&elements, &lines);
        assert_eq!(fused.matches.len(), 25);
        let (matches, text_only, total_matches, total_text_only) = aligned_hits(&elements, &lines, &fused, 10);
        assert_eq!((matches.len(), total_matches), (10, 25));
        assert!(text_only.is_empty());
        assert_eq!(total_text_only, 0);
        // 无 query 时按 align 的确定性顺序取前 10（y 升序 → 前 10 个元素）。
        let ids: Vec<&str> = matches.iter().map(|hit| hit["elementId"].as_str().unwrap()).collect();
        let expected: Vec<String> = (0..10).map(|index| format!("r:[{index}]")).collect();
        assert_eq!(ids, expected.iter().map(String::as_str).collect::<Vec<_>>());
        // textOnly 截断到 20 且 total 如实（手工构造 fused：25 行全未对齐）。
        let unaligned_elements = vec![element("r:[1]", "保存", 0.0, 0.0, 100.0, 100.0)];
        let unaligned_lines: Vec<FusionLine> = (0..25)
            .map(|index| line("随机文本", 0.0, index as f64 * 30.0, 80.0, 20.0))
            .collect();
        let fused = Fused { matches: Vec::new(), text_only: (0..25).collect() };
        let (matches, text_only, total_matches, total_text_only) =
            aligned_hits(&unaligned_elements, &unaligned_lines, &fused, 10);
        assert!(matches.is_empty());
        assert_eq!((text_only.len(), total_matches, total_text_only), (20, 0, 25));
        for item in &text_only {
            assert!(item["text"].is_string() && item["bbox"].is_object());
            assert_eq!(item["score"].as_f64(), Some(1.0));
        }
    }

    // ---- query 模式：extract_query_hits ----

    #[test]
    fn query_hits_use_label_or_aligned_line_text_with_source_and_ocr_text() {
        // 元素 A：label 与 query 部分相似、无命中行 → source uia。
        // 元素 B：label 与 query 较远，但命中行文本 == query → source fusion。
        let elements = vec![
            element("r:[a]", "保存文件", 0.0, 0.0, 100.0, 100.0),
            element("r:[b]", "保存", 500.0, 0.0, 100.0, 100.0),
        ];
        // 行文本「保存文件」：与 A label 完全一致（align 命中 A），与 B label 包含关系。
        let lines = vec![line("保存文件", 0.0, 0.0, 100.0, 100.0)];
        let fused = align(&elements, &lines);
        assert_eq!(fused.matches.len(), 1, "only the closest element wins the line");
        assert_eq!(fused.matches[0].element_index, 0);
        let (matches, text_only, total_matches, total_text_only) =
            extract_query_hits(&elements, &lines, &fused, "保存", 0.5, 10);
        assert_eq!(total_matches, 2);
        assert!(text_only.is_empty() && total_text_only == 0);
        let first = &matches[0];
        assert_eq!(first["elementId"], "r:[a]");
        assert_eq!(first["source"], "fusion");
        assert_eq!(first["ocrText"], "保存文件");
        // 文本项 sim = 1.0（"保存" 是 "保存文件" 的子串 → 0.8），几何项 = 1.0。
        assert!((first["score"].as_f64().unwrap() - (QUERY_TEXT_WEIGHT * 0.8 + QUERY_OVERLAP_WEIGHT)).abs() < 1e-9);
        let second = &matches[1];
        assert_eq!(second["elementId"], "r:[b]");
        assert_eq!(second["source"], "uia", "no aligned line → label-only match");
        assert_eq!(second["ocrText"], Value::Null);
        // 元素 B label 与 query 完全相等 → textScore = 1.0，几何项 0（无命中行）。
        assert!((second["score"].as_f64().unwrap() - QUERY_TEXT_WEIGHT).abs() < 1e-9);
    }

    #[test]
    fn query_hits_filter_by_min_score_and_sort_text_only() {
        // 25 行未对齐文本，均与 query 相关；textOnly 截断到 20 且 total 如实。
        let elements = vec![element("r:[1]", "别的东西", 0.0, 0.0, 10.0, 10.0)];
        let lines: Vec<FusionLine> = (0..25)
            .map(|index| line(&format!("保存{index}"), 0.0, index as f64 * 40.0, 100.0, 20.0))
            .collect();
        let fused = align(&elements, &lines);
        let (matches, text_only, total_matches, total_text_only) =
            extract_query_hits(&elements, &lines, &fused, "保存", 0.5, 10);
        assert_eq!(total_matches, 0);
        assert!(matches.is_empty());
        assert_eq!((text_only.len(), total_text_only), (20, 25));
        // 元素 label「别的东西」与 query 无交集 → 不命中；textOnly 同分按行号序。
        assert_eq!(text_only[0]["text"], "保存0");
        for (index, item) in text_only.iter().enumerate() {
            let expected = format!("保存{index}");
            assert_eq!(item["text"], expected.as_str());
            assert!(item["score"].as_f64().unwrap() >= 0.5);
        }
        // minScore 拉高到 1.0：只有 sim == 1 的行（无）→ textOnly 空。
        let (_, text_only, _, total_text_only) = extract_query_hits(&elements, &lines, &fused, "保存", 1.0, 10);
        assert!(text_only.is_empty() && total_text_only == 0);
    }

    // ---- 降级通道：uia_only_hits ----

    #[test]
    fn uia_only_hits_match_labels_without_ocr() {
        let elements = vec![
            element("r:[1]", "保存", 0.0, 0.0, 10.0, 10.0),
            element("r:[2]", "保存文件", 0.0, 20.0, 10.0, 10.0),
            element("r:[3]", "取消", 0.0, 40.0, 10.0, 10.0),
            element("r:[4]", "", 0.0, 60.0, 10.0, 10.0),
        ];
        let (matches, text_only, total_matches, total_text_only) = uia_only_hits(&elements, Some("保存"), 0.5, 10);
        assert_eq!((matches.len(), total_matches), (2, 2));
        assert!(text_only.is_empty() && total_text_only == 0);
        assert_eq!(matches[0]["elementId"], "r:[1]");
        assert!((matches[0]["score"].as_f64().unwrap() - QUERY_TEXT_WEIGHT).abs() < 1e-9);
        assert_eq!(matches[0]["source"], "uia");
        assert_eq!(matches[0]["ocrText"], Value::Null);
        assert_eq!(matches[0]["overlap"].as_f64(), Some(0.0));
        assert_eq!(matches[1]["elementId"], "r:[2]");
        // maxResults 截断但 total 如实。
        let (matches, _, total_matches, _) = uia_only_hits(&elements, Some("保存"), 0.5, 1);
        assert_eq!((matches.len(), total_matches), (1, 2));
        // 无 query：没有相关性可算 → 空候选。
        let (matches, text_only, total_matches, total_text_only) = uia_only_hits(&elements, None, 0.5, 10);
        assert!(matches.is_empty() && text_only.is_empty() && total_matches == 0 && total_text_only == 0);
    }
}
