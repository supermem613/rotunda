/**
 * Pure state + reducer for the rotunda sync TUI.
 *
 * Everything here is side-effect free: `initialState` builds the world from
 * a list of FileChange, and `reduce(state, event)` is the single mutator.
 * I/O lives in src/tui/screen.ts; rendering lives in src/tui/layout.ts.
 *
 * Test discipline: every key/event must be expressible as an `Event` so the
 * reducer can be tested with synthetic streams without a real terminal.
 */

import type { FileChange } from "../core/types.js";

/** What we will actually do with a row when the user hits Apply. */
export type ResolvedAction =
  | "push"          // local → repo
  | "pull"          // repo → local
  | "delete-local"  // remove local file
  | "delete-repo"   // remove from repo
  | "keep-local"    // conflict resolved: take local, push to repo
  | "keep-repo"     // conflict resolved: take repo, copy to local
  | "merge"         // conflict resolved: write merged content (merged stored on row)
  | "defer"         // snapshot to .rotunda/conflicts/, skip
  | "skip"          // do nothing this run
  | "conflict";     // unresolved — apply gate refuses to commit

/** A single row in the TUI list. Wraps a FileChange with user/UI state. */
export interface Row {
  change: FileChange;
  /**
   * The action that will execute on Apply. Computed once at initialState time
   * from the engine's classification, then mutated only by user events. We
   * store the resolved value (never a "default") so render and apply share
   * one source of truth — no implicit fall-throughs.
   */
  action: ResolvedAction;
  /**
   * For 'merge' rows: the LLM-merged content. Apply writes this to local AND
   * pushes it to repo. Hash of these bytes goes into state (not localHash).
   */
  mergedContent?: string;
  /**
   * Last LLM-merge attempt error, if any. Surfaced in the row label so the
   * user sees WHY merge failed (no auth, API error, empty response, etc.)
   * and can decide whether to retry, pick a side, or defer.
   */
  mergeError?: string;
  /**
   * Cached unified diff, pre-normalized (CR stripped, tabs expanded) and
   * split into lines. Populated lazily when the modal opens.
   *
   * Stored as a string[] (not the raw string) because rendering the diff
   * view and clamping scroll each need an array of lines. Normalising and
   * splitting once on diff-loaded — rather than on every keypress — keeps
   * ESC / scroll responsive when the diff is large.
   */
  diffLines?: string[];
}

/** Top-level view of the TUI. Each maps to a different render function. */
export type View = "list" | "diff" | "preview" | "filter-input";

/** Sorting / grouping mode for the list view. */
export type GroupBy = "root" | "action";

/** Terminal viewport. Recomputed every frame from process.stdout. */
export interface Viewport {
  cols: number;
  rows: number;
}

export interface AppState {
  rows: Row[];
  cursor: number;          // index into rows (filtered view); 0 if rows empty
  view: View;
  groupBy: GroupBy;
  /** Glob substring filter; "" = no filter. Conflict-only is a separate flag. */
  filter: string;
  filterDraft: string;     // text being typed in 'filter-input' view
  conflictsOnly: boolean;
  /** Vertical scroll offset for the list view (top-of-viewport row index). */
  listScroll: number;
  /** Vertical scroll offset within the modal diff overlay. */
  diffScroll: number;
  /** Last status / error message shown in the footer. Cleared on next event. */
  message?: string;
  /** Set true when user confirms apply preview; the runner consumes & exits. */
  applyConfirmed: boolean;
  /** Set true when user quits without applying. */
  quit: boolean;
  viewport: Viewport;
}

/** Discriminated union of every possible UI event. */
export type Event =
  | { type: "key"; key: Key }
  | { type: "resize"; viewport: Viewport }
  | { type: "diff-loaded"; rowIndex: number; diff: string }
  | { type: "merge-success"; rowIndex: number; merged: string }
  | { type: "merge-failure"; rowIndex: number; error: string };

/** Normalized key event from src/tui/keys.ts. */
export interface Key {
  /** Single printable char OR named key. */
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** Raw sequence, mainly for debugging / unhandled cases. */
  sequence?: string;
}

// ────────────────────────────────────────────────────────────
// Initial state
// ────────────────────────────────────────────────────────────

