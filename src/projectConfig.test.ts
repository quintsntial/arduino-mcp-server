import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkBaud,
  checkOutputsGate,
  findBoardEnv,
  loadProjectConfig,
  parseBoardEnv,
  resolveTargets
} from "./projectConfig.js";

const SAMPLE = `# dev_loop.sh settings for this project (KEY=VALUE; environment variables override)
# Board: Arduino Nano clone, ATmega328P, old bootloader, CH340 USB (test rig)
SKETCH_DIR=arduino/temp_fan_control
FQBN=arduino:avr:nano:cpu=atmega328old
PORT="/dev/cu.usbserial-230"   # trailing comment
BAUD=9600
LIBS=DHTlib,Adafruit NeoPixel
CORE=arduino:avr
OUTPUTS=leds
UNKNOWN_KEY=ignored
`;

describe("parseBoardEnv", () => {
  test("reads known keys, strips quotes and comments, ignores unknown keys", () => {
    const { values, boardComment } = parseBoardEnv(SAMPLE);
    assert.equal(values.FQBN, "arduino:avr:nano:cpu=atmega328old");
    assert.equal(values.PORT, "/dev/cu.usbserial-230");
    assert.equal(values.LIBS, "DHTlib,Adafruit NeoPixel");
    assert.equal(values.UNKNOWN_KEY, undefined);
    assert.equal(boardComment, "Arduino Nano clone, ATmega328P, old bootloader, CH340 USB (test rig)");
  });

  test("skips empty values and lines without '='", () => {
    const { values } = parseBoardEnv("PORT=\nnonsense\nBAUD = 115200\n");
    assert.equal(values.PORT, undefined);
    assert.equal(values.BAUD, "115200");
  });
});

describe("project lookup and defaults", () => {
  let root: string;
  let sketchDir: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "board-env-test-"));
    sketchDir = path.join(root, "arduino", "temp_fan_control");
    fs.mkdirSync(sketchDir, { recursive: true });
    fs.mkdirSync(path.join(root, "tools"));
    fs.writeFileSync(path.join(root, "tools", "board.env"), SAMPLE);
    fs.writeFileSync(path.join(sketchDir, "temp_fan_control.ino"), "void setup(){}\nvoid loop(){}\n");
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("finds board.env by walking up from the .ino file", () => {
    assert.equal(findBoardEnv(path.join(sketchDir, "temp_fan_control.ino")), path.join(root, "tools", "board.env"));
  });

  test("loads typed values with SKETCH_DIR resolved against the project root", () => {
    const config = loadProjectConfig({ projectDir: root });
    assert.ok(config);
    assert.equal(config.projectDir, root);
    assert.equal(config.sketchPath, sketchDir);
    assert.equal(config.baud, 9600);
    assert.deepEqual(config.libs, ["DHTlib", "Adafruit NeoPixel"]);
    assert.equal(config.outputs, "leds");
    assert.deepEqual(config.problems, []);
  });

  test("tool arguments win over board.env; board.env fills the rest", () => {
    const resolved = resolveTargets({ projectDir: root, port: "/dev/cu.other" }, ["sketchPath", "fqbn", "port"]);
    assert.equal(resolved.port, "/dev/cu.other");
    assert.equal(resolved.fqbn, "arduino:avr:nano:cpu=atmega328old");
    assert.equal(resolved.sketchPath, sketchDir);
    assert.deepEqual(resolved.missing, []);
  });

  test("reports invalid OUTPUTS and BAUD values", () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-env-bad-"));
    fs.mkdirSync(path.join(badDir, "tools"));
    fs.writeFileSync(path.join(badDir, "tools", "board.env"), "BAUD=fast\nOUTPUTS=relay\n");
    const config = loadProjectConfig({ projectDir: badDir });
    fs.rmSync(badDir, { recursive: true, force: true });
    assert.equal(config?.outputs, undefined);
    assert.equal(config?.baud, undefined);
    assert.equal(config?.problems.length, 2);
  });
});

describe("resolveTargets without a project", () => {
  test("lists the missing required values", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-project-"));
    const saved = process.cwd();
    process.chdir(empty);
    try {
      const resolved = resolveTargets({ sketchPath: path.join(empty, "x") }, ["sketchPath", "fqbn", "port"]);
      assert.equal(resolved.config, null);
      assert.equal(resolved.missing.length, 2);
      assert.match(resolved.missing.join(" "), /fqbn/);
      assert.match(resolved.missing.join(" "), /port/);
    } finally {
      process.chdir(saved);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("checkOutputsGate", () => {
  test("refuses when it is unknown what the outputs drive", () => {
    assert.equal(checkOutputsGate(undefined, false).errorCode, "OUTPUTS_UNKNOWN");
  });

  test("allows LED and low-voltage boards", () => {
    assert.equal(checkOutputsGate("leds", false).ok, true);
    assert.equal(checkOutputsGate("low-voltage", false).ok, true);
  });

  test("requires per-upload confirmation for mains", () => {
    assert.equal(checkOutputsGate("mains", false).errorCode, "MAINS_CONFIRMATION_REQUIRED");
    assert.equal(checkOutputsGate("mains", true).ok, true);
  });
});

describe("checkBaud", () => {
  test("refuses 1200 baud, allows normal rates", () => {
    assert.equal(checkBaud(1200).errorCode, "BAUD_1200_REFUSED");
    assert.equal(checkBaud(9600).ok, true);
  });
});
