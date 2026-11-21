//! vision::ocr_logic —— OCR 纯逻辑层（批2 拍板③ 改判：抽进 lib）。
//!
//! 零 COM / 零 windows feature / 零行为侵入：只用 std，cargo test 直接跑模块内
//! 单测。批3 `replacer_read_screen` 工具化时直接消费本模块（examples 落点会
//! 导致复制代码或反向依赖，见 docs/plan-batch2-capture-ocr-20261114.md §7-3）。
//!
//! 三件套：
//! - [`join_line_words`]：WinRT OCR 把每个汉字拆成独立 word 且插入假空格
//!   （批1 实测"今 8 编 队 开 工"）；CJK 相邻不加空格，Latin/数字间保留空格。
//! - [`normalize_hit`]：bbox clamp 进图像边界 + 面积>0 校验。
//! - [`pick_engine`]：引擎选择链纯函数（用户档案语言 → zh 族 → 任意可用），
//!   固化断言防回归（批1 实测 zh-Hans-CN 命中）。
//!
//! 主干红线：本文件纯函数，不碰 COM/设备/文件，不改变任何现有行为。

/// 文字命中框：图像/屏幕像素坐标，左上角原点（WinRT 返回 float，原样保留）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextBbox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl TextBbox {
    pub const ZERO: TextBbox = TextBbox { x: 0.0, y: 0.0, width: 0.0, height: 0.0 };

    /// 右边界（x + width）。
    pub fn right(&self) -> f32 {
        self.x + self.width
    }

    /// 下边界（y + height）。
    pub fn bottom(&self) -> f32 {
        self.y + self.height
    }

    /// 判定 `self` 是否完整包含于 `outer`（word bbox ⊆ 行 bbox 断言用）。
    pub fn contained_in(&self, outer: &TextBbox) -> bool {
        self.x >= outer.x
            && self.y >= outer.y
            && self.right() <= outer.right() + f32::EPSILON
            && self.bottom() <= outer.bottom() + f32::EPSILON
    }
}

/// 判断字符是否属于 CJK 字形/全角标点区间。
/// 区间约定（批2 拍板口径）：U+3000-U+9FFF（CJK 标点、假名、汉字）与
/// U+FF00-U+FFEF（全角形式：全角逗号/句号/括号等）。
pub fn is_cjk_char(c: char) -> bool {
    matches!(c, '\u{3000}'..='\u{9FFF}' | '\u{FF00}'..='\u{FFEF}')
}

/// 合并一行 OCR 词序列为行文本（拍板③-1：CJK 文本合并）。
///
/// WinRT OCR 会把每个汉字拆成独立 word 并插入假空格；规则：
/// - 相邻两端都是 CJK（含全角标点）→ 不加空格；
/// - 其余（Latin/数字/CJK 与 Latin 交界）→ 保留一个空格；
/// - 空串词条被跳过。
pub fn join_line_words<S: AsRef<str>>(words: &[S]) -> String {
    let mut out = String::new();
    for word in words {
        let s = word.as_ref();
        if s.is_empty() {
            continue;
        }
        if !out.is_empty() {
            let last = out.chars().last().expect("non-empty string has chars");
            let first = s.chars().next().expect("non-empty string has chars");
            if !(is_cjk_char(last) && is_cjk_char(first)) {
                out.push(' ');
            }
        }
        out.push_str(s);
    }
    out
}

/// bbox 归一化（拍板③-2：精度与不变量）。
///
/// clamp 进图像边界 `[0, image_w] × [0, image_h]`，随后面积>0 校验；
/// 完全出界或退化（宽/高 ≤ 0）返回 `None`（调用方丢弃该命中）。
pub fn normalize_hit(bbox: TextBbox, image_w: f32, image_h: f32) -> Option<TextBbox> {
    if image_w <= 0.0 || image_h <= 0.0 {
        return None;
    }
    let x = bbox.x.max(0.0).min(image_w);
    let y = bbox.y.max(0.0).min(image_h);
    let right = bbox.right().max(0.0).min(image_w);
    let bottom = bbox.bottom().max(0.0).min(image_h);
    let width = right - x;
    let height = bottom - y;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(TextBbox { x, y, width, height })
}

