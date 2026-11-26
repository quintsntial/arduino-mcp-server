// Project settings from <project>/tools/board.env (KEY=VALUE lines), the format used by our
// dev_loop.sh workflow. Tool arguments always win; board.env only fills what was not passed.
//
//   SKETCH_DIR   sketch folder, relative to the project root (or absolute)
//   FQBN         e.g. arduino:avr:nano:cpu=atmega328old
//   PORT         e.g. /dev/cu.usbserial-230
//   BAUD         serial speed, must match Serial.begin (default 9600)
//   LIBS, CORE, BOARD_URLS   setup info (comma separated lists)
//   OUTPUTS      what the board's outputs drive: leds | low-voltage | mains
//   BACKUP_DIR   where backup_firmware saves images, relative to the project root (default backups/)
//   BACKUP_BEFORE_UPLOAD  1 = uploads refuse until a firmware backup of the connected board exists

import fs from "node:fs";
import path from "node:path";

export const BOARD_ENV_RELATIVE_PATH = path.join("tools", "board.env");
const KNOWN_KEYS = new Set([
  "SKETCH_DIR",
  "FQBN",
  "PORT",
  "BAUD",
  "LIBS",
  "CORE",
  "BOARD_URLS",
  "OUTPUTS",
  "BACKUP_DIR",
  "BACKUP_BEFORE_UPLOAD"
]);
export const OUTPUT_KINDS = ["leds", "low-voltage", "mains"] as const;
export type OutputsKind = (typeof OUTPUT_KINDS)[number];

export interface ProjectConfig {
  projectDir: string;
  boardEnvPath: string;
  boardComment: string | null; // first "# Board: ..." comment, if any
  sketchPath?: string;
  fqbn?: string;
  port?: string;
  baud?: number;
  libs: string[];
  core?: string;
  boardUrls: string[];
  outputs?: OutputsKind;
  backupDir: string; // BACKUP_DIR resolved against the project root, default <project>/backups
  backupBeforeUpload: boolean;
  problems: string[]; // values present but invalid
}

