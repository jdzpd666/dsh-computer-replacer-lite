//! B-2 探针（批2；批3 raw_full 口径修复）：CaptureStream 自闭环（capture→OCR
//! 全链计时）+ CJK 合并输出 + bbox 归一化 + 引擎复用取证（拍板补充②）。
//!
//! 运行：
//! - 无参数（默认，自闭环）：cargo run --example b2_ocr --release
//!   直接 CaptureStream 取主屏帧喂 OCR（原始 BGRA 帧进 OCR——PNG 红线：PNG 只作
//!   本地诊断产物，永不进工具路径/模型管道）。
//! - 带 png 路径参数：走批1 旧路径（PNG 解码 → OCR），供指定图复测。
//!
//! 输出：行文本（CJK 已正确合并，无假空格）+ 行/词 bbox（已 clamp 进图像边界）；
//! 引擎复用取证：同一 WinrtOcr 实例连跑 5 次 OCR，报告首次 vs 后续耗时
//! （批3 常驻摊销依据：引擎实例化/语言包加载有成本，与 CaptureStream 一起常驻）。
//!
//! **raw_full 口径修复（批3，计划 §1）**：原生全文对比不再经 trait 默认实现
//! （`OcrEngine::recognize_full` 的"由行拼回全文"曾冒充引擎原生全文——C-1 同款
//! 根因）。现在两条来源并列如实输出：
//! - `raw_full(inherent)`：`WinrtOcr` 固有 `recognize_full` 直调（具体类型，不走
//!   dyn 分发）= WinRT `OcrResult.Text` 原生全文（含每字一 word 的假空格）；
//! - `trait_full(default-join)`：`OcrEngine` trait 默认实现（行拼接）——保留作
//!   trait 可替换性证明，但不再冒充原生全文。
//! 工具路径（replacer_read_screen）消费 hits 的合并行文本（ocr_logic），与两条
//! 全文都不同：顶层 text = budget_fit 之后保留行的 join（单一全文口径）。
//!
//! OCR 引擎走 `OcrEngine` trait 抽象（vision::ocr）：dyn 路径证明完整版换
//! TurboOCR/TensorRT 时本文件无需改动（升级路径硬要求）。
//! 只读操作：不注入任何输入。

use replacer_worker::vision::bitmap::Bitmap;
use replacer_worker::vision::capture::CaptureStream;
use replacer_worker::vision::ocr::{OcrEngine, WinrtOcr};
use std::time::{Duration, Instant};
use windows::core::{Error, HRESULT};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

const REUSE_ROUNDS: usize = 5; // 拍板补充②：同一实例连跑 ≥5 次

