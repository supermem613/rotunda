import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  reduce,
  defaultAction,
  visibleIndices,
  hasUnresolvedConflicts,
  actionCounts,
  actionCycle,
  listPageSize,
  type AppState,
  type Event,
  type Key,
} from "../../src/tui/state.js";
import type { FileChange } from "../../src/core/types.js";

function k(name: string, extra: Partial<Key> = {}): Event {
  return { type: "key", key: { name, ...extra } };
}

function vp(rows = 24, cols = 80): { cols: number; rows: number } {
  return { cols, rows };
}

function fc(over: Partial<FileChange> = {}): FileChange {
  return {
    relativePath: over.relativePath ?? "a.md",
    rootName: over.rootName ?? "claude",
    action: over.action ?? "added",
    side: over.side ?? "local",
    localHash: over.localHash ?? "lh",
    repoHash: over.repoHash,
    stateHash: over.stateHash,
  };
}

describe("defaultAction", () => {
  it("local added → push", () => {
    assert.equal(defaultAction(fc({ action: "added", side: "local" })), "push");
  });
  it("local modified → push", () => {
    assert.equal(defaultAction(fc({ action: "modified", side: "local" })), "push");
  });
  it("local deleted → delete-repo", () => {
    assert.equal(defaultAction(fc({ action: "deleted", side: "local" })), "delete-repo");
  });
  it("repo added → pull", () => {
    assert.equal(defaultAction(fc({ action: "added", side: "repo", repoHash: "rh" })), "pull");
  });
  it("repo deleted → delete-local", () => {
    assert.equal(defaultAction(fc({ action: "deleted", side: "repo" })), "delete-local");
  });
  it("conflict → conflict", () => {
    assert.equal(defaultAction(fc({ action: "conflict", side: "both", repoHash: "rh" })), "conflict");
  });
});

describe("initialState", () => {
  it("classifies each row by engine default", () => {
    const s = initialState([
      fc({ relativePath: "a", action: "added", side: "local" }),
      fc({ relativePath: "b", action: "conflict", side: "both", repoHash: "x" }),
    ], vp());
    assert.equal(s.rows[0].action, "push");
    assert.equal(s.rows[1].action, "conflict");
  });

  it("honors deferred map from prior state", () => {
    const s = initialState(
      [fc({ relativePath: "a" })],
      vp(),
      { "claude/a": { reason: "conflict", capturedAt: "now" } },
    );
    assert.equal(s.rows[0].action, "defer");
  });
});

describe("reduce / cursor + scroll", () => {
  it("down moves cursor", () => {
    let s: AppState = initialState([fc({ relativePath: "a" }), fc({ relativePath: "b" })], vp());
    s = reduce(s, k("down"));
    assert.equal(s.cursor, 1);
  });

  it("up clamps at 0", () => {
    let s: AppState = initialState([fc({ relativePath: "a" }), fc({ relativePath: "b" })], vp());
    s = reduce(s, k("up"));
    assert.equal(s.cursor, 0);
  });

  it("end / home jump to extremes", () => {
    let s: AppState = initialState(
      Array.from({ length: 10 }, (_, i) => fc({ relativePath: `f${i}` })),
      vp(),
    );
    s = reduce(s, k("end"));
    assert.equal(s.cursor, 9);
    s = reduce(s, k("home"));
    assert.equal(s.cursor, 0);
  });

  it("scrolls down to keep cursor in view", () => {
    let s: AppState = initialState(
      Array.from({ length: 50 }, (_, i) => fc({ relativePath: `f${i}` })),
      vp(20, 80), // page = 20 - 6 = 14
    );
    const page = listPageSize(s);
    for (let i = 0; i < page + 2; i++) s = reduce(s, k("down"));
    assert.ok(s.listScroll > 0, "should have scrolled");
    assert.ok(s.cursor >= s.listScroll && s.cursor < s.listScroll + page);
  });
});

