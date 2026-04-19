import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildExplainPrompt,
  buildReshapePrompt,
  buildConflictPrompt,
} from "../../src/llm/prompts.js";
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
