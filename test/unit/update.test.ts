import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCommand } from "../../src/commands/update.js";
import type { VcsBackend } from "../../src/utils/vcs.js";

describe("updateCommand", () => {
  it("skips install and build when backend pull returns false", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rotunda-update-"));
    try {
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      const commands: string[] = [];
      const backend: VcsBackend = {
        isRepo: async () => true,
        pull: async () => {
          commands.push("backend.pull");
          return false;
        },
        publish: async () => {},
      };
      await updateCommand({
        repoRoot,
        isGitRepo: async () => true,
        resolveBackend: () => backend,
        runCommand: async (command) => {
          commands.push(command);
        },
      });
      assert.deepEqual(commands, ["backend.pull"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("runs install and build when backend pull returns true", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rotunda-update-"));
    try {
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      const commands: string[] = [];
      const backend: VcsBackend = {
        isRepo: async () => true,
        pull: async () => {
          commands.push("backend.pull");
          return true;
        },
        publish: async () => {},
      };
      await updateCommand({
        repoRoot,
        isGitRepo: async () => true,
        resolveBackend: () => backend,
        runCommand: async (command) => {
          commands.push(command);
        },
      });
      assert.deepEqual(commands, [
        "backend.pull",
        "npm install --no-audit --no-fund",
        "npm run build",
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
