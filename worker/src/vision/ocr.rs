//! B-2：OCR 引擎接口抽象 + WinRT（Windows.Media.Ocr）实现。
//!
//! 批3 迁移注记：本文件自 worker/examples/vision/ocr.rs 原样迁入 lib（代码与
//! 注释零改动，仅 `use` 路径随模块位置调整），成为 replacer_read_screen 的
//! 常驻 OCR 引擎（批3 计划 §0）。
//!
//! `OcrEngine` trait 是通道 B 的稳定边界（HANDOFF §9 硬要求）：周末版用
//! WinRT 系统引擎（中文友好、零部署），完整版换 TurboOCR/TensorRT 内核时
//! 只新增 impl，调用方与 replacer_read_screen 工具边界不动。
//!
//! 批2 精调（拍板③）：纯逻辑抽进 lib（`replacer_worker::vision::ocr_logic`），
//! 本文件消费三个纯函数：
//! - 行文本 = `join_line_words`（CJK 相邻不加空格，消灭 WinRT 每字一 word 的假空格）；
//! - 行/词 bbox 全部过 `normalize_hit`（clamp 进图像边界 + 面积>0 校验）；
//! - 引擎选择链 = `pick_engine`（用户档案语言 → zh 族 → 任意，选择逻辑纯函数可测）。
//!
//! 坐标系：图像/屏幕像素，左上角原点（WinRT 返回 float，这里原样保留）。

// 每个 example 只用到共享模块的一部分，抑制 per-example 死代码警告
#![allow(dead_code)]

use windows::core::{Error, HRESULT, Result};
use windows::Globalization::{ApplicationLanguages, Language};
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine as WinRtOcrEngine;
use windows::Storage::Streams::DataWriter;

// 批2 拍板③：bbox 类型与纯函数统一来自 lib 纯逻辑层（批3 直接复用）
pub use super::ocr_logic::TextBbox;
use super::ocr_logic::{join_line_words, normalize_hit, pick_engine};

use super::bitmap::Bitmap;

/// 一条文字命中：行级条目（`words` 为其内部的词级命中，bbox 同坐标系）。
#[derive(Clone, Debug)]
pub struct TextHit {
    pub text: String,
    pub bbox: TextBbox,
    pub words: Vec<TextHit>,
}

/// OCR 引擎稳定接口。完整版换引擎时只加新 impl，签名不动。
pub trait OcrEngine {
    /// 引擎标识（stdout 汇报 / 降级探测用）。
    fn engine_name(&self) -> String;
    /// 识别一张 BGRA8 位图，返回行级文字 + bbox（词级嵌套）。
    fn recognize(&self, image: &Bitmap) -> Result<Vec<TextHit>>;
    /// 识别并返回（行级命中，引擎原生全文）。默认实现由行拼回全文。
    fn recognize_full(&self, image: &Bitmap) -> Result<(Vec<TextHit>, String)> {
        let hits = self.recognize(image)?;
        let full = hits
            .iter()
            .map(|hit| hit.text.clone())
            .collect::<Vec<_>>()
            .join("\r\n");
        Ok((hits, full))
    }
}

/// WinRT 实现：Windows.Media.Ocr（系统自带，中文/中英混排友好）。
pub struct WinrtOcr {
    engine: WinRtOcrEngine,
    language_tag: String,
}

impl WinrtOcr {
    /// 引擎选择链：① 用户语言档案 → ② zh 族 → ③ 任意可用语言。
    /// 选择决策走纯函数 `pick_engine`（拍板③-3，固化断言防回归）；需已 CoInitializeEx(MTA)。
    pub fn create() -> Result<Self> {
        // 可用语言 + 用户档案，交给纯函数选链
        let available: Vec<String> = {
            let languages = WinRtOcrEngine::AvailableRecognizerLanguages()?;
            let mut tags = Vec::with_capacity(languages.Size()? as usize);
            for i in 0..languages.Size()? {
                tags.push(languages.GetAt(i)?.LanguageTag()?.to_string());
            }
            tags
        };
        let profile: Vec<String> = {
            let languages = ApplicationLanguages::Languages()?;
            let mut tags = Vec::with_capacity(languages.Size()? as usize);
            for i in 0..languages.Size()? {
                tags.push(languages.GetAt(i)?.to_string());
            }
            tags
        };
        let avail_refs: Vec<&str> = available.iter().map(|s| s.as_str()).collect();
        let prof_refs: Vec<&str> = profile.iter().map(|s| s.as_str()).collect();
        let picked = pick_engine(&avail_refs, &prof_refs)
            .ok_or_else(|| Error::new(
                HRESULT(0x8000_4005u32 as i32), // E_FAIL
                "no available OcrEngine (no language packs installed?)",
            ))?;

        // 按选中 tag 建引擎；极端情况（tag 建引擎失败）兜底逐个可用语言
        if let Ok(engine) = Self::try_from_tag(&available[picked]) {
            return Ok(Self::wrap(engine)?);
        }
        for tag in &available {
            if let Ok(engine) = Self::try_from_tag(tag) {
                return Ok(Self::wrap(engine)?);
            }
        }
        Err(Error::new(
            HRESULT(0x8000_4005u32 as i32), // E_FAIL
            "no available OcrEngine (no language packs installed?)",
        ))
    }

