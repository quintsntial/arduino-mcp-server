// Firmware backup and restore: read a board's whole flash to a file that can be written back,
// with a JSON sidecar that identifies the board it came from.
//
//   AVR (arduino:avr:*)   avrdude from the installed core, settings from the board's properties,
//                         Intel HEX image.
//   ESP8266 / ESP32       esptool (core-shipped, else on PATH, else `python3 -m esptool`), whole flash
//                         (size from flash-id) to a raw .bin.
//
// Everything that runs a program goes through FirmwareDeps.run, so tests can use canned output.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandResult } from "./arduinoCli.js";

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

export interface FirmwareDeps {
  run: Runner;
  cliPath: string;
  /** For tests: file existence checks used when looking for core-shipped tools. */
  fileExists?: (file: string) => boolean;
  /** For tests: the PATH used to look for an esptool executable. */
  pathEnv?: string;
  now?: () => Date;
}

export type FirmwareFamily = "avr" | "esp8266" | "esp32";

export interface UsbIdentity {
  vid: string | null;
  pid: string | null;
  serialNumber: string | null;
}

export interface FirmwareSidecar {
  formatVersion: 1;
  createdAt: string;
  label: string | null;
  family: FirmwareFamily;
  fqbn: string;
  port: string;
  usb: UsbIdentity | null;
  mcu?: string;
  deviceSignature?: string;
  chip?: string;
  mac?: string;
  flashId?: { manufacturer?: string; device?: string };
  flashSizeBytes: number | null;
  image: { file: string; format: "ihex" | "bin"; bytes: number; sha256: string };
  tool: { name: "avrdude" | "esptool"; command: string; source: string; version: string | null };
  readBaud?: number;
}

export interface StepLog {
  step: string;
  command: string;
  args: string[];
  ok: boolean;
  durationMs: number;
  outputTail: string;
}

export interface FirmwareOpResult {
  ok: boolean;
  errorCode?: string;
  error?: string;
  imagePath?: string;
  sidecarPath?: string;
  sidecar?: FirmwareSidecar;
  verified?: boolean;
  notes: string[];
  steps: StepLog[];
}

// ------------------------------------------------------------------ pure helpers

export function familyFromFqbn(fqbn: string | undefined): FirmwareFamily | null {
  const arch = fqbn?.split(":")[1];
  if (arch === "avr") return "avr";
  if (arch === "esp8266") return "esp8266";
  if (arch === "esp32") return "esp32";
  return null;
}

export function chipFamily(chip: string | undefined): FirmwareFamily | null {
  if (!chip) return null;
  if (/esp8266/i.test(chip)) return "esp8266";
  if (/esp32/i.test(chip)) return "esp32";
  return null;
}

/** Parse `arduino-cli board details --show-properties` output (key=value lines). */
export function parseProperties(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return props;
}

/** A tools.<tool>.<key> property with {path} and other {placeholders} filled in; undefined if unresolved. */
export function toolProperty(props: Record<string, string>, tool: string, key: string): string | undefined {
  let value = props[`tools.${tool}.${key}`];
  if (value === undefined) return undefined;
  const toolPath = props[`tools.${tool}.path`] ?? props[`runtime.tools.${tool}.path`];
  for (let i = 0; i < 5 && value.includes("{"); i++) {
    value = value.replace(/\{([^{}]+)\}/g, (whole, name: string) =>
      name === "path" ? toolPath ?? whole : props[`tools.${tool}.${name}`] ?? props[name] ?? whole
    );
  }
  return value.includes("{") ? undefined : value;
}

export interface AvrdudePlan {
  cmd: string;
  config: string;
  mcu: string;
  protocol: string;
  speed: string | null;
  version: string | null;
}

