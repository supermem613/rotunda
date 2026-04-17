import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashContent } from "../../src/utils/hash.js";

describe("hashContent", () => {
  it("produces consistent SHA256 for same input", () => {
    const hash1 = hashContent("hello world");
    const hash2 = hashContent("hello world");
    assert.equal(hash1, hash2);
  });

  it("produces different hashes for different input", () => {
    const hash1 = hashContent("hello");
    const hash2 = hashContent("world");
    assert.notEqual(hash1, hash2);
  });

  it("produces a 64-char hex string", () => {
    const hash = hashContent("test");
    assert.equal(hash.length, 64);
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it("handles empty string", () => {
    const hash = hashContent("");
    assert.equal(hash.length, 64);
  });

  it("handles Buffer input", () => {
    const hash = hashContent(Buffer.from("hello"));
    const hashStr = hashContent("hello");
    assert.equal(hash, hashStr);
  });
});