    fn try_from_tag(tag: &str) -> Result<WinRtOcrEngine> {
        let language = Language::CreateLanguage(&windows::core::HSTRING::from(tag))?;
        WinRtOcrEngine::TryCreateFromLanguage(&language)
    }

    fn wrap(engine: WinRtOcrEngine) -> Result<Self> {
        let tag = engine
            .RecognizerLanguage()
            .and_then(|l| l.LanguageTag())
            .map(|t| t.to_string())
            .unwrap_or_else(|_| "?".to_string());
        Ok(Self { engine, language_tag: tag })
    }

    /// 识别并附带 OcrResult 原生全文（WinRT 自带行分隔符 \r\n，含假空格——
    /// b2 探针用它做 CJK 合并前后对比；工具路径请消费 hits 的合并行文本）。
    pub fn recognize_full(&self, image: &Bitmap) -> Result<(Vec<TextHit>, String)> {
        let swb = self.to_software_bitmap(image)?;
        let result = self.engine.RecognizeAsync(&swb)?.get()?;
        let hits = Self::collect_hits(&result, image.width as f32, image.height as f32)?;
        let raw_full = result.Text()?.to_string();
        Ok((hits, raw_full))
    }

    fn to_software_bitmap(&self, image: &Bitmap) -> Result<SoftwareBitmap> {
        // BGRA8 像素 → IBuffer（unattached DataWriter 同步 DetachBuffer）→ SoftwareBitmap
        let writer = DataWriter::new()?;
        writer.WriteBytes(&image.bgra)?;
        let buffer = writer.DetachBuffer()?;
        SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            image.width as i32,
            image.height as i32,
        )
    }

    /// 行级收集（拍板③-1/2）：行文本 = join_line_words(词序列)；行/词 bbox 过
    /// normalize_hit（clamp + 面积>0，无效词丢弃；全空行丢弃）。
    fn collect_hits(
        result: &windows::Media::Ocr::OcrResult,
        image_w: f32,
        image_h: f32,
    ) -> Result<Vec<TextHit>> {
        let lines = result.Lines()?;
        let mut hits = Vec::with_capacity(lines.Size()? as usize);
        for i in 0..lines.Size()? {
            let line = lines.GetAt(i)?;
            let mut words_out: Vec<TextHit> = Vec::new();
            let mut word_texts: Vec<String> = Vec::new();
            let mut union = None::<TextBbox>;
            let words = line.Words()?;
            for j in 0..words.Size()? {
                let word = words.GetAt(j)?;
                let text = word.Text()?.to_string();
                if text.is_empty() {
                    continue;
                }
                let rect = word.BoundingRect()?;
                let raw = TextBbox { x: rect.X, y: rect.Y, width: rect.Width, height: rect.Height };
                let bbox = match normalize_hit(raw, image_w, image_h) {
                    Some(bbox) => bbox,
                    None => continue, // 出界/退化词命中丢弃
                };
                union = Some(match union {
                    None => bbox,
                    Some(u) => TextBbox {
                        // 并集矩形：左上取 min，右下取 max
                        x: u.x.min(bbox.x),
                        y: u.y.min(bbox.y),
                        width: u.right().max(bbox.right()) - u.x.min(bbox.x),
                        height: u.bottom().max(bbox.bottom()) - u.y.min(bbox.y),
                    },
                });
                word_texts.push(text.clone());
                words_out.push(TextHit { text, bbox, words: Vec::new() });
            }
            if word_texts.is_empty() {
                continue;
            }
            // 行 bbox 同样过归一化（union 本身在界内，此处校验面积>0 不变量）
            let line_bbox = normalize_hit(
                union.unwrap_or(TextBbox::ZERO),
                image_w,
                image_h,
            )
            .ok_or_else(|| Error::new(
                HRESULT(0x8000_4005u32 as i32),
                "ocr: line bbox degenerate after normalize",
            ))?;
            hits.push(TextHit {
                // 拍板③-1：CJK 合并——消灭 WinRT 每字一 word 的假空格
                text: join_line_words(&word_texts),
                bbox: line_bbox,
                words: words_out,
            });
        }
        Ok(hits)
    }
}

impl OcrEngine for WinrtOcr {
    fn engine_name(&self) -> String {
        format!("WinRT-Windows.Media.Ocr[{}]", self.language_tag)
    }

    fn recognize(&self, image: &Bitmap) -> Result<Vec<TextHit>> {
        Ok(self.recognize_full(image)?.0)
    }
}
