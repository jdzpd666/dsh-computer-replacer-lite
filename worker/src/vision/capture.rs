//! B-1：DXGI Desktop Duplication 帧捕获 —— 批2 流式化（CaptureStream 常驻会话）。
//!
//! 批3 迁移注记：本文件自 worker/examples/vision/capture.rs 原样迁入 lib
//! （代码与注释零改动，仅 `use` 路径随模块位置调整），成为 replacer_read_screen
//! 的常驻帧源（批3 计划 §0）。
//!
//! 管线（`new()` 一次性建好，全资产常驻，会话不再用完即拆）：
//! DXGI 枚举适配器/输出 → D3D11 设备 → interop IDirect3DDevice →
//! GraphicsCaptureItem（监视器）→ Direct3D11CaptureFramePool(FreeThreaded, buffer=2)
//! → FrameArrived 事件注册 → CaptureSession.StartCapture。
//!
//! `next_frame(timeout)` 事件驱动取帧：FrameArrived 在池线程持续 drain 队列并只
//! 保留最新一帧（丢弃积压，符合 buffer=2 语义）；Condvar::wait_timeout 唤醒，
//! 无 sleep 轮询（批1 的 16ms 轮询粒度损耗消除）。warm 单次取帧 ≈ staging
//! 拷贝耗时，预期 <20ms；warm <100ms 是硬指标（拍板①）。
//!
//! 帧语义（批2 拍板补充①）：DXGI 只在内容变化时推新帧——静止屏幕下不会再有
//! FrameArrived 事件。此时 `next_frame` 必须返回池中缓存的最后一帧（那正是
//! OCR 要的当前画面），**不得等满 timeout 报超时**。实现：最新帧纹理常驻信号
//! 区不清空，存在缓存即立即返回；只有"从未收到任何帧"且等待超时才报错。
//! 决策逻辑抽为纯函数 [`frame_decision`]，由 worker/tests/vision.test.rs 静态
//! 单测固化，真机行为由 b1 warm 矩阵验证。
//!
//! warm/cold 口径（拍板①）：warm <100ms 硬指标；cold 只作诊断数字如实报告，
//! **不加**设备预热缓存——cold 由进程冷启动与设备创建支配，工具化后 worker
//! 常驻即可摊销，这正是 B-3 把 CaptureStream 放进 worker 常驻的设计依据。
//!
//! PNG 红线（批2 拍板②）：PNG 只作本地诊断产物（存 %TEMP%），**永远不进工具
//! 路径/模型管道**（6.2MB 顺管道发模型会炸上下文）；OCR 与工具消费原始帧数据
//! （BGRA `Bitmap`）。PNG 编码不在此模块关键路径内，仅存档时单独计时编码。
//!
//! 只读操作：不注入任何输入；帧池用 FreeThreaded 无需 DispatcherQueue。
//! 需调用线程已 CoInitializeEx(MTA)。

// 本模块同时被 b1/b2 两个 example 与 tests/vision.test.rs 引用，
// 每个 crate root 只用到其中一部分，抑制 per-crate 死代码警告
#![allow(dead_code)]

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use windows::core::{factory, Error, HRESULT, Interface, Result};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1, IDXGIOutput, DXGI_OUTPUT_DESC,
};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::bitmap::Bitmap;

/// `next_frame` 的取帧决策纯函数（拍板补充① 的可测形式，零 COM）。
///
/// - `has_cache` = 池中是否有缓存帧（含静止屏幕的最后一帧——缓存纹理常驻不清空）；
/// - `timed_out` = 本次等待是否已到 timeout。
///
/// 决策表：
/// - 有缓存 → 立即返回缓存帧（静止屏的正常路径，OCR 拿到的就是当前画面）；
/// - 无缓存且超时 → 报错（只有"从未收到任何帧"才会走到这里）；
/// - 其余 → 继续等 FrameArrived 唤醒（Condvar，无轮询）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameAction {
    /// 返回池中缓存的最新帧（立即，≈staging 拷贝耗时）。
    ReturnCached,
    /// 无任何帧，继续等待（首帧到达路径）。
    WaitForFirst,
    /// 从未收到任何帧且等待超时 → 报错。
    ErrorTimeout,
}

pub fn frame_decision(has_cache: bool, timed_out: bool) -> FrameAction {
    if has_cache {
        FrameAction::ReturnCached
    } else if timed_out {
        FrameAction::ErrorTimeout
    } else {
        FrameAction::WaitForFirst
    }
}

/// 最新帧信号区：FrameArrived（池线程）写入，next_frame（调用线程）读取。
#[derive(Default)]
struct FrameSignal {
    /// 池中最新的帧纹理（常驻不清空——静止屏帧语义的载体）。
    texture: SendTexture,
    /// 累计到帧计数（诊断用）。
    frame_seq: u64,
}

