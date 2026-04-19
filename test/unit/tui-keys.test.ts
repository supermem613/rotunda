import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { normalizeKey } from "../../src/tui/keys.js";

describe("normalizeKey", () => {
  it("maps return → enter", () => {
    assert.equal(normalizeKey(undefined, { name: "return" }).name, "enter");
  });

  it("maps bare space to 'space'", () => {
    assert.equal(normalizeKey(" ", undefined).name, "space");
  });

  it("normalises escape via raw.name", () => {
    assert.equal(
      normalizeKey(undefined, { name: "escape", sequence: "\x1b" }).name,
      "escape",
    );
  });

  it("normalises escape when only str='\\x1b' is provided", () => {
    assert.equal(normalizeKey("\x1b", undefined).name, "escape");
  });

  it("normalises escape via raw.sequence='\\x1b' alone", () => {
    assert.equal(
      normalizeKey(undefined, { sequence: "\x1b" } as never).name,
      "escape",
    );
  });

  it("preserves ctrl flag", () => {
    const key = normalizeKey(undefined, { name: "c", ctrl: true });
    assert.equal(key.name, "c");
    assert.equal(key.ctrl, true);
  });
});