/** How to talk to an AVR board's bootloader, from its board properties. Nothing is hard-coded. */
export function avrdudePlan(props: Record<string, string>): { plan: AvrdudePlan } | { error: string } {
  const uploadTool = props["upload.tool.default"] ?? props["upload.tool"];
  if (uploadTool && uploadTool !== "avrdude") {
    return { error: `This board uploads with "${uploadTool}", not avrdude; firmware backup supports avrdude boards only.` };
  }
  if (props["upload.use_1200bps_touch"] === "true") {
    return {
      error:
        "This board enters its bootloader with a 1200 baud touch (e.g. Leonardo/Micro); firmware backup does not support that yet."
    };
  }
  const cmd = toolProperty(props, "avrdude", "cmd.path");
  const config = toolProperty(props, "avrdude", "config.path");
  const mcu = props["build.mcu"];
  const protocol = props["upload.protocol"];
  const missing = [
    !cmd && "tools.avrdude.cmd.path",
    !config && "tools.avrdude.config.path",
    !mcu && "build.mcu",
    !protocol && "upload.protocol"
  ].filter(Boolean);
  if (missing.length > 0) {
    return { error: `Board properties lack ${missing.join(", ")}; cannot build the avrdude command.` };
  }
  const toolPath = props["tools.avrdude.path"] ?? props["runtime.tools.avrdude.path"];
  return {
    plan: {
      cmd: cmd!,
      config: config!,
      mcu: mcu!,
      protocol: protocol!,
      speed: props["upload.speed"] ?? null,
      version: toolPath ? path.basename(toolPath) : null
    }
  };
}

export function avrdudeArgs(plan: AvrdudePlan, port: string, op: "read" | "write", file: string): string[] {
  const base = [`-C${plan.config}`, `-p${plan.mcu}`, `-c${plan.protocol}`, `-P${port}`];
  if (plan.speed) base.push(`-b${plan.speed}`);
  // Writing: -D as in the core's upload pattern (the bootloader erases page by page); verify stays on.
  // Reading: -v so avrdude 8 prints the device signature (the chip id recorded in the sidecar).
  return op === "read" ? [...base, "-v", `-Uflash:r:${file}:i`] : [...base, "-D", `-Uflash:w:${file}:i`];
}

/** Flash size of common AVR MCUs (for restore checks); null when unknown. */
const AVR_FLASH_BYTES: Record<string, number> = {
  atmega8: 8192,
  atmega168: 16384,
  atmega168p: 16384,
  atmega328: 32768,
  atmega328p: 32768,
  atmega328pb: 32768,
  atmega32u4: 32768,
  atmega644p: 65536,
  atmega1280: 131072,
  atmega1284p: 131072,
  atmega2560: 262144,
  attiny85: 8192
};

export function avrFlashBytes(mcu: string | undefined): number | null {
  return mcu ? AVR_FLASH_BYTES[mcu.toLowerCase()] ?? null : null;
}

export interface HexStats {
  valid: boolean;
  dataBytes: number;
  highestAddress: number;
  allErased: boolean; // every data byte is 0xFF
  allZero: boolean;
  problem?: string;
}

/** Check an Intel HEX file: record checksums, how much data it holds, and whether that data is blank. */
export function intelHexStats(text: string): HexStats {
  let base = 0;
  let dataBytes = 0;
  let highest = -1;
  let anyNotFF = false;
  let anyNotZero = false;
  let sawEof = false;
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!/^:[0-9A-Fa-f]{10,}$/.test(line) || line.length % 2 === 0) {
      return { valid: false, dataBytes, highestAddress: highest, allErased: false, allZero: false, problem: `line ${index + 1} is not an Intel HEX record` };
    }
    const bytes = Buffer.from(line.slice(1), "hex");
    const sum = bytes.reduce((acc, b) => (acc + b) & 0xff, 0);
    const len = bytes[0];
    if (sum !== 0 || bytes.length !== len + 5) {
      return { valid: false, dataBytes, highestAddress: highest, allErased: false, allZero: false, problem: `bad checksum or length on line ${index + 1}` };
    }
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + len);
    if (type === 0x00) {
      dataBytes += len;
      highest = Math.max(highest, base + addr + len - 1);
      for (const b of data) {
        if (b !== 0xff) anyNotFF = true;
        if (b !== 0x00) anyNotZero = true;
      }
    } else if (type === 0x01) {
      sawEof = true;
      break;
    } else if (type === 0x02) {
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 0x04) {
      base = ((data[0] << 8) | data[1]) << 16;
    }
  }
  if (!sawEof) {
    return { valid: false, dataBytes, highestAddress: highest, allErased: false, allZero: false, problem: "no end-of-file record (truncated read?)" };
  }
  return { valid: true, dataBytes, highestAddress: highest, allErased: dataBytes > 0 && !anyNotFF, allZero: dataBytes > 0 && !anyNotZero };
}

