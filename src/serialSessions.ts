import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { PortOperationCoordinator, type PortLockInfo } from "./portCoordinator.js";

export type SerialSessionState =
  | "OPENING"
  | "READY"
  | "RESETTING"
  | "DISCONNECTED"
  | "STALE"
  | "CLOSED";

export type SerialReadEncoding = "utf8" | "base64";

export interface SerialSessionOpenInput {
  cliPath: string;
  port: string;
  baudRate: number;
  ttlMs: number;
  maxBufferBytes: number;
}

export interface SerialSessionSummary {
  sessionId: string;
  port: string;
  baudRate: number;
  state: SerialSessionState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  endedAt: number | null;
  totalBytesReceived: number;
  droppedBytes: number;
  bufferStartOffset: number;
  bufferEndOffset: number;
  lastError: string | null;
  lock: PortLockInfo | null;
}

interface SerialSession {
  id: string;
  owner: string;
  port: string;
  baudRate: number;
  ttlMs: number;
  maxBufferBytes: number;
  state: SerialSessionState;
  process: ChildProcessWithoutNullStreams;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  endedAt: number | null;
  totalBytesReceived: number;
  droppedBytes: number;
  buffer: Buffer;
  stderrTail: string;
  closeRequested: boolean;
  lastError: string | null;
}

interface ErrorInfo {
  errorCode: string;
  error: string;
}

interface OpenResult {
  ok: boolean;
  session?: SerialSessionSummary;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  lockHeldBy?: PortLockInfo;
}

interface CloseResult {
  ok: boolean;
  session?: SerialSessionSummary;
  error?: string;
  errorCode?: string;
}

interface WriteResult {
  ok: boolean;
  session?: SerialSessionSummary;
  writtenBytes?: number;
  error?: string;
  errorCode?: string;
}

interface ReadResult {
  ok: boolean;
  session?: SerialSessionSummary;
  data?: string;
  encoding?: SerialReadEncoding;
  bytesRead?: number;
  startOffset?: number;
  nextOffset?: number;
  truncated?: boolean;
  /** Set when the session has ended: the data is what was buffered before it ended. */
  endedNote?: string;
  error?: string;
  errorCode?: string;
}

interface ExpectResult {
  ok: boolean;
  session?: SerialSessionSummary;
  matched?: boolean;
  pattern?: string;
  matchIndex?: number;
  fromOffset?: number;
  timeoutMs?: number;
  error?: string;
  errorCode?: string;
}

export interface RecordResult {
  ok: boolean;
  session?: SerialSessionSummary;
  /** Bytes received from startOffset up to the end of the recording, as UTF-8. */
  text?: string;
  bytes?: number;
  startOffset?: number;
  nextOffset?: number;
  requestedMs?: number;
  durationMs?: number;
  /** True when the session ended (e.g. the board disconnected) before the duration was up. */
  endedEarly?: boolean;
  /** True when the buffer had already dropped some of the requested bytes (raise maxBufferBytes). */
  truncated?: boolean;
  error?: string;
  errorCode?: string;
}

export const MAX_RECORD_MS = 10 * 60_000;
/** Ended sessions stay queryable this long, so later calls can say why they ended. */
const ENDED_RETENTION_MS = 10 * 60_000;
const MAX_ENDED_SESSIONS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a serial device path still exists; null when that can't be checked (e.g. Windows COM ports). */
function portPresent(port: string): boolean | null {
  if (!port.startsWith("/dev/")) {
    return null;
  }
  return fs.existsSync(port);
}

export class SerialSessionManager {
  private readonly sessions = new Map<string, SerialSession>();
  /** Sessions that ended (closed, expired, disconnected), kept for ENDED_RETENTION_MS. */
  private readonly ended = new Map<string, SerialSession>();
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(private readonly coordinator: PortOperationCoordinator) {
    this.cleanupInterval = setInterval(() => {
      this.sweepExpiredSessions();
    }, 5_000);
    this.cleanupInterval.unref();
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    for (const session of this.sessions.values()) {
      session.closeRequested = true;
      session.process.kill();
      this.coordinator.release(session.port, session.owner);
    }
    this.sessions.clear();
    this.ended.clear();
  }

