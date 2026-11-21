//! 通道 B 视觉层（批2 纯逻辑 + 批3 COM 资产常驻 + 批4 locate 融合）。
//!
//! 批3 迁移（计划 §0-§1）：CaptureStream / WinrtOcr / Bitmap 三件自
//! worker/examples/vision/ 原样迁入 lib，成为 replacer_read_screen 的常驻
//! 感知资产（惰性初始化，见 ipc/handler.rs vision_thread）。
//! 批4 新增 replacer_locate：UIA 元素 × OCR 文本行融合（双通道，见
//! docs/plan-batch4-locate-20261121.md §2）。模块构成：
//!
//! - [`bitmap`]：BGRA8 位图中间表示 + PNG 编/解码（PNG 仅诊断存档，不进工具路径）；
//! - [`capture`]：DXGI Desktop Duplication 帧捕获（close 幂等守护、frame_decision 帧语义随身）；
//! - [`ocr`]：OcrEngine trait 稳定边界 + WinRT 实现（升级 TurboOCR/TensorRT 时只加 impl）；
//! - [`ocr_logic`]：零 COM 纯函数（CJK 合并 / bbox 归一化 / 引擎选择链）；
//! - [`budget`]：read_screen / locate 响应预算（budget_fit 序列化整帧口径）与区域裁剪纯函数；
//! - [`capability`]：locate 双通道判定（fusion / uia_only；grounding 批4 恒 false）；
//! - [`fusion`]：locate 融合纯函数（normalize / similarity / overlap / align / query 提取，
//!   公式与常量按计划 §2.3 冻结，不随实现调整）。
//!
//! 红线：capture/OCR 全链只读（零 SendInput/keybd_event/SendMessage）；
//! PNG 零字节出 worker（read_screen 返回纯文字+bbox）。

pub mod bitmap;
pub mod budget;
pub mod capability;
pub mod capture;
pub mod fusion;
pub mod ocr;
pub mod ocr_logic;

pub use budget::{
    budget_fit, budget_locate, clamped_region, crop_bitmap, Region, LOCATE_MAX_RESULTS,
    LOCATE_MAX_TEXT_ONLY, MAX_FRAME_BYTES, RESPONSE_BUDGET_BYTES,
};
pub use capability::{choose_channel, degrade_reason, fault_reason, Capabilities, Channel};
pub use capture::{CaptureStream, FrameAction};
pub use fusion::{
    align, aligned_hits, extract_query_hits, physical_scale, scale_rect, similarity, uia_only_hits,
    Fused, FusionElement, FusionLine, Match, Rect, TEXT_ONLY_CAP,
};
pub use ocr::{OcrEngine, TextHit, WinrtOcr};
pub use ocr_logic::{join_line_words, normalize_hit, pick_engine, TextBbox};
