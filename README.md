# dsh-computer-replacer-lite

> Windows desktop automation plugin for **DeepSeek Harness (DSH)** — 14 `replacer_*` tools that let an agent read UI Automation trees, read on-screen text through DXGI + Windows OCR, and perform **approval-gated, focus-safe** input without touching the physical mouse.

**中文简介**：DSH 的 Windows 电脑操控插件（第 14 个工具 `replacer_locate` 于 0.2.0 上线）。感知走 UIA + DXGI/OCR 两条通道，**读屏路径零图像字节出 worker**；所有写操作都先弹审批卡；全局急停热键 `Ctrl+Alt+Shift+P`；动作前必须 observe，焦点一变即 fail-closed。

- Version: **0.2.2** (2026-11-21)
- Platform: Windows 10/11 x64 (tested on Windows 11 25H2, build 26200, 125% DPI)
- License: MIT

---

## Highlights

- **UIA-first.** Element actions use native UIA patterns (Invoke / Value / Scroll). `PostMessageW` is only used for L2 fallbacks (context menu, wheel, single key), and physical coordinate clicks are the last resort.
- **Zero-image read paths.** `replacer_read_screen` and `replacer_locate` return **text lines + physical-pixel bboxes + timings only**; image bytes never leave the Rust worker (the protocol rejects any unknown field, e.g. `unexpected field in read-screen result (zero-image contract violated)`).
- **Approval-gated.** Every mutating call opens an approval card; denial or timeout means **zero worker requests**. Screen reads have their own read-only card that discloses they read everything visible on screen.
- **Global panic hotkey.** `Ctrl+Alt+Shift+P` latches an emergency stop: injection stops immediately (worker + TS latch), while read-only perception keeps working. There is also an in-UI panic button.
- **Fail-closed context safety.** Actions are bound to a prior `replacer_observe` snapshot; if the foreground window or focus changes, the action is rejected with `CONTEXT_CHANGED` and never replayed.
- **Named-pipe IPC.** TypeScript plugin ↔ Rust worker over a per-launch Windows named pipe: length-framed UTF-8 JSON, 64 KiB frame cap, 128 pending requests, bounded restart budget.

---

## Tools (14)

| Tool | What it does | Injection |
|---|---|---|
| `replacer_observe` | Read-only UIA snapshot of an explicit hwnd: one page of elements, snapshotId + nextOffset pagination, focus fingerprint. | none |
| `replacer_windows` | Read-only: list top-level windows (hwnd, label, control type, bounds). | none |
| `replacer_status` | Read-only: worker connection, tier (currently `L2`), worlds, panic latch, approval audit. | none |
| `replacer_read_screen` | Read-only screen perception: DXGI Desktop Duplication capture + local WinRT OCR, returns text lines with full-screen physical-pixel bboxes and timings. Optional `region` only narrows the OCR input; bboxes stay in full-screen coordinates. Response is byte-budgeted (≈58 KB), truncation is explicit. | none |
| `replacer_locate` | Read-only fusion locator (0.2.0): reconciles a UIA snapshot with the OCR channel. Returns candidate `matches` (stable `elementId`, label, bbox, score — feed one to `replacer_click_by_id`) and `textOnly` (text OCR saw that the UIA tree does not expose). Optional `query`; degrades to `channel:"uia_only"` + `degraded:true` when capture/OCR is unavailable. **Never clicks.** | none |
| `replacer_click_by_id` | Click one observed element (L1 main path). | UIA InvokePattern |
| `replacer_type` | Write text into one observed element. | UIA ValuePattern (SetValue); no synthesized keystrokes |
| `replacer_scroll` | Scroll one observed container by whole viewports (1–10 steps). | UIA ScrollPattern |
| `replacer_right_click_by_id` | Right-click one observed element (L2, for controls without a UIA pattern). | PostMessageW `WM_CONTEXTMENU` |
| `replacer_wheel_by_id` | Wheel-scroll the focused window of an observed element (L2, for self-drawn containers). | PostMessageW `WM_MOUSEWHEEL` |
| `replacer_key` | Post one key to an explicit hwnd's input surface (L2). Single key names or one character; **no Ctrl/Alt/Shift chords** (PostMessageW cannot deliver modifier state). | PostMessageW `WM_CHAR` / `WM_KEYDOWN`+`WM_KEYUP` |
| `replacer_observe_elevated` | Read-only UIA snapshot of a higher-integrity window through the user-launched elevated broker (e.g. Task Manager). | none |
| `replacer_click_elevated` | Click an element returned by `replacer_observe_elevated`. | elevated broker → UIA InvokePattern |
| `replacer_click_xy` | Coordinate fallback, only when no UIA element can be addressed. Moves the physical pointer. | SetCursorPos + SendInput left click |