/// 引擎选择链纯函数（拍板③-3）：用户档案语言 → zh 族回退 → 任意可用。
///
/// - `available`：可用识别语言 tag 列表（系统 `AvailableRecognizerLanguages` 顺序）；
/// - `profile`：用户语言档案 tag 列表（`ApplicationLanguages::Languages` 顺序）；
/// - 返回 `available` 中命中的下标；全部落空返回 `None`。
///
/// 匹配规则：档案语言大小写不敏感精确匹配；zh 回退优先简体
/// （zh-Hans-CN → zh-CN → zh-Hans），再繁体（zh-Hant-CN → zh-Hant），
/// 再任意 zh 前缀；最后兜底 available[0]。
pub fn pick_engine(available: &[&str], profile: &[&str]) -> Option<usize> {
    // ① 用户档案语言
    for lang in profile {
        if let Some(index) = find_ci(available, lang) {
            return Some(index);
        }
    }
    // ② zh 族回退（简体优先，批1 实测 zh-Hans-CN 命中）
    for tag in ["zh-hans-cn", "zh-cn", "zh-hans", "zh-hant-cn", "zh-hant"] {
        if let Some(index) = find_ci(available, tag) {
            return Some(index);
        }
    }
    if let Some(index) = available
        .iter()
        .position(|a| a.to_ascii_lowercase().starts_with("zh"))
    {
        return Some(index);
    }
    // ③ 任意可用
    if available.is_empty() {
        None
    } else {
        Some(0)
    }
}

