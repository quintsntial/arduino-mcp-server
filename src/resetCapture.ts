import { spawn } from "node:child_process";
import { childEnv, type MonitorCapture } from "./arduinoCli.js";

/**
 * Seeing a boot marker that a sketch prints once in setup().
 *
 * ESP8266/ESP32 boards reboot right after the upload (esptool hard reset) and boot in well under a
 * second, but `arduino-cli monitor` needs about a second to start, so the marker is gone before the
 * monitor is open. The method here: open the serial port first, THEN reset the board with the
 * DTR/RTS lines (the same sequence esptool uses), and read the output of that boot. AVR boards such as
 * the Nano reset when the port opens, so they keep the plain monitor path.
 *
 * Port access needs a serial library; this server has none, so a small pyserial helper runs under
 * python3 (pyserial comes with esptool, often in the user site-packages, so no -I; the helper runs from / so the
 * working directory cannot supply modules). If it is missing the caller falls back to the plain monitor
 * and reports why.
 */

export type ResetMode = "auto" | "dtr-rts" | "none";

/** Cores whose boards reboot on their own right after an upload, before a monitor can open. */
export function bootsBeforeMonitorOpens(fqbn: string | undefined): boolean {
  const vendor = fqbn?.split(":")[0]?.trim().toLowerCase();
  return vendor === "esp8266" || vendor === "esp32";
}

/** Whether to use the open-first-then-reset capture. "auto" = esp8266 only (the one verified on hardware). */
export function shouldResetAfterUpload(mode: ResetMode, fqbn: string | undefined): boolean {
  if (mode === "dtr-rts") {
    return true;
  }
  if (mode === "none") {
    return false;
  }
  return fqbn?.split(":")[0]?.trim().toLowerCase() === "esp8266";
}

export type ReadyFailure = "READY_PATTERN_TIMEOUT" | "READY_BOOTED_BEFORE_MONITOR" | "READY_RESET_FAILED";

/** Why the ready pattern was not seen, distinguished from an upload failure. null when it matched. */
export function classifyReadyFailure(input: {
  matched: boolean;
  resetRequested: boolean;
  resetDone: boolean;
  fqbn?: string;
}): { errorCode: ReadyFailure; message: string } | null {
  if (input.matched) {
    return null;
  }
  if (input.resetRequested && !input.resetDone) {
    return {
      errorCode: "READY_RESET_FAILED",
      message:
        "The upload succeeded, but the board could not be reset through DTR/RTS after the monitor opened, so the boot marker was not seen."
    };
  }
  if (!input.resetRequested && bootsBeforeMonitorOpens(input.fqbn)) {
    return {
      errorCode: "READY_BOOTED_BEFORE_MONITOR",
      message:
        "The upload succeeded, but the board booted before the monitor opened, so a marker printed once in setup() cannot be seen. Use resetAfterUpload=\"dtr-rts\", or print the marker repeatedly in loop()."
    };
  }
  return {
    errorCode: "READY_PATTERN_TIMEOUT",
    message: "Upload succeeded but readiness pattern was not observed before timeout."
  };
}

export const RESET_CAPTURE_SCRIPT = `
import json, sys, time
try:
    import serial
except Exception as e:
    print(json.dumps({"ok": False, "stage": "import", "error": "pyserial not available: %s" % e}))
    sys.exit(3)
port, baud, timeout_ms, pattern, case_sensitive, do_reset = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5] == "1", sys.argv[6] == "1"
try:
    ser = serial.Serial(port, baud, timeout=0.05)
except Exception as e:
    print(json.dumps({"ok": False, "stage": "open", "error": "cannot open %s: %s" % (port, e)}))
    sys.exit(2)
started = time.time()
deadline = started + timeout_ms / 1000.0
reset_done = False
reset_error = None
if do_reset:
    try:
        ser.dtr = False   # GPIO0 high: boot the program, not the bootloader
        ser.rts = True    # EN low: hold in reset
        time.sleep(0.1)
        ser.reset_input_buffer()
        ser.rts = False   # EN high: boot
        reset_done = True
    except Exception as e:
        reset_error = str(e)
buf = b""
needle = pattern if case_sensitive else pattern.lower()
matched = False
while time.time() < deadline:
    try:
        chunk = ser.read(4096)
    except Exception as e:
        reset_error = (reset_error or "") + " read error: %s" % e
        break
    if chunk:
        buf += chunk
        text = buf.decode("latin-1")
        if needle and needle in (text if case_sensitive else text.lower()):
            matched = True
            end = time.time() + 0.15
            while time.time() < end:
                buf += ser.read(4096)
            break
try:
    ser.close()
except Exception:
    pass
print(json.dumps({"ok": True, "matched": matched, "text": buf.decode("latin-1"), "durationMs": int((time.time() - started) * 1000), "resetDone": reset_done, "resetError": reset_error}))
`;

export type ResetCaptureOutcome =
  | { kind: "ok"; capture: MonitorCapture; resetDone: boolean; resetError: string | null }
  | { kind: "unavailable"; reason: string };

/** Turn the helper's output into an outcome. A missing library, busy port or crash is "unavailable". */
export function parseResetCaptureOutput(stdout: string, stderr: string, code: number | null): ResetCaptureOutcome {
  const line = stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0).pop();
  let parsed: Record<string, unknown> | null = null;
  if (line) {
    try {
      const value: unknown = JSON.parse(line);
      parsed = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    const detail = stderr.trim().split(/\r?\n/).pop() || (code === null ? "helper did not start or timed out" : `helper exited with code ${code}`);
    return { kind: "unavailable", reason: detail };
  }
  if (parsed.ok !== true) {
    return { kind: "unavailable", reason: typeof parsed.error === "string" ? parsed.error : "helper failed" };
  }
  return {
    kind: "ok",
    capture: {
      text: typeof parsed.text === "string" ? parsed.text : "",
      matched: parsed.matched === true,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      attempts: 1,
      stderr: stderr.trim()
    },
    resetDone: parsed.resetDone === true,
    resetError: typeof parsed.resetError === "string" ? parsed.resetError : null
  };
}

export function resetCaptureArgs(
  port: string,
  baudRate: number,
  opts: { timeoutMs: number; pattern?: string; caseSensitive?: boolean; reset: boolean }
): string[] {
  return [
    "-c",
    RESET_CAPTURE_SCRIPT,
    port,
    String(Math.floor(baudRate)),
    String(Math.floor(opts.timeoutMs)),
    opts.pattern ?? "",
    opts.caseSensitive ? "1" : "0",
    opts.reset ? "1" : "0"
  ];
}

/** Open the port, pulse reset through DTR/RTS, capture until the pattern or the timeout. */
export async function captureWithReset(
  pythonPath: string,
  port: string,
  baudRate: number,
  opts: { timeoutMs: number; pattern?: string; caseSensitive?: boolean; reset?: boolean }
): Promise<ResetCaptureOutcome> {
  const args = resetCaptureArgs(port, baudRate, { ...opts, reset: opts.reset ?? true });
  return await new Promise<ResetCaptureOutcome>((resolve) => {
    const child = spawn(pythonPath, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv(), cwd: "/" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), opts.timeoutMs + 5000);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ kind: "unavailable", reason: `cannot run ${pythonPath}: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(parseResetCaptureOutput(stdout, stderr, code));
    });
  });
}
