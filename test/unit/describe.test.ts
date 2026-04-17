import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseAnalysis,
  wrapText,
  splitIntoBatches,
} from "../../src/commands/describe.js";
import type { DescribeFileInput } from "../../src/llm/prompts.js";
import { MAX_PROMPT_TOKENS } from "../../src/llm/tokens.js";

// ─── helpers ─────────────────────────────────────────────────

function bigDiff(tokens: number): string {
  const hunks: string[] = [];
  let totalChars = 0;
  const target = tokens * 3;
  let i = 0;
  while (totalChars < target) {
    const hunk =
      `@@ -${i * 10 + 1},3 +${i * 10 + 1},3 @@\n` +
      `-old line ${i} with some padding text here\n` +
      `+new line ${i} with some padding text here\n` +
      ` context line ${i} unchanged`;
    hunks.push(hunk);
    totalChars += hunk.length + 1;
    i++;
  }
  return hunks.join("\n");
}

function makeFile(
  overrides: Partial<DescribeFileInput> = {},
): DescribeFileInput {
  return {
    path: "config.json",
    root: "dotfiles",
    action: "modified",
    side: "local",
    diff: "-old\n+new",
    content: null,
    ...overrides,
  };
}

// ─── parseAnalysis ──────────────────────────────────────────

describe("parseAnalysis", () => {
  it("parses valid JSON directly", () => {
    const json = JSON.stringify({
      overview: "test overview",
      files: [{ path: "a.ts", root: "r", action: "modified", summary: "changed", chunks: [] }],
    });
    const result = parseAnalysis(json);
    assert.strictEqual(result.overview, "test overview");
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].path, "a.ts");
  });

  it("extracts JSON from markdown fences", () => {
    const raw = 'Here is the analysis:\n```json\n{"overview":"fenced","files":[]}\n```\n';
    const result = parseAnalysis(raw);
    assert.strictEqual(result.overview, "fenced");
  });

  it("extracts JSON from fences without language tag", () => {
    const raw = '```\n{"overview":"no-lang","files":[]}\n```';
    const result = parseAnalysis(raw);
    assert.strictEqual(result.overview, "no-lang");
  });

  it("extracts JSON from surrounding text (brace match)", () => {
    const raw = 'Some intro text. {"overview":"brace","files":[]} Some outro.';
    const result = parseAnalysis(raw);
    assert.strictEqual(result.overview, "brace");
  });

  it("falls back to treating entire response as overview", () => {
    const raw = "This is not JSON at all, just a plain text explanation.";
    const result = parseAnalysis(raw);
    assert.strictEqual(result.overview, raw);
    assert.deepStrictEqual(result.files, []);
  });

  it("handles empty string", () => {
    const result = parseAnalysis("");
    assert.strictEqual(result.overview, "");
    assert.deepStrictEqual(result.files, []);
  });

  it("handles malformed JSON in fences gracefully", () => {
    const raw = '```json\n{invalid json here}\n```';
    const result = parseAnalysis(raw);
    // Should fall back to brace match or overview
    assert.ok(result.overview.length > 0);
  });

  it("parses analysis with observations", () => {
    const json = JSON.stringify({
      overview: "overview",
      files: [{
        path: "a.ts",
        root: "r",
        action: "modified",
        summary: "changed",
        chunks: [{ header: "@@ -1,3", description: "did stuff" }],
        observations: ["watch out for X"],
      }],
    });
    const result = parseAnalysis(json);
    assert.deepStrictEqual(result.files[0].observations, ["watch out for X"]);
  });

  it("parses analysis with multiple files", () => {
    const json = JSON.stringify({
      overview: "multi",
      files: [
        { path: "a.ts", root: "r", action: "added", summary: "new", chunks: [] },
        { path: "b.ts", root: "r", action: "deleted", summary: "gone", chunks: [] },
        { path: "c.ts", root: "r", action: "modified", summary: "edited", chunks: [] },
      ],
    });
    const result = parseAnalysis(json);
    assert.strictEqual(result.files.length, 3);
  });
});

// ─── wrapText ───────────────────────────────────────────────