### DSH fast-click signals

When the model writes an exact control name as `<C:Control Name>` or a known UIA runtime id as `<I:r:[42,1115222]>` **alone in its reply**, the harness turns it into a UIA invoke on the most recently observed window after an approval card. This is a DSH integration feature; it only works for UIA-addressable controls.

---

## Requirements

- Windows 10 or 11, x64
- DeepSeek Harness desktop app
- Node.js >= 22 only if you build from source
- Rust + MSVC + Windows SDK only if you rebuild the worker (a prebuilt `dist/replacer-worker.exe` is shipped in this repository)

**Not supported yet:** multi-monitor / mixed-DPI setups (single monitor is assumed), drag gestures, modifier-key chords, and pixel-level vision grounding.

---

## Install

The plugin ships **prebuilt** (`dist/index.js`, `dist/client.js`, `dist/replacer-worker.exe`), so no build step is required.

1. **From the DSH plugin market** — listed under *tools*: [jdzpd666/dsh-computer-replacer-lite](https://awesome-dsh-plugin.com/p/jdzpd666/dsh-computer-replacer-lite/). Search “computer replacer”, or install it directly:

   ```bash
   dsh plugin --profile web add github:jdzpd666/dsh-computer-replacer-lite
   ```
2. **From this repository** — add the package to your DSH profile as a dependency named `dsh-computer-replacer` (the package name is intentionally not “-lite”, so existing installs keep working), add it to the profile's `bundles`, and restart DSH. For a local checkout:

```json
"dsh-computer-replacer": "file:F:/path/to/dsh-computer-replacer-lite"
```

Then open the DSH plugin page and enable the plugin. The worker is started automatically; `replacer_status` should report `connected: true` and `tier: "L2"`.

### Build from source

```bash
npm ci
npm run build:ts        # tsc -> dist/
npm run build:client    # client bundle -> dist/client.js
npm run build:worker    # Rust release build (MSVC + Windows SDK), copies the exe into dist/
```

Verification (Windows, real worker):

```bash
cargo test --release     # in worker/
npm test                 # tsc + node --test tests/automated/*.test.mjs
```

---

## Safety model

- **Approval before action.** Mutating tools ask every time; a denied/cancelled card produces no worker request. Read-only screen reads have a separate card that states they read all visible screen content.
- **Permission presets (read this).** `cordis.patch.yml` adds three presets to `@deepseek-ai/dsh-permission-presets`: `danger-full-access` (**the default**), `workspace-write-ask`, and `workspace-write-never`. With the default preset, new sessions run mutating tools without approval cards. Pick `workspace-write-ask` in DSH if you want the approval path above; remove the `permission` block from the patch if you do not want the presets at all.
- **No L3 keyboard injection.** The keyboard path never uses `SendInput`/`keybd_event`; `replacer_status.l3` is always `false`. `SendInput` only exists in the `replacer_click_xy` coordinate fallback, which shows an approval card and visibly moves the pointer.
- **Panic latch.** `Ctrl+Alt+Shift+P` (global hotkey) or the in-UI panic button latches a stop. Injection is cut; read-only tools such as `replacer_read_screen`/`replacer_locate` continue to work by design.
- **Zero-image contract.** Screen-reading responses are validated against a strict whitelist; any extra field (including images) fails the call.
- **Context changes fail closed.** After `observe`, a focus/window change produces `CONTEXT_CHANGED`; no action is retried automatically.
- **Process boundary.** The worker runs as a child process at the user's integrity level. Elevated windows require the separately user-launched elevated broker (UAC); it only serves ping/observe/invoke/stop and rejects other accounts.

---

## Project layout

```
src/                 TypeScript plugin: tool registration, approval/policy gates, IPC client, worker supervisor
dist/                Prebuilt plugin output shipped with the repo (JS + replacer-worker.exe)
worker/              Rust worker: UIA observation, DXGI capture, WinRT OCR, PostMessage L2 injection, IPC
scripts/             Build helpers, fixtures and verification harnesses
tests/automated/     Node test suite (protocol, gates, plugin registration, real worker E2E)
cordis.patch.yml     DSH bundle patch
```

---

## Limitations

- Windows only; single monitor; mixed DPI not supported.
- No drag gestures, no modifier-key chords, no pixel-level visual grounding (the locator matches text — UIA labels + OCR — not images).
- `replacer_key` posts single keys; use `replacer_type` for text.
- Some applications ignore `WM_CONTEXTMENU`/`WM_MOUSEWHEEL`; those need a UIA-native alternative or `replacer_click_xy`.
- This tool can automate UI steps; it is not a replacement for human judgment (e.g. design/CAD modeling decisions).

## License

MIT © 2026 jdzpd666. Not affiliated with Microsoft or DeepSeek.