export function parseAvrSignature(output: string): string | undefined {
  const match = output.match(/Device signature\s*=\s*((?:0x)?[0-9A-Fa-f]{2}(?:\s*(?:0x)?[0-9A-Fa-f]{2})+)/);
  return match ? match[1].replace(/0x/gi, "").replace(/\s+/g, " ").trim().toUpperCase() : undefined;
}

export interface EsptoolVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

export function parseEsptoolVersion(output: string): EsptoolVersion | null {
  const match = output.match(/v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), text: match[0].replace(/^v/, "") };
}

/** esptool v5 uses dashed command names; older versions use underscores. */
export function esptoolCommands(major: number) {
  const name = (base: string) => (major >= 5 ? base.replace(/_/g, "-") : base);
  return {
    flashId: name("flash_id"),
    readFlash: name("read_flash"),
    writeFlash: name("write_flash"),
    readMac: name("read_mac")
  };
}

export interface FlashIdInfo {
  chip?: string;
  mac?: string;
  manufacturer?: string;
  device?: string;
  flashSizeBytes?: number;
}

/** Parse esptool flash_id / flash-id output (v4 "Chip is X", v5 "Chip type: X"). */
export function parseFlashId(output: string): FlashIdInfo {
  const info: FlashIdInfo = {};
  // A whole line "Chip is X" (v4) or "Chip type: X" (v5), not "Detecting chip type... X".
  const chip = output.match(/^\s*Chip (?:is\s+|type:\s*)([^\r\n]+)/im);
  if (chip) info.chip = chip[1].trim();
  const mac = output.match(/MAC:\s*((?:[0-9a-f]{2}:){5}[0-9a-f]{2})/i);
  if (mac) info.mac = mac[1].toLowerCase();
  const manufacturer = output.match(/Manufacturer:\s*([0-9a-fx]+)/i);
  if (manufacturer) info.manufacturer = manufacturer[1];
  const device = output.match(/Device:\s*([0-9a-fx]+)/i);
  if (device) info.device = device[1];
  const size = output.match(/Detected flash size:\s*(\d+)\s*(KB|MB)/i);
  if (size) info.flashSizeBytes = Number(size[1]) * (size[2].toUpperCase() === "MB" ? 1024 * 1024 : 1024);
  return info;
}

export interface EsptoolCandidate {
  command: string;
  prefixArgs: string[];
  source: string;
}

/** Where to look for esptool, in order: the installed core, an executable on PATH, the Python module. */
export function esptoolCandidates(
  props: Record<string, string> | null,
  pathEnv: string,
  fileExists: (file: string) => boolean
): EsptoolCandidate[] {
  const candidates: EsptoolCandidate[] = [];
  if (props) {
    const platform = props["runtime.platform.path"];
    const python = props["runtime.tools.python3.path"];
    const esp8266Script = platform ? path.join(platform, "tools", "esptool", "esptool.py") : null;
    if (esp8266Script && fileExists(esp8266Script)) {
      const pythonBin = python && fileExists(path.join(python, "python3")) ? path.join(python, "python3") : "python3";
      candidates.push({ command: pythonBin, prefixArgs: [esp8266Script], source: "esp8266 core" });
    }
    const esp32Tool = props["runtime.tools.esptool_py.path"] ?? props["tools.esptool_py.path"];
    if (esp32Tool) {
      for (const name of ["esptool", "esptool.py"]) {
        const file = path.join(esp32Tool, name);
        if (fileExists(file)) {
          candidates.push({ command: file, prefixArgs: [], source: "esp32 core" });
          break;
        }
      }
    }
  }
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const name of ["esptool", "esptool.py"]) {
      const file = path.join(dir, name);
      if (fileExists(file) && !candidates.some((c) => c.command === file)) {
        candidates.push({ command: file, prefixArgs: [], source: "PATH" });
      }
    }
  }
  candidates.push({ command: "python3", prefixArgs: ["-m", "esptool"], source: "python3 -m esptool" });
  return candidates;
}