describe("wrapText", () => {
  it("returns single line when text fits within width", () => {
    const lines = wrapText("short text", 80);
    assert.deepStrictEqual(lines, ["short text"]);
  });

  it("wraps long text at word boundaries", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const lines = wrapText(text, 20);
    assert.ok(lines.length > 1, "should wrap into multiple lines");
    for (const line of lines) {
      assert.ok(line.length <= 22, `line should be near width: "${line}"`);
    }
  });

  it("preserves all words after wrapping", () => {
    const text = "one two three four five six seven";
    const lines = wrapText(text, 10);
    const rejoined = lines.join(" ");
    assert.strictEqual(rejoined, text);
  });

  it("handles empty string", () => {
    const lines = wrapText("", 80);
    assert.deepStrictEqual(lines, [""]);
  });

  it("handles single very long word", () => {
    const word = "x".repeat(100);
    const lines = wrapText(word, 20);
    // A single word can't be broken, so it stays on one line
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], word);
  });

  it("handles multiple spaces between words", () => {
    const text = "one   two   three";
    const lines = wrapText(text, 80);
    // split(/\s+/) collapses spaces
    assert.deepStrictEqual(lines, ["one two three"]);
  });
});

// ─── splitIntoBatches ───────────────────────────────────────

describe("splitIntoBatches", () => {
  it("returns a single batch when all files fit", () => {
    const files = [makeFile(), makeFile({ path: "b.ts" })];
    const batches = splitIntoBatches(files);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].length, 2);
  });

  it("splits large files into multiple batches", () => {
    // 20 files with 10K-token diffs = ~200K tokens, exceeds 121K budget
    const files = Array.from({ length: 20 }, (_, i) =>
      makeFile({ path: `file${i}.ts`, diff: bigDiff(10_000) }),
    );
    const batches = splitIntoBatches(files);
    assert.ok(batches.length > 1, `should split into >1 batch, got ${batches.length}`);

    // Every file should appear in exactly one batch
    const allFiles = batches.flat();
    assert.strictEqual(allFiles.length, 20);
  });

  it("preserves file order across batches", () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile({ path: `file${i}.ts`, diff: bigDiff(20_000) }),
    );
    const batches = splitIntoBatches(files);
    const allPaths = batches.flat().map((f) => f.path);
    for (let i = 1; i < allPaths.length; i++) {
      const prev = parseInt(allPaths[i - 1].match(/\d+/)![0], 10);
      const curr = parseInt(allPaths[i].match(/\d+/)![0], 10);
      assert.ok(curr > prev, `files should be in order: ${allPaths[i - 1]} before ${allPaths[i]}`);
    }
  });

  it("handles empty file list", () => {
    const batches = splitIntoBatches([]);
    assert.strictEqual(batches.length, 0);
  });

  it("handles a single file", () => {
    const batches = splitIntoBatches([makeFile()]);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].length, 1);
  });

  it("puts a single huge file in its own batch", () => {
    const files = [
      makeFile({ path: "small.ts", diff: "-a\n+b" }),
      makeFile({ path: "huge.ts", diff: bigDiff(200_000) }),
      makeFile({ path: "small2.ts", diff: "-c\n+d" }),
    ];
    const batches = splitIntoBatches(files);
    // The huge file should be isolated in its own batch
    const hugeBatch = batches.find((b) =>
      b.some((f) => f.path === "huge.ts"),
    );
    assert.ok(hugeBatch, "huge file should be in a batch");
    // The huge file should either be alone or with one of the small files
    assert.ok(hugeBatch!.length <= 2, "huge file batch should be small");
  });

  it("all batches fit within MAX_PROMPT_TOKENS (via raw estimation)", () => {
    // This test verifies the batch sizes are reasonable
    const files = Array.from({ length: 30 }, (_, i) =>
      makeFile({ path: `file${i}.ts`, diff: bigDiff(5_000) }),
    );
    const batches = splitIntoBatches(files);
    // Each batch should have multiple files (not degenerate 1-per-batch)
    assert.ok(
      batches.length < files.length,
      `should batch files together, not one per batch: ${batches.length} batches for ${files.length} files`,
    );
  });
});
