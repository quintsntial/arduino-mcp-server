import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { arduinoUserDir, childEnv } from "./arduinoCli.js";

test("ARDUINO_USER_DIR unset, empty or an unfilled template means not set", () => {
  assert.equal(arduinoUserDir({}), undefined);
  assert.equal(arduinoUserDir({ ARDUINO_USER_DIR: "  " }), undefined);
  assert.equal(arduinoUserDir({ ARDUINO_USER_DIR: "${user_config.arduino_user_dir}" }), undefined);
  assert.equal(childEnv({ PATH: "/bin" }).ARDUINO_DIRECTORIES_USER, undefined);
});

test("ARDUINO_USER_DIR is passed on as ARDUINO_DIRECTORIES_USER, with ~ expanded", () => {
  assert.equal(arduinoUserDir({ ARDUINO_USER_DIR: "/tmp/ard" }), "/tmp/ard");
  assert.equal(arduinoUserDir({ ARDUINO_USER_DIR: "~/Workspace/Claude/arduino" }), path.join(os.homedir(), "Workspace/Claude/arduino"));
  const env = childEnv({ PATH: "/bin", ARDUINO_USER_DIR: "/tmp/ard" });
  assert.equal(env.ARDUINO_DIRECTORIES_USER, "/tmp/ard");
  assert.equal(env.PATH, "/bin");
});

test("TMPDIR is always set for child processes (ctags needs it)", () => {
  assert.ok(childEnv({ PATH: "/bin" }).TMPDIR);
  assert.ok(childEnv({ PATH: "/bin", TMPDIR: "" }).TMPDIR);
  assert.equal(childEnv({ PATH: "/bin", TMPDIR: "/x/tmp" }).TMPDIR, "/x/tmp");
});