export function backupBaseName(label: string | undefined, family: FirmwareFamily, date: Date): string {
  const slug = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${slug || family}-${stamp}`;
}

export interface BoardIdentity {
  family: FirmwareFamily;
  fqbn: string;
  port: string;
  usb: UsbIdentity | null;
  mac?: string;
}

export type MatchStrength = "mac" | "fqbn+port+usb";

/**
 * Whether a backup belongs to the connected board. ESP boards match on their MAC address. AVR boards
 * have no unique ID readable through the bootloader, so they match on FQBN + port + USB VID/PID, which
 * any board of the same type on the same port and USB chip also passes.
 */
export function sidecarMatchesBoard(sidecar: FirmwareSidecar, board: BoardIdentity): { match: boolean; strength?: MatchStrength } {
  if (sidecar.family !== board.family) return { match: false };
  if (board.family === "avr") {
    const usbMatch =
      !!sidecar.usb?.vid &&
      !!board.usb?.vid &&
      sidecar.usb.vid.toLowerCase() === board.usb.vid.toLowerCase() &&
      (sidecar.usb.pid ?? "").toLowerCase() === (board.usb.pid ?? "").toLowerCase();
    return sidecar.fqbn === board.fqbn && sidecar.port === board.port && usbMatch
      ? { match: true, strength: "fqbn+port+usb" }
      : { match: false };
  }
  return sidecar.mac && board.mac && sidecar.mac.toLowerCase() === board.mac.toLowerCase()
    ? { match: true, strength: "mac" }
    : { match: false };
}

export function readSidecar(file: string): FirmwareSidecar | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as FirmwareSidecar;
    return parsed && parsed.formatVersion === 1 && parsed.image?.file ? parsed : null;
  } catch {
    return null;
  }
}

/** Newest backup in dir that matches the board, or null. */
export function findMatchingBackup(
  dir: string,
  board: BoardIdentity
): { sidecarPath: string; sidecar: FirmwareSidecar; strength: MatchStrength } | null {
  if (!fs.existsSync(dir)) return null;
  const found = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ sidecarPath: path.join(dir, name), sidecar: readSidecar(path.join(dir, name)) }))
    .filter((entry): entry is { sidecarPath: string; sidecar: FirmwareSidecar } => entry.sidecar !== null)
    .filter((entry) => fs.existsSync(path.join(dir, entry.sidecar.image.file)))
    .sort((a, b) => b.sidecar.createdAt.localeCompare(a.sidecar.createdAt));
  for (const entry of found) {
    const result = sidecarMatchesBoard(entry.sidecar, board);
    if (result.match) return { ...entry, strength: result.strength! };
  }
  return null;
}

export interface RestoreTarget {
  family: FirmwareFamily | null;
  mcu?: string;
  flashSizeBytes?: number | null;
}

/** Reasons a backup must not be written to the connected board (empty list = compatible). */
export function restoreProblems(sidecar: FirmwareSidecar, target: RestoreTarget): string[] {
  const problems: string[] = [];
  if (sidecar.family !== target.family) {
    problems.push(`The backup is for a ${sidecar.family} board, the connected board is ${target.family ?? "an unsupported type"}.`);
    return problems;
  }
  if (sidecar.family === "avr" && sidecar.mcu && target.mcu && sidecar.mcu !== target.mcu) {
    problems.push(`The backup is for ${sidecar.mcu}, the connected board's FQBN is ${target.mcu}.`);
  }
  if (sidecar.family !== "avr" && !target.flashSizeBytes) {
    problems.push("Could not detect the connected board's flash size.");
  }
  if (sidecar.flashSizeBytes && target.flashSizeBytes && sidecar.flashSizeBytes !== target.flashSizeBytes) {
    problems.push(`The backup holds ${sidecar.flashSizeBytes} bytes of flash, the connected board has ${target.flashSizeBytes}.`);
  }
  return problems;
}

/**
 * Serial speed for reading ESP flash. 460800 failed with "Invalid head of packet (0x0D): Possible serial noise"
 * on a CH340 NodeMCU (2026-11-27); 115200 read the whole 4 MB reliably (about 6 min).
 */
export const DEFAULT_ESP_READ_BAUD = 115_200;
/** Serial speed for writing ESP flash in restore_firmware: same reasoning as reading. */
export const DEFAULT_ESP_WRITE_BAUD = 115_200;

export const AVR_WEAK_MATCH_NOTE =
  "AVR boards have no unique ID readable through the bootloader, so the match uses FQBN + port + USB VID/PID: any board of the same type on the same port with the same USB chip counts as backed up.";