describe("reduce / cycle action", () => {
  it("right cycles push → delete-local → skip → push", () => {
    let s: AppState = initialState([fc({ relativePath: "a" })], vp());
    assert.equal(s.rows[0].action, "push");
    s = reduce(s, k("right"));
    assert.equal(s.rows[0].action, "delete-local");
    s = reduce(s, k("right"));
    assert.equal(s.rows[0].action, "skip");
    s = reduce(s, k("right"));
    assert.equal(s.rows[0].action, "push");
  });

  it("conflict cycle is keep-repo / keep-local", () => {
    const cycle = actionCycle(fc({ action: "conflict", side: "both", repoHash: "rh" }));
    assert.deepEqual(cycle, ["keep-repo", "keep-local"]);
  });

  it("space sets row to skip", () => {
    let s: AppState = initialState([fc({ relativePath: "a" })], vp());
    s = reduce(s, k("space"));
    assert.equal(s.rows[0].action, "skip");
  });
});

describe("reduce / merge events", () => {
  it("merge-success sets action=merge with content", () => {
    let s: AppState = initialState([fc({ action: "conflict", side: "both", repoHash: "rh" })], vp());
    s = reduce(s, { type: "merge-success", rowIndex: 0, merged: "MERGED" });
    assert.equal(s.rows[0].action, "merge");
    assert.equal(s.rows[0].mergedContent, "MERGED");
    assert.equal(s.rows[0].mergeError, undefined);
  });

  it("merge-failure keeps row as conflict and stamps error", () => {
    let s: AppState = initialState([fc({ action: "conflict", side: "both", repoHash: "rh" })], vp());
    s = reduce(s, { type: "merge-failure", rowIndex: 0, error: "no-auth" });
    assert.equal(s.rows[0].action, "conflict");
    assert.equal(s.rows[0].mergeError, "no-auth");
    // Apply gate must still block
    assert.equal(hasUnresolvedConflicts(s), true);
  });
});

describe("reduce / m key on conflict requests merge sentinel", () => {
  it("m sets sentinel message", () => {
    let s: AppState = initialState([fc({ action: "conflict", side: "both", repoHash: "rh" })], vp());
    s = reduce(s, k("m"));
    assert.match(s.message ?? "", /^__merge__:0$/);
  });

  it("m on non-conflict does nothing", () => {
    let s: AppState = initialState([fc({ action: "added", side: "local" })], vp());
    s = reduce(s, k("m"));
    assert.equal(s.message, undefined);
  });
});

describe("reduce / d key defers row", () => {
  it("d on a conflict row sets action=defer", () => {
    let s: AppState = initialState([fc({ action: "conflict", side: "both", repoHash: "rh" })], vp());
    s = reduce(s, k("d"));
    assert.equal(s.rows[0].action, "defer");
    assert.equal(hasUnresolvedConflicts(s), false);
  });
});

describe("reduce / bulk keys", () => {
  function rows() {
    return [
      fc({ relativePath: "loc-add", action: "added", side: "local" }),
      fc({ relativePath: "rep-add", action: "added", side: "repo", repoHash: "rh" }),
      fc({ relativePath: "conf",    action: "conflict", side: "both", repoHash: "rh" }),
      fc({ relativePath: "rep-del", action: "deleted", side: "repo" }),
    ];
  }

  it("1 = repo-wins maps actions appropriately", () => {
    let s: AppState = initialState(rows(), vp());
    s = reduce(s, k("1"));
    assert.equal(s.rows[0].action, "delete-local"); // local-only, no repo → delete-local
    assert.equal(s.rows[1].action, "pull");
    assert.equal(s.rows[2].action, "keep-repo");
    assert.equal(s.rows[3].action, "delete-local");
    assert.equal(hasUnresolvedConflicts(s), false);
  });

  it("2 = local-wins maps actions appropriately", () => {
    let s: AppState = initialState(rows(), vp());
    s = reduce(s, k("2"));
    assert.equal(s.rows[0].action, "push");
    assert.equal(s.rows[2].action, "keep-local");
    assert.equal(s.rows[3].action, "push");
  });

  it("3 = skip-all", () => {
    let s: AppState = initialState(rows(), vp());
    s = reduce(s, k("3"));
    assert.ok(s.rows.every((r) => r.action === "skip"));
  });

  it("4 = reset returns to engine defaults", () => {
    let s: AppState = initialState(rows(), vp());
    s = reduce(s, k("3"));
    s = reduce(s, k("4"));
    assert.equal(s.rows[0].action, "push");
    assert.equal(s.rows[2].action, "conflict");
  });
});