fn main() -> windows::core::Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()?; }

    let input = std::env::args().nth(1);

    // 引擎创建计时（语言包加载成本 → 批3 常驻摊销依据）。
    // 一个具体实例，两条路径并列消费：固有直调 + &dyn trait 分发。
    let t_engine = Instant::now();
    let native = WinrtOcr::create()?;
    let engine_ms = t_engine.elapsed().as_secs_f64() * 1000.0;
    let engine_name = native.engine_name();
    let dyn_engine: &dyn OcrEngine = &native;

    // 输入：默认 CaptureStream 自闭环（原始帧），带参数则 PNG 解码（旧路径）
    let (image, capture_ms, decode_ms, path_note) = match &input {
        Some(path) => {
            let png_bytes = std::fs::read(path)
                .map_err(|e| Error::new(HRESULT(0x8000_4005u32 as i32), e.to_string()))?;
            let t_decode = Instant::now();
            let image = Bitmap::decode_png(&png_bytes)?;
            let decode_ms = t_decode.elapsed().as_secs_f64() * 1000.0;
            (image, 0.0, decode_ms, path.clone())
        }
        None => {
            let t_capture = Instant::now();
            let mut stream = CaptureStream::new()?;
            let image = stream.next_frame(Duration::from_secs(2))?;
            let capture_ms = t_capture.elapsed().as_secs_f64() * 1000.0;
            let stream_size = (stream.item_size, stream.monitor_name.clone());
            stream.close();
            (
                image,
                capture_ms,
                0.0,
                format!(
                    "capture-self-loop pool={}x{} monitor={}",
                    stream_size.0 .0, stream_size.0 .1, stream_size.1
                ),
            )
        }
    };

    // 引擎复用取证（拍板补充②）：同一实例连跑 REUSE_ROUNDS 次。
    // 走 **dyn trait** 路径（可替换性证明）。
    let mut ocr_ms = Vec::with_capacity(REUSE_ROUNDS);
    let mut hits = Vec::new();
    let mut trait_full = String::new();
    for i in 0..REUSE_ROUNDS {
        let t_ocr = Instant::now();
        let (round_hits, round_full) = dyn_engine.recognize_full(&image)?;
        ocr_ms.push(t_ocr.elapsed().as_secs_f64() * 1000.0);
        if i == 0 {
            hits = round_hits;
            trait_full = round_full;
        }
    }
    let ocr_first = ocr_ms[0];
    let reuse_avg = ocr_ms[1..].iter().sum::<f64>() / (REUSE_ROUNDS - 1) as f64;

    // 固有直调（具体类型，不走 dyn）：WinRT 原生全文 + 同一批 hits。
    let t_inherent = Instant::now();
    let (inherent_hits, raw_full) = WinrtOcr::recognize_full(&native, &image)?;
    let inherent_ms = t_inherent.elapsed().as_secs_f64() * 1000.0;
    if inherent_hits.len() != hits.len() {
        // dyn 与固有两次识别理论同图同果；计数漂移只说明屏幕在变，如实报告。
        println!("  NOTE hits drift dyn={} inherent={} (screen changed between runs?)", hits.len(), inherent_hits.len());
    }

    // 全链（自闭环路径 = capture + ocr_first）
    let total_ms = capture_ms + ocr_first;

    println!(
        "B2_OCR_OK engine={} image={}x{} lines={} engine_create_ms={:.1} capture_ms={:.1} \
         decode_ms={:.1} ocr_first_ms={:.1} ocr_reuse_avg_ms={:.1} (n={}) ocr_all_ms=[{}] \
         inherent_full_ms={:.1} chain_ms={:.1} input={}",
        engine_name,
        image.width,
        image.height,
        hits.len(),
        engine_ms,
        capture_ms,
        decode_ms,
        ocr_first,
        reuse_avg,
        REUSE_ROUNDS - 1,
        ocr_ms.iter().map(|v| format!("{v:.1}")).collect::<Vec<_>>().join(","),
        inherent_ms,
        total_ms,
        path_note,
    );

    // 行输出：CJK 已合并文本 + 归一化 bbox（词级嵌套）
    for (i, hit) in hits.iter().enumerate() {
        println!(
            "  line[{}] bbox=({:.0},{:.0} {:.0}x{:.0}) text={:?}",
            i, hit.bbox.x, hit.bbox.y, hit.bbox.width, hit.bbox.height, hit.text,
        );
        for word in &hit.words {
            println!(
                "    word bbox=({:.0},{:.0} {:.0}x{:.0}) text={:?}",
                word.bbox.x, word.bbox.y, word.bbox.width, word.bbox.height, word.text,
            );
        }
    }
    // 全文三条来源并列（口径修复：不再混用）：
    // - raw_full(inherent)：WinRT OcrResult.Text 原生全文（假空格，引擎真输出）；
    // - trait_full(default-join)：trait 默认行拼接（C-1 根因，保留作可替换性证据）；
    // - merged_full(ocr_logic)：工具路径实际消费的合并行文本口径。
    println!("  raw_full(inherent WinrtOcr, native fake-spaces)={:?}", raw_full);
    println!("  trait_full(dyn OcrEngine default-join, C-1 root cause)={:?}", trait_full);
    println!(
        "  merged_full(ocr_logic, tool-path text basis)={:?}",
        hits.iter().map(|h| h.text.clone()).collect::<Vec<_>>().join("\r\n")
    );
    Ok(())
}
