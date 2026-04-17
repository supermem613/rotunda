import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnalysis,
  wrapText,
  responseTokenBudget,
  splitIntoBatches,
} from "../../src/commands/describe.js";
import type { DescribeFileInput } from "../../src/llm/prompts.js";

// ─── parseAnalysis ──────────────────────────────────────────

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

  it("parses JSON inside ```json fences", () => {
    const raw = "Here is the analysis:\n```json\n" + JSON.stringify(valid) + "\n```\n";
    const result = parseAnalysis(raw);
    assert.equal(result.overview, "Some changes");
  });

  it("parses JSON inside plain ``` fences", () => {
    const raw = "```\n" + JSON.stringify(valid) + "\n```";
    const result = parseAnalysis(raw);
    assert.equal(result.overview, "Some changes");
  });

  it("extracts JSON from surrounding prose via brace matching", () => {
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

  it("falls back for completely empty input", () => {
    const result = parseAnalysis("");
    assert.equal(result.overview, "");
    assert.deepEqual(result.files, []);
  });

  it("handles truncated JSON gracefully (falls back)", () => {
    const truncated = '{"overview":"partial","files":[{"path":"a.txt"';
    const result = parseAnalysis(truncated);
    // Brace matcher finds something that still fails JSON.parse → fallback
    assert.equal(typeof result.overview, "string");
  });
});

// ─── wrapText ───────────────────────────────────────────────

describe("wrapText", () => {
  it("wraps long text at the given width", () => {
    const lines = wrapText("one two three four five six", 10);
    for (const line of lines) {
      assert.ok(line.length <= 14, `line "${line}" should be near width`);
    }
    assert.ok(lines.length > 1, "should produce multiple lines");
  });

  it("does not split a single short line", () => {
    const lines = wrapText("hello", 80);
    assert.deepEqual(lines, ["hello"]);
  });

  it("returns [''] for empty input", () => {
    const lines = wrapText("", 80);
    assert.deepEqual(lines, [""]);
  });

  it("handles a single word longer than width", () => {
    const lines = wrapText("superlongword", 5);
    assert.deepEqual(lines, ["superlongword"]);
  });
});

// ─── responseTokenBudget ────────────────────────────────────

describe("responseTokenBudget", () => {
  it("returns minimum 4096 for small file counts", () => {
    assert.equal(responseTokenBudget(1), 4096);
    assert.equal(responseTokenBudget(10), 4096);
  });

  it("scales linearly with file count", () => {
    // 50 files × 150 = 7500
    assert.equal(responseTokenBudget(50), 7500);
  });

  it("caps at 16384", () => {
    assert.equal(responseTokenBudget(200), 16384);
    assert.equal(responseTokenBudget(1000), 16384);
  });

  it("returns 4096 for zero files", () => {
    assert.equal(responseTokenBudget(0), 4096);
  });
});

// ─── splitIntoBatches ───────────────────────────────────────

function makeFile(tokenSize: number): DescribeFileInput {
  // Each char ≈ 1/3 token, so tokenSize × 3 chars in the diff
  return {
    path: "f.txt",
    root: "r",
    action: "modified",
    side: "local",
    diff: "x".repeat(tokenSize * 3),
    content: null,
  };
}

describe("splitIntoBatches", () => {
  it("returns a single batch when everything fits", () => {
    const files = [makeFile(100), makeFile(100)];
    const batches = splitIntoBatches(files);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
  });

  it("splits into multiple batches when total exceeds budget", () => {
    // Each file ~40K tokens; MAX_PROMPT_TOKENS ~122K; system overhead ~300
    const files = [makeFile(40_000), makeFile(40_000), makeFile(40_000), makeFile(40_000)];
    const batches = splitIntoBatches(files);
    assert.ok(batches.length >= 2, `expected ≥2 batches, got ${batches.length}`);
    // All files should still be present
    const total = batches.reduce((sum, b) => sum + b.length, 0);
    assert.equal(total, 4);
  });

  it("puts a single oversized file in its own batch", () => {
    const small = makeFile(1000);
    const huge = makeFile(200_000); // well over the ~122K budget
    const batches = splitIntoBatches([small, huge]);
    assert.ok(batches.length >= 2, `expected ≥2 batches, got ${batches.length}`);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(splitIntoBatches([]), []);
  });

  it("preserves file order within batches", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      ...makeFile(100),
      path: `file-${i}.txt`,
    }));
    const batches = splitIntoBatches(files);
    const flattened = batches.flat();
    for (let i = 0; i < flattened.length; i++) {
      assert.equal(flattened[i].path, `file-${i}.txt`);
    }
  });
});
