import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState,
  updateStateFiles,
  removeFromState,
} from "../../src/core/state.js";

describe("emptyState", () => {
  it("creates state with empty files", () => {
    const state = emptyState();
    assert.deepEqual(state.files, {});
    assert.ok(state.lastSync);
    // Should be a valid ISO date
    assert.ok(!isNaN(Date.parse(state.lastSync)));
  });
});

describe("updateStateFiles", () => {
  it("adds new file entries to state", () => {
    const state = emptyState();
    const synced = new Map([["skill.md", "hash-abc"]]);

    const updated = updateStateFiles(state, ".claude", synced);
    assert.ok(updated.files[".claude/skill.md"]);
    assert.equal(updated.files[".claude/skill.md"].hash, "hash-abc");
  });

  it("updates existing file entries", () => {
    const state = emptyState();
    state.files[".claude/skill.md"] = {
      hash: "hash-old",
      size: 0,
      syncedAt: "2026-01-01T00:00:00Z",
    };

    const synced = new Map([["skill.md", "hash-new"]]);
    const updated = updateStateFiles(state, ".claude", synced);
    assert.equal(updated.files[".claude/skill.md"].hash, "hash-new");
  });

  it("preserves other files in state", () => {
    const state = emptyState();
    state.files[".copilot/config.json"] = {
      hash: "hash-copilot",
      size: 100,
      syncedAt: "2026-01-01T00:00:00Z",
    };

    const synced = new Map([["skill.md", "hash-abc"]]);
    const updated = updateStateFiles(state, ".claude", synced);
    assert.ok(updated.files[".copilot/config.json"]);
    assert.ok(updated.files[".claude/skill.md"]);
  });

  it("does not mutate original state", () => {
    const state = emptyState();
    const synced = new Map([["skill.md", "hash-abc"]]);

    updateStateFiles(state, ".claude", synced);
    assert.deepEqual(state.files, {});
  });
});

describe("removeFromState", () => {
  it("removes specified files", () => {
    const state = emptyState();
    state.files[".claude/old-skill.md"] = {
      hash: "hash-old",
      size: 0,
      syncedAt: "2026-01-01T00:00:00Z",
    };
    state.files[".claude/keep.md"] = {
      hash: "hash-keep",
      size: 0,
      syncedAt: "2026-01-01T00:00:00Z",
    };

    const updated = removeFromState(state, ".claude", ["old-skill.md"]);
    assert.ok(!updated.files[".claude/old-skill.md"]);
    assert.ok(updated.files[".claude/keep.md"]);
  });

  it("does not mutate original state", () => {
    const state = emptyState();
    state.files[".claude/file.md"] = {
      hash: "hash",
      size: 0,
      syncedAt: "2026-01-01T00:00:00Z",
    };

    removeFromState(state, ".claude", ["file.md"]);
    assert.ok(state.files[".claude/file.md"]);
  });
});