/** Parse KEY=VALUE lines: '#' starts a comment, surrounding quotes are stripped, unknown keys ignored. */
export function parseBoardEnv(text: string): { values: Record<string, string>; boardComment: string | null } {
  const values: Record<string, string> = {};
  let boardComment: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const commentMatch = rawLine.match(/^\s*#\s*Board:\s*(.+?)\s*$/i);
    if (commentMatch && boardComment === null) {
      boardComment = commentMatch[1];
    }
    const line = rawLine.replace(/#.*/, "").trim();
    const eq = line.indexOf("=");
    if (!line || eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (KNOWN_KEYS.has(key) && value.length > 0) {
      values[key] = value;
    }
  }
  return { values, boardComment };
}

/** Walk up from a file or folder to the nearest folder that holds tools/board.env. */
export function findBoardEnv(startPath: string): string | null {
  let dir = path.resolve(startPath);
  try {
    if (fs.statSync(dir).isFile()) {
      dir = path.dirname(dir);
    }
  } catch {
    // A path that does not exist yet: still search its parents.
  }
  for (;;) {
    const candidate = path.join(dir, BOARD_ENV_RELATIVE_PATH);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** board.env switch values: 1, true, yes, on (any case) mean enabled. */
export function isEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

const splitList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export function readProjectConfig(boardEnvPath: string): ProjectConfig {
  const { values, boardComment } = parseBoardEnv(fs.readFileSync(boardEnvPath, "utf8"));
  const projectDir = path.dirname(path.dirname(boardEnvPath));
  const problems: string[] = [];

  let baud: number | undefined;
  if (values.BAUD !== undefined) {
    const parsed = Number(values.BAUD);
    if (Number.isInteger(parsed) && parsed > 0) {
      baud = parsed;
    } else {
      problems.push(`BAUD "${values.BAUD}" is not a positive whole number.`);
    }
  }

  let outputs: OutputsKind | undefined;
  if (values.OUTPUTS !== undefined) {
    const lowered = values.OUTPUTS.toLowerCase();
    if ((OUTPUT_KINDS as readonly string[]).includes(lowered)) {
      outputs = lowered as OutputsKind;
    } else {
      problems.push(`OUTPUTS "${values.OUTPUTS}" must be one of: ${OUTPUT_KINDS.join(", ")}.`);
    }
  }

  return {
    projectDir,
    boardEnvPath,
    boardComment,
    sketchPath: values.SKETCH_DIR ? path.resolve(projectDir, values.SKETCH_DIR) : undefined,
    fqbn: values.FQBN,
    port: values.PORT,
    baud,
    libs: splitList(values.LIBS),
    core: values.CORE,
    boardUrls: splitList(values.BOARD_URLS),
    outputs,
    backupDir: path.resolve(projectDir, values.BACKUP_DIR ?? "backups"),
    backupBeforeUpload: isEnabled(values.BACKUP_BEFORE_UPLOAD),
    problems
  };
}

/**
 * Find the project config. Search order: the sketch path (when given), then the explicit project
 * folder, then ARDUINO_PROJECT_DIR, then the server's working directory (the folder Claude Code was
 * started in).
 */
export function loadProjectConfig(opts: { sketchPath?: string; projectDir?: string }): ProjectConfig | null {
  const starts = [opts.sketchPath, opts.projectDir, process.env.ARDUINO_PROJECT_DIR, process.cwd()];
  for (const start of starts) {
    if (!start || start.trim().length === 0) {
      continue;
    }
    const found = findBoardEnv(start.trim());
    if (found) {
      return readProjectConfig(found);
    }
  }
  return null;
}

export interface TargetInput {
  projectDir?: string;
  sketchPath?: string;
  fqbn?: string;
  port?: string;
  baud?: number;
}

export interface ResolvedTargets {
  config: ProjectConfig | null;
  sketchPath?: string;
  fqbn?: string;
  port?: string;
  baud?: number;
  missing: string[]; // names of required values that neither the call nor board.env supplied
}

const REQUIRED_HINT: Record<string, string> = {
  sketchPath: "sketchPath (or SKETCH_DIR in tools/board.env)",
  fqbn: "fqbn (or FQBN in tools/board.env)",
  port: "port (or PORT in tools/board.env)"
};

/** Fill missing tool arguments from board.env and report what is still missing. */
export function resolveTargets(input: TargetInput, required: Array<"sketchPath" | "fqbn" | "port">): ResolvedTargets {
  const config = loadProjectConfig({ sketchPath: input.sketchPath, projectDir: input.projectDir });
  const resolved: ResolvedTargets = {
    config,
    sketchPath: input.sketchPath ?? config?.sketchPath,
    fqbn: input.fqbn ?? config?.fqbn,
    port: input.port ?? config?.port,
    baud: input.baud ?? config?.baud,
    missing: []
  };
  resolved.missing = required.filter((key) => !resolved[key]).map((key) => REQUIRED_HINT[key]);
  return resolved;
}

export interface GateResult {
  ok: boolean;
  errorCode?: string;
  error?: string;
  nextActions?: string[];
}

/**
 * Uploads run new code that drives the board's outputs. Refuse until it is known what they drive,
 * and require an explicit per-upload confirmation when they switch mains.
 */
export function checkOutputsGate(outputs: OutputsKind | undefined, confirmMains: boolean): GateResult {
  if (!outputs) {
    return {
      ok: false,
      errorCode: "OUTPUTS_UNKNOWN",
      error: "It is not known what this board's outputs drive, so the upload was not started.",
      nextActions: [
        "Ask the user what the board's outputs (relays, motors, heaters, LEDs) are connected to.",
        `Then add OUTPUTS=${OUTPUT_KINDS.join("|")} to tools/board.env, or pass outputs with the user's answer.`
      ]
    };
  }
  if (outputs === "mains" && !confirmMains) {
    return {
      ok: false,
      errorCode: "MAINS_CONFIRMATION_REQUIRED",
      error: "This board's outputs switch mains, heaters or motors. Each upload needs the user's explicit go-ahead.",
      nextActions: ["Ask the user to approve this specific upload, then retry with confirmMains=true."]
    };
  }
  return { ok: true };
}

/** 1200 baud makes ATmega32U4 boards (Leonardo, Micro, Pro Micro) reset into their bootloader. */
export function checkBaud(baud: number): GateResult {
  if (baud === 1200) {
    return {
      ok: false,
      errorCode: "BAUD_1200_REFUSED",
      error: "1200 baud resets ATmega32U4 boards into the bootloader; use the sketch's Serial.begin speed.",
      nextActions: ["Use the baud rate from Serial.begin (BAUD in tools/board.env)."]
    };
  }
  return { ok: true };
}