/**
 * Build the engine-default action for a single FileChange. This is the only
 * place that bakes engine semantics into the TUI; the reducer only mutates
 * actions in response to explicit user input from here.
 *
 * Per project decision (no fresh-install special-casing): defaults are the
 * engine's classification, plain. Local-only with empty state defaults to
 * 'push'. The TUI's bulk keys + visible action column are the safety, not
 * a heuristic shift in defaults.
 */
export function defaultAction(change: FileChange): ResolvedAction {
  if (change.action === "conflict") return "conflict";
  if (change.side === "local") {
    if (change.action === "added" || change.action === "modified") return "push";
    if (change.action === "deleted") return "delete-repo";
  }
  if (change.side === "repo") {
    if (change.action === "added" || change.action === "modified") return "pull";
    if (change.action === "deleted") return "delete-local";
  }
  // 'both' with non-conflict action shouldn't reach here (engine collapses
  // identical-content additions). Treat as skip if it does.
  return "skip";
}

export function initialState(
  changes: FileChange[],
  viewport: Viewport,
  deferred: Record<string, { reason: string; capturedAt: string }> = {},
): AppState {
  const rows: Row[] = changes.map((change) => {
    const stateKey = `${change.rootName}/${change.relativePath}`;
    const isDeferred = !!deferred[stateKey];
    return {
      change,
      action: isDeferred ? "defer" : defaultAction(change),
    };
  });
  return {
    rows,
    cursor: 0,
    view: "list",
    groupBy: "root",
    filter: "",
    filterDraft: "",
    conflictsOnly: false,
    listScroll: 0,
    diffScroll: 0,
    applyConfirmed: false,
    quit: false,
    viewport,
  };
}

// ────────────────────────────────────────────────────────────
// Selectors (pure helpers used by reducer + layout)
// ────────────────────────────────────────────────────────────

/**
 * Filtered indices into state.rows that should currently be visible.
 * Order is preserved from state.rows (which is already sorted by engine).
 * Tests rely on this being a pure function of state.
 */
export function visibleIndices(state: AppState): number[] {
  const out: number[] = [];
  const f = state.filter.toLowerCase();
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    if (state.conflictsOnly && r.action !== "conflict") continue;
    if (f) {
      const hay = `${r.change.rootName}/${r.change.relativePath}`.toLowerCase();
      if (!hay.includes(f)) continue;
    }
    out.push(i);
  }
  return out;
}

/** True if at least one row is unresolved-conflict. Apply gate uses this. */
export function hasUnresolvedConflicts(state: AppState): boolean {
  return state.rows.some((r) => r.action === "conflict");
}

/** Aggregate counts by ResolvedAction — used in the apply preview. */
export function actionCounts(state: AppState): Record<ResolvedAction, number> {
  const counts: Record<ResolvedAction, number> = {
    push: 0, pull: 0, "delete-local": 0, "delete-repo": 0,
    "keep-local": 0, "keep-repo": 0, merge: 0, defer: 0, skip: 0, conflict: 0,
  };
  for (const r of state.rows) counts[r.action]++;
  return counts;
}

// ────────────────────────────────────────────────────────────
// Reducer
// ────────────────────────────────────────────────────────────

/**
 * Pure reducer: (state, event) → state. NEVER mutates the input.
 *
 * All key handling is centralised here. The screen layer only translates
 * raw input into Event objects and calls reduce().
 */
export function reduce(state: AppState, event: Event): AppState {
  // Clear any stale status message on every event (errors are explicit).
  const base: AppState = state.message ? { ...state, message: undefined } : state;

  switch (event.type) {
    case "resize":
      return clampScroll({ ...base, viewport: event.viewport });

    case "diff-loaded": {
      const rows = base.rows.slice();
      rows[event.rowIndex] = {
        ...rows[event.rowIndex],
        diffLines: normalizeDiff(event.diff),
      };
      const next = { ...base, rows };
      // Re-clamp scroll now that we know real line count (handles
      // user pressing 'end' / pagedown before diff finished loading).
      if (event.rowIndex === next.cursor && next.view === "diff") {
        return setDiffScroll(next, next.diffScroll);
      }
      return next;
    }

    case "merge-success": {
      const rows = base.rows.slice();
      const r = rows[event.rowIndex];
      rows[event.rowIndex] = {
        ...r,
        action: "merge",
        mergedContent: event.merged,
        mergeError: undefined,
      };
      return { ...base, rows, message: "Merge applied. Press [a] to commit." };
    }

    case "merge-failure": {
      const rows = base.rows.slice();
      const r = rows[event.rowIndex];
      // Stay as conflict — never silently approve. Surface the error so the
      // user understands WHY merge didn't take and can pick a side or retry.
      rows[event.rowIndex] = {
        ...r,
        action: "conflict",
        mergeError: event.error,
      };
      return { ...base, rows, message: `Merge failed: ${event.error}` };
    }

    case "key":
      return reduceKey(base, event.key);
  }
}

