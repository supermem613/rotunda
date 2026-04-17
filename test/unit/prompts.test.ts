import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildExplainPrompt,
  buildReshapePrompt,
  buildConflictPrompt,
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
