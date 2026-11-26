import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface CommandResult {
  ok: boolean;
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ArduinoCliConfig {
  cliPath: string;
  sketchRoot?: string;
}

export function resolveSketchPath(inputPath: string, sketchRoot?: string): string {
  const resolved = path.resolve(inputPath);

  if (!sketchRoot) {
    return resolved;
  }

  const root = path.resolve(sketchRoot);
  const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;

  if (normalizedResolved === normalizedRoot || normalizedResolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return resolved;
  }

  throw new Error(`Path "${resolved}" is outside ARDUINO_SKETCH_ROOT "${root}".`);
}

/**
 * The Arduino "user" directory (sketchbook, where `lib install` puts libraries), from ARDUINO_USER_DIR.
 * Lets the server use a folder it can read: on macOS an app-launched process may not be allowed into
 * ~/Documents, where arduino-cli keeps libraries by default. Empty or an unfilled "${...}" template
 * (an optional extension setting left blank) means "not set". A leading ~ is expanded.
 */
export function arduinoUserDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.ARDUINO_USER_DIR?.trim();
  if (!raw || raw.includes("${")) {
    return undefined;
  }
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

/** Environment for child processes: passes ARDUINO_USER_DIR to arduino-cli as ARDUINO_DIRECTORIES_USER. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const userDir = arduinoUserDir(env);
  return userDir ? { ...env, ARDUINO_DIRECTORIES_USER: userDir } : { ...env };
}

export async function runArduinoCli(
  config: ArduinoCliConfig,
  args: string[],
  timeoutMs = 60_000
): Promise<CommandResult> {
  return runCommand(config.cliPath, args, timeoutMs);
}

export async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 60_000
): Promise<CommandResult> {
  const started = Date.now();

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv()
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - started;
      resolve({
        ok: false,
        command,
        args,
        code: null,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        timedOut: false,
        durationMs
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      resolve({
        ok: code === 0 && !timedOut,
        command,
        args,
        code,
        stdout,
        stderr,
        timedOut,
        durationMs
      });
    });
  });
}

export interface MonitorCapture {
  text: string; // everything received, across reconnects
  matched: boolean; // pattern found (always false without a pattern)
  durationMs: number;
  attempts: number; // monitor starts (more than 1 when the port re-enumerated after reset)
  stderr: string;
}

/**
 * Capture serial output with `arduino-cli monitor` for up to timeoutMs, stopping early once the
 * pattern appears. stdin must stay open: with stdin closed the monitor exits after about a second
 * having read nothing. If the monitor exits early (port briefly gone after an upload reset, as on
 * ATmega32U4 boards), it is restarted until the deadline.
 */
export async function captureMonitor(
  cliPath: string,
  port: string,
  baudRate: number,
  opts: { timeoutMs: number; pattern?: string; caseSensitive?: boolean }
): Promise<MonitorCapture> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const pattern = opts.pattern && opts.pattern.length > 0 ? opts.pattern : undefined;
  const needle = pattern && !opts.caseSensitive ? pattern.toLowerCase() : pattern;
  let text = "";
  let stderr = "";
  let attempts = 0;
  let matched = false;

  const found = () => {
    if (!needle) {
      return false;
    }
    return (opts.caseSensitive ? text : text.toLowerCase()).includes(needle);
  };

  while (!matched && Date.now() < deadline) {
    attempts += 1;
    await new Promise<void>((resolve) => {
      const child = spawn(cliPath, ["monitor", "-p", port, "-c", `baudrate=${Math.floor(baudRate)}`, "--quiet"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv()
      });
      const timer = setTimeout(() => child.kill(), Math.max(deadline - Date.now(), 0));
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("latin1");
        if (found()) {
          matched = true;
          // Let the rest of the matching line arrive before stopping.
          setTimeout(() => child.kill(), 150);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        stderr += `\n${err.message}`;
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!matched && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300)); // port re-enumerating: retry shortly
    }
  }

  return { text, matched, durationMs: Date.now() - started, attempts, stderr: stderr.trim() };
}

export function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
