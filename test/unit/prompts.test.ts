import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildExplainPrompt,
  buildReshapePrompt,
  buildConflictPrompt,
  buildDescribePrompt,
  estimateDescribeFileTokens,
  getDescribeSystemTokens,
} from "../../src/llm/prompts.js";
import type { DescribeFileInput } from "../../src/llm/prompts.js";
import { estimateTokens, MAX_PROMPT_TOKENS } from "../../src/llm/tokens.js";
import type { FileChange } from "../../src/core/types.js";

function makeChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    relativePath: "config/settings.json",
    rootName: "dotfiles",
    action: "modified",
    side: "local",
    ...overrides,
  };
}

/** Create a large string of the given approximate token count. */
function bigString(tokens: number): string {
  // 3 chars per token (CHARS_PER_TOKEN)
  return "x".repeat(tokens * 3);
}

/** Create a multi-hunk diff of approximately the given token count. */
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
    totalChars += hunk.length + 1; // +1 for join newline
    i++;
  }
  return hunks.join("\n");
}

describe("buildExplainPrompt", () => {
  it("includes full content for added files", () => {
    const change = makeChange({ action: "added" });
    const content = '{ "key": "value" }';
    const { user } = buildExplainPrompt(change, null, content, "");

    assert.ok(user.includes(content), "should include the full file content");
    assert.ok(user.includes("added"), "should mention the change type");
  });

  it("mentions removal for deleted files", () => {
    const change = makeChange({ action: "deleted" });
    const prev = "old content";
    const { user } = buildExplainPrompt(change, prev, null, "");

    assert.ok(user.includes("removed"), "should mention removal");
    assert.ok(user.includes(prev), "should include previous content");
  });

  it("includes the diff for modified files", () => {
    const change = makeChange({ action: "modified" });
    const diff = "-old line\n+new line";
    const { user } = buildExplainPrompt(change, "old", "new", diff);

    assert.ok(user.includes(diff), "should include the diff");
    assert.ok(
      user.includes(change.relativePath),
      "should include the file path",
    );
  });

  it("truncates a huge diff to stay within budget", () => {
    const change = makeChange({ action: "modified" });
    const hugeDiff = bigDiff(200_000); // way over budget
    const { system, user } = buildExplainPrompt(change, null, null, hugeDiff);

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `prompt should fit within budget: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("truncates huge added file content to stay within budget", () => {
    const change = makeChange({ action: "added" });
    const hugeContent = bigString(200_000);
    const { system, user } = buildExplainPrompt(change, null, hugeContent, "");

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `prompt should fit within budget: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
    assert.ok(user.includes("truncated"), "should indicate truncation");
  });

  it("handles conflict action like modified", () => {
    const change = makeChange({ action: "conflict" });
    const diff = "-repo\n+local";
    const { user } = buildExplainPrompt(change, "repo", "local", diff);
    assert.ok(user.includes("conflict"));
    assert.ok(user.includes(diff));
  });
});