/// D3D11 纹理指针的跨线程搬运包装。
///
/// 安全性依据：D3D11 对象是自由线程对象（free-threaded，无套间亲和），
/// 接口指针可跨套间/线程使用；所有权由 `Arc<Mutex<FrameSignal>>` 保证，
/// 任一时刻信号区只持一份引用，`next_frame` clone 后在调用线程独占使用。
/// 这与 WinRT FreeThreaded 帧池的事件线程模型（官方 GraphicsCapture 示例同款做法）一致。
struct SendTexture(Option<ID3D11Texture2D>);
unsafe impl Send for SendTexture {}
impl Default for SendTexture {
    fn default() -> Self {
        Self(None)
    }
}

/// 常驻捕获流：一次建管线，反复取帧。
///
/// 用法：`new()` → 多次 `next_frame(timeout)` → `close()`（Drop 兜底同样关闭）。
/// 非 Send：设备/staging 等资产应在创建线程上使用（探针与批3 worker 均单线程消费）。
pub struct CaptureStream {
    // 事件信号区（handler 与 next_frame 共享）
    signal: Arc<(Mutex<FrameSignal>, Condvar)>,
    // 常驻管线资产
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    capture_device: IDirect3DDevice,
    item: GraphicsCaptureItem,
    frame_cookie: i64,
    closed: bool,
    session: GraphicsCaptureSession,
    pool: Direct3D11CaptureFramePool,
    /// 捕获目标描述（stdout 汇报用）。
    pub monitor_name: String,
    pub item_size: (i32, i32),
}

