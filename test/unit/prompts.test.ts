import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildExplainPrompt,
  buildReshapePrompt,
  buildConflictPrompt,
  buildDescribePrompt,
} from "../../src/llm/prompts.js";
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

  it("truncates large file content to 3000 chars", () => {
    const bigContent = "x".repeat(5000);
    const files = [
      { path: "big.md", root: "claude", action: "added", side: "local", diff: "", content: bigContent },
    ];
    const { user } = buildDescribePrompt(files);

    assert.ok(user.includes("(truncated)"), "should indicate truncation");
    assert.ok(!user.includes("x".repeat(5000)), "should not include full content");
  });

  it("includes diff content for modified files", () => {
    const diff = "-removed line\n+added line";
    const files = [
      { path: "config.json", root: "dotfiles", action: "modified", side: "local", diff, content: null },
    ];
    const { user } = buildDescribePrompt(files);

    assert.ok(user.includes(diff), "should include the diff");
  });
});
