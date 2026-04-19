import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeViaLLM, stripFences } from "../../src/llm/merge.js";

describe("stripFences", () => {
  it("strips outer ``` block", () => {
    assert.equal(stripFences("```\nhello\n```"), "hello");
  });
  it("strips outer ```lang block", () => {
    assert.equal(stripFences("```ts\nhello\n```"), "hello");
  });
  it("preserves inner code blocks", () => {
    const s = "intro\n```\ninner\n```\noutro";
    assert.equal(stripFences(s), s);
  });
  it("trims surrounding whitespace", () => {
    assert.equal(stripFences("   hello   "), "hello");
  });
});

describe("mergeViaLLM", () => {
  it("returns no-auth without throwing when token is null", async () => {
    const r = await mergeViaLLM(null, { path: "x", base: null, local: "a", repo: "b" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "no-auth");
      assert.match(r.detail, /rotunda auth/);
    }
  });
});