// ------------------------------------------------------------------ running the tools

function tailOf(raw: CommandResult, chars = 1500): string {
  const text = `${raw.stdout}\n${raw.stderr}`.trim();
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function logged(deps: FirmwareDeps, steps: StepLog[], step: string, command: string, args: string[], timeoutMs: number) {
  const raw = await deps.run(command, args, timeoutMs);
  steps.push({ step, command, args, ok: raw.ok, durationMs: raw.durationMs, outputTail: tailOf(raw, 600) });
  return raw;
}

export async function boardProperties(deps: FirmwareDeps, fqbn: string): Promise<Record<string, string> | null> {
  const raw = await deps.run(deps.cliPath, ["board", "details", "-b", fqbn, "--show-properties=expanded"], 60_000);
  return raw.ok ? parseProperties(raw.stdout) : null;
}

/** USB identity of a port from `arduino-cli board list`; null when the port is not connected. */
export async function portUsbIdentity(deps: FirmwareDeps, port: string): Promise<UsbIdentity | null> {
  const raw = await deps.run(deps.cliPath, ["board", "list", "--format", "json"], 60_000);
  if (!raw.ok) return null;
  try {
    const parsed = JSON.parse(raw.stdout) as { detected_ports?: Array<{ port?: { address?: string; properties?: Record<string, string> } }> };
    const entry = (parsed.detected_ports ?? []).find((e) => e.port?.address === port);
    if (!entry) return null;
    const props = entry.port?.properties ?? {};
    return { vid: props.vid ?? null, pid: props.pid ?? null, serialNumber: props.serialNumber || null };
  } catch {
    return null;
  }
}

export interface ResolvedEsptool extends EsptoolCandidate {
  version: EsptoolVersion | null;
}

export async function resolveEsptool(deps: FirmwareDeps, props: Record<string, string> | null): Promise<ResolvedEsptool | null> {
  const exists = deps.fileExists ?? ((file: string) => fs.existsSync(file));
  for (const candidate of esptoolCandidates(props, deps.pathEnv ?? process.env.PATH ?? "", exists)) {
    const raw = await deps.run(candidate.command, [...candidate.prefixArgs, "version"], 30_000);
    if (raw.ok) {
      return { ...candidate, version: parseEsptoolVersion(`${raw.stdout}\n${raw.stderr}`) };
    }
  }
  return null;
}

function ensureBackupDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    // ESP images usually hold the saved Wi-Fi name and password in plain text: never commit backups.
    fs.writeFileSync(ignore, "*\n");
  }
}

function fail(errorCode: string, error: string, steps: StepLog[], notes: string[] = []): FirmwareOpResult {
  return { ok: false, errorCode, error, steps, notes };
}

export interface BackupInput {
  fqbn: string;
  port: string;
  backupDir: string;
  label?: string;
  readBaud?: number;
}

