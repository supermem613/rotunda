import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnalysis,
  responseTokenBudget,
  splitIntoBatches,
  wrapText,
} from "../../src/commands/describe.js";
import type { DescribeFileInput } from "../../src/llm/prompts.js";

function makeFile(tokenSize: number, path = "f.txt"): DescribeFileInput {
  return {
    path,
    root: "r",
    action: "modified",
    side: "local",
    diff: "x".repeat(tokenSize * 3),
    content: null,
  };
}

describe("parseAnalysis", () => {
  const valid = {
    overview: "Some changes",
    files: [{ path: "a.txt", root: "r", action: "modified", summary: "tweaked", chunks: [] }],
  };

  it("parses raw JSON", () => {
    const result = parseAnalysis(JSON.stringify(valid));
    assert.equal(result.overview, "Some changes");
    assert.equal(result.files.length, 1);
  });

  it("parses JSON inside fenced blocks", () => {
    const raw = "Here is the analysis:\n```json\n" + JSON.stringify(valid) + "\n```\n";
    const result = parseAnalysis(raw);
    assert.equal(result.overview, "Some changes");
  });

  it("extracts JSON from surrounding prose", () => {
    const raw = "Sure! " + JSON.stringify(valid) + " Hope that helps.";
    const result = parseAnalysis(raw);
    assert.equal(result.overview, "Some changes");
  });

  it("falls back to overview-only for non-JSON text", () => {
    const raw = "I couldn't parse the files.";
    const result = parseAnalysis(raw);
    assert.equal(result.overview, raw);
    assert.deepEqual(result.files, []);
  });
});

describe("wrapText", () => {
  it("wraps long text at the given width", () => {
    const lines = wrapText("one two three four five six", 10);
    assert.ok(lines.length > 1, "should produce multiple lines");
    for (const line of lines) {
      assert.ok(line.length <= 14, `line "${line}" should be near width`);
    }
  });

  it("returns [''] for empty input", () => {
    assert.deepEqual(wrapText("", 80), [""]);
  });
});

describe("responseTokenBudget", () => {
  it("returns minimum 4096 for small file counts", () => {
    assert.equal(responseTokenBudget(1), 4096);
    assert.equal(responseTokenBudget(10), 4096);
  });

  it("scales linearly and caps at 16384", () => {
    assert.equal(responseTokenBudget(50), 7500);
    assert.equal(responseTokenBudget(1000), 16384);
  });
});

describe("splitIntoBatches", () => {
  it("returns a single batch when everything fits", () => {
    const files = [makeFile(100, "a.txt"), makeFile(100, "b.txt")];
    const batches = splitIntoBatches(files);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
  });

  it("splits into multiple batches when total exceeds budget", () => {
    const files = [makeFile(40_000, "a"), makeFile(40_000, "b"), makeFile(40_000, "c"), makeFile(40_000, "d")];
    const batches = splitIntoBatches(files);
    assert.ok(batches.length >= 2, `expected >=2 batches, got ${batches.length}`);
    assert.equal(batches.reduce((sum, b) => sum + b.length, 0), 4);
  });

  it("preserves file order within batches", () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(100, `file-${i}.txt`));
    const flattened = splitIntoBatches(files).flat();
    for (let i = 0; i < flattened.length; i++) {
      assert.equal(flattened[i].path, `file-${i}.txt`);
    }
  });
});
