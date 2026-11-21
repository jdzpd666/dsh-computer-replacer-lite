// 批3 真机 harness（B-3 replacer_read_screen，只读零注入）：
//   node scripts/verify-readscreen.mjs
//
// 覆盖（计划 §5）：
// 1. 全屏：行数、中文行、bbox 全屏物理像素界内、timings（build/capture/ocr）如实输出；
// 2. region 裁剪：1/4 屏 → 行数 ≤ 全屏且 bbox 落在 region 内（bbox 仍全屏坐标，口径③）；
// 3. 无 region 二连跑：第二次 buildMs=0（惰性摊销证据）；
// 4. 响应预算：整帧序列化字节数 ≤ 65536（真实帧远低于 budget_fit 的 58KB 预算）；
// 5. 零图像字段固化：顶层键集合精确匹配（PNG 红线：零图像字节出 worker）；
// 6. region 校验：负数 origin 被 worker 拒绝（INVALID_ARGUMENT）。
//
// 不在本 harness 内（归集成者）：panic 闩锁期间 read_screen 正常返回（对照写工具
// PANIC_ABORTED）——需独占热键窗口，npm panic-gate.test.mjs 已有插件级对照断言。
// 全程零注入：只读 capture + OCR，不触碰热键、不抢物理输入。
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../dist/worker/supervisor.js';
import { readScreenResult, MAX_FRAME_BYTES } from '../dist/ipc/protocol.js';

const exe = fileURLToPath(new URL('../dist/replacer-worker.exe', import.meta.url));
const s = new Supervisor(exe);
const ready = once(s, 'ready', { signal: AbortSignal.timeout(8000) });
s.start();
await ready;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures += 1;
};

try {
  const summary = (tag, r) => {
    const inside = r.lines.every(l => l.bbox.x >= 0 && l.bbox.y >= 0
      && l.bbox.x + l.bbox.width <= r.width + 1 && l.bbox.y + l.bbox.height <= r.height + 1);
    console.log(`${tag}: width=${r.width} height=${r.height} lines=${r.lines.length} truncated=${r.truncated}`
      + ` text_bytes=${Buffer.byteLength(r.text, 'utf8')} frame_bytes=${JSON.stringify(r).length}`
      + ` timings=build/${r.timings.buildMs.toFixed(1)} capture/${r.timings.captureMs.toFixed(1)} ocr/${r.timings.ocrMs.toFixed(1)}`
      + ` bbox_in_screen=${inside} cjk_lines=${r.lines.filter(l => /\p{Script=Han}/u.test(l.text)).length}`);
    return inside;
  };

  // 1) 全屏（首次：惰性 init，吃冷启动并如实返回 buildMs）
  const full = readScreenResult(await s.client.request('read_screen', {}, 15000));
  check('full-screen timings report an honest cold buildMs', full.timings.buildMs > 0, `buildMs=${full.timings.buildMs}`);
  check('full-screen bbox stays in full-screen physical pixels', summary('FULL', full));
  check('full-screen OCR found CJK text', /\p{Script=Han}/u.test(full.text));
  check('frame within the pipe limit', JSON.stringify(full).length <= MAX_FRAME_BYTES, `${JSON.stringify(full).length}/${MAX_FRAME_BYTES} bytes`);

  // 2) region 裁剪（bbox 保持全屏坐标且落在 region 内）。region 用右下角 (960,540) 起步——
  // 原点 (0,0) 时全屏坐标与局部坐标数值相同，对口径③'加回原点'无证伪力（批3 审查 CONCERN 修正）。
  const region = { x: 960, y: 540, width: 960, height: 540 };
  const cropped = readScreenResult(await s.client.request('read_screen', { region }, 15000));
  check('region crop sees no more lines than full screen', cropped.lines.length <= full.lines.length);
  check('region bbox inside the region (full-screen coordinates preserved, non-zero origin)',
    summary('REGION 960x540+960,540', cropped)
    && cropped.lines.every(l => l.bbox.x >= region.x && l.bbox.y >= region.y
      && l.bbox.x < region.x + region.width + 1 && l.bbox.y < region.y + region.height + 1));

  // 3) 无 region 二连跑：第二次 buildMs=0（惰性摊销证据）
  const warm = readScreenResult(await s.client.request('read_screen', {}, 15000));
  check('warm second run amortizes pipeline build', warm.timings.buildMs === 0, `buildMs=${warm.timings.buildMs}`);
  summary('FULL(warm #2)', warm);

  // 4) 零图像字段固化（顶层键集合精确匹配）
  const keys = Object.keys(full).sort().join(',');
  check('zero-image contract: exact top-level key set', keys === 'height,lines,text,timings,truncated,width', keys);

  // 5) region 校验：负数 origin / 宽 0 被 worker 拒绝
  for (const bad of [{ x: -1, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 100 }]) {
    const error = await s.client.request('read_screen', { region: bad }).then(() => null, e => e);
    check(`region ${JSON.stringify(bad)} rejected`, error?.code === 'INVALID_ARGUMENT', error?.code ?? 'accepted');
  }
} finally {
  await s.stop();
}
console.log(failures === 0 ? 'VERIFY_READSCREEN_ALL_PASSED' : `VERIFY_READSCREEN_FAILED failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