function reduceKey(state: AppState, key: Key): AppState {
  // Filter input view eats most keys.
  if (state.view === "filter-input") {
    return reduceFilterInput(state, key);
  }
  // Diff modal has its own bindings (with shared per-row actions).
  if (state.view === "diff") {
    return reduceDiff(state, key);
  }
  // Apply preview is a yes/no gate.
  if (state.view === "preview") {
    return reducePreview(state, key);
  }
  return reduceList(state, key);
}

function reduceList(state: AppState, key: Key): AppState {
  // Quit
  if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
    return { ...state, quit: true };
  }

  // Cursor movement
  const visible = visibleIndices(state);
  if (visible.length === 0) {
    // No visible rows: only quit / filter / preview / mode toggles meaningful.
    return reduceListGlobalKeys(state, key);
  }
  // Translate cursor (which is an index into rows[]) to a position in visible[].
  let pos = visible.indexOf(state.cursor);
  if (pos < 0) pos = 0;

  switch (key.name) {
    case "up":
      pos = Math.max(0, pos - 1);
      return clampScroll({ ...state, cursor: visible[pos] });
    case "down":
      pos = Math.min(visible.length - 1, pos + 1);
      return clampScroll({ ...state, cursor: visible[pos] });
    case "pageup":
      pos = Math.max(0, pos - listPageSize(state));
      return clampScroll({ ...state, cursor: visible[pos] });
    case "pagedown":
      pos = Math.min(visible.length - 1, pos + listPageSize(state));
      return clampScroll({ ...state, cursor: visible[pos] });
    case "home":
      return clampScroll({ ...state, cursor: visible[0] });
    case "end":
      return clampScroll({ ...state, cursor: visible[visible.length - 1] });
    case "return": // ENTER
    case "enter":
      return { ...state, view: "diff", diffScroll: 0 };
    case "left":
      return cycleAction(state, state.cursor, -1);
    case "right":
      return cycleAction(state, state.cursor, +1);
    case "space":
      return setRowAction(state, state.cursor, "skip");
    case "m":
      return requestMerge(state, state.cursor);
    case "e":
      // Editor flow is I/O-driven; reducer just signals via message.
      // The screen layer reads message === '__editor__' to know to act.
      return { ...state, message: `__editor__:${state.cursor}` };
    case "d":
      // Defer is a row action — no I/O at TUI time; snapshot happens at apply.
      return setRowAction(state, state.cursor, "defer");
  }
  return reduceListGlobalKeys(state, key);
}

function reduceListGlobalKeys(state: AppState, key: Key): AppState {
  switch (key.name) {
    case "1":
      return bulkApply(state, "repo-wins");
    case "2":
      return bulkApply(state, "local-wins");
    case "3":
      return bulkApply(state, "skip-all");
    case "4":
      return bulkApply(state, "reset");
    case "c": {
      const next: AppState = { ...state, conflictsOnly: !state.conflictsOnly };
      return clampScroll({ ...next, cursor: firstVisible(next) });
    }
    case "g":
      return { ...state, groupBy: state.groupBy === "root" ? "action" : "root" };
    case "/":
      return { ...state, view: "filter-input", filterDraft: state.filter };
    case "a":
      return { ...state, view: "preview" };
  }
  return state;
}

function reduceFilterInput(state: AppState, key: Key): AppState {
  if (key.name === "escape") {
    return { ...state, view: "list", filterDraft: state.filter };
  }
  if (key.name === "return" || key.name === "enter") {
    const next: AppState = { ...state, view: "list", filter: state.filterDraft };
    return clampScroll({ ...next, cursor: firstVisible(next) });
  }
  if (key.name === "backspace") {
    return { ...state, filterDraft: state.filterDraft.slice(0, -1) };
  }
  // Single printable character
  if (key.name.length === 1 && !key.ctrl && !key.meta) {
    return { ...state, filterDraft: state.filterDraft + key.name };
  }
  return state;
}