describe("buildReshapePrompt", () => {
  it("includes the user instruction", () => {
    const instruction = "Remove all comments from the file";
    const { user } = buildReshapePrompt("repo", "local", "diff", instruction);

    assert.ok(
      user.includes(instruction),
      "should include the user instruction",
    );
  });

  it("system prompt says to output ONLY file content", () => {
    const { system } = buildReshapePrompt("repo", "local", "diff", "fix it");

    assert.ok(
      system.includes("Output ONLY the complete new file content"),
      "system prompt should instruct ONLY file content output",
    );
  });

  it("truncates huge repo content to stay within budget", () => {
    const hugeRepo = bigString(200_000);
    const { system, user } = buildReshapePrompt(hugeRepo, "local", "", "fix it");

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
    assert.ok(user.includes("truncated"), "should indicate truncation");
  });

  it("truncates huge local content to stay within budget", () => {
    const hugeLocal = bigString(200_000);
    const { system, user } = buildReshapePrompt("repo", hugeLocal, "", "fix it");

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("truncates huge diff to stay within budget", () => {
    const hugeDiff = bigDiff(200_000);
    const { system, user } = buildReshapePrompt(null, null, hugeDiff, "fix it");

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("handles all three inputs being huge", () => {
    const huge = bigString(100_000);
    const hugeDiff = bigDiff(100_000);
    const { system, user } = buildReshapePrompt(huge, huge, hugeDiff, "fix it");

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("preserves small inputs without truncation", () => {
    const { user } = buildReshapePrompt("small repo", "small local", "-a\n+b", "fix");
    assert.ok(user.includes("small repo"));
    assert.ok(user.includes("small local"));
    assert.ok(!user.includes("truncated"));
  });
});

describe("buildConflictPrompt", () => {
  it("includes both diffs", () => {
    const repoDiff = "-repo old\n+repo new";
    const localDiff = "-local old\n+local new";
    const { user } = buildConflictPrompt(
      "repo content",
      "local content",
      repoDiff,
      localDiff,
    );

    assert.ok(user.includes(repoDiff), "should include the repo diff");
    assert.ok(user.includes(localDiff), "should include the local diff");
  });

  it("truncates huge diffs to stay within budget", () => {
    const hugeDiff1 = bigDiff(200_000);
    const hugeDiff2 = bigDiff(200_000);
    const { system, user } = buildConflictPrompt(
      "repo content",
      "local content",
      hugeDiff1,
      hugeDiff2,
    );

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("preserves small diffs without truncation", () => {
    const repoDiff = "-a\n+b";
    const localDiff = "-c\n+d";
    const { user } = buildConflictPrompt("repo", "local", repoDiff, localDiff);
    assert.ok(!user.includes("omitted"), "should not truncate small diffs");
  });
});

describe("buildDescribePrompt", () => {
  it("produces a system prompt requesting JSON output", () => {
    const files = [
      { path: "hooks/pre-commit.json", root: "claude", action: "modified", side: "local", diff: "-old\n+new", content: null },
    ];
    const { system } = buildDescribePrompt(files);

    assert.ok(system.includes("JSON"), "should request JSON output");
    assert.ok(system.includes("overview"), "should mention overview field");
    assert.ok(system.includes("chunks"), "should mention chunks field");
  });

  it("includes all files in the user prompt", () => {
    const files = [
      { path: "skills/commit/SKILL.md", root: "claude", action: "added", side: "local", diff: "", content: "# Commit skill" },
      { path: "hooks/pre-commit.json", root: "claude", action: "modified", side: "local", diff: "-old\n+new", content: null },
    ];
    const { user } = buildDescribePrompt(files);

    assert.ok(user.includes("skills/commit/SKILL.md"), "should include first file path");
    assert.ok(user.includes("hooks/pre-commit.json"), "should include second file path");
    assert.ok(user.includes("2 changed file(s)"), "should state the file count");
  });

  it("truncates large file content within per-file budget", () => {
    // Use a tight budget so 5000 chars (~1667 tokens) exceeds the per-file allowance
    const bigContent = "x".repeat(5000);
    const files = [
      { path: "big.md", root: "claude", action: "added", side: "local", diff: "", content: bigContent },
    ];
    const { user } = buildDescribePrompt(files, 1000); // tight budget forces truncation

    assert.ok(!user.includes("x".repeat(5000)), "should not include full content");
    assert.ok(user.includes("truncated"), "should indicate truncation");
  });

  it("includes diff content for modified files", () => {
    const diff = "-removed line\n+added line";
    const files = [
      { path: "config.json", root: "dotfiles", action: "modified", side: "local", diff, content: null },
    ];
    const { user } = buildDescribePrompt(files);

    assert.ok(user.includes(diff), "should include the diff");
  });

  // ── Token budget tests ──────────────────────────────────────

  it("stays within budget with many files with large diffs", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `file${i}.ts`,
      root: "repo",
      action: "modified",
      side: "local",
      diff: bigDiff(5000),
      content: null,
    }));
    const { system, user } = buildDescribePrompt(files);

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `50-file prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("stays within budget with a single file with enormous diff", () => {
    const files = [
      { path: "giant.ts", root: "repo", action: "modified", side: "local", diff: bigDiff(200_000), content: null },
    ];
    const { system, user } = buildDescribePrompt(files);

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `giant-diff prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("stays within budget with many files with large content", () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `file${i}.md`,
      root: "docs",
      action: "added",
      side: "local",
      diff: "",
      content: bigString(10_000),
    }));
    const { system, user } = buildDescribePrompt(files);

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `30-file content prompt should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });

  it("respects a custom tokenBudget parameter", () => {
    const smallBudget = 500; // very tight
    const files = [
      { path: "a.ts", root: "r", action: "modified", side: "local", diff: bigDiff(2000), content: null },
    ];
    const { system, user } = buildDescribePrompt(files, smallBudget);

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    // With a small budget, the diff should be heavily truncated
    // The system prompt alone may approach the budget, but the user prompt should be small
    assert.ok(
      totalTokens <= smallBudget + estimateTokens(system) + 200,
      `should respect custom budget`,
    );
  });

  it("distributes budget across files proportionally", () => {
    const files = [
      { path: "small.ts", root: "r", action: "modified", side: "local", diff: "-a\n+b", content: null },
      { path: "big.ts", root: "r", action: "modified", side: "local", diff: bigDiff(100_000), content: null },
    ];
    const { user } = buildDescribePrompt(files);

    // Both files should be present
    assert.ok(user.includes("small.ts"));
    assert.ok(user.includes("big.ts"));
    // The small diff should be preserved fully
    assert.ok(user.includes("-a\n+b"));
  });

  it("handles empty file list", () => {
    const { user } = buildDescribePrompt([]);
    assert.ok(user.includes("0 changed file(s)"));
  });

  it("handles files with both diff and content", () => {
    const files = [
      {
        path: "mixed.ts",
        root: "r",
        action: "modified",
        side: "local",
        diff: bigDiff(100_000),
        content: bigString(100_000),
      },
    ];
    const { system, user } = buildDescribePrompt(files);

    const totalTokens = estimateTokens(system) + estimateTokens(user);
    assert.ok(
      totalTokens <= MAX_PROMPT_TOKENS,
      `mixed diff+content should fit: ${totalTokens} <= ${MAX_PROMPT_TOKENS}`,
    );
  });
});

// ─── estimateDescribeFileTokens ─────────────────────────────

describe("estimateDescribeFileTokens", () => {
  it("returns a positive value for a file with a diff", () => {
    const f: DescribeFileInput = {
      path: "a.ts", root: "r", action: "modified", side: "local",
      diff: "-old\n+new", content: null,
    };
    const tokens = estimateDescribeFileTokens(f);
    assert.ok(tokens > 50, "should include overhead + diff tokens");
  });

  it("returns a positive value for a file with content", () => {
    const f: DescribeFileInput = {
      path: "a.ts", root: "r", action: "added", side: "local",
      diff: "", content: "hello world",
    };
    const tokens = estimateDescribeFileTokens(f);
    assert.ok(tokens > 50, "should include overhead + content tokens");
  });

  it("returns overhead only for a file with no diff and no content", () => {
    const f: DescribeFileInput = {
      path: "a.ts", root: "r", action: "deleted", side: "local",
      diff: "", content: null,
    };
    const tokens = estimateDescribeFileTokens(f);
    assert.strictEqual(tokens, 50, "should be just the metadata overhead");
  });

  it("scales with diff size", () => {
    const small: DescribeFileInput = {
      path: "a.ts", root: "r", action: "modified", side: "local",
      diff: "-a\n+b", content: null,
    };
    const large: DescribeFileInput = {
      path: "b.ts", root: "r", action: "modified", side: "local",
      diff: bigDiff(10_000), content: null,
    };
    assert.ok(
      estimateDescribeFileTokens(large) > estimateDescribeFileTokens(small) * 10,
      "large diff should estimate much higher",
    );
  });

  it("combined file estimates can predict whether batching is needed", () => {
    // Create files whose raw size exceeds the budget
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `file${i}.ts`,
      root: "r",
      action: "modified",
      side: "local",
      diff: bigDiff(10_000),
      content: null,
    }));
    const systemOverhead = getDescribeSystemTokens();
    const rawTotal = files.reduce(
      (sum, f) => sum + estimateDescribeFileTokens(f as DescribeFileInput), systemOverhead,
    );
    assert.ok(
      rawTotal > MAX_PROMPT_TOKENS,
      `20 files with 10K-token diffs should exceed budget: ${rawTotal} > ${MAX_PROMPT_TOKENS}`,
    );
  });
});

// ─── getDescribeSystemTokens ────────────────────────────────

describe("getDescribeSystemTokens", () => {
  it("returns a reasonable positive number", () => {
    const tokens = getDescribeSystemTokens();
    assert.ok(tokens > 100, "system prompt should be > 100 tokens");
    assert.ok(tokens < 2000, "system prompt should be < 2000 tokens");
  });

  it("matches the system prompt from buildDescribePrompt", () => {
    const { system } = buildDescribePrompt([]);
    const estimated = getDescribeSystemTokens();
    const actual = estimateTokens(system);
    // getDescribeSystemTokens adds 100 for framing overhead
    assert.ok(
      Math.abs(estimated - actual - 100) < 10,
      `should be close: estimated=${estimated}, actual+100=${actual + 100}`,
    );
  });
});

