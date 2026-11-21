import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  Frames, IpcError, clickResult, elementDetail, encode, fastClickResult, fastClickXyResult, keyResult, labelLookup, locateResult,
  normalizeClick, normalizeClickXy, normalizeKey, normalizeLabelLookup, normalizeLocate, normalizeObserve, normalizeReadScreen, normalizeRightClick,
  normalizeRuntimeClick, normalizeRuntimeLookup, normalizeScroll, normalizeType, normalizeWheel,
  object, observePage, readScreenResult, response, rightClickResult, runtimeLookup, scrollResult, typeResult, wheelResult, windows,
  workerStatus,
  type ClickResult, type ElementDetail, type FastClickResult, type FastClickXyResult, type KeyResult, type LabelLookup, type LocateResult,
  type NormalizedLocateRequest, type NormalizedReadScreenRequest, type ObservePage, type ReadScreenResult, type RightClickResult, type RuntimeLookup,
  type ScrollResult, type TypeResult, type WheelResult,
  type WindowInfo, type WorkerStatus,
} from './protocol.js';

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }

export class IpcClient extends EventEmitter {
  private socket: Socket | undefined;
  private readonly pending = new Map<string, Pending>();

  get pendingCount(): number { return this.pending.size; }
  get connected(): boolean { return this.socket !== undefined && !this.socket.destroyed; }