function reduceDiff(state: AppState, key: Key): AppState {
  switch (key.name) {
    case "escape":
    case "q":
      return { ...state, view: "list", diffScroll: 0 };
    case "up":
      return setDiffScroll(state, state.diffScroll - 1);
    case "down":
      return setDiffScroll(state, state.diffScroll + 1);
    case "pageup":
      return setDiffScroll(state, state.diffScroll - diffPageSize(state));
    case "pagedown":
      return setDiffScroll(state, state.diffScroll + diffPageSize(state));
    case "home":
      return setDiffScroll(state, 0);
    case "end":
      return setDiffScroll(state, Number.MAX_SAFE_INTEGER);
    // Per-row action keys also work inside the modal so the user can decide
    // while still reading the diff.
    case "left":
      return cycleAction(state, state.cursor, -1);
    case "right":
      return cycleAction(state, state.cursor, +1);
    case "space":
      return setRowAction(state, state.cursor, "skip");
    case "m":
      return requestMerge(state, state.cursor);
    case "d":
      return setRowAction(state, state.cursor, "defer");
    case "e":
      return { ...state, message: `__editor__:${state.cursor}` };
  }
  return state;
}

function reducePreview(state: AppState, key: Key): AppState {
  if (key.name === "return" || key.name === "enter") {
    if (hasUnresolvedConflicts(state)) {
      const n = state.rows.filter((r) => r.action === "conflict").length;
      return {
        ...state,
        view: "list",
        message: `${n} unresolved conflict${n === 1 ? "" : "s"}. Resolve them or press [d] to defer.`,
      };
    }
    return { ...state, applyConfirmed: true };
  }
  if (key.name === "escape" || key.name === "n") {
    return { ...state, view: "list" };
  }
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    return { ...state, quit: true };
  }
  return state;
}

// ────────────────────────────────────────────────────────────
// Per-row action machinery
// ────────────────────────────────────────────────────────────

/**
 * Allowed actions for a row, in the order ←/→ cycle through them.
 * Order is the canonical UX cycle and is intentionally exhaustive; if the
 * engine ever produces a side/action combo not enumerated here we fall back
 * to ['skip'] so the row is still safe.
 */
export function actionCycle(change: FileChange): ResolvedAction[] {
  if (change.action === "conflict") {
    // For conflicts, ←/→ cycles the two winner picks plus skip. Merge / defer /
    // editor are letter-keys that jump out of the cycle.
    return ["keep-repo", "keep-local", "skip"];
  }
  if (change.side === "local") {
    if (change.action === "deleted") return ["delete-repo", "skip"];
    // local-only / locally-modified: push (default), delete the local file, or skip.
    return ["push", "delete-local", "skip"];
  }
  if (change.side === "repo") {
    if (change.action === "deleted") return ["delete-local", "skip"];
    // repo-only / repo-modified: pull (default), delete the repo file, or skip.
    return ["pull", "delete-repo", "skip"];
  }
  return ["skip"];
}

function cycleAction(state: AppState, rowIndex: number, dir: 1 | -1): AppState {
  const row = state.rows[rowIndex];
  if (!row) return state;
  const cycle = actionCycle(row.change);
  // If the row is currently in a non-cycle action (merge / defer / merge-error
  // conflict), entering the cycle starts at the natural pick for that side.
  let idx = cycle.indexOf(row.action);
  if (idx < 0) {
    idx = dir > 0 ? -1 : cycle.length;
  }
  const next = cycle[(idx + dir + cycle.length) % cycle.length];
  return setRowAction(state, rowIndex, next);
}

function setRowAction(state: AppState, rowIndex: number, action: ResolvedAction): AppState {
  const row = state.rows[rowIndex];
  if (!row) return state;
  // Setting any action other than 'merge' invalidates a stale mergedContent.
  const cleaned: Row = action === "merge"
    ? { ...row, action }
    : { ...row, action, mergedContent: undefined, mergeError: undefined };
  const rows = state.rows.slice();
  rows[rowIndex] = cleaned;
  return { ...state, rows };
}

function requestMerge(state: AppState, rowIndex: number): AppState {
  const row = state.rows[rowIndex];
  if (!row || row.change.action !== "conflict") return state;
  // The screen layer is responsible for actually invoking the LLM and
  // dispatching merge-success / merge-failure events. We just signal here.
  return { ...state, message: `__merge__:${rowIndex}` };
}

