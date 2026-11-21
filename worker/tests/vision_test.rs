//! 通道 B vision 静态单测（批2；批3 迁移后改走 lib 路径）：帧语义拍板补充① 的
//! 可测固化 + 位图不变量。
//!
//! 真机行为（静止屏缓存帧、warm 矩阵）由 b1_capture 探针验证；这里固化纯逻辑：
//! - `frame_decision`：next_frame 的取帧决策表（零 COM）；
//! - `Bitmap::new`：像素缓冲尺寸不变量。
//!
//! capture.rs/ocr.rs 的 COM 路径在 cargo test 中只编译不执行（无头环境安全）。批3
//! 后 bitmap/capture 已是 lib 模块（replacer_worker::vision），直接 use，不再挂
//! examples 源文件。

use replacer_worker::vision::capture::{frame_decision, FrameAction};
use replacer_worker::vision::bitmap;

// ---- 组1：静止屏帧语义（拍板补充① 决策表） ----
// 核心红线：有缓存帧时不得等满 timeout 报超时——必须立即返回缓存帧
//（那正是 OCR 要的当前画面）；只有"从未收到任何帧"且超时才报错。
#[test]
fn static_screen_returns_cached_frame_not_timeout() {
    // 静止屏：无新帧到达，但池中有最后一帧 → 立即返回缓存（超时与否无关）
    assert_eq!(frame_decision(true, false), FrameAction::ReturnCached);
    assert_eq!(frame_decision(true, true), FrameAction::ReturnCached);
    // 冷启动首帧：无缓存未超时 → 继续等 FrameArrived（事件驱动，无轮询）
    assert_eq!(frame_decision(false, false), FrameAction::WaitForFirst);
    // 冷启动失败：无缓存且超时 → 唯一允许报超时的场景
    assert_eq!(frame_decision(false, true), FrameAction::ErrorTimeout);
}

// ---- 组2：Bitmap 像素缓冲不变量 ----
#[test]
fn bitmap_size_invariant() {
    let bgra = vec![0u8; 4 * 6];
    let bmp = bitmap::Bitmap::new(3, 2, bgra.clone()).expect("3x2 needs 24 bytes");
    assert_eq!(bmp.width, 3);
    assert_eq!(bmp.height, 2);
    assert_eq!(bmp.bgra.len(), 24);
    // 尺寸不符必须报错（E_INVALIDARG）
    assert!(bitmap::Bitmap::new(4, 2, bgra).is_err());
}
