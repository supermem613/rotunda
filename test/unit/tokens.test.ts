import { describe, it } from "node:test";
import assert from "node:assert";
import {
  estimateTokens,
  tokensToChars,
  truncateToTokenBudget,
  truncateDiff,
  TokenOverflowError,
  CHARS_PER_TOKEN,
  MAX_PROMPT_TOKENS,
  MODEL_TOKEN_LIMIT,
  MAX_RESPONSE_TOKENS,
} from "../../src/llm/tokens.js";

// ─── Constants ───────────────────────────────────────────────

describe("token constants", () => {
  it("CHARS_PER_TOKEN is 3 (conservative for code)", () => {
    assert.strictEqual(CHARS_PER_TOKEN, 3);
  });

  it("MODEL_TOKEN_LIMIT is 128K for gpt-5-mini", () => {
    assert.strictEqual(MODEL_TOKEN_LIMIT, 128_000);
  });

  it("MAX_PROMPT_TOKENS leaves room for response and safety margin", () => {
    assert.ok(MAX_PROMPT_TOKENS < MODEL_TOKEN_LIMIT);
    assert.ok(MAX_PROMPT_TOKENS > 0);
    assert.strictEqual(
      MAX_PROMPT_TOKENS,
      MODEL_TOKEN_LIMIT - MAX_RESPONSE_TOKENS - 2_000,
    );
  });

  it("MAX_RESPONSE_TOKENS is 4096", () => {
    assert.strictEqual(MAX_RESPONSE_TOKENS, 4096);
  });
});

// ─── estimateTokens ─────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    assert.strictEqual(estimateTokens(""), 0);
  });

  it("estimates 1 token for strings up to CHARS_PER_TOKEN length", () => {
    assert.strictEqual(estimateTokens("ab"), 1);
    assert.strictEqual(estimateTokens("abc"), 1);
  });

  it("rounds up to the next whole token", () => {
    assert.strictEqual(estimateTokens("abcd"), 2); // 4 / 3 → ceil = 2
  });

  it("scales linearly for larger strings", () => {
    const text = "x".repeat(300);
    assert.strictEqual(estimateTokens(text), 100); // 300 / 3
  });

  it("handles multi-line code-like strings", () => {
    const code = 'function hello() {\n  console.log("hello");\n}\n';
    const tokens = estimateTokens(code);
    assert.ok(tokens > 0);
    assert.strictEqual(tokens, Math.ceil(code.length / CHARS_PER_TOKEN));
  });
});

// ─── tokensToChars ──────────────────────────────────────────

describe("tokensToChars", () => {
  it("converts tokens back to char count", () => {
    assert.strictEqual(tokensToChars(1), CHARS_PER_TOKEN);
    assert.strictEqual(tokensToChars(100), 300);
  });

  it("returns 0 for 0 tokens", () => {
    assert.strictEqual(tokensToChars(0), 0);
  });
});

// ─── truncateToTokenBudget ──────────────────────────────────

describe("truncateToTokenBudget", () => {
  it("returns text unchanged when within budget", () => {
    const text = "short text";
    const result = truncateToTokenBudget(text, 1000);
    assert.strictEqual(result, text);
  });

  it("truncates text that exceeds the budget", () => {
    const text = "x".repeat(600); // 200 tokens at 3 chars/token
    const result = truncateToTokenBudget(text, 50); // 150 chars budget
    assert.ok(result.length < text.length, "should be shorter");
    assert.ok(result.includes("truncated"), "should have truncation marker");
  });

  it("includes the label in the truncation marker", () => {
    const text = "x".repeat(600);
    const result = truncateToTokenBudget(text, 50, "diff");
    assert.ok(result.includes("diff truncated"), "should include the label");
  });

  it("uses default label 'content' when none provided", () => {
    const text = "x".repeat(600);
    const result = truncateToTokenBudget(text, 50);
    assert.ok(result.includes("content truncated"), "should use default label");
  });

  it("truncates on a line boundary when possible", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const result = truncateToTokenBudget(text, 20); // ~60 chars
    // Should not cut mid-line
    const resultLines = result.split("\n");
    // All lines except the marker should be complete original lines
    for (const line of resultLines.slice(0, -1)) {
      if (line.startsWith("...")) continue;
      assert.ok(
        lines.includes(line),
        `"${line}" should be a complete original line`,
      );
    }
  });

  it("reports approximate omitted tokens in the marker", () => {
    const text = "x".repeat(900); // 300 tokens
    const result = truncateToTokenBudget(text, 100); // 300 char budget
    const match = result.match(/~(\d+) tokens omitted/);
    assert.ok(match, "should report omitted token count");
    const omitted = parseInt(match![1], 10);
    assert.ok(omitted > 0, "omitted count should be positive");
  });

  it("handles text with no newlines gracefully", () => {
    const text = "x".repeat(600);
    const result = truncateToTokenBudget(text, 50);
    assert.ok(result.length < text.length);
    assert.ok(result.includes("truncated"));
  });

  it("does not truncate text exactly at the budget boundary", () => {
    const budget = 100;
    const text = "x".repeat(tokensToChars(budget)); // exactly at budget
    const result = truncateToTokenBudget(text, budget);
    assert.strictEqual(result, text);
  });
});

