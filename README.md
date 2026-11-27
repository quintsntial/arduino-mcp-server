# arduino-mcp-server

[![npm version](https://img.shields.io/npm/v/arduino-mcp-server)](https://www.npmjs.com/package/arduino-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Give your AI assistant full control over Arduino — compile, upload, monitor serial, and verify wiring safety, all through natural language.**

Part of the [HardwareMCP](https://github.com/hardware-mcp) ecosystem — open-source MCP servers that bridge AI to physical hardware.

---

## What this does

AI assistants can control Jira, GitHub, and databases. They can't talk to a microcontroller — until now.

`arduino-mcp-server` wraps `arduino-cli` into an MCP server so your AI can:

- **Detect** connected boards and ports automatically
- **Compile and upload** sketches without touching the terminal
- **Monitor serial output** with stateful sessions (open, read, expect, write, close)
- **Run electrical safety checks** before sending commands to hardware
- **Manage dependencies** — cores, libraries, and CLI installation

---

## Quick Start

**Install:**
```bash
npm install -g arduino-mcp-server
```

**Add to Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "arduino": {
      "command": "npx",
      "args": ["-y", "arduino-mcp-server"],
      "env": {
        "ARDUINO_CLI_PATH": "arduino-cli",
        "ARDUINO_SKETCH_ROOT": "/path/to/your/sketches"
      }
    }
  }
}
```

Requires [arduino-cli](https://arduino.github.io/arduino-cli/) on your PATH, or let the server install it for you.

---

## What you can say

**Bootstrap from scratch:**
> "Check if Arduino CLI is installed and set everything up for an Arduino Uno."

**Compile and upload:**
> "Compile my Blink sketch and upload it to the Uno on COM6."

**Serial monitoring:**
> "Open serial on COM6 at 115200 and wait until the device prints READY."

**Safety-first workflows:**
> "Run a safety preflight for an Arduino Uno with 5V on pin 13 at 25mA before I send commands."

---

## Tools

| Tool | What it does |
|------|-------------|
| `arduino_cli_doctor` | Check Arduino CLI installation and version |
| `install_arduino_cli` | Guide through arduino-cli installation |
| `detect_hardware` | Detect connected boards and infer FQBNs |
| `list_connected_boards` | List all connected Arduino boards |
| `list_serial_ports` | List available serial ports |
| `ensure_core_installed` | Check/install board cores; `projectDir`/`boardUrls` pass package index URLs (default `BOARD_URLS` from `tools/board.env`) as `--additional-urls` |
| `compile_sketch` | Compile a sketch for a target board |
| `upload_sketch` | Compile the current source and upload it to a board |
| `upload_and_wait_ready` | Compile, upload and wait for device ready signal (`resetAfterUpload`: see below) |
| `backup_firmware` | Read a board's whole flash (AVR: avrdude, Intel HEX; ESP8266/ESP32: esptool, .bin) plus a JSON sidecar |
| `restore_firmware` | Write a backup back (same gates as upload; refuses another board family, MCU or flash size; verifies) |
| `serial_open_session` | Open a stateful serial session |
| `serial_read` | Read buffered serial data (also after the session ended) |
| `serial_expect` | Wait for a pattern in serial output |
| `serial_record` | Record a session for up to 10 minutes, optionally saving every line to a file |
| `serial_write` | Send data over serial |
| `serial_close_session` | Close a serial session |
| `serial_list_sessions` | List active serial sessions |
| `read_serial_snapshot` | Quick one-shot serial read |
| `safety_preflight` | Electrical safety check before hardware ops |
| `get_board_details` | Get pin/capability details for a board |
| `list_supported_boards` | List all boards arduino-cli supports |
| `list_board_reference` | Browse board pin reference |
| `search_board_reference` | Search board reference by keyword |

### Third-party cores and boot markers

`ensure_core_installed` (and the automatic core install in `compile_sketch`, `upload_sketch` and `upload_and_wait_ready`)
passes the package index URLs as `--additional-urls` to `core update-index`, `core list` and `core install`. The URLs come
from the `boardUrls` argument, else from `BOARD_URLS` in the project's `tools/board.env`; the result shows which ones were
used (`boardUrls`, `boardUrlsSource`).

ESP8266 boards reboot right after an upload and boot before `arduino-cli monitor` is open, so a marker printed once in
`setup()` would be missed. `upload_and_wait_ready` therefore (`resetAfterUpload`, default `auto`) opens the serial port
first and then resets the board through DTR/RTS (the esptool sequence), and reads that boot. This needs `python3` with
`pyserial` (installed with esptool; set `ARDUINO_PYTHON_PATH` for another interpreter). AVR boards such as the Nano reset
when the port opens and keep the plain monitor. `dtr-rts` forces the reset, `none` forces the plain monitor. If the
marker is not seen, `errorCode` says why: `READY_BOOTED_BEFORE_MONITOR` (ESP board, no reset available),
`READY_RESET_FAILED` (reset pulse failed) or `READY_PATTERN_TIMEOUT`; none of these is an upload failure
(`UPLOAD_FAILED`).

### Firmware backups

`backup_firmware` saves the flash to `BACKUP_DIR` from `tools/board.env` (default `<project>/backups/`, or pass
`backupDir`) and writes a `.gitignore` (`*`) there: ESP images usually contain the saved Wi-Fi name and password in
plain text. The sidecar records FQBN, port, USB VID/PID, chip/flash id (MAC for ESP), flash size, sha256, the tool and
its version. With `BACKUP_BEFORE_UPLOAD=1` in `tools/board.env`, `upload_sketch` and `upload_and_wait_ready` compile
first and then check that the part of the flash the upload overwrites (the "region") can be restored. It can if the
region equals (1) the image of the last upload this server made to the board (`<BACKUP_DIR>/uploads/`) or (2) the
newest backup of the board (ESP: matched by MAC; AVR: by FQBN + port + USB VID/PID, which any board of the same type on
that port also passes). ESP: region = the new image rounded up to 4096-byte sectors from offset 0, compared with
`esptool verify_flash` (on-chip MD5; Wi-Fi settings, file system and EEPROM emulation are not compared). AVR: region =
the address range of the new image, compared with `avrdude` verify. If neither matches, the server makes a new backup
and then uploads (a full ESP read takes several minutes); if the backup or a comparison fails, nothing is uploaded
(`BACKUP_REQUIRED`, `FLASH_CHECK_FAILED`). The upload result reports `backup.comparison` = `last-upload`, `backup` or
`new-backup`. After each gated upload the image and a record (board, sketch, FQBN, boot marker, sha256, UTC time) are
saved in `uploads/`. `backupOverrideApproved=true` skips all of this, after the user approved it. Erasing flash, fuses/eFuses and bootloaders are out of scope.

**Resources:**
- `arduino://boards/reference` — structured board pin/capability reference

**Prompts:**
- `arduino-cli-bootstrap-policy` — policy for arduino-cli setup behavior
- `arduino-setup-assistant` — guided Arduino environment setup

---

## Safety preflight guardrails

`safety_preflight` (and the `safetyContext` passed to `upload_sketch`, `upload_and_wait_ready`, and `serial_write`) now also covers battery and ESP32-family pin footguns, driven by small, extensible data tables rather than hardcoded to any one board:

**Battery charge-rate (C-rate) check** — pass a `battery` object (`capacityMah`, `chargeCurrentMa`, `chemistry`) and the check computes `chargeCurrentMa / batteryCapacityMah` and flags it:
- **`BATTERY_CRATE_UNSAFE`** (hard, blocking) above 1C
- **`BATTERY_CRATE_CAUTION`** (soft, non-blocking) above 0.5C

Generic small LiPo cells are commonly rated for roughly a 0.5–1C safe charge current, so the message spells out the math, e.g. *"380mA into a 100mAh cell is a 3.8C rate — well above the ~0.5-1C safe range for typical small LiPo cells; verify your cell's actual rated charge current before proceeding."* If `chargeCurrentMa` is omitted, it's inferred from a small board → onboard-charge-IC lookup table (currently seeded with Seeed XIAO ESP32S3, XIAO ESP32S3 Sense, and XIAO ESP32C3 — see `data/battery-charge-ic-reference.json`, easy to extend with more boards). These are approximate, manufacturer-published figures — verify against the live datasheet/wiki for your exact board revision before trusting them in a production workflow.

**Battery polarity confirmation** — when `battery.connecting: true` (or any battery field is set) but `battery.polarityConfirmed` isn't explicitly `true`, the preflight blocks with `BATTERY_POLARITY_UNCONFIRMED` and a reminder to never assume BAT+/BAT- from wire color. On Seeed XIAO boards it cites the official convention: the negative pad is closest to the USB-C port, positive is farthest from it.

**ESP32-family pin safety** (table-driven per board via `data/board-reference.json`):
- **SPI-flash pins** (GPIO6-11 on classic ESP32 WROOM/WROVER modules) — hard error (`SPI_FLASH_PIN_USED`); wiring these prevents boot.
- **Boot-strapping pins** (GPIO0/2/12/15 on classic ESP32) — caution; usable at runtime but risky if externally held during boot/reset (existing check).
- **Input-only pins with no internal pull resistor** (GPIO34-39 on classic ESP32) — caution (`NO_INTERNAL_PULL_PIN`); add an external pull-up/pull-down if using them as buttons/switches.
- **Seeed XIAO ESP32S3** — modeled with its 11 usable GPIO (D0-D10), default I2C on D4/D5, and an informational note surfaced whenever D6/D7 are wired: they're hardware UART1 TX/RX by default, but enabling "USB CDC on Boot" frees them as plain GPIO.

Board data for all of the above lives in JSON, keyed by board id/FQBN, so more boards can be added without touching guardrail logic.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ARDUINO_CLI_PATH` | `arduino-cli` | Path to arduino-cli binary |
| `ARDUINO_SKETCH_ROOT` | *(none)* | Restrict sketch paths to this directory |

---

## Development

```bash
git clone https://github.com/hardware-mcp/arduino-mcp-server
cd arduino-mcp-server
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

---

## Part of HardwareMCP

This server is part of the [HardwareMCP](https://github.com/hardware-mcp) ecosystem — a collection of MCP servers that give AI assistants real control over physical hardware.

---

## License

MIT — see [LICENSE](LICENSE).

## Support

[Open an issue](https://github.com/hardware-mcp/arduino-mcp-server/issues)