  attach(socket: Socket): void {
    this.disconnect();
    this.socket = socket;
    const frames = new Frames();
    const lost = () => { if (this.socket === socket) this.disconnect(); };

    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      try {
        for (const value of frames.push(chunk)) {
          if (object(value) && value.event === 'CONTEXT_CHANGED' && object(value.fingerprint)) {
            this.emit('notification', value); continue;
          }
          const message = response(value);
          const entry = this.pending.get(message.id);
          if (!entry) continue;
          clearTimeout(entry.timer); this.pending.delete(message.id);
          if (message.ok) entry.resolve(message.result);
          else entry.reject(new IpcError(message.error.code, message.error.message));
        }
      } catch { lost(); }
    });

    socket.on('error', lost);
    socket.on('close', lost);
    socket.on('end', () => {
      try { frames.end(); } catch { /* 截断帧终止连接，由 lost 拒绝所有未完成请求。 */ }
      lost();
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new IpcError('WORKER_UNAVAILABLE', 'Worker disconnected'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) return Promise.reject(new IpcError('INVALID_ARGUMENT', 'Invalid timeout'));
    if (this.pending.size >= 128) return Promise.reject(new IpcError('WORKER_UNAVAILABLE', 'Too many pending requests'));

    const id = randomUUID();
    let frame: Buffer;
    try { frame = encode({ id, method, params }); } catch (error) { return Promise.reject(error); }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcError('TIMEOUT', 'Request timed out; not replayed'));
        if (method === 'observe' && this.socket === socket) this.disconnect();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      const failWrite = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(id);
        entry.reject(new IpcError('WORKER_UNAVAILABLE', 'Write failed; not replayed'));
        if (this.socket === socket) this.disconnect();
      };

      try { socket.write(frame, error => { if (error) failWrite(); }); } catch { failWrite(); }
    });
  }

  async observe(args: unknown, timeoutMs = 5000): Promise<ObservePage> {
    const request = normalizeObserve(args);
    const socket = this.socket;
    const result = await this.request('observe', { ...request }, timeoutMs);
    try { return observePage(result, request); } catch (error) { if (this.socket === socket) this.disconnect(); throw error; }
  }

  async nextPage(previous: ObservePage, limit = 200, timeoutMs = 5000): Promise<ObservePage | null> {
    if (previous.nextOffset === null) return null;
    const page = await this.observe({ hwnd: previous.hwnd, snapshotId: previous.snapshotId, offset: previous.nextOffset, limit }, timeoutMs);
    if (page.version !== previous.version || page.observedAt !== previous.observedAt || page.totalElements !== previous.totalElements || page.pullMs !== previous.pullMs || page.modelMs !== previous.modelMs || page.observeMs !== previous.observeMs) {
      this.disconnect(); throw new IpcError('WORKER_UNAVAILABLE', 'Snapshot metadata changed during pagination');
    }
    return page;
  }

  /** Read-only element facts for an approval card. Never captures or injects. */
  async lookup(args: unknown, timeoutMs = 4000): Promise<ElementDetail> {
    const request = normalizeClick(args);
    return elementDetail(await this.request('lookup', { ...request }, timeoutMs), request);
  }

  /**
   * Request one L1 click. Callers must have an approval grant before this is
   * reached; a dispatch whose reply is lost is reported INJECTION_UNCERTAIN
   * rather than TIMEOUT, because the Invoke may already have run.
   */
  async click(args: unknown, timeoutMs = 12_000): Promise<ClickResult> {
    const request = normalizeClick(args);
    let result: unknown;
    try {
      result = await this.request('click', { ...request }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') throw new IpcError('INJECTION_UNCERTAIN', 'Click reply timed out after dispatch; outcome unknown and not replayed');
      throw error;
    }
    try { return clickResult(result, request); } catch (error) { this.disconnect(); throw error; }
  }

  /** Read-only top-level window enumeration; never captures or injects. */
  async topWindows(timeoutMs = 6000): Promise<WindowInfo[]> {
    return windows(await this.request('windows', {}, timeoutMs));
  }

  /**
   * Read-only screen perception (B-3): DXGI capture + local OCR, text + bounding
   * boxes only, zero image bytes and zero injection. Timeout covers the whole
   * chain (lazy pipeline build + capture 2s + OCR 10s); 15s is the documented
   * ceiling. A lost reply is plain TIMEOUT: nothing was ever injected.
   */
  async readScreen(args: unknown, timeoutMs = 15_000): Promise<ReadScreenResult> {
    const request: NormalizedReadScreenRequest = normalizeReadScreen(args);
    const result = await this.request('read_screen', { ...request }, timeoutMs);
    return readScreenResult(result);
  }

  /**
   * Read-only visual↔UIA fusion (B-4): DXGI capture + local OCR fused with the
   * UIA element tree, returning aligned candidate elements plus text-only OCR
   * lines. Zero injection and zero image bytes; the 20s ceiling covers worker
   * observe (4s) + vision (14s). A lost reply is plain TIMEOUT: nothing was
   * ever injected, and a malformed reply rejects without disconnecting (same
   * read-only family as readScreen).
   */
  async locate(args: unknown, timeoutMs = 20_000): Promise<LocateResult> {
    const request: NormalizedLocateRequest = normalizeLocate(args);
    const result = await this.request('locate', { ...request }, timeoutMs);
    return locateResult(result);
  }

  /** Read-only worker self-report: tier flags, worlds and process id. */
  async status(timeoutMs = 4000): Promise<WorkerStatus> {
    return workerStatus(await this.request('status', {}, timeoutMs));
  }

  /**
   * Write text through ValuePattern. Approval must already be granted; a lost
   * reply is INJECTION_UNCERTAIN because SetValue may have landed.
   */
  async typeText(args: unknown, timeoutMs = 12_000): Promise<TypeResult> {
    const request = normalizeType(args);
    let result: unknown;
    try {
      result = await this.request('type', { ...request }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') throw new IpcError('INJECTION_UNCERTAIN', 'Type reply timed out after dispatch; outcome unknown and not replayed');
      throw error;
    }
    try { return typeResult(result, request); } catch (error) { this.disconnect(); throw error; }
  }

  /**
   * Scroll a container through ScrollPattern. Approval must already be granted;
   * a lost reply is INJECTION_UNCERTAIN because the view may have moved.
   */
  async scroll(args: unknown, timeoutMs = 12_000): Promise<ScrollResult> {
    const request = normalizeScroll(args);
    let result: unknown;
    try {
      result = await this.request('scroll', { ...request }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') throw new IpcError('INJECTION_UNCERTAIN', 'Scroll reply timed out after dispatch; outcome unknown and not replayed');
      throw error;
    }
    try { return scrollResult(result, request); } catch (error) { this.disconnect(); throw error; }
  }

  /**
   * Post WM_CONTEXTMENU to the deepest child under one element.
   * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN
   * because the message may already have been delivered.
   */
  async rightClick(args: unknown, timeoutMs = 12_000): Promise<RightClickResult> {
    const request = normalizeRightClick(args);
    let result: unknown;
    try {
      result = await this.request('right_click', { ...request }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') throw new IpcError('INJECTION_UNCERTAIN', 'Right-click reply timed out after dispatch; outcome unknown and not replayed');
      throw error;
    }
    try { return rightClickResult(result, request); } catch (error) { this.disconnect(); throw error; }
  }

  /**
   * Post WM_MOUSEWHEEL to the focused window of one element. Approval must
   * already be granted; a lost reply is INJECTION_UNCERTAIN because some or all
   * wheel messages may already have been delivered.
   */
  async wheel(args: unknown, timeoutMs = 12_000): Promise<WheelResult> {
    const request = normalizeWheel(args);
    let result: unknown;
    try {
      result = await this.request('wheel', { ...request }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') throw new IpcError('INJECTION_UNCERTAIN', 'Wheel reply timed out after dispatch; outcome unknown and not replayed');
      throw error;
    }
    try { return wheelResult(result, request); } catch (error) { this.disconnect(); throw error; }
  }

  /**
   * Post one key to the focused window of one hwnd through PostMessageW.
   * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN because
   * some or all key messages may already have been delivered.
   */
  async key(args: unknown, timeoutMs = 12_000): Promise<KeyResult> {
    const request = normalizeKey(args);
    let result: unknown;
    try {
      result = await this.request('key', { ...request }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') throw new IpcError('INJECTION_UNCERTAIN', 'Key reply timed out after dispatch; outcome unknown and not replayed');
      throw error;
    }
    try { return keyResult(result, request); } catch (error) { this.disconnect(); throw error; }
  }

  /** Read-only exact-name lookup; facts for the approval card, never input. */
  async lookupLabel(args: unknown, timeoutMs = 4000): Promise<LabelLookup> {
    const request = normalizeLabelLookup(args);
    return labelLookup(await this.request('lookup_label', { hwnd: request.hwnd, label: request.label }, timeoutMs), request);
  }

  /** Read-only RuntimeId lookup; facts for the approval card, never input. */
  async lookupRuntime(args: unknown, timeoutMs = 4000): Promise<RuntimeLookup> {
    const request = normalizeRuntimeLookup(args);
    return runtimeLookup(await this.request('lookup_runtime', { hwnd: request.hwnd, runtimeId: request.runtimeId }, timeoutMs), request);
  }

  /**
   * Fast path: invoke one RuntimeId without publishing a world snapshot.
   * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN
   * because the element may already have been invoked.
   */
  async clickRuntime(args: unknown, timeoutMs = 12000): Promise<FastClickResult> {
    const request = normalizeRuntimeClick(args);
    let result: unknown;
    try {
      result = await this.request('click_runtime', { hwnd: request.hwnd, runtimeId: request.runtimeId }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') {
        throw new IpcError('INJECTION_UNCERTAIN', 'Fast click reply timed out after dispatch; outcome unknown and not replayed');
      }
      throw error;
    }
    try {
      return fastClickResult(result, request);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  /**
   * Coordinate fallback: move the pointer and send one left click.
   * Approval must already be granted; a lost reply is INJECTION_UNCERTAIN.
   */
  async clickXy(args: unknown, timeoutMs = 12000): Promise<FastClickXyResult> {
    const request = normalizeClickXy(args);
    let result: unknown;
    try {
      result = await this.request('click_xy', { hwnd: request.hwnd, x: request.x, y: request.y }, timeoutMs);
    } catch (error) {
      if (error instanceof IpcError && error.code === 'TIMEOUT') {
        throw new IpcError('INJECTION_UNCERTAIN', 'Coordinate click reply timed out after dispatch; outcome unknown and not replayed');
      }
      throw error;
    }
    try {
      return fastClickXyResult(result, request);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    const socket = this.socket; this.socket = undefined; socket?.destroy();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new IpcError('WORKER_UNAVAILABLE', 'Connection lost; not replayed')); }
    this.pending.clear();
    if (socket) this.emit('disconnected');
  }
}