export async function backupFirmware(deps: FirmwareDeps, input: BackupInput): Promise<FirmwareOpResult> {
  const steps: StepLog[] = [];
  const family = familyFromFqbn(input.fqbn);
  if (!family) {
    return fail("UNSUPPORTED_BOARD", `Firmware backup supports arduino:avr, esp8266 and esp32 boards, not ${input.fqbn}.`, steps);
  }
  const usb = await portUsbIdentity(deps, input.port);
  if (!usb) {
    return fail("PORT_NOT_FOUND", `Port ${input.port} is not connected (arduino-cli board list). Check the cable and list_connected_boards.`, steps);
  }
  const date = (deps.now ?? (() => new Date()))();
  const base = backupBaseName(input.label, family, date);
  ensureBackupDir(input.backupDir);

  if (family === "avr") {
    const props = await boardProperties(deps, input.fqbn);
    if (!props) {
      return fail("BOARD_DETAILS_FAILED", `arduino-cli board details failed for ${input.fqbn}: is its core installed?`, steps);
    }
    const planned = avrdudePlan(props);
    if ("error" in planned) {
      return fail("UNSUPPORTED_BOARD", planned.error, steps);
    }
    const plan = planned.plan;
    const imagePath = path.join(input.backupDir, `${base}.hex`);
    const raw = await logged(deps, steps, "avrdude read flash", plan.cmd, avrdudeArgs(plan, input.port, "read", imagePath), 180_000);
    if (!raw.ok || !fs.existsSync(imagePath)) {
      fs.rmSync(imagePath, { force: true });
      return fail("FLASH_READ_FAILED", `avrdude could not read the flash: ${tailOf(raw, 400)}`, steps);
    }
    const stats = intelHexStats(fs.readFileSync(imagePath, "utf8"));
    if (!stats.valid || stats.dataBytes === 0 || stats.allErased || stats.allZero) {
      fs.rmSync(imagePath, { force: true });
      const why = !stats.valid
        ? `the HEX file is damaged (${stats.problem})`
        : stats.dataBytes === 0
          ? "it holds no data"
          : stats.allErased
            ? "every byte is 0xFF: the flash is empty, or read-protected by lock bits"
            : "every byte is 0x00: the flash is read-protected by lock bits";
      return fail("FLASH_UNREADABLE", `The flash read back unusable data, so no backup was saved: ${why}.`, steps);
    }
    const sidecar: FirmwareSidecar = {
      formatVersion: 1,
      createdAt: date.toISOString(),
      label: input.label ?? null,
      family,
      fqbn: input.fqbn,
      port: input.port,
      usb,
      mcu: plan.mcu,
      deviceSignature: parseAvrSignature(`${raw.stdout}\n${raw.stderr}`),
      flashSizeBytes: avrFlashBytes(plan.mcu),
      image: { file: path.basename(imagePath), format: "ihex", bytes: fs.statSync(imagePath).size, sha256: sha256File(imagePath) },
      tool: { name: "avrdude", command: plan.cmd, source: "installed core", version: plan.version }
    };
    const sidecarPath = path.join(input.backupDir, `${base}.json`);
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    return {
      ok: true,
      imagePath,
      sidecarPath,
      sidecar,
      steps,
      notes: [`${stats.dataBytes} bytes of flash data read (highest address 0x${stats.highestAddress.toString(16)}).`]
    };
  }

  // ESP8266 / ESP32
  const props = await boardProperties(deps, input.fqbn); // null when the ESP core is not installed: fine
  const esptool = await resolveEsptool(deps, props);
  if (!esptool) {
    return fail("ESPTOOL_NOT_FOUND", "No esptool found (installed core, PATH, or python3 -m esptool).", steps);
  }
  const cmds = esptoolCommands(esptool.version?.major ?? 4);
  const idRaw = await logged(deps, steps, "esptool flash id", esptool.command, [...esptool.prefixArgs, "--port", input.port, cmds.flashId], 120_000);
  if (!idRaw.ok) {
    return fail("FLASH_ID_FAILED", `esptool ${cmds.flashId} failed: ${tailOf(idRaw, 400)}`, steps);
  }
  const info = parseFlashId(`${idRaw.stdout}\n${idRaw.stderr}`);
  const detected = chipFamily(info.chip);
  if (detected !== family) {
    return fail("CHIP_MISMATCH", `The board on ${input.port} reports chip "${info.chip ?? "unknown"}", but the FQBN ${input.fqbn} is ${family}. Nothing was read.`, steps);
  }
  if (!info.flashSizeBytes) {
    return fail("FLASH_SIZE_UNKNOWN", `esptool ${cmds.flashId} did not report the flash size, so the whole flash cannot be read.`, steps);
  }
  const readBaud = input.readBaud ?? DEFAULT_ESP_READ_BAUD;
  const imagePath = path.join(input.backupDir, `${base}.bin`);
  const readRaw = await logged(
    deps,
    steps,
    "esptool read flash",
    esptool.command,
    [...esptool.prefixArgs, "--port", input.port, "--baud", String(readBaud), cmds.readFlash, "0", String(info.flashSizeBytes), imagePath],
    20 * 60_000
  );
  if (!readRaw.ok || !fs.existsSync(imagePath)) {
    fs.rmSync(imagePath, { force: true });
    return fail("FLASH_READ_FAILED", `esptool ${cmds.readFlash} failed: ${tailOf(readRaw, 400)} (check the cable; a lower readBaud such as 57600 may help).`, steps);
  }
  const bytes = fs.statSync(imagePath).size;
  if (bytes !== info.flashSizeBytes) {
    fs.rmSync(imagePath, { force: true });
    return fail("FLASH_READ_INCOMPLETE", `Read ${bytes} bytes but the flash holds ${info.flashSizeBytes}; no backup was saved.`, steps);
  }
  const sidecar: FirmwareSidecar = {
    formatVersion: 1,
    createdAt: date.toISOString(),
    label: input.label ?? null,
    family,
    fqbn: input.fqbn,
    port: input.port,
    usb,
    chip: info.chip,
    mac: info.mac,
    flashId: { manufacturer: info.manufacturer, device: info.device },
    flashSizeBytes: info.flashSizeBytes,
    image: { file: path.basename(imagePath), format: "bin", bytes, sha256: sha256File(imagePath) },
    tool: { name: "esptool", command: [esptool.command, ...esptool.prefixArgs].join(" "), source: esptool.source, version: esptool.version?.text ?? null },
    readBaud
  };
  const sidecarPath = path.join(input.backupDir, `${base}.json`);
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return {
    ok: true,
    imagePath,
    sidecarPath,
    sidecar,
    steps,
    notes: ["ESP flash images usually contain the saved Wi-Fi name and password in plain text: keep the file private (the backup folder has a .gitignore)."]
  };
}