// ─── truncateDiff ───────────────────────────────────────────

describe("truncateDiff", () => {
  it("returns diff unchanged when within budget", () => {
    const diff = "@@ -1,3 +1,3 @@\n-old\n+new\n context";
    const result = truncateDiff(diff, 1000);
    assert.strictEqual(result, diff);
  });

  it("truncates large diffs", () => {
    // Create a huge diff with many hunks
    const hunks: string[] = [];
    for (let i = 0; i < 100; i++) {
      hunks.push(
        `@@ -${i * 10 + 1},5 +${i * 10 + 1},5 @@\n` +
        `-old line ${i}\n` +
        `+new line ${i}\n` +
        ` context line ${i}\n` +
        ` context line ${i + 1}\n` +
        ` context line ${i + 2}`,
      );
    }
    const diff = hunks.join("\n");
    const result = truncateDiff(diff, 50); // very small budget
    assert.ok(result.length < diff.length, "should be shorter");
  });

  it("preserves complete hunks (does not cut mid-hunk)", () => {
    const hunk1 = "@@ -1,3 +1,3 @@\n-old1\n+new1\n ctx1";
    const hunk2 = "@@ -10,3 +10,3 @@\n-old2\n+new2\n ctx2";
    const hunk3 = "@@ -20,3 +20,3 @@\n-old3\n+new3\n ctx3";
    const diff = [hunk1, hunk2, hunk3].join("\n");

    // Budget enough for ~2 hunks
    const twoHunkChars = (hunk1 + "\n" + hunk2).length;
    const budget = Math.ceil(twoHunkChars / CHARS_PER_TOKEN) + 5;
    const result = truncateDiff(diff, budget);

    // Should contain complete hunk1 and hunk2
    assert.ok(result.includes("-old1"), "should keep hunk 1");
    assert.ok(result.includes("+new1"), "should keep hunk 1 additions");
  });

  it("includes omitted hunk count in the marker", () => {
    const hunks: string[] = [];
    for (let i = 0; i < 20; i++) {
      hunks.push(
        `@@ -${i * 10 + 1},3 +${i * 10 + 1},3 @@\n-old${i}\n+new${i}\n ctx${i}`,
      );
    }
    const diff = hunks.join("\n");
    const result = truncateDiff(diff, 30); // ~90 chars, fits ~2 hunks
    assert.ok(
      result.includes("hunk(s) omitted"),
      "should mention omitted hunks",
    );
  });

  it("handles empty diff", () => {
    assert.strictEqual(truncateDiff("", 100), "");
  });

  it("handles diff with no hunk headers", () => {
    const diff = "-old line\n+new line\n context";
    const result = truncateDiff(diff, 1000);
    assert.strictEqual(result, diff);
  });

  it("handles single-hunk diff that exceeds budget", () => {
    // One massive hunk
    const lines = ["@@ -1,500 +1,500 @@"];
    for (let i = 0; i < 500; i++) {
      lines.push(`-old line number ${i} with some content`);
      lines.push(`+new line number ${i} with some content`);
    }
    const diff = lines.join("\n");
    const result = truncateDiff(diff, 50); // ~150 chars
    assert.ok(result.includes("hunk(s) omitted"));
  });
});

// ─── TokenOverflowError ─────────────────────────────────────

describe("TokenOverflowError", () => {
  it("stores estimated and limit token counts", () => {
    const err = new TokenOverflowError(80000, 64000);
    assert.strictEqual(err.estimatedTokens, 80000);
    assert.strictEqual(err.limitTokens, 64000);
  });

  it("has a descriptive message", () => {
    const err = new TokenOverflowError(80000, 64000);
    assert.ok(err.message.includes("80000"));
    assert.ok(err.message.includes("64000"));
  });

  it("has name set to TokenOverflowError", () => {
    const err = new TokenOverflowError(1, 0);
    assert.strictEqual(err.name, "TokenOverflowError");
  });

  it("is an instance of Error", () => {
    const err = new TokenOverflowError(1, 0);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof TokenOverflowError);
  });
});
