import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult } from "./arduinoCli.js";
import {
  AVR_WEAK_MATCH_NOTE,
  avrdudeArgs,
  avrdudePlan,
  backupBaseName,
  backupFirmware,
  checkBackupGate,
  chipFamily,
  esptoolCandidates,
  espRegionBytes,
  esptoolCommands,
  familyFromFqbn,
  findLastUpload,
  intelHexStats,
  parseAvrSignature,
  parseEsptoolVersion,
  parseFlashId,
  parseProperties,
  restoreFirmware,
  restoreProblems,
  sidecarMatchesBoard,
  writeUploadRecord,
  type BoardIdentity,
  type FirmwareDeps,
  type FirmwareSidecar,
  type UploadImage
} from "./firmware.js";

// Excerpt of `arduino-cli board details -b arduino:avr:nano:cpu=atmega328old --show-properties=expanded`.
const NANO_OLD_PROPS = `build.mcu=atmega328p
upload.protocol=arduino
upload.speed=57600
upload.tool=avrdude
upload.tool.default=avrdude
tools.avrdude.path=/A15/packages/arduino/tools/avrdude/8.0.0-arduino1
tools.avrdude.cmd.path={path}/bin/avrdude
tools.avrdude.config.path={path}/etc/avrdude.conf
`;

