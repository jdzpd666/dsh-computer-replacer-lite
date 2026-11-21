/**
 * Client for the user-launched elevated broker.
 *
 * The broker is a second process the *human* starts through UAC:
 *
 *   Start-Process -FilePath "<plugin>\\replacer-worker.exe" -ArgumentList "elevated-broker" -Verb RunAs
 *
 * It is deliberately not a Windows service and never runs as LocalSystem. It serves
 * one named pipe with strong-typed messages only (ping / observe / invoke / stop),
 * rejects clients of other users and refuses to act while a secure desktop is up.
 *
 * This module only speaks that framing: u32 little-endian length + UTF-8 JSON body,
 * one request per connection. A failed request throws BrokerError carrying the
 * broker's own error code, or a transport code (BROKER_NOT_RUNNING,
 * BROKER_ACCESS_DENIED, BROKER_TIMEOUT, BROKER_PROTOCOL_ERROR) when no answer exists.
 */
import { Socket } from 'node:net';

export const BROKER_PIPE = '\\\\.\\pipe\\replacer_elevated';
/** Frames can carry a whole window tree; the broker enforces the same ceiling. */
export const MAX_BROKER_FRAME_BYTES = 12 * 1024 * 1024;
const REPLY_TIMEOUT_MS = 60_000;

export class BrokerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BrokerError';
  }
}

export interface BrokerReply {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface BrokerCallOptions {
  timeoutMs?: number;
}

/**
 * Send one request and resolve with the broker's reply object.
 *
 * Rejects with BrokerError on any transport failure and on a reply whose ok is not
 * true; a reply is never interpreted as success just because bytes arrived.
 */
export function callBroker(request: Record<string, unknown>, options: BrokerCallOptions = {}): Promise<BrokerReply> {
  const timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
  return new Promise<BrokerReply>((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    let buffer = Buffer.alloc(0);

    const finish = (error: BrokerError | null, reply?: BrokerReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === null) resolve(reply as BrokerReply);
      else reject(error);
    };

    const timer = setTimeout(() => {
      finish(new BrokerError('BROKER_TIMEOUT', 'The elevated broker did not answer within ' + timeoutMs + ' ms; whether it acted is unknown'));
    }, timeoutMs);

    socket.once('connect', () => {
      let body: Buffer;
      try { body = Buffer.from(JSON.stringify(request), 'utf8'); }
      catch (error) { finish(new BrokerError('INVALID_ARGUMENT', 'Request is not serializable: ' + String(error))); return; }
      if (body.length === 0 || body.length > MAX_BROKER_FRAME_BYTES) {
        finish(new BrokerError('INVALID_ARGUMENT', 'Request frame is out of range'));
        return;
      }
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      socket.write(Buffer.concat([header, body]));
    });

    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_BROKER_FRAME_BYTES) {
        finish(new BrokerError('BROKER_PROTOCOL_ERROR', 'Broker reply frame length ' + length + ' is out of range'));
        return;
      }
      if (buffer.length < 4 + length) return;
      const text = buffer.subarray(4, 4 + length).toString('utf8');
      let reply: BrokerReply;
      try { reply = JSON.parse(text) as BrokerReply; }
      catch { finish(new BrokerError('BROKER_PROTOCOL_ERROR', 'Broker reply is not valid JSON')); return; }
      if (reply === null || typeof reply !== 'object' || reply.ok !== true) {
        const code = typeof reply?.code === 'string' ? reply.code : 'BROKER_PROTOCOL_ERROR';
        const message = typeof reply?.message === 'string' ? reply.message : 'The elevated broker refused the request';
        finish(new BrokerError(code, message));
        return;
      }
      finish(null, reply);
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'ENOENT' ? 'BROKER_NOT_RUNNING'
        : error.code === 'EACCES' || error.code === 'EPERM' ? 'BROKER_ACCESS_DENIED'
        : 'BROKER_UNAVAILABLE';
      const message = code === 'BROKER_NOT_RUNNING'
        ? 'The elevated broker is not running.'
        : code === 'BROKER_ACCESS_DENIED'
          ? 'The elevated broker refused the connection (access denied).'
          : 'Could not reach the elevated broker: ' + error.message;
      finish(new BrokerError(code, message));
    });

    socket.once('close', () => {
      finish(new BrokerError('BROKER_UNAVAILABLE', 'The elevated broker closed the connection before replying'));
    });

    socket.connect({ path: BROKER_PIPE });
  });
}
