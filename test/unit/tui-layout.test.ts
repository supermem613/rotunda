import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render, stripAnsi } from "../../src/tui/layout.js";
import { initialState, reduce, type AppState } from "../../src/tui/state.js";
import type { FileChange } from "../../src/core/types.js";

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

function noLineExceeds(text: string, cols: number): void {
  const lines = stripAnsi(text).split("\n");
  for (const l of lines) {
    assert.ok(
      l.length <= cols,
      `line "${l.slice(0, 40)}…" length ${l.length} > cols ${cols}`,
    );
  }
}

describe("layout / list view fits viewport at multiple sizes", () => {
  const sizes: Array<[number, number]> = [
    [80, 24],
    [120, 40],
    [200, 60],
    [40, 10],
  ];

  for (const [cols, rows] of sizes) {
    it(`${cols}x${rows}`, () => {
      const state: AppState = initialState(
        Array.from({ length: 100 }, (_, i) =>
          fc({
            relativePath: `dir/f${i}-with-a-fairly-long-name.md`,
            action: i % 5 === 0 ? "conflict" : "added",
            side: i % 5 === 0 ? "both" : "local",
            repoHash: i % 5 === 0 ? "rh" : undefined,
          }),
        ),
        { cols, rows },
      );
      const out = render(state);
      noLineExceeds(out, cols);
      // Header + footer present
      assert.match(stripAnsi(out), /rotunda sync/);
    });
  }
});

describe("layout / diff modal", () => {
  it("renders diff lines and respects diff scroll", () => {
    let state: AppState = initialState([fc({ action: "modified", side: "local" })], { cols: 80, rows: 24 });
    state = reduce(state, { type: "key", key: { name: "enter" } });
    state = reduce(state, { type: "diff-loaded", rowIndex: 0, diff:
      "+++ a/b\n--- a/b\n@@ -1 +1 @@\n-old\n+new" });
    const out = stripAnsi(render(state));
    assert.match(out, /DIFF/);
    assert.match(out, /old/);
    assert.match(out, /new/);
  });

  it("pagedown past EOF then pageup scrolls back immediately (regression)", () => {
    let state: AppState = initialState([fc({ action: "modified", side: "local" })], { cols: 80, rows: 24 });
    state = reduce(state, { type: "key", key: { name: "enter" } });
    const diff = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    state = reduce(state, { type: "diff-loaded", rowIndex: 0, diff });
    // page size for 24 rows is 21 → max diffScroll = 30-21 = 9
    state = reduce(state, { type: "key", key: { name: "pagedown" } });
    state = reduce(state, { type: "key", key: { name: "pagedown" } });
    state = reduce(state, { type: "key", key: { name: "pagedown" } });
    assert.equal(state.diffScroll, 9, "should clamp to max, not accumulate");
    state = reduce(state, { type: "key", key: { name: "pageup" } });
    assert.ok(state.diffScroll < 9, "single pageup must move the view");
  });

  it("end jumps to bottom, home jumps to top", () => {
    let state: AppState = initialState([fc({ action: "modified", side: "local" })], { cols: 80, rows: 24 });
    state = reduce(state, { type: "key", key: { name: "enter" } });
    const diff = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n");
    state = reduce(state, { type: "diff-loaded", rowIndex: 0, diff });
    state = reduce(state, { type: "key", key: { name: "end" } });
    assert.equal(state.diffScroll, 100 - 21);
    state = reduce(state, { type: "key", key: { name: "home" } });
    assert.equal(state.diffScroll, 0);
  });
});

describe("layout / preview view", () => {
  it("blocks apply when there are conflicts", () => {
    const state: AppState = initialState(
      [fc({ action: "conflict", side: "both", repoHash: "rh" })],
      { cols: 80, rows: 24 },
    );
    const open = reduce(state, { type: "key", key: { name: "a" } });
    const out = stripAnsi(render(open));
    assert.match(out, /1 unresolved conflict/);
    assert.doesNotMatch(out, /apply now/);
  });

  it("shows apply prompt when fully resolved", () => {
    let state: AppState = initialState(
      [fc({ action: "added", side: "local" })],
      { cols: 80, rows: 24 },
    );
    state = reduce(state, { type: "key", key: { name: "a" } });
    const out = stripAnsi(render(state));
    assert.match(out, /apply now/);
  });
});