export interface RestoreInput {
  sidecarPath: string;
  fqbn: string;
  port: string;
  writeBaud?: number;
}

export async function restoreFirmware(deps: FirmwareDeps, input: RestoreInput): Promise<FirmwareOpResult> {
  const steps: StepLog[] = [];
  const sidecar = readSidecar(input.sidecarPath);
  if (!sidecar) {
    return fail("BACKUP_NOT_FOUND", `${input.sidecarPath} is not a firmware backup sidecar.`, steps);
  }
  const imagePath = path.join(path.dirname(input.sidecarPath), sidecar.image.file);
  if (!fs.existsSync(imagePath)) {
    return fail("BACKUP_NOT_FOUND", `The image ${imagePath} named in the sidecar is missing.`, steps);
  }
  if (sha256File(imagePath) !== sidecar.image.sha256) {
    return fail("IMAGE_CHANGED", `${imagePath} no longer matches the sha256 in its sidecar; refusing to write it.`, steps);
  }
  const family = familyFromFqbn(input.fqbn);
  const usb = await portUsbIdentity(deps, input.port);
  if (!usb) {
    return fail("PORT_NOT_FOUND", `Port ${input.port} is not connected (arduino-cli board list).`, steps);
  }
  const notes: string[] = [];

  if (family === "avr") {
    const props = await boardProperties(deps, input.fqbn);
    const planned = props ? avrdudePlan(props) : { error: `arduino-cli board details failed for ${input.fqbn}.` };
    if ("error" in planned) {
      return fail("UNSUPPORTED_BOARD", planned.error, steps);
    }
    const problems = restoreProblems(sidecar, { family, mcu: planned.plan.mcu, flashSizeBytes: avrFlashBytes(planned.plan.mcu) });
    if (problems.length > 0) {
      return fail("BACKUP_MISMATCH", `${problems.join(" ")} Nothing was written.`, steps);
    }
    const raw = await logged(deps, steps, "avrdude write flash", planned.plan.cmd, avrdudeArgs(planned.plan, input.port, "write", imagePath), 300_000);
    if (!raw.ok) {
      return fail("FLASH_WRITE_FAILED", `avrdude failed: ${tailOf(raw, 400)}`, steps);
    }
    const verified = /verified/i.test(`${raw.stdout}\n${raw.stderr}`);
    if (!verified) notes.push("avrdude finished, but its output did not confirm verification.");
    return { ok: true, imagePath, sidecarPath: input.sidecarPath, sidecar, verified, steps, notes };
  }

  if (family === "esp8266" || family === "esp32") {
    const props = await boardProperties(deps, input.fqbn);
    const esptool = await resolveEsptool(deps, props);
    if (!esptool) {
      return fail("ESPTOOL_NOT_FOUND", "No esptool found (installed core, PATH, or python3 -m esptool).", steps);
    }
    const cmds = esptoolCommands(esptool.version?.major ?? 4);
    const idRaw = await logged(deps, steps, "esptool flash id", esptool.command, [...esptool.prefixArgs, "--port", input.port, cmds.flashId], 120_000);
    if (!idRaw.ok) {
      return fail("FLASH_ID_FAILED", `esptool ${cmds.flashId} failed: ${tailOf(idRaw, 400)}`, steps);
    }
    const info = parseFlashId(`${idRaw.stdout}\n${idRaw.stderr}`);
    const problems = restoreProblems(sidecar, { family: chipFamily(info.chip), flashSizeBytes: info.flashSizeBytes });
    if (problems.length > 0) {
      return fail("BACKUP_MISMATCH", `${problems.join(" ")} Nothing was written.`, steps);
    }
    if (sidecar.mac && info.mac && sidecar.mac !== info.mac) {
      notes.push(`The backup came from the board with MAC ${sidecar.mac}; this one is ${info.mac}.`);
    }
    const raw = await logged(
      deps,
      steps,
      "esptool write flash",
      esptool.command,
      [...esptool.prefixArgs, "--port", input.port, "--baud", String(input.writeBaud ?? DEFAULT_ESP_WRITE_BAUD), cmds.writeFlash, "0", imagePath],
      20 * 60_000
    );
    if (!raw.ok) {
      return fail("FLASH_WRITE_FAILED", `esptool ${cmds.writeFlash} failed: ${tailOf(raw, 400)}`, steps);
    }
    const verified = /Hash of data verified/i.test(`${raw.stdout}\n${raw.stderr}`);
    if (!verified) notes.push("esptool finished, but its output did not confirm the hash check.");
    return { ok: true, imagePath, sidecarPath: input.sidecarPath, sidecar, verified, steps, notes };
  }

  return fail("UNSUPPORTED_BOARD", `Firmware restore supports arduino:avr, esp8266 and esp32 boards, not ${input.fqbn}.`, steps);
}

