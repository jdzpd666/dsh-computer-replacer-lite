//! 通道 B 共享位图结构 + PNG 编/解码。
//!
//! 批3 迁移注记：自 worker/examples/vision/bitmap.rs 原样迁入 lib（必修①：
//! capture.rs/ocr.rs 均 use 同包 Bitmap，三件一起迁；PNG 编码仍只服务本地
//! 诊断产物，**永不进工具路径/模型管道**——PNG 红线不变）。
//!
// 每个 example 只用到共享模块的一部分，抑制 per-example 死代码警告
#![allow(dead_code)]
//!
//! `Bitmap` 是通道 B 的中间表示：B-1 捕获产出 BGRA8 像素，B-2 OCR 消费同一结构。
//! 完整版换 GoClick/TensorRT 帧源时此类型不动（HANDOFF §9 升级路径）。
//!
//! PNG 编码是纯 Rust 零依赖实现（RGB8、filter 0、deflate stored 块），
//! 同步、确定性；PNG 解码走 WinRT BitmapDecoder（需已初始化 COM/MTA）。

use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

/// BGRA8 位图：一行 `width * 4` 字节，无行填充，行序从上到下。
#[derive(Clone)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

impl Bitmap {
    pub fn new(width: u32, height: u32, bgra: Vec<u8>) -> windows::core::Result<Self> {
        let expected = width as usize * height as usize * 4;
        if bgra.len() != expected {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x80070057u32 as i32), // E_INVALIDARG
                format!(
                    "Bitmap: pixel buffer {expected} bytes expected, got {}",
                    bgra.len()
                ),
            ));
        }
        Ok(Self { width, height, bgra })
    }

    /// WinRT 解码 PNG/任意系统支持格式为 BGRA8。需已 CoInitializeEx(MTA)。
    pub fn decode_png(png: &[u8]) -> windows::core::Result<Self> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::new()?;
        writer.WriteBytes(png)?;
        let buffer = writer.DetachBuffer()?;
        stream.WriteAsync(&buffer)?.get()?;
        stream.Seek(0)?;

        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let width = decoder.PixelWidth()?;
        let height = decoder.PixelHeight()?;
        let format = decoder.BitmapPixelFormat()?;
        let data = decoder.GetPixelDataAsync()?.get()?.DetachPixelData()?;

        // 归一化到 BGRA8：WIC 的 PNG 解码常见 RGBA8，交换 R/B 通道。
        let mut bgra = data.to_vec();
        if format == BitmapPixelFormat::Rgba8 {
            for px in bgra.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
        }
        Self::new(width, height, bgra)
    }

    /// 编码为 PNG（RGB8，filter 0，deflate stored 块）。纯同步零依赖。
    pub fn to_png(&self) -> Vec<u8> {
        // 原始扫描线：每行前一个 filter 字节（0 = None），行内 BGRA -> RGB。
        let row_len = 1 + self.width as usize * 3;
        let mut raw = Vec::with_capacity(row_len * self.height as usize);
        for row in 0..self.height as usize {
            raw.push(0u8); // filter type None
            let src = &self.bgra[row * self.width as usize * 4..];
            for px in src[..self.width as usize * 4].chunks_exact(4) {
                raw.push(px[2]); // B -> R
                raw.push(px[1]); // G
                raw.push(px[0]); // R -> B
            }
        }

        // zlib 流：header + stored deflate 块 + adler32
        let mut idat = vec![0x78u8, 0x01u8];
        let mut offset = 0usize;
        while offset < raw.len() {
            let chunk = (raw.len() - offset).min(65535);
            let final_block = offset + chunk == raw.len();
            idat.push(if final_block { 1 } else { 0 });
            idat.extend_from_slice(&(chunk as u16).to_le_bytes());
            idat.extend_from_slice(&(!(chunk as u16)).to_le_bytes());
            idat.extend_from_slice(&raw[offset..offset + chunk]);
            offset += chunk;
        }
        idat.extend_from_slice(&adler32(&raw).to_be_bytes());

        let mut png = Vec::with_capacity(idat.len() + 64);
        png.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&self.width.to_be_bytes());
        ihdr.extend_from_slice(&self.height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // bitdepth 8, RGB, deflate, filter 0, no interlace
        push_chunk(&mut png, b"IHDR", &ihdr);
        push_chunk(&mut png, b"IDAT", &idat);
        push_chunk(&mut png, b"IEND", &[]);
        png
    }

    /// 落盘 PNG，返回文件字节数。
    pub fn save_png(&self, path: &str) -> std::io::Result<usize> {
        let png = self.to_png();
        std::fs::write(path, &png)?;
        Ok(png.len())
    }
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = crc32(kind);
    crc = crc32_update(crc, data);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    crc32_update(0xFFFF_FFFF, data) ^ 0xFFFF_FFFF
}

fn crc32_update(mut crc: u32, data: &[u8]) -> u32 {
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}
