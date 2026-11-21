//! B-1 探针（批2）：CaptureStream 冷/热矩阵 + PNG 编码分离计时。
//!
//! 批3 迁移注记：CaptureStream/Bitmap 已迁入 lib（replacer_worker::vision），
//! 本探针改走 lib 路径（examples/vision/ 目录已删除，避免双份漂移）。
//!
//! 运行：cargo run --example b1_capture --release
//! 产出：%TEMP%\replacer-b1-frame.png（B-2 的默认输入，形成自闭环）。
//!
//! 计时矩阵（拍板①口径：warm <100ms 硬指标，cold 只作诊断如实报告）：
//! - cold：进程 main() 起点 → 首帧到手全链（含 COM 初始化、DXGI/D3D 设备创建、
//!   帧池/会话建立、首帧到达等待、staging 拷贝读出）；
//! - warm×10：会话常驻后连续取 10 帧（静止屏走缓存帧路径，即拍板补充①的
//!   真机验证），报 avg/max/p95；
//! - PNG：编码+落盘单独计时（红线：PNG 只作本地诊断产物，移出关键路径，
//!   永不进工具路径/模型管道）。
//!
//! 只读操作：不注入任何输入；探针结束显式 close 并退出。

use replacer_worker::vision::{bitmap::Bitmap, capture::CaptureStream};

use std::time::{Duration, Instant};

use windows::core::{Error, HRESULT};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

const WARM_ROUNDS: usize = 10;

fn main() -> windows::core::Result<()> {
    // cold 计时起点：main() 第一行（COM 初始化也计入 cold）
    let t0 = Instant::now();

    // WinRT/DXGI 都要求 COM 已初始化；多线程套间 + 免线程工厂（与 worker uia 模块同款写法）
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()?; }

    let mut stream = CaptureStream::new()?;
    let new_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // cold：进程起点 → 首帧全链
    let first = stream.next_frame(Duration::from_secs(2))?;
    let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // warm×10：常驻会话连续取帧（静止屏 = 缓存帧路径，拍板补充①真机验证）
    let mut warm_ms = Vec::with_capacity(WARM_ROUNDS);
    for _ in 0..WARM_ROUNDS {
        let t = Instant::now();
        let _frame = stream.next_frame(Duration::from_secs(1))?;
        warm_ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let warm_avg = warm_ms.iter().sum::<f64>() / warm_ms.len() as f64;
    let warm_max = warm_ms.iter().cloned().fold(0.0, f64::max);
    let warm_p95 = percentile(&warm_ms, 0.95);
    let warm_pass = warm_avg < 100.0 && warm_max < 100.0;

    // PNG 编码分离计时（红线：仅本地诊断存档，不进工具路径）
    let t_png = Instant::now();
    let png_len = stream_frame_save(&first, &output_path())
        .map_err(|e| Error::new(HRESULT(0x8000_4005u32 as i32), e.to_string()))?;
    let png_ms = t_png.elapsed().as_secs_f64() * 1000.0;

    let (name, size) = (stream.monitor_name.clone(), stream.item_size);
    stream.close();

    println!(
        "B1_STREAM_OK monitor={} pool_size={}x{} frame={}x{} new_ms={:.1} cold_ms={:.1} \
         warm_n={} warm_avg_ms={:.1} warm_max_ms={:.1} warm_p95_ms={:.1} warm_target=<100ms {} \
         png_ms={:.1} png_bytes={} path={}",
        name,
        size.0,
        size.1,
        first.width,
        first.height,
        new_ms,
        cold_ms,
        WARM_ROUNDS,
        warm_avg,
        warm_max,
        warm_p95,
        if warm_pass { "PASS" } else { "FAIL" },
        png_ms,
        png_len,
        output_path(),
    );
    // warm 序列明细（诊断用）
    println!(
        "B1_WARM_SERIES {}",
        warm_ms.iter().map(|v| format!("{v:.1}")).collect::<Vec<_>>().join(",")
    );
    Ok(())
}

/// PNG 编码 + 落盘（本地诊断产物专用；工具路径消费原始帧数据，见 capture.rs 红线注释）。
fn stream_frame_save(frame: &Bitmap, path: &str) -> std::io::Result<usize> {
    frame.save_png(path)
}

/// 线性插值百分位（n=10 时 p95 落在尾部两点之间，比取最大值更有诊断意义）。
fn percentile(values: &[f64], p: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in timing"));
    if sorted.is_empty() {
        return 0.0;
    }
    let index = p * (sorted.len() - 1) as f64;
    let low = index.floor() as usize;
    let high = index.ceil() as usize;
    if low == high {
        return sorted[low];
    }
    let frac = index - low as f64;
    sorted[low] * (1.0 - frac) + sorted[high] * frac
}

fn output_path() -> String {
    format!("{}\\replacer-b1-frame.png", temp_dir())
}

fn temp_dir() -> String {
    std::env::var("TEMP").unwrap_or_else(|_| ".".to_string())
}
