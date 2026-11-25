import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findBootMarker, parseDiagnostics, parseMemoryUse, serialLines, tail } from "./output.js";

const AVR_SIZE = `Sketch uses 6678 bytes (21%) of program storage space. Maximum is 30720 bytes.
Global variables use 413 bytes (20%) of dynamic memory, leaving 1635 bytes for local variables. Maximum is 2048 bytes.
`;

describe("parseMemoryUse", () => {
  test("parses AVR flash and RAM use", () => {
    assert.deepEqual(parseMemoryUse(AVR_SIZE), {
      flashBytes: 6678,
      flashPercent: 21,
      flashMaxBytes: 30720,
      ramBytes: 413,
      ramPercent: 20,
      ramMaxBytes: 2048
    });
  });

  test("returns null when there is no size report", () => {
    assert.equal(parseMemoryUse("Error during build: exit status 1"), null);
  });
});

describe("parseDiagnostics", () => {
  const STDERR = `/p/arduino/x/x.ino: In function 'void loop()':
/p/arduino/x/x.ino:116:16: error: 'undefinedVar' was not declared in this scope
   int avgT10 = undefinedVar + (int)(totalTemp * 10 / numReadings);
                ^~~~~~~~~~~~
/p/arduino/x/x.ino:116:16: error: 'undefinedVar' was not declared in this scope
/p/arduino/x/x.ino:20:5: warning: unused variable 'a' [-Wunused-variable]
/p/arduino/x/helper.h:3:10: fatal error: missing.h: No such file or directory
Error during build: exit status 1`;

  test("extracts errors and warnings with file, line and column, without duplicates", () => {
    const diagnostics = parseDiagnostics(STDERR);
    assert.equal(diagnostics.length, 3);
    assert.deepEqual(diagnostics[0], {
      file: "/p/arduino/x/x.ino",
      line: 116,
      column: 16,
      severity: "error",
      message: "'undefinedVar' was not declared in this scope"
    });
    assert.equal(diagnostics[1].severity, "warning");
    assert.equal(diagnostics[2].severity, "error"); // fatal error counts as error
    assert.equal(diagnostics[2].file, "/p/arduino/x/helper.h");
  });
});

describe("serial helpers", () => {
  test("splits lines and replaces non-printable bytes", () => {
    assert.deepEqual(serialLines("T=17.0\r\n\u0000ÿBOOT x v2\r\n\r\nT=16.9"), ["T=17.0", "??BOOT x v2", "T=16.9"]);
  });

  test("finds the last boot marker, even glued to a partial line", () => {
    const text = "T=18.9 H=18.0 relay=1 pwm=10BOOT temp_fan_control v2.2\r\nT=19.0\r\nBOOT temp_fan_control v2.3\r\n";
    assert.equal(findBootMarker(text), "BOOT temp_fan_control v2.3");
    assert.equal(findBootMarker("no marker here"), null);
  });

  test("tail keeps the end of long text", () => {
    assert.equal(tail("short", 10), "short");
    assert.match(tail("x".repeat(20) + "END", 5), /omitted.*\nxxEND$/s);
  });
});