export interface BackupGateResult {
  ok: boolean;
  errorCode?: string;
  error?: string;
  matched?: { sidecarPath: string; strength: MatchStrength; createdAt: string };
  note?: string;
}

/** BACKUP_BEFORE_UPLOAD: is there a backup of the connected board in backupDir? */
export async function checkBackupGate(deps: FirmwareDeps, input: { fqbn: string | undefined; port: string; backupDir: string }): Promise<BackupGateResult> {
  const family = familyFromFqbn(input.fqbn);
  if (!family || !input.fqbn) {
    return {
      ok: false,
      errorCode: "BACKUP_REQUIRED",
      error: `BACKUP_BEFORE_UPLOAD is set, but backup_firmware does not support ${input.fqbn ?? "a board without FQBN"}, so no backup can be checked. Nothing was uploaded.`
    };
  }
  const usb = await portUsbIdentity(deps, input.port);
  let mac: string | undefined;
  if (family !== "avr") {
    const esptool = await resolveEsptool(deps, await boardProperties(deps, input.fqbn));
    if (esptool) {
      const cmds = esptoolCommands(esptool.version?.major ?? 4);
      const raw = await deps.run(esptool.command, [...esptool.prefixArgs, "--port", input.port, cmds.readMac], 60_000);
      mac = raw.ok ? parseFlashId(`${raw.stdout}\n${raw.stderr}`).mac : undefined;
    }
    if (!mac) {
      return {
        ok: false,
        errorCode: "BACKUP_REQUIRED",
        error: `BACKUP_BEFORE_UPLOAD is set, but the MAC address of the board on ${input.port} could not be read to find its backup. Nothing was uploaded.`
      };
    }
  }
  const match = findMatchingBackup(input.backupDir, { family, fqbn: input.fqbn, port: input.port, usb, mac });
  if (match) {
    return {
      ok: true,
      matched: { sidecarPath: match.sidecarPath, strength: match.strength, createdAt: match.sidecar.createdAt },
      note: match.strength === "fqbn+port+usb" ? AVR_WEAK_MATCH_NOTE : undefined
    };
  }
  return {
    ok: false,
    errorCode: "BACKUP_REQUIRED",
    error:
      `BACKUP_BEFORE_UPLOAD is set and ${input.backupDir} has no backup of the board on ${input.port}` +
      (family === "avr" ? ` (matched on FQBN + port + USB VID/PID). ${AVR_WEAK_MATCH_NOTE}` : ` (matched on MAC ${mac}).`) +
      " Nothing was uploaded."
  };
}
