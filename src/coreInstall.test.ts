import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { additionalUrlsArgs, coreCommandArgs, normalizeBoardUrls, resolveBoardUrls } from "./coreInstall.js";

const ESP = "https://arduino.esp8266.com/stable/package_esp8266com_index.json";
const OTHER = "https://example.com/package_other_index.json";

describe("resolveBoardUrls", () => {
  test("uses BOARD_URLS from board.env when no argument is given", () => {
    assert.deepEqual(resolveBoardUrls(undefined, [ESP]), { urls: [ESP], source: "board.env" });
    assert.deepEqual(resolveBoardUrls([], [ESP]), { urls: [ESP], source: "board.env" });
  });

  test("an explicit boardUrls argument wins over board.env", () => {
    assert.deepEqual(resolveBoardUrls([OTHER], [ESP]), { urls: [OTHER], source: "argument" });
  });

  test("no URLs anywhere gives source none", () => {
    assert.deepEqual(resolveBoardUrls(undefined, undefined), { urls: [], source: "none" });
  });

  test("trims, drops blanks and duplicates", () => {
    assert.deepEqual(normalizeBoardUrls([` ${ESP} `, "", ESP, OTHER]), [ESP, OTHER]);
  });
});

describe("coreCommandArgs", () => {
  test("without URLs no --additional-urls is added", () => {
    const args = coreCommandArgs("arduino:avr", []);
    assert.deepEqual(args.list, ["core", "list", "--format", "json"]);
    assert.deepEqual(args.updateIndex, ["core", "update-index"]);
    assert.deepEqual(args.install, ["core", "install", "arduino:avr"]);
  });

  test("with URLs all three commands get one comma separated --additional-urls", () => {
    const args = coreCommandArgs("esp8266:esp8266", [ESP, OTHER]);
    const extra = ["--additional-urls", `${ESP},${OTHER}`];
    assert.deepEqual(args.list, ["core", "list", "--format", "json", ...extra]);
    assert.deepEqual(args.updateIndex, ["core", "update-index", ...extra]);
    assert.deepEqual(args.install, ["core", "install", "esp8266:esp8266", ...extra]);
  });

  test("additionalUrlsArgs is empty for no URLs", () => {
    assert.deepEqual(additionalUrlsArgs([]), []);
  });
});
