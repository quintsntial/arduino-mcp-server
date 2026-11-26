import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PortOperationCoordinator } from "./portCoordinator.js";
import { SerialSessionManager } from "./serialSessions.js";

// A stand-in for `arduino-cli monitor`: ignores its arguments and behaves per FAKE_MONITOR_MODE.
//   stream: prints a numbered line every 100 ms until killed
//   exit:   prints a boot line, then after 0.8 s reports a device error and exits (board unplugged)
const FAKE_MONITOR = `#!/bin/sh
if [ "$FAKE_MONITOR_MODE" = "exit" ]; then
  echo "BOOT fake v1"
  sleep 0.8
  echo "Port monitor error: device not configured" 1>&2
  exit 1
fi
i=0
while true; do
  echo "line $i"
  i=$((i+1))
  sleep 0.1
done
`;

const MISSING_PORT = "/dev/cu.arduino-mcp-test-missing-port";

describe("SerialSessionManager", () => {
  let dir: string;
  let cliPath: string;
  let manager: SerialSessionManager;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial-sessions-test-"));
    cliPath = path.join(dir, "fake-arduino-cli");
    fs.writeFileSync(cliPath, FAKE_MONITOR, { mode: 0o755 });
    manager = new SerialSessionManager(new PortOperationCoordinator());
  });

  after(() => {
    manager.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function open(port: string, mode: "stream" | "exit", ttlMs = 60_000) {
    process.env.FAKE_MONITOR_MODE = mode;
    const result = await manager.openSession({ cliPath, port, baudRate: 115200, ttlMs, maxBufferBytes: 65_536 });
    assert.equal(result.ok, true, result.error);
    return result.session!.sessionId;
  }

  test("serial_record collects lines for the whole duration and keeps a short lease alive", async () => {
    // Lease of 5 s, recording of 6 s: without the record loop renewing the lease, the 5 s sweep would kill it.
    const id = await open("/dev/null", "stream", 5_000);
    const result = await manager.recordSession(id, 6_000, null);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.endedEarly, false);
    assert.ok(result.durationMs! >= 6_000);
    const lines = result.text!.split("\n").filter((line) => line.startsWith("line "));
    assert.ok(lines.length >= 30, `expected ~60 lines, got ${lines.length}`);
    assert.equal(manager.getSessionSummary(id)?.state, "READY");
    manager.closeSession(id);
  });

  test("a disconnect ends the recording early and says the port is gone; buffered data stays readable", async () => {
    const id = await open(MISSING_PORT, "exit");
    const result = await manager.recordSession(id, 5_000, null);
    assert.equal(result.ok, false);
    assert.equal(result.endedEarly, true);
    assert.ok(result.durationMs! < 4_000);
    assert.equal(result.errorCode, "SESSION_DISCONNECTED");
    assert.match(result.error!, /no longer present/);
    assert.match(result.error!, /device not configured/);

    // Everything that arrived before the disconnect can still be read.
    const read = manager.readSession(id, null, 4096, "utf8");
    assert.equal(read.ok, true);
    assert.match(read.data!, /BOOT fake v1/);
    assert.match(read.endedNote!, /ended unexpectedly/);

    const expect = await manager.expectInSession(id, "anything", 1_000, false, null);
    assert.equal(expect.errorCode, "SESSION_DISCONNECTED");
  });

  test("a disconnected session does not block a new session on the same port", async () => {
    const id = await open(MISSING_PORT, "stream");
    assert.equal(manager.getSessionSummary(id)?.state, "READY");
    manager.closeSession(id);
  });

  test("a closed session reports SESSION_CLOSED, and closing it again is a no-op", async () => {
    const id = await open("/dev/null", "stream");
    assert.equal(manager.closeSession(id).ok, true);
    const expect = await manager.expectInSession(id, "line", 1_000, false, null);
    assert.equal(expect.errorCode, "SESSION_CLOSED");
    assert.equal(manager.closeSession(id).ok, true);
  });

  test("an unknown session id is reported as not found", async () => {
    const result = await manager.recordSession("no-such-session", 1_000, null);
    assert.equal(result.errorCode, "SESSION_NOT_FOUND");
  });
});