/// 大小写不敏感的精确匹配查找。
fn find_ci(available: &[&str], tag: &str) -> Option<usize> {
    available
        .iter()
        .position(|a| a.eq_ignore_ascii_case(tag))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 组1：CJK 合并去假空格（批1 实测样例） ----
    #[test]
    fn cjk_join_removes_fake_spaces() {
        // 批1 原样："今 8 编 队 开 工" → 汉字间无空格，数字边界保留
        assert_eq!(
            join_line_words(&["今", "8", "编", "队", "开", "工"]),
            "今 8 编队开工"
        );
        assert_eq!(join_line_words(&["编", "队", "开", "工"]), "编队开工");
    }

    // ---- 组2：Latin/数字间保留空格 ----
    #[test]
    fn latin_and_digits_keep_spaces() {
        assert_eq!(join_line_words(&["hello", "world"]), "hello world");
        assert_eq!(join_line_words(&["1", "2", "3"]), "1 2 3");
        assert_eq!(join_line_words(&["Replacer", "v0", "1"]), "Replacer v0 1");
        // 混排：Latin ↔ CJK 交界保留空格
        assert_eq!(join_line_words(&["打开", "Notepad"]), "打开 Notepad");
    }

    // ---- 组3：全角标点按 CJK 处理 + 空串跳过 ----
    #[test]
    fn fullwidth_punctuation_and_empty_words() {
        assert_eq!(join_line_words(&["今天", "，", "好", "！"]), "今天，好！");
        assert_eq!(join_line_words(&["、"]), "、");
        assert_eq!(join_line_words(&["a", "", "b"]), "a b");
        assert_eq!(join_line_words::<&str>(&[]), "");
    }

    // ---- 组4：is_cjk_char 区间边界 ----
    #[test]
    fn cjk_char_ranges() {
        assert!(is_cjk_char('今')); // U+4ECA 汉字
        assert!(is_cjk_char('\u{3000}')); // CJK 区间起点（全角空格）
        assert!(is_cjk_char('\u{3001}')); // 、
        assert!(is_cjk_char('，')); // U+FF0C 全角逗号
        assert!(is_cjk_char('\u{FF00}')); // 全角区间起点
        assert!(is_cjk_char('\u{FFEF}')); // 全角区间终点
        assert!(is_cjk_char('\u{9FFF}')); // 汉字区间终点
        assert!(!is_cjk_char('\u{2FFF}')); // CJK 区间前一个码位
        assert!(!is_cjk_char('\u{A000}')); // 汉字区间后一个码位
        assert!(!is_cjk_char('a'));
        assert!(!is_cjk_char('8'));
        assert!(!is_cjk_char('§')); // U+00A7
    }

    // ---- 组5：normalize_hit clamp 与面积校验 ----
    #[test]
    fn normalize_hit_clamps_and_validates() {
        let image = (200.0f32, 100.0f32);
        // 完全在界内：原样返回
        let inside = TextBbox { x: 10.0, y: 20.0, width: 30.0, height: 40.0 };
        assert_eq!(normalize_hit(inside, image.0, image.1), Some(inside));
        // 左上越界 → clamp 到 (0,0)，右下保持
        let over = normalize_hit(
            TextBbox { x: -5.0, y: -3.0, width: 100.0, height: 50.0 },
            image.0,
            image.1,
        )
        .expect("clamped bbox valid");
        assert_eq!((over.x, over.y), (0.0, 0.0));
        assert_eq!((over.width, over.height), (95.0, 47.0));
        // 右下越界 → 裁到图像边缘，仍有效
        let clipped = normalize_hit(
            TextBbox { x: 150.0, y: 50.0, width: 100.0, height: 100.0 },
            image.0,
            image.1,
        )
        .expect("partial overlap valid");
        assert_eq!((clipped.width, clipped.height), (50.0, 50.0));
        // 完全出界 / 零面积 / 负尺寸 → None
        assert_eq!(
            normalize_hit(TextBbox { x: 210.0, y: 120.0, width: 50.0, height: 50.0 }, image.0, image.1),
            None
        );
        assert_eq!(
            normalize_hit(TextBbox { x: 10.0, y: 10.0, width: 0.0, height: 20.0 }, image.0, image.1),
            None
        );
        assert_eq!(
            normalize_hit(TextBbox { x: 10.0, y: 10.0, width: 5.0, height: -1.0 }, image.0, image.1),
            None
        );
        // 非法图像尺寸 → None
        assert_eq!(normalize_hit(inside, 0.0, 100.0), None);
    }

    // ---- 组6：pick_engine 选择链优先级 ----
    #[test]
    fn pick_engine_priority_chain() {
        // ① 用户档案语言优先
        assert_eq!(pick_engine(&["en-us", "zh-hans-cn"], &["en-us"]), Some(0));
        assert_eq!(pick_engine(&["en-us", "zh-hans-cn"], &["zh-Hans-CN"]), Some(1));
        // ② 档案无命中 → zh 族回退（简体优先）
        assert_eq!(pick_engine(&["en-us", "zh-hans-cn"], &["fr-fr"]), Some(1));
        assert_eq!(pick_engine(&["zh-hant-tw", "zh-hans-cn"], &["fr-fr"]), Some(1));
        // ③ zh 前缀兜底
        assert_eq!(pick_engine(&["en-us", "zh-hk"], &["fr-fr"]), Some(1));
        // ④ 任意可用兜底
        assert_eq!(pick_engine(&["en-us"], &["fr-fr"]), Some(0));
        // ⑤ 空列表 → None
        assert_eq!(pick_engine(&[], &["en-us"]), None);
        assert_eq!(pick_engine(&[], &[]), None);
    }

    // ---- 组7：TextBbox 几何工具（word ⊆ line 断言用） ----
    #[test]
    fn bbox_geometry_helpers() {
        let line = TextBbox { x: 0.0, y: 10.0, width: 100.0, height: 20.0 };
        let word = TextBbox { x: 5.0, y: 12.0, width: 30.0, height: 16.0 };
        assert!(word.contained_in(&line));
        // 贴边（即 line 本身）也算包含（浮点容差）
        let edge = TextBbox { x: 0.0, y: 10.0, width: 100.0, height: 20.0 };
        assert!(edge.contained_in(&line));
        // 越界不包含
        let outside = TextBbox { x: 50.0, y: 12.0, width: 60.0, height: 16.0 };
        assert!(!outside.contained_in(&line));
        assert_eq!(line.right(), 100.0);
        assert_eq!(line.bottom(), 30.0);
    }
}