/** Build an Intel HEX file from data records (16 bytes each) plus EOF. */
function hexOf(bytes: number[], start = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const addr = start + i;
    const record = [chunk.length, (addr >> 8) & 0xff, addr & 0xff, 0x00, ...chunk];
    const sum = (0x100 - (record.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    lines.push(`:${[...record, sum].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
  }
  lines.push(":00000001FF");
  return `${lines.join("\n")}\n`;
}

const ok = (stdout = "", stderr = ""): CommandResult => ({
  ok: true,
  command: "x",
  args: [],
  code: 0,
  stdout,
  stderr,
  timedOut: false,
  durationMs: 1
});
const failed = (stderr: string): CommandResult => ({ ...ok("", stderr), ok: false, code: 1 });

describe("pure helpers", () => {
  test("familyFromFqbn and chipFamily", () => {
    assert.equal(familyFromFqbn("arduino:avr:nano:cpu=atmega328old"), "avr");
    assert.equal(familyFromFqbn("esp8266:esp8266:nodemcuv2"), "esp8266");
    assert.equal(familyFromFqbn("esp32:esp32:esp32"), "esp32");
    assert.equal(familyFromFqbn("arduino:samd:mkr1000"), null);
    assert.equal(chipFamily("ESP8266EX"), "esp8266");
    assert.equal(chipFamily("ESP32-S3 (QFN56) (revision v0.2)"), "esp32");
  });

  test("avrdude settings come from the board properties, with {path} expanded", () => {
    const planned = avrdudePlan(parseProperties(NANO_OLD_PROPS));
    assert.ok("plan" in planned);
    const plan = planned.plan;
    assert.equal(plan.cmd, "/A15/packages/arduino/tools/avrdude/8.0.0-arduino1/bin/avrdude");
    assert.equal(plan.version, "8.0.0-arduino1");
    assert.deepEqual(avrdudeArgs(plan, "/dev/cu.usbserial-230", "read", "/b/x.hex"), [
      "-C/A15/packages/arduino/tools/avrdude/8.0.0-arduino1/etc/avrdude.conf",
      "-patmega328p",
      "-carduino",
      "-P/dev/cu.usbserial-230",
      "-b57600",
      "-v",
      "-Uflash:r:/b/x.hex:i"
    ]);
    const write = avrdudeArgs(plan, "/dev/p", "write", "/b/x.hex");
    assert.deepEqual(write.slice(-2), ["-D", "-Uflash:w:/b/x.hex:i"]);
    assert.ok(!write.includes("-V"), "verify must stay on when writing");
  });

  test("avrdude plan refuses boards it cannot handle", () => {
    const touch = avrdudePlan(parseProperties(`${NANO_OLD_PROPS}upload.use_1200bps_touch=true\n`));
    assert.ok("error" in touch && /1200 baud/.test(touch.error));
    const other = avrdudePlan(parseProperties("upload.tool.default=bossac\nbuild.mcu=cortex-m0plus\n"));
    assert.ok("error" in other && /bossac/.test(other.error));
  });

  test("Intel HEX check: valid data, blank flash, damage", () => {
    const good = intelHexStats(hexOf([0x0c, 0x94, 0x5c, 0x00, ...Array(28).fill(0xff)]));
    assert.equal(good.valid, true);
    assert.equal(good.dataBytes, 32);
    assert.equal(good.highestAddress, 31);
    assert.equal(good.allErased, false);
    assert.equal(intelHexStats(hexOf(Array(32).fill(0xff))).allErased, true);
    assert.equal(intelHexStats(hexOf(Array(32).fill(0x00))).allZero, true);
    assert.equal(intelHexStats(hexOf([1, 2, 3]).replace(":00000001FF", "")).valid, false);
    assert.equal(intelHexStats(":0300000001020399\n:00000001FF\n").valid, false); // bad checksum
    // Extended linear address record moves the base to 0x10000.
    const ext = intelHexStats(`:020000040001F9\n${hexOf([0xaa])}`);
    assert.equal(ext.highestAddress, 0x10000);
  });

  test("AVR device signature", () => {
    assert.equal(parseAvrSignature("Device signature = 1E 95 0F (ATmega328P)"), "1E 95 0F");
    assert.equal(parseAvrSignature("avrdude: Device signature = 0x1e950f (probably m328p)"), "1E950F");
  });

  test("esptool version decides the command names", () => {
    assert.equal(parseEsptoolVersion("esptool.py v4.7.0\n4.7.0")?.major, 4);
    assert.equal(parseEsptoolVersion("esptool v5.0.2")?.text, "5.0.2");
    assert.deepEqual(esptoolCommands(4), { flashId: "flash_id", readFlash: "read_flash", writeFlash: "write_flash", verifyFlash: "verify_flash", readMac: "read_mac" });
    assert.deepEqual(esptoolCommands(5), { flashId: "flash-id", readFlash: "read-flash", writeFlash: "write-flash", verifyFlash: "verify-flash", readMac: "read-mac" });
  });

  test("flash id parsing, v4 and v5 output", () => {
    const v4 = parseFlashId(
      "Detecting chip type... ESP8266\nChip is ESP8266EX\nFeatures: WiFi\nMAC: 5c:cf:7f:aa:bb:cc\nManufacturer: 20\nDevice: 4016\nDetected flash size: 4MB\n"
    );
    assert.deepEqual(v4, { chip: "ESP8266EX", mac: "5c:cf:7f:aa:bb:cc", manufacturer: "20", device: "4016", flashSizeBytes: 4 * 1024 * 1024 });
    const v5 = parseFlashId("Chip type:          ESP32-D0WD-V3 (revision v3.1)\nMAC:                A0:B1:C2:D3:E4:F5\nDetected flash size: 512KB\n");
    assert.equal(v5.chip, "ESP32-D0WD-V3 (revision v3.1)");
    assert.equal(v5.mac, "a0:b1:c2:d3:e4:f5");
    assert.equal(v5.flashSizeBytes, 512 * 1024);
  });

  test("esptool search order: core, PATH, python module", () => {
    const props = {
      "runtime.platform.path": "/A15/esp8266/3.1.2",
      "runtime.tools.python3.path": "/A15/tools/python3/3.7.2"
    };
    const files = new Set(["/A15/esp8266/3.1.2/tools/esptool/esptool.py", "/A15/tools/python3/3.7.2/python3", "/usr/local/bin/esptool"]);
    const list = esptoolCandidates(props, "/usr/bin:/usr/local/bin", (f) => files.has(f));
    assert.deepEqual(
      list.map((c) => c.source),
      ["esp8266 core", "PATH", "python3 -m esptool"]
    );
    assert.equal(list[0].command, "/A15/tools/python3/3.7.2/python3");
    assert.deepEqual(list[2].prefixArgs, ["-m", "esptool"]);
  });

  test("backup file names", () => {
    assert.equal(backupBaseName("NodeMCU text+tune!", "esp8266", new Date(2026, 10, 26, 21, 5, 9)), "nodemcu-text-tune-20261126-210509");
    assert.equal(backupBaseName(undefined, "avr", new Date(2026, 0, 2, 3, 4, 5)), "avr-20260102-030405");
  });
});

const sidecarBase = (over: Partial<FirmwareSidecar>): FirmwareSidecar => ({
  formatVersion: 1,
  createdAt: "2026-11-26T20:00:00.000Z",
  label: null,
  family: "avr",
  fqbn: "arduino:avr:nano:cpu=atmega328old",
  port: "/dev/cu.usbserial-230",
  usb: { vid: "0x1A86", pid: "0x7523", serialNumber: null },
  flashSizeBytes: 32768,
  mcu: "atmega328p",
  image: { file: "x.hex", format: "ihex", bytes: 1, sha256: "0" },
  tool: { name: "avrdude", command: "avrdude", source: "installed core", version: null },
  ...over
});

describe("sidecar matching and restore checks", () => {
  const nano = { family: "avr" as const, fqbn: "arduino:avr:nano:cpu=atmega328old", port: "/dev/cu.usbserial-230", usb: { vid: "0x1a86", pid: "0x7523", serialNumber: null } };

  test("AVR matches on FQBN + port + USB VID/PID (weak)", () => {
    assert.deepEqual(sidecarMatchesBoard(sidecarBase({}), nano), { match: true, strength: "fqbn+port+usb" });
    assert.equal(sidecarMatchesBoard(sidecarBase({}), { ...nano, port: "/dev/cu.usbserial-110" }).match, false);
    assert.equal(sidecarMatchesBoard(sidecarBase({}), { ...nano, usb: { vid: "0x2341", pid: "0x0043", serialNumber: null } }).match, false);
  });

  test("ESP matches on MAC only", () => {
    const esp = sidecarBase({ family: "esp8266", mac: "5c:cf:7f:aa:bb:cc", fqbn: "esp8266:esp8266:nodemcuv2" });
    const board = { family: "esp8266" as const, fqbn: "esp8266:esp8266:generic", port: "/dev/other", usb: null, mac: "5C:CF:7F:AA:BB:CC" };
    assert.deepEqual(sidecarMatchesBoard(esp, board), { match: true, strength: "mac" });
    assert.equal(sidecarMatchesBoard(esp, { ...board, mac: "5c:cf:7f:00:00:00" }).match, false);
    assert.equal(sidecarMatchesBoard(esp, { ...nano }).match, false);
  });

  test("restore refuses another family, MCU or flash size", () => {
    assert.deepEqual(restoreProblems(sidecarBase({}), { family: "avr", mcu: "atmega328p", flashSizeBytes: 32768 }), []);
    assert.match(restoreProblems(sidecarBase({}), { family: "esp8266" })[0], /avr board/);
    assert.match(restoreProblems(sidecarBase({}), { family: "avr", mcu: "atmega2560", flashSizeBytes: 262144 }).join(" "), /atmega2560/);
    const esp = sidecarBase({ family: "esp8266", flashSizeBytes: 4194304, mcu: undefined });
    assert.match(restoreProblems(esp, { family: "esp8266", flashSizeBytes: 1048576 })[0], /4194304 bytes/);
    assert.match(restoreProblems(esp, { family: "esp8266", flashSizeBytes: undefined })[0], /flash size/);
  });
});

describe("backup, restore and the upload gate with fake tools", () => {
  let dir: string;
  const port = "/dev/cu.usbserial-230";
  const avrdude = "/A15/packages/arduino/tools/avrdude/8.0.0-arduino1/bin/avrdude";
  const boardList = JSON.stringify({
    detected_ports: [{ port: { address: port, properties: { vid: "0x1A86", pid: "0x7523", serialNumber: "" } } }]
  });
  let flashBytes: number[] = [0x0c, 0x94, 0x5c, 0x00, 0x0c, 0x94, 0x6e, 0x00];
  let writes: string[][] = [];

  const deps = (extra: Partial<FirmwareDeps> = {}): FirmwareDeps => ({
    cliPath: "arduino-cli",
    pathEnv: "",
    fileExists: () => false,
    now: () => new Date(2026, 10, 26, 21, 0, 0),
    run: async (command, args) => {
      if (command === "arduino-cli" && args[0] === "board" && args[1] === "list") return ok(boardList);
      if (command === "arduino-cli" && args[1] === "details") {
        return args[3]?.startsWith("arduino:avr") ? ok(NANO_OLD_PROPS) : failed("platform not installed");
      }
      if (command === avrdude) {
        const read = args.find((a) => a.startsWith("-Uflash:r:"));
        if (read) {
          fs.writeFileSync(read.slice("-Uflash:r:".length, -2), hexOf(flashBytes));
          return ok("", "avrdude: Device signature = 1E 95 0F (ATmega328P)\nAvrdude done.  Thank you.");
        }
        writes.push(args);
        return ok("", "Writing | ### | 100%\nReading | ### | 100%\n8 bytes of flash verified\nAvrdude done.  Thank you.");
      }
      if (command === "python3" && args.includes("version")) return ok("esptool.py v4.7.0\n4.7.0");
      if (command === "python3" && args.includes("flash_id")) {
        return ok("Chip is ESP8266EX\nMAC: 5c:cf:7f:aa:bb:cc\nManufacturer: 20\nDevice: 4016\nDetected flash size: 1MB\n");
      }
      if (command === "python3" && args.includes("read_mac")) return ok("Chip is ESP8266EX\nMAC: 5c:cf:7f:aa:bb:cc\n");
      if (command === "python3" && args.includes("write_flash")) {
        writes.push(args);
        return ok("Wrote 1048576 bytes at 0x00000000 in 90.0 seconds\nHash of data verified.\nHard resetting via RTS pin...");
      }
      if (command === "python3" && args.includes("read_flash")) {
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(Number(args[args.length - 2]), 0xab));
        return ok("Read 1048576 bytes at 0x00000000");
      }
      return failed(`unexpected command ${command} ${args.join(" ")}`);
    },
    ...extra
  });

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "firmware-test-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("AVR backup saves HEX + sidecar and a .gitignore", async () => {
    const result = await backupFirmware(deps(), { fqbn: "arduino:avr:nano:cpu=atmega328old", port, backupDir: dir, label: "nano v3.5" });
    assert.equal(result.ok, true, result.error);
    assert.equal(path.basename(result.imagePath!), "nano-v3-5-20261126-210000.hex");
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "*\n");
    const sidecar = JSON.parse(fs.readFileSync(result.sidecarPath!, "utf8")) as FirmwareSidecar;
    assert.equal(sidecar.deviceSignature, "1E 95 0F");
    assert.equal(sidecar.mcu, "atmega328p");
    assert.equal(sidecar.usb?.vid, "0x1A86");
    assert.equal(sidecar.tool.version, "8.0.0-arduino1");
    assert.match(sidecar.image.sha256, /^[0-9a-f]{64}$/);
  });

  test("an all-0xFF read is reported as unreadable and not saved", async () => {
    flashBytes = Array(32).fill(0xff);
    const sub = path.join(dir, "blank");
    const result = await backupFirmware(deps(), { fqbn: "arduino:avr:nano:cpu=atmega328old", port, backupDir: sub });
    assert.equal(result.errorCode, "FLASH_UNREADABLE");
    assert.match(result.error!, /lock bits/);
    assert.deepEqual(fs.readdirSync(sub).filter((f) => f !== ".gitignore"), []);
    flashBytes = [0x0c, 0x94, 0x5c, 0x00, 0x0c, 0x94, 0x6e, 0x00];
  });

  test("a port that is not connected is refused before anything runs", async () => {
    const result = await backupFirmware(deps(), { fqbn: "arduino:avr:nano:cpu=atmega328old", port: "/dev/cu.nothing", backupDir: dir });
    assert.equal(result.errorCode, "PORT_NOT_FOUND");
  });

  test("AVR restore writes with verify on; a changed image or other MCU is refused", async () => {
    const sidecarPath = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f))[0];
    writes = [];
    const result = await restoreFirmware(deps(), { sidecarPath, fqbn: "arduino:avr:nano:cpu=atmega328old", port });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.verified, true);
    assert.equal(writes.length, 1);

    const mega = await restoreFirmware(
      deps({
        run: async (command, args) =>
          command === "arduino-cli" && args[1] === "details"
            ? ok(NANO_OLD_PROPS.replace("atmega328p", "atmega2560"))
            : deps().run(command, args, 0)
      }),
      { sidecarPath, fqbn: "arduino:avr:mega", port }
    );
    assert.equal(mega.errorCode, "BACKUP_MISMATCH");

    const image = path.join(dir, (JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as FirmwareSidecar).image.file);
    fs.appendFileSync(image, "\n");
    const changed = await restoreFirmware(deps(), { sidecarPath, fqbn: "arduino:avr:nano:cpu=atmega328old", port });
    assert.equal(changed.errorCode, "IMAGE_CHANGED");
  });

  test("ESP backup: flash id first, whole flash, MAC in the sidecar, python esptool reported", async () => {
    const espDir = path.join(dir, "esp");
    const result = await backupFirmware(deps(), { fqbn: "esp8266:esp8266:nodemcuv2", port, backupDir: espDir, label: "nodemcu" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sidecar?.mac, "5c:cf:7f:aa:bb:cc");
    assert.equal(result.sidecar?.flashSizeBytes, 1024 * 1024);
    assert.equal(result.sidecar?.image.bytes, 1024 * 1024);
    assert.equal(result.sidecar?.tool.source, "python3 -m esptool");
    assert.equal(result.sidecar?.tool.version, "4.7.0");
    assert.deepEqual(result.steps.map((s) => s.step), ["esptool flash id", "esptool read flash"]);
    const readArgs = result.steps[1].args;
    assert.deepEqual(readArgs.slice(-4, -1), ["read_flash", "0", String(1024 * 1024)]);
    assert.deepEqual(readArgs.slice(-6, -4), ["--baud", "115200"], "ESP reads default to 115200");
    assert.equal(result.sidecar?.readBaud, 115200);
  });

  test("ESP backup refuses when the chip is not what the FQBN says", async () => {
    const result = await backupFirmware(deps(), { fqbn: "esp32:esp32:esp32", port, backupDir: path.join(dir, "esp32") });
    assert.equal(result.errorCode, "CHIP_MISMATCH");
  });

  test("ESP restore: flash id check, write at 115200 by default, hash verified", async () => {
    const espDir = path.join(dir, "esp");
    const sidecarPath = fs.readdirSync(espDir).filter((f) => f.endsWith(".json")).map((f) => path.join(espDir, f))[0];
    writes = [];
    const result = await restoreFirmware(deps(), { sidecarPath, fqbn: "esp8266:esp8266:nodemcuv2", port });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.verified, true);
    assert.deepEqual(result.steps.map((s) => s.step), ["esptool flash id", "esptool write flash"]);
    assert.equal(writes.length, 1);
    const args = writes[0];
    assert.deepEqual(args.slice(args.indexOf("--baud"), args.indexOf("--baud") + 2), ["--baud", "115200"]);
    assert.deepEqual(args.slice(-3, -1), ["write_flash", "0"]);
  });
});

/** Bytes of the data records of an Intel HEX file, by address. */
function hexBytes(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(":")) continue;
    const bytes = Buffer.from(line.slice(1), "hex");
    if (bytes[3] !== 0) continue;
    const addr = (bytes[1] << 8) | bytes[2];
    for (let i = 0; i < bytes[0]; i++) out.set(addr + i, bytes[4 + i]);
  }
  return out;
}

describe("upload gate: the flash content must be restorable", () => {
  const espPort = "/dev/cu.usbserial-240";
  const avrPort = "/dev/cu.usbserial-230";
  const avrdude = "/A15/packages/arduino/tools/avrdude/8.0.0-arduino1/bin/avrdude";
  const boardList = JSON.stringify({
    detected_ports: [
      { port: { address: espPort, properties: { vid: "0x1A86", pid: "0x7523", serialNumber: "" } } },
      { port: { address: avrPort, properties: { vid: "0x1A86", pid: "0x7523", serialNumber: "" } } }
    ]
  });
  const ESP_FQBN = "esp8266:esp8266:nodemcuv2";
  const AVR_FQBN = "arduino:avr:nano:cpu=atmega328old";
  const FLASH = 1024 * 1024;

  let dir: string; // backup dir
  let work: string; // images
  let espFlash: Buffer;
  let avrFlash: number[];
  let verifyMode: "compare" | "error";
  let readFails: boolean;
  let log: string[]; // tool calls that matter

  const deps = (): FirmwareDeps => ({
    cliPath: "arduino-cli",
    pathEnv: "",
    fileExists: () => false,
    now: () => new Date(2026, 10, 27, 10, 0, log.length),
    run: async (command, args) => {
      if (command === "arduino-cli" && args[0] === "board" && args[1] === "list") return ok(boardList);
      if (command === "arduino-cli" && args[1] === "details") {
        return args[3]?.startsWith("arduino:avr") ? ok(NANO_OLD_PROPS) : failed("platform not installed");
      }
      if (command === avrdude) {
        const read = args.find((a) => a.startsWith("-Uflash:r:"));
        if (read) {
          log.push("avr read");
          fs.writeFileSync(read.slice("-Uflash:r:".length, -2), hexOf(avrFlash));
          return ok("", "avrdude: Device signature = 1E 95 0F (ATmega328P)\nAvrdude done.  Thank you.");
        }
        const verify = args.find((a) => a.startsWith("-Uflash:v:"));
        if (verify) {
          log.push("avr verify");
          if (verifyMode === "error") return failed("avrdude: stk500_getsync(): not in sync");
          const wanted = hexBytes(fs.readFileSync(verify.slice("-Uflash:v:".length, -2), "utf8"));
          for (const [addr, value] of wanted) {
            if (avrFlash[addr] !== value) return failed(`avrdude: verification mismatch\n\tdevice 0x${(avrFlash[addr] ?? 0xff).toString(16)} != file 0x${value.toString(16)}`);
          }
          return ok("", `${wanted.size} bytes of flash verified\nAvrdude done.  Thank you.`);
        }
      }
      if (command === "python3" && args.includes("version")) return ok("esptool.py v4.7.0\n4.7.0");
      if (command === "python3" && args.includes("flash_id")) {
        return ok("Chip is ESP8266EX\nMAC: 84:cc:a8:b0:07:90\nManufacturer: 20\nDevice: 4016\nDetected flash size: 1MB\n");
      }
      if (command === "python3" && args.includes("read_mac")) return ok("Chip is ESP8266EX\nMAC: 84:cc:a8:b0:07:90\n");
      if (command === "python3" && args.includes("verify_flash")) {
        log.push("esp verify");
        if (verifyMode === "error") return failed("A fatal error occurred: Failed to connect to ESP8266");
        const file = fs.readFileSync(args[args.length - 1]);
        return file.equals(espFlash.subarray(0, file.length))
          ? ok("-- verify OK (digest matched)")
          : { ...failed("-- verify FAILED (digest mismatch)"), code: 2 };
      }
      if (command === "python3" && args.includes("read_flash")) {
        log.push("esp read");
        if (readFails) return failed("A fatal error occurred: Invalid head of packet (0x0D)");
        fs.writeFileSync(args[args.length - 1], espFlash);
        return ok("Read 1048576 bytes at 0x00000000");
      }
      return failed(`unexpected command ${command} ${args.join(" ")}`);
    }
  });

  const espImage = (bytes: number, fill: number): UploadImage => {
    const file = path.join(work, `esp-${bytes}-${fill}.bin`);
    fs.writeFileSync(file, Buffer.alloc(bytes, fill));
    return { path: file, format: "bin" };
  };
  const avrImage = (data: number[]): UploadImage => {
    const file = path.join(work, `avr-${data.length}-${data[0]}.hex`);
    fs.writeFileSync(file, hexOf(data));
    return { path: file, format: "ihex" };
  };
  const espBoard: BoardIdentity = { family: "esp8266", fqbn: ESP_FQBN, port: espPort, usb: null, mac: "84:cc:a8:b0:07:90" };
  const avrBoard: BoardIdentity = { family: "avr", fqbn: AVR_FQBN, port: avrPort, usb: { vid: "0x1A86", pid: "0x7523", serialNumber: null } };
  const espGate = (image: UploadImage, extra: { autoBackup?: boolean } = {}) =>
    checkBackupGate(deps(), { fqbn: ESP_FQBN, port: espPort, backupDir: dir, image, ...extra });
  const avrGate = (image: UploadImage) => checkBackupGate(deps(), { fqbn: AVR_FQBN, port: avrPort, backupDir: dir, image });
  const makeBackup = async (fqbn: string, port: string) => {
    const made = await backupFirmware(deps(), { fqbn, port, backupDir: dir, label: "old" });
    assert.equal(made.ok, true, made.error);
    log = [];
    return made;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-backups-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "gate-images-"));
    espFlash = Buffer.alloc(FLASH, 0xff);
    avrFlash = [...Array(256).fill(0xff)];
    verifyMode = "compare";
    readFails = false;
    log = [];
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  test("the region is the new image rounded up to whole sectors", () => {
    assert.equal(espRegionBytes(1), 4096);
    assert.equal(espRegionBytes(4096), 4096);
    assert.equal(espRegionBytes(5000), 8192);
  });

  test("ESP: the flash holds the newest backup -> upload allowed, comparison backup", async () => {
    espFlash.fill(0x11, 0, 6000);
    await makeBackup(ESP_FQBN, espPort);
    const result = await espGate(espImage(5000, 0x22));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.comparison, "backup");
    assert.deepEqual(result.region, { offset: 0, bytes: 8192 });
    assert.deepEqual(log, ["esp verify"], "no new read of the whole flash");
    assert.ok(result.matched?.sidecarPath.endsWith(".json"));
  });

  test("ESP: a change outside the program region is not a mismatch", async () => {
    espFlash.fill(0x11, 0, 6000);
    await makeBackup(ESP_FQBN, espPort);
    espFlash.fill(0x77, 8192, 20000); // Wi-Fi settings / file system / EEPROM emulation changed while the program ran
    const result = await espGate(espImage(5000, 0x22));
    assert.equal(result.comparison, "backup");
  });

  test("ESP: the flash holds the last upload -> comparison last-upload, no backup read", async () => {
    espFlash.fill(0x11, 0, 6000);
    await makeBackup(ESP_FQBN, espPort); // old backup: does not match any more
    const uploaded = espImage(5000, 0x33);
    writeUploadRecord(deps(), { backupDir: dir, board: espBoard, image: uploaded, sketchPath: "/s", bootMarker: "BOOT x v4" });
    espFlash.fill(0xff, 0, 8192);
    fs.readFileSync(uploaded.path).copy(espFlash, 0); // what the upload wrote; the rest of its last sector is erased
    espFlash.fill(0x55, 100000, 120000); // other areas changed
    const result = await espGate(espImage(4000, 0x44));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.comparison, "last-upload");
    assert.equal(result.lastUpload?.bootMarker, "BOOT x v4");
    assert.deepEqual(log, ["esp verify"]);
  });

  test("ESP: an upload record that does not cover the new region is not enough", async () => {
    espFlash.fill(0x11, 0, 6000);
    await makeBackup(ESP_FQBN, espPort);
    const uploaded = espImage(3000, 0x33); // 1 sector
    writeUploadRecord(deps(), { backupDir: dir, board: espBoard, image: uploaded });
    espFlash.fill(0xff, 0, 8192);
    fs.readFileSync(uploaded.path).copy(espFlash, 0);
    espFlash.fill(0x99, 4096, 5000); // something else lives in the second sector
    const result = await espGate(espImage(5000, 0x44)); // needs 2 sectors
    assert.equal(result.comparison, "new-backup");
  });

  test("ESP: the flash matches neither -> new backup, then upload allowed (new-backup)", async () => {
    espFlash.fill(0x11, 0, 6000);
    await makeBackup(ESP_FQBN, espPort);
    espFlash.fill(0x88, 0, 6000); // somebody flashed a program with the Arduino IDE
    const before = fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).length;
    const result = await espGate(espImage(5000, 0x22));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.comparison, "new-backup");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).length, before + 1);
    assert.equal(result.newBackup?.bytes, FLASH);
    assert.match(result.newBackup!.sha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(result.newBackup!.imagePath)[0], 0x88, "the new backup holds the program that was on the board");
    assert.ok(log.includes("esp read"));
  });

  test("ESP: no backup and no record at all -> new backup too", async () => {
    const result = await espGate(espImage(5000, 0x22));
    assert.equal(result.comparison, "new-backup");
  });

  test("ESP: the flash matches neither and the backup fails -> BACKUP_REQUIRED, no upload", async () => {
    espFlash.fill(0x11, 0, 6000);
    await makeBackup(ESP_FQBN, espPort);
    espFlash.fill(0x88, 0, 6000);
    readFails = true;
    const result = await espGate(espImage(5000, 0x22));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "BACKUP_REQUIRED");
    assert.match(result.error!, /automatic backup failed/);
    assert.match(result.error!, /Nothing was uploaded/);
  });

  test("ESP: automatic backup off -> BACKUP_REQUIRED when the flash matches neither", async () => {
    const result = await espGate(espImage(5000, 0x22), { autoBackup: false });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "BACKUP_REQUIRED");
    assert.deepEqual(log, []);
  });

  test("ESP: the verify command fails -> no upload, no backup attempt (fail safe)", async () => {
    espFlash.fill(0x11, 0, 6000);
    await makeBackup(ESP_FQBN, espPort);
    verifyMode = "error";
    const result = await espGate(espImage(5000, 0x22));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "FLASH_CHECK_FAILED");
    assert.match(result.error!, /Nothing was uploaded/);
    assert.ok(!log.includes("esp read"));
  });

  test("ESP: a damaged backup image is not trusted", async () => {
    espFlash.fill(0x11, 0, 6000);
    const made = await makeBackup(ESP_FQBN, espPort);
    fs.appendFileSync(made.imagePath!, "x"); // sha256 no longer matches its sidecar
    const result = await espGate(espImage(5000, 0x22));
    assert.equal(result.comparison, "new-backup");
  });

  test("an upload record of another board is ignored", () => {
    writeUploadRecord(deps(), { backupDir: dir, board: { ...espBoard, mac: "5c:cf:7f:00:00:01" }, image: espImage(100, 1) });
    assert.equal(findLastUpload(dir, espBoard), null);
    writeUploadRecord(deps(), { backupDir: dir, board: espBoard, image: espImage(100, 2) });
    assert.ok(findLastUpload(dir, espBoard));
  });

  test("upload record: image copy, sha256, board identity, and uploads/ stays out of git", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "something\n");
    const image = espImage(100, 7);
    const written = writeUploadRecord(deps(), { backupDir: dir, board: espBoard, image, sketchPath: "/s/probe", bootMarker: "BOOT probe v4" });
    assert.ok(written.recordPath.startsWith(path.join(dir, "uploads")));
    const copy = path.join(dir, "uploads", written.record.image.file);
    assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(image.path)));
    assert.equal(written.record.image.sha256, crypto.createHash("sha256").update(fs.readFileSync(copy)).digest("hex"));
    assert.equal(written.record.mac, "84:cc:a8:b0:07:90");
    assert.equal(written.record.fqbn, ESP_FQBN);
    assert.equal(written.record.bootMarker, "BOOT probe v4");
    assert.match(written.record.createdAt, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^uploads\/$/m);
  });

  test("AVR: the flash holds the newest backup (weak match noted)", async () => {
    avrFlash = [...Array(64).fill(0x11), ...Array(192).fill(0xff)];
    await makeBackup(AVR_FQBN, avrPort);
    const result = await avrGate(avrImage(Array(32).fill(0x22)));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.comparison, "backup");
    assert.equal(result.matched?.strength, "fqbn+port+usb");
    assert.equal(result.note, AVR_WEAK_MATCH_NOTE);
    assert.deepEqual(log, ["avr verify"]);
  });

  test("AVR: the flash holds the last upload", async () => {
    avrFlash = [...Array(64).fill(0x11), ...Array(192).fill(0xff)];
    await makeBackup(AVR_FQBN, avrPort);
    const uploaded = avrImage(Array(64).fill(0x33));
    writeUploadRecord(deps(), { backupDir: dir, board: avrBoard, image: uploaded });
    avrFlash = [...Array(64).fill(0x33), ...Array(192).fill(0xff)];
    const result = await avrGate(avrImage(Array(48).fill(0x44)));
    assert.equal(result.comparison, "last-upload");
    // a longer new image is not covered by the record (it would overwrite unrecorded flash)
    const longer = await avrGate(avrImage(Array(96).fill(0x55)));
    assert.equal(longer.comparison, "new-backup");
  });

  test("AVR: the flash matches neither -> new backup; the verify command fails -> no upload", async () => {
    avrFlash = [...Array(64).fill(0x11), ...Array(192).fill(0xff)];
    await makeBackup(AVR_FQBN, avrPort);
    avrFlash = [...Array(64).fill(0x99), ...Array(192).fill(0xff)];
    const neither = await avrGate(avrImage(Array(32).fill(0x22)));
    assert.equal(neither.comparison, "new-backup");
    avrFlash = [...Array(64).fill(0x11), ...Array(192).fill(0xff)];
    verifyMode = "error";
    const broken = await avrGate(avrImage(Array(32).fill(0x22)));
    assert.equal(broken.ok, false);
    assert.equal(broken.errorCode, "FLASH_CHECK_FAILED");
  });
});
