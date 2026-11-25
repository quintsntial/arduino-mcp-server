import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { baseFqbn, findBoardReferenceByFqbn } from "./boardReference.js";

describe("findBoardReferenceByFqbn", () => {
  test("matches a plain FQBN", () => {
    assert.equal(findBoardReferenceByFqbn("arduino:avr:nano")?.id, "arduino_nano_classic");
  });

  test("matches an FQBN with board menu options (old-bootloader Nano clone)", () => {
    assert.equal(findBoardReferenceByFqbn("arduino:avr:nano:cpu=atmega328old")?.id, "arduino_nano_classic");
  });

  test("is case-insensitive and trims", () => {
    assert.equal(findBoardReferenceByFqbn("  Arduino:AVR:Nano:cpu=atmega328  ")?.id, "arduino_nano_classic");
  });

  test("returns null for an unknown board", () => {
    assert.equal(findBoardReferenceByFqbn("acme:avr:nothing:cpu=x"), null);
  });
});

describe("baseFqbn", () => {
  test("strips menu options", () => {
    assert.equal(baseFqbn("arduino:avr:nano:cpu=atmega328old"), "arduino:avr:nano");
    assert.equal(baseFqbn("esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M"), "esp32:esp32:esp32s3");
  });

  test("leaves a base FQBN unchanged", () => {
    assert.equal(baseFqbn("arduino:avr:uno"), "arduino:avr:uno");
  });
});