  async openSession(input: SerialSessionOpenInput): Promise<OpenResult> {
    const port = input.port.trim();
    const baudRate = Math.floor(input.baudRate);
    const ttlMs = Math.min(Math.max(input.ttlMs, 5_000), 10 * 60_000);
    const maxBufferBytes = Math.min(Math.max(input.maxBufferBytes, 4_096), 2 * 1024 * 1024);

    if (!port) {
      return {
        ok: false,
        errorCode: "INVALID_PORT",
        error: "Port is required."
      };
    }

    for (const existing of Array.from(this.sessions.values())) {
      if (existing.port.toLowerCase() !== port.toLowerCase()) {
        continue;
      }
      if (this.isSessionReadable(existing)) {
        return {
          ok: false,
          errorCode: "PORT_BUSY",
          error: `Port ${port} already has an active serial session (${existing.id}).`,
          retryable: true
        };
      }
      // An ended session (e.g. the board was unplugged) must not block a new one on the same port.
      this.retire(existing);
    }

    const sessionId = randomUUID();
    const owner = `serial-session:${sessionId}`;
    const lock = this.coordinator.acquire(port, owner, "serial_open_session");
    if (!lock.ok) {
      return {
        ok: false,
        errorCode: "PORT_BUSY",
        error: `Port ${port} is busy.`,
        retryable: true,
        lockHeldBy: lock.heldBy
      };
    }

    const args = ["monitor", "-p", port, "-c", `baudrate=${baudRate}`];
    const child = spawn(input.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const now = Date.now();
    const session: SerialSession = {
      id: sessionId,
      owner,
      port,
      baudRate,
      ttlMs,
      maxBufferBytes,
      state: "OPENING",
      process: child,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
      endedAt: null,
      totalBytesReceived: 0,
      droppedBytes: 0,
      buffer: Buffer.alloc(0),
      stderrTail: "",
      closeRequested: false,
      lastError: null
    };

    this.sessions.set(session.id, session);
    this.attachProcessHandlers(session);

    await sleep(500);
    const liveSession = this.sessions.get(session.id);
    if (!liveSession) {
      return {
        ok: false,
        errorCode: "SESSION_OPEN_FAILED",
        error: `Failed to open serial session on ${port}.`
      };
    }

    if (liveSession.state === "DISCONNECTED") {
      this.coordinator.release(liveSession.port, liveSession.owner);
      this.sessions.delete(liveSession.id);
      const present = portPresent(port);
      return {
        ok: false,
        errorCode: "SESSION_OPEN_FAILED",
        error:
          (liveSession.lastError ?? `Serial session closed during open on ${port}.`) +
          (present === false ? ` Port ${port} does not exist: check the board is connected (list_connected_boards).` : ""),
        retryable: true
      };
    }

    if (liveSession.state === "OPENING") {
      liveSession.state = "READY";
      liveSession.updatedAt = Date.now();
    }

    return {
      ok: true,
      session: this.toSummary(liveSession)
    };
  }

  listSessions(): SerialSessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => this.toSummary(session));
  }

  /** Summary of a live or recently ended session, or null if the id is unknown. */
  getSessionSummary(sessionId: string): SerialSessionSummary | null {
    const session = this.find(sessionId);
    return session ? this.toSummary(session) : null;
  }

  closeSession(sessionId: string): CloseResult {
    const live = this.sessions.get(sessionId);
    if (!live) {
      const endedSession = this.ended.get(sessionId);
      if (endedSession) {
        // Already ended (closed, expired or disconnected): closing again is a no-op.
        return { ok: true, session: this.toSummary(endedSession) };
      }
      return { ok: false, ...this.notFound(sessionId) };
    }

    live.closeRequested = true;
    live.state = "CLOSED";
    live.updatedAt = Date.now();
    live.expiresAt = live.updatedAt;
    live.process.kill();
    this.coordinator.release(live.port, live.owner);
    this.retire(live);

    return {
      ok: true,
      session: this.toSummary(live)
    };
  }

  readSession(
    sessionId: string,
    fromOffset: number | null,
    maxBytes: number,
    encoding: SerialReadEncoding
  ): ReadResult {
    const session = this.find(sessionId);
    if (!session) {
      return { ok: false, ...this.notFound(sessionId) };
    }

    // Reading stays possible after a session ends: the buffer holds what arrived before it ended.
    const isLive = this.isSessionReadable(session);
    if (isLive) {
      this.touch(session);
    }

    const startOffset = session.totalBytesReceived - session.buffer.length;
    const desiredOffset = fromOffset === null ? startOffset : Math.max(0, Math.floor(fromOffset));
    const effectiveOffset = Math.max(desiredOffset, startOffset);
    const bytesLimit = Math.min(Math.max(Math.floor(maxBytes), 1), session.maxBufferBytes);
    const startIndex = effectiveOffset - startOffset;
    const window = session.buffer.subarray(startIndex, startIndex + bytesLimit);

    return {
      ok: true,
      session: this.toSummary(session),
      data: encoding === "base64" ? window.toString("base64") : window.toString("utf8"),
      encoding,
      bytesRead: window.length,
      startOffset: effectiveOffset,
      nextOffset: effectiveOffset + window.length,
      truncated: desiredOffset < startOffset,
      endedNote: isLive ? undefined : this.endedError(session).error
    };
  }

  async expectInSession(
    sessionId: string,
    pattern: string,
    timeoutMs: number,
    caseSensitive: boolean,
    fromOffset: number | null
  ): Promise<ExpectResult> {
    const session = this.find(sessionId);
    if (!session) {
      return { ok: false, ...this.notFound(sessionId) };
    }

    if (!this.isSessionReadable(session)) {
      return { ok: false, ...this.endedError(session), session: this.toSummary(session) };
    }

    const boundedTimeout = Math.min(Math.max(Math.floor(timeoutMs), 200), 120_000);
    const started = Date.now();
    const baseOffset =
      fromOffset === null ? session.totalBytesReceived : Math.max(0, Math.floor(fromOffset));
    const expectedPattern = caseSensitive ? pattern : pattern.toLowerCase();

    while (Date.now() - started <= boundedTimeout) {
      if (!this.isSessionReadable(session)) {
        return { ok: false, ...this.endedError(session), session: this.toSummary(session) };
      }
      // Waiting counts as use: without this the lease could expire mid-wait.
      this.touch(session);

      const startOffset = session.totalBytesReceived - session.buffer.length;
      const effectiveOffset = Math.max(baseOffset, startOffset);
      const view = session.buffer.subarray(effectiveOffset - startOffset);
      const text = view.toString("utf8");
      const haystack = caseSensitive ? text : text.toLowerCase();
      const idx = haystack.indexOf(expectedPattern);
      if (idx >= 0) {
        return {
          ok: true,
          matched: true,
          pattern,
          matchIndex: effectiveOffset + idx,
          fromOffset: effectiveOffset,
          timeoutMs: boundedTimeout,
          session: this.toSummary(session)
        };
      }

      await sleep(100);
    }

    return {
      ok: false,
      matched: false,
      pattern,
      fromOffset: baseOffset,
      timeoutMs: boundedTimeout,
      errorCode: "EXPECT_TIMEOUT",
      error: `Pattern was not observed before timeout (${boundedTimeout}ms).`,
      session: this.toSummary(session)
    };
  }

  /**
   * Collect everything the session receives for durationMs (keeping its lease alive), starting at
   * fromOffset, or at the current end of the buffer when null. Stops early if the session ends.
   */
  async recordSession(sessionId: string, durationMs: number, fromOffset: number | null): Promise<RecordResult> {
    const session = this.find(sessionId);
    if (!session) {
      return { ok: false, ...this.notFound(sessionId) };
    }
    if (!this.isSessionReadable(session)) {
      return { ok: false, ...this.endedError(session), session: this.toSummary(session) };
    }

    const requestedMs = Math.min(Math.max(Math.floor(durationMs), 1_000), MAX_RECORD_MS);
    const started = Date.now();
    const baseOffset = fromOffset === null ? session.totalBytesReceived : Math.max(0, Math.floor(fromOffset));
    let endedEarly = false;

    while (Date.now() - started < requestedMs) {
      if (!this.isSessionReadable(session)) {
        endedEarly = true;
        break;
      }
      this.touch(session);
      await sleep(Math.min(200, requestedMs - (Date.now() - started)));
    }

    const bufferStart = session.totalBytesReceived - session.buffer.length;
    const effectiveOffset = Math.max(baseOffset, bufferStart);
    const window = session.buffer.subarray(Math.max(0, effectiveOffset - bufferStart));
    const ended = endedEarly ? this.endedError(session) : null;

    return {
      ok: !endedEarly,
      session: this.toSummary(session),
      text: window.toString("utf8"),
      bytes: window.length,
      startOffset: effectiveOffset,
      nextOffset: session.totalBytesReceived,
      requestedMs,
      durationMs: Date.now() - started,
      endedEarly,
      truncated: baseOffset < bufferStart,
      errorCode: ended?.errorCode,
      error: ended?.error
    };
  }

  writeSession(sessionId: string, payload: Buffer): WriteResult {
    const session = this.find(sessionId);
    if (!session) {
      return { ok: false, ...this.notFound(sessionId) };
    }

    if (!this.isSessionWritable(session)) {
      const info = this.isSessionReadable(session)
        ? { errorCode: "SESSION_NOT_READY", error: `Session ${session.id} is not writable in state ${session.state}.` }
        : this.endedError(session);
      return { ok: false, ...info, session: this.toSummary(session) };
    }

    try {
      const wrote = session.process.stdin.write(payload);
      this.touch(session);
      return {
        ok: wrote,
        session: this.toSummary(session),
        writtenBytes: payload.length,
        error: wrote ? undefined : "Write backpressure: data accepted but stream is congested.",
        errorCode: wrote ? undefined : "WRITE_BACKPRESSURE"
      };
    } catch (error) {
      session.lastError = error instanceof Error ? error.message : "Unknown serial write failure.";
      session.state = "DISCONNECTED";
      session.endedAt = Date.now();
      this.coordinator.release(session.port, session.owner);
      return {
        ok: false,
        errorCode: "SERIAL_WRITE_FAILED",
        error: session.lastError,
        session: this.toSummary(session)
      };
    }
  }

  private find(sessionId: string): SerialSession | undefined {
    return this.sessions.get(sessionId) ?? this.ended.get(sessionId);
  }

  private notFound(sessionId: string): ErrorInfo {
    return {
      errorCode: "SESSION_NOT_FOUND",
      error: `No serial session found for id ${sessionId} (unknown id, or it ended more than ${
        ENDED_RETENTION_MS / 60_000
      } minutes ago).`
    };
  }

  /** Why a session can no longer be used, in terms the user can act on. */
  private endedError(session: SerialSession): ErrorInfo {
    if (session.state === "CLOSED") {
      return {
        errorCode: "SESSION_CLOSED",
        error: `Session ${session.id} was closed with serial_close_session. Open a new session.`
      };
    }
    if (session.state === "STALE") {
      return {
        errorCode: "SESSION_EXPIRED",
        error: `Session ${session.id} expired: no tool used it for ${session.ttlMs} ms. Open a new session (a larger ttlMs keeps it alive longer).`
      };
    }

    const reason = session.lastError?.split(/\r?\n/).filter((line) => line.trim()).pop() ?? "the serial monitor stopped";
    const present = portPresent(session.port);
    const portHint =
      present === false
        ? ` Port ${session.port} is no longer present: the board dropped off USB (cable, connector or power). Reconnect it, check list_connected_boards, then open a new session.`
        : present === true
          ? ` Port ${session.port} still exists: the board may have reset or another program took the port. Open a new session.`
          : " Check the board is still connected, then open a new session.";
    return {
      errorCode: "SESSION_DISCONNECTED",
      error: `Session ${session.id} on ${session.port} ended unexpectedly (${reason}).${portHint}`
    };
  }

  private attachProcessHandlers(session: SerialSession) {
    session.process.stdout.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.appendBuffer(session, data);
      if (session.state === "OPENING") {
        session.state = "READY";
      }
      session.updatedAt = Date.now();
    });

    session.process.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      session.stderrTail = `${session.stderrTail}${text}`.slice(-8_000);
      session.lastError = session.stderrTail.trim() || null;
      session.updatedAt = Date.now();
    });

    session.process.on("error", (error) => {
      session.lastError = error.message;
      session.state = "DISCONNECTED";
      session.updatedAt = Date.now();
      session.endedAt = session.updatedAt;
      this.coordinator.release(session.port, session.owner);
    });

    session.process.on("close", (code, signal) => {
      session.updatedAt = Date.now();
      if (!session.closeRequested && session.state !== "STALE") {
        session.state = "DISCONNECTED";
        if (!session.lastError) {
          session.lastError =
            code !== null ? `arduino-cli monitor exited with code ${code}` : `arduino-cli monitor was stopped (${signal})`;
        }
      }
      session.endedAt ??= session.updatedAt;
      this.coordinator.release(session.port, session.owner);
    });
  }

  private appendBuffer(session: SerialSession, chunk: Buffer) {
    session.totalBytesReceived += chunk.length;

    if (chunk.length >= session.maxBufferBytes) {
      const kept = chunk.subarray(chunk.length - session.maxBufferBytes);
      session.droppedBytes += session.buffer.length + (chunk.length - kept.length);
      session.buffer = Buffer.from(kept);
      return;
    }

    const combinedLength = session.buffer.length + chunk.length;
    if (combinedLength > session.maxBufferBytes) {
      const drop = combinedLength - session.maxBufferBytes;
      session.droppedBytes += drop;
      session.buffer = Buffer.concat([session.buffer.subarray(drop), chunk]);
      return;
    }

    session.buffer = Buffer.concat([session.buffer, chunk]);
  }

  private touch(session: SerialSession) {
    const now = Date.now();
    session.updatedAt = now;
    session.expiresAt = now + session.ttlMs;
  }

  private isSessionReadable(session: SerialSession): boolean {
    return session.state === "OPENING" || session.state === "READY" || session.state === "RESETTING";
  }

  private isSessionWritable(session: SerialSession): boolean {
    return session.state === "READY" || session.state === "RESETTING";
  }

  /** Move a session from the live map to the ended map (kept for ENDED_RETENTION_MS). */
  private retire(session: SerialSession) {
    session.endedAt ??= Date.now();
    this.sessions.delete(session.id);
    this.ended.set(session.id, session);
    while (this.ended.size > MAX_ENDED_SESSIONS) {
      const oldest = this.ended.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.ended.delete(oldest);
    }
  }

  private sweepExpiredSessions() {
    const now = Date.now();
    for (const session of Array.from(this.sessions.values())) {
      if (session.state === "CLOSED" || session.state === "DISCONNECTED") {
        this.retire(session);
        continue;
      }

      if (now <= session.expiresAt) {
        continue;
      }

      session.state = "STALE";
      session.lastError = "Session lease expired.";
      session.closeRequested = true;
      session.process.kill();
      this.coordinator.release(session.port, session.owner);
      this.retire(session);
    }

    for (const [id, session] of Array.from(this.ended.entries())) {
      if (now - (session.endedAt ?? now) > ENDED_RETENTION_MS) {
        this.ended.delete(id);
      }
    }
  }

  private toSummary(session: SerialSession): SerialSessionSummary {
    return {
      sessionId: session.id,
      port: session.port,
      baudRate: session.baudRate,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      endedAt: session.endedAt,
      totalBytesReceived: session.totalBytesReceived,
      droppedBytes: session.droppedBytes,
      bufferStartOffset: session.totalBytesReceived - session.buffer.length,
      bufferEndOffset: session.totalBytesReceived,
      lastError: session.lastError,
      lock: this.coordinator.get(session.port)
    };
  }
}
