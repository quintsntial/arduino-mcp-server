import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  bootsBeforeMonitorOpens,
  classifyReadyFailure,
  parseResetCaptureOutput,
  resetCaptureArgs,
  shouldResetAfterUpload
} from "./resetCapture.js";

const ESP = "esp8266:esp8266:nodemcuv2";
const NANO = "arduino:avr:nano:cpu=atmega328old";

describe("shouldResetAfterUpload", () => {
  test("auto: ESP8266 uses reset-after-open, the Nano keeps the plain monitor", () => {
    assert.equal(shouldResetAfterUpload("auto", ESP), true);
    assert.equal(shouldResetAfterUpload("auto", NANO), false);
    assert.equal(shouldResetAfterUpload("auto", undefined), false);
  });
  test("explicit modes override the board", () => {
    assert.equal(shouldResetAfterUpload("dtr-rts", NANO), true);
    assert.equal(shouldResetAfterUpload("none", ESP), false);
  });
});

describe("bootsBeforeMonitorOpens", () => {
  test("esp8266 and esp32 reboot on their own after upload; AVR does not", () => {
    assert.equal(bootsBeforeMonitorOpens(ESP), true);
    assert.equal(bootsBeforeMonitorOpens("esp32:esp32:esp32"), true);
    assert.equal(bootsBeforeMonitorOpens(NANO), false);
  });
});

describe("classifyReadyFailure", () => {
  test("matched is not a failure", () => {
    assert.equal(classifyReadyFailure({ matched: true, resetRequested: true, resetDone: true, fqbn: ESP }), null);
  });
  test("ESP without reset: booted before the monitor opened (not an upload failure)", () => {
    const f = classifyReadyFailure({ matched: false, resetRequested: false, resetDone: false, fqbn: ESP });
    assert.equal(f?.errorCode, "READY_BOOTED_BEFORE_MONITOR");
    assert.match(f!.message, /booted before the monitor opened/);
  });
  test("reset requested but the pulse failed", () => {
    const f = classifyReadyFailure({ matched: false, resetRequested: true, resetDone: false, fqbn: ESP });
    assert.equal(f?.errorCode, "READY_RESET_FAILED");
  });
  test("reset done but no marker, and the Nano without a marker: plain timeout", () => {
    assert.equal(classifyReadyFailure({ matched: false, resetRequested: true, resetDone: true, fqbn: ESP })?.errorCode, "READY_PATTERN_TIMEOUT");
    assert.equal(classifyReadyFailure({ matched: false, resetRequested: false, resetDone: false, fqbn: NANO })?.errorCode, "READY_PATTERN_TIMEOUT");
  });
});

describe("parseResetCaptureOutput", () => {
  test("ok output becomes a capture", () => {
    const out = parseResetCaptureOutput(
      JSON.stringify({ ok: true, matched: true, text: "boot\nBOOT x v1\n", durationMs: 812, resetDone: true, resetError: null }) + "\n",
      "",
      0
    );
    assert.equal(out.kind, "ok");
    if (out.kind === "ok") {
      assert.equal(out.capture.matched, true);
      assert.equal(out.capture.text, "boot\nBOOT x v1\n");
      assert.equal(out.resetDone, true);
    }
  });
  test("a missing pyserial is unavailable with the reason", () => {
    const out = parseResetCaptureOutput(JSON.stringify({ ok: false, stage: "import", error: "pyserial not available: x" }), "", 3);
    assert.deepEqual(out, { kind: "unavailable", reason: "pyserial not available: x" });
  });
  test("garbage output uses stderr, else the exit code", () => {
    assert.deepEqual(parseResetCaptureOutput("", "Traceback\nboom", 1), { kind: "unavailable", reason: "boom" });
    assert.deepEqual(parseResetCaptureOutput("", "", 1), { kind: "unavailable", reason: "helper exited with code 1" });
    assert.deepEqual(parseResetCaptureOutput("", "", null), { kind: "unavailable", reason: "helper did not start or timed out" });
  });
});

describe("resetCaptureArgs", () => {
  test("passes port, baud, timeout, pattern and flags as separate arguments (no shell)", () => {
    const args = resetCaptureArgs("/dev/cu.x", 115200, { timeoutMs: 20000, pattern: "BOOT a; b", caseSensitive: true, reset: true });
    assert.equal(args[0], "-c");
    assert.deepEqual(args.slice(2), ["/dev/cu.x", "115200", "20000", "BOOT a; b", "1", "1"]);
  });
});

describe("captureWithReset without hardware", () => {
  test("a port that does not exist is reported as unavailable, not as a match", async () => {
    const { captureWithReset } = await import("./resetCapture.js");
    const out = await captureWithReset("python3", "/dev/cu.does-not-exist", 115200, { timeoutMs: 1000, pattern: "X" });
    assert.equal(out.kind, "unavailable");
    if (out.kind === "unavailable") {
      assert.match(out.reason, /cannot open|pyserial/);
    }
  });
  test("a missing python is reported as unavailable", async () => {
    const { captureWithReset } = await import("./resetCapture.js");
    const out = await captureWithReset("/nonexistent/python", "/dev/x", 115200, { timeoutMs: 500 });
    assert.equal(out.kind, "unavailable");
  });
});