describe("filter + conflicts-only", () => {
  function set() {
    return initialState([
      fc({ relativePath: "alpha.md" }),
      fc({ relativePath: "beta.md" }),
      fc({ relativePath: "gamma.md", action: "conflict", side: "both", repoHash: "rh" }),
    ], vp());
  }

  it("/ + text + ENTER applies filter", () => {
    let s = set();
    s = reduce(s, k("/"));
    assert.equal(s.view, "filter-input");
    s = reduce(s, k("a"));
    s = reduce(s, k("l"));
    s = reduce(s, k("p"));
    s = reduce(s, k("h"));
    s = reduce(s, k("a"));
    s = reduce(s, k("enter"));
    assert.equal(s.filter, "alpha");
    const v = visibleIndices(s);
    assert.equal(v.length, 1);
  });

  it("c toggles conflicts-only", () => {
    let s = set();
    s = reduce(s, k("c"));
    assert.equal(s.conflictsOnly, true);
    assert.equal(visibleIndices(s).length, 1);
  });
});

describe("apply preview gate", () => {
  it("a opens preview; ENTER while conflict-present blocks", () => {
    let s: AppState = initialState([fc({ action: "conflict", side: "both", repoHash: "rh" })], vp());
    s = reduce(s, k("a"));
    assert.equal(s.view, "preview");
    s = reduce(s, k("enter"));
    assert.equal(s.applyConfirmed, false, "must not commit while conflicts unresolved");
    assert.equal(s.view, "list");
    assert.match(s.message ?? "", /unresolved conflict/);
  });

  it("ENTER after resolving conflicts commits", () => {
    let s: AppState = initialState([fc({ action: "conflict", side: "both", repoHash: "rh" })], vp());
    s = reduce(s, k("d")); // defer it
    s = reduce(s, k("a"));
    s = reduce(s, k("enter"));
    assert.equal(s.applyConfirmed, true);
  });

  it("y in preview no longer commits (must use ENTER)", () => {
    let s: AppState = initialState([fc()], vp());
    s = reduce(s, k("a"));
    assert.equal(s.view, "preview");
    s = reduce(s, k("y"));
    assert.equal(s.applyConfirmed, false);
    assert.equal(s.view, "preview");
  });

  it("q quits", () => {
    let s: AppState = initialState([fc()], vp());
    s = reduce(s, k("q"));
    assert.equal(s.quit, true);
  });

  it("ctrl-c quits", () => {
    let s: AppState = initialState([fc()], vp());
    s = reduce(s, k("c", { ctrl: true }));
    assert.equal(s.quit, true);
  });

  it("escape quits from list view", () => {
    let s: AppState = initialState([fc()], vp());
    s = reduce(s, k("escape"));
    assert.equal(s.quit, true);
  });
});

describe("actionCounts", () => {
  it("aggregates across rows", () => {
    const s: AppState = initialState([
      fc({ relativePath: "a", action: "added", side: "local" }),
      fc({ relativePath: "b", action: "added", side: "local" }),
      fc({ relativePath: "c", action: "conflict", side: "both", repoHash: "rh" }),
    ], vp());
    const counts = actionCounts(s);
    assert.equal(counts.push, 2);
    assert.equal(counts.conflict, 1);
  });
});

describe("resize", () => {
  it("updates viewport and reclamps scroll", () => {
    let s: AppState = initialState(
      Array.from({ length: 30 }, (_, i) => fc({ relativePath: `f${i}` })),
      vp(40, 80),
    );
    for (let i = 0; i < 25; i++) s = reduce(s, k("down"));
    const beforeScroll = s.listScroll;
    s = reduce(s, { type: "resize", viewport: { cols: 80, rows: 100 } });
    // With a much taller viewport, scroll should pull back toward 0.
    assert.ok(s.listScroll <= beforeScroll);
  });
});