impl CaptureStream {
    /// 一次性建全管线并启动常驻会话。需已 CoInitializeEx(MTA)。
    pub fn new() -> Result<Self> {
        unsafe {
            // 1) DXGI 枚举：工厂 → 适配器 0 → 输出 0（主显示器）
            let dxgi_factory: IDXGIFactory1 = CreateDXGIFactory1()?;
            let adapter: IDXGIAdapter1 = dxgi_factory.EnumAdapters1(0)?;
            let output: IDXGIOutput = adapter.EnumOutputs(0)?;
            let desc: DXGI_OUTPUT_DESC = output.GetDesc()?;
            let monitor = desc.Monitor;
            let monitor_name = {
                let len = desc
                    .DeviceName
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(desc.DeviceName.len());
                String::from_utf16_lossy(&desc.DeviceName[..len])
            };

            // 2) D3D11 设备（绑该适配器；BGRA 支持是 WinRT 互操作前提）
            let mut device_out: Option<ID3D11Device> = None;
            let mut context_out: Option<ID3D11DeviceContext> = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN, // 指定适配器时必须 UNKNOWN
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1]),
                D3D11_SDK_VERSION,
                Some(&mut device_out),
                None,
                Some(&mut context_out),
            )?;
            let device = device_out.ok_or_else(|| err("D3D11CreateDevice: no device"))?;
            let context = context_out.ok_or_else(|| err("D3D11CreateDevice: no context"))?;

            // 3) D3D11 设备 → WinRT IDirect3DDevice（Graphics.DirectX interop）
            let dxgi_device: IDXGIDevice = device.cast()?;
            let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)?;
            let capture_device: IDirect3DDevice = inspectable.cast()?;

            // 4) GraphicsCaptureItem：主监视器
            let interop: IGraphicsCaptureItemInterop =
                factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop.CreateForMonitor(monitor)?;
            let size = item.Size()?;
            let item_size = (size.Width, size.Height);

            // 5) 帧池（FreeThreaded：事件在池线程回调，无需 DispatcherQueue）
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &capture_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2, // buffer=2：handler 只留最新，另一格供合成器写入
                size,
            )?;

            // 6) FrameArrived 事件：drain 队列只留最新一帧，Condvar 唤醒取帧方
            let signal: Arc<(Mutex<FrameSignal>, Condvar)> =
                Arc::new((Mutex::new(FrameSignal::default()), Condvar::new()));
            let handler_signal = Arc::clone(&signal);
            let handler = TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(
                move |sender, _args| {
                let pool = sender.ok()?;
                // drain：把池中积压帧取空，只保留最新（丢弃积压）
                loop {
                    match pool.TryGetNextFrame() {
                        Ok(frame) => {
                            let surface = frame.Surface()?;
                            let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
                            let texture: ID3D11Texture2D = access.GetInterface()?;
                            let (lock, cvar) = &*handler_signal;
                            let mut guard = lock.lock().expect("frame signal mutex poisoned");
                            guard.texture = SendTexture(Some(texture));
                            guard.frame_seq += 1;
                            drop(guard);
                            cvar.notify_all();
                        }
                        Err(_) => break, // 池空（DXGI 无新帧即返回 Err）
                    }
                }
                Ok(())
                },
            );
            let frame_cookie = pool.FrameArrived(&handler)?;

            // 7) 会话常驻启动
            let session = pool.CreateCaptureSession(&item)?;
            // 不捕获光标（老系统无此属性，失败忽略）
            let _ = session.SetIsCursorCaptureEnabled(false);
            session.StartCapture()?;

            Ok(Self {
                signal,
                staging: None,
                device,
                context,
                capture_device,
                item,
                frame_cookie,
                closed: false,
                session,
                pool,
                monitor_name,
                item_size,
            })
        }
    }

    /// 取一帧 BGRA8 位图（事件驱动，无轮询）。
    ///
    /// 帧语义见模块注释（拍板补充①）：有缓存帧立即返回（静止屏即此路径）；
    /// 无任何帧时等待 FrameArrived 唤醒直至 `timeout`，超时才报错。
    pub fn next_frame(&mut self, timeout: Duration) -> Result<Bitmap> {
        let deadline = Instant::now() + timeout;
        let (lock, cvar) = &*self.signal;
        let mut guard = lock.lock().expect("frame signal mutex poisoned");

        let texture = loop {
            // 拍板补充①：缓存帧存在 → 立即返回（静止屏无新帧也返回最后一帧）
            if let Some(texture) = guard.texture.0.clone() {
                break texture;
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(err("capture: no frame within timeout (first frame)"));
            }
            let (next_guard, wait) =
                cvar.wait_timeout(guard, deadline - now).expect("condvar poisoned");
            guard = next_guard;
            if wait.timed_out() && guard.texture.0.is_none() {
                return Err(err("capture: no frame within timeout (first frame)"));
            }
        };
        drop(guard);
        self.readout(&texture)
    }

    /// 把帧纹理拷进 staging 并读出 BGRA 像素（warm 单次取帧 ≈ 本函数耗时）。
    fn readout(&mut self, texture: &ID3D11Texture2D) -> Result<Bitmap> {
        unsafe {
            let mut tex_desc: D3D11_TEXTURE2D_DESC = std::mem::zeroed();
            texture.GetDesc(&mut tex_desc);

            // staging 复用：尺寸不变则不重建（分辨率切换时兜底重建）
            let staging = match &self.staging {
                Some((staging, w, h)) if *w == tex_desc.Width && *h == tex_desc.Height => {
                    staging.clone()
                }
                _ => {
                    let staging_desc = D3D11_TEXTURE2D_DESC {
                        Width: tex_desc.Width,
                        Height: tex_desc.Height,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: tex_desc.Format,
                        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0, // staging 纹理不绑渲染管线
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                    };
                    let mut staging_out: Option<ID3D11Texture2D> = None;
                    self.device
                        .CreateTexture2D(&staging_desc, None, Some(&mut staging_out))?;
                    let staging = staging_out.ok_or_else(|| err("CreateTexture2D: no staging"))?;
                    self.staging = Some((staging.clone(), tex_desc.Width, tex_desc.Height));
                    staging
                }
            };

            let source: ID3D11Resource = texture.cast()?;
            let target: ID3D11Resource = staging.cast()?;
            self.context.CopyResource(&target, &source);

            let mut mapped: D3D11_MAPPED_SUBRESOURCE = std::mem::zeroed();
            self.context
                .Map(&target, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let width = tex_desc.Width;
            let height = tex_desc.Height;
            let row_bytes = width as usize * 4;
            let mut bgra = Vec::with_capacity(row_bytes * height as usize);
            let base = mapped.pData as *const u8;
            for row in 0..height as usize {
                let src = base.add(row * mapped.RowPitch as usize);
                bgra.extend_from_slice(std::slice::from_raw_parts(src, row_bytes));
            }
            self.context.Unmap(&target, 0);

            Bitmap::new(width, height, bgra)
        }
    }

    /// 显式关闭会话并注销事件（Drop 亦会兜底调用）。
    /// 幂等（真机实证：显式 close 后 Drop 再走一次 close，第二次
    /// RemoveFrameArrived 携带过期 token 会触发 0xC0000409 fail-fast 崩溃；
    /// 用 closed 标志守护，重复 close 安全）。
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let _ = self.pool.RemoveFrameArrived(self.frame_cookie);
        let _ = self.session.Close();
        let _ = self.pool.Close();
        self.staging = None;
    }
}

impl Drop for CaptureStream {
    fn drop(&mut self) {
        self.close();
    }
}

/// 单帧捕获结果：像素位图 + 捕获目标描述（stdout 汇报用）。
pub struct CaptureOutcome {
    pub bitmap: Bitmap,
    pub monitor_name: String,
    pub item_size: (i32, i32),
}

/// 兼容薄包装（拍板：保留 b2_ocr 旧输入路径）：建流 → 取一帧 → 关流。
/// 需已 CoInitializeEx(MTA)。
pub fn capture_primary_monitor() -> Result<CaptureOutcome> {
    let mut stream = CaptureStream::new()?;
    let bitmap = stream.next_frame(Duration::from_secs(2))?;
    let outcome = CaptureOutcome {
        bitmap,
        monitor_name: stream.monitor_name.clone(),
        item_size: stream.item_size,
    };
    stream.close();
    Ok(outcome)
}

fn err(message: &str) -> Error {
    Error::new(HRESULT(0x8000_4005u32 as i32), message) // E_FAIL
}