type BulkOp = "repo-wins" | "local-wins" | "skip-all" | "reset";

function bulkApply(state: AppState, op: BulkOp): AppState {
  const rows = state.rows.map((r): Row => {
    if (op === "reset") {
      return { ...r, action: defaultAction(r.change), mergedContent: undefined, mergeError: undefined };
    }
    if (op === "skip-all") {
      return { ...r, action: "skip", mergedContent: undefined, mergeError: undefined };
    }
    // For 'repo-wins' / 'local-wins', map per row class.
    const winner: "repo" | "local" = op === "repo-wins" ? "repo" : "local";
    return { ...r, action: bulkActionFor(r, winner), mergedContent: undefined, mergeError: undefined };
  });
  return { ...state, rows };
}

function bulkActionFor(r: Row, winner: "repo" | "local"): ResolvedAction {
  const c = r.change;
  if (c.action === "conflict") {
    return winner === "repo" ? "keep-repo" : "keep-local";
  }
  if (c.side === "local") {
    if (c.action === "deleted") {
      // local file gone: repo-wins restores it (pull); local-wins propagates the deletion.
      return winner === "repo" ? "pull" : "delete-repo";
    }
    // local-only / locally-modified: local-wins pushes; repo-wins reverts local to repo (or skip if no repo file).
    if (winner === "local") return "push";
    return c.repoHash !== undefined ? "pull" : "delete-local";
  }
  if (c.side === "repo") {
    if (c.action === "deleted") {
      return winner === "repo" ? "delete-local" : "push";
    }
    if (winner === "repo") return "pull";
    return c.localHash !== undefined ? "push" : "delete-repo";
  }
  return "skip";
}

// ────────────────────────────────────────────────────────────
// Scroll / layout helpers (pure)
// ────────────────────────────────────────────────────────────

/**
 * Number of rows visible in the list region, given the current viewport.
 * Header (3) + footer (2) + a 1-line status margin = 6 reserved rows.
 */
export function listPageSize(state: AppState): number {
  return Math.max(1, state.viewport.rows - 6);
}

/** Number of rows visible in the diff modal. Title + footer take 3. */
export function diffPageSize(state: AppState): number {
  return Math.max(1, state.viewport.rows - 3);
}

/**
 * Clamp diff scroll against the current row's diff length. Pure.
 * Bug fix: without clamping, pagedown past EOF inflates diffScroll, then
 * pageup/up has to subtract many invisible "ghost" lines before the view
 * actually moves.
 */
function setDiffScroll(state: AppState, requested: number): AppState {
  const row = state.rows[state.cursor];
  const totalLines = row?.diffLines?.length ?? 0;
  const max = Math.max(0, totalLines - diffPageSize(state));
  const clamped = Math.max(0, Math.min(requested, max));
  return { ...state, diffScroll: clamped };
}

/**
 * Normalise a raw unified diff into an array of lines ready for the diff
 * view. Strips CRs (Windows line endings would wrap the cursor back to
 * col 0 mid-frame and overwrite earlier output) and expands tabs so
 * padRow's width math matches what the terminal actually displays.
 *
 * Runs once when diff-loaded fires — not on every frame or scroll
 * keystroke. For a multi-megabyte diff this moves O(N) work out of the
 * render path, which is the difference between an instant ESC-to-list
 * and a visibly laggy one.
 */
export function normalizeDiff(diff: string): string[] {
  return diff.replace(/\r/g, "").replace(/\t/g, "    ").split("\n");
}

function firstVisible(state: AppState): number {
  const v = visibleIndices(state);
  return v.length > 0 ? v[0] : 0;
}

/**
 * Keep listScroll such that the cursor is in view. Called after any cursor
 * or viewport change. Pure — does not touch state.cursor.
 */
function clampScroll(state: AppState): AppState {
  const visible = visibleIndices(state);
  if (visible.length === 0) {
    return { ...state, listScroll: 0 };
  }
  const cursorPos = Math.max(0, visible.indexOf(state.cursor));
  const page = listPageSize(state);
  let scroll = state.listScroll;
  if (cursorPos < scroll) scroll = cursorPos;
  if (cursorPos >= scroll + page) scroll = cursorPos - page + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, visible.length - page)));
  return { ...state, listScroll: scroll };
}
