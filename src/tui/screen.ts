/**
 * TUI runtime: alt-screen, raw mode, keyboard, resize, modal side effects.
 *
 * This is the only file in src/tui/ that does I/O. Everything else is pure.
 *
 * Usage:
 *   const result = await runTui({ initialChanges, manifest, cwd, deferred, ... });
 *   if (result.applied) { ... commit gitPaths ... } else if (result.quit) { ... }
 */

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gitDiffFiles } from "../utils/git.js";
import { loadToken } from "../llm/auth.js";
import { mergeViaLLM } from "../llm/merge.js";
import type { Manifest, FileChange, SyncState } from "../core/types.js";
import { reduce, initialState, type AppState, type Event, type Viewport } from "./state.js";
import { renderFrame } from "./layout.js";
import { subscribeKeys } from "./keys.js";

const ANSI_ALT_SCREEN_ON = "\x1b[?1049h";
const ANSI_ALT_SCREEN_OFF = "\x1b[?1049l";
const ANSI_HIDE_CURSOR = "\x1b[?25l";
const ANSI_SHOW_CURSOR = "\x1b[?25h";

export interface RunTuiOptions {
  changes: FileChange[];
  manifest: Manifest;
  cwd: string;
  state: SyncState;
  /** Inject for tests; defaults to real stdout/stdin. */
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

export interface TuiResult {
  /** True if the user pressed Apply and the gate passed. */
  applied: boolean;
  /** True if the user quit without applying. */
  quit: boolean;
  /** Final reducer state (rows + actions) — caller maps to ApplyPlan. */
  state: AppState;
}

/**
 * Run the TUI. Resolves when the user applies or quits. Always restores
 * the terminal — even on uncaught errors — via the cleanup chain in finally.
 */
export async function runTui(opts: RunTuiOptions): Promise<TuiResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;

  const viewport = currentViewport(stdout);
  let state: AppState = initialState(opts.changes, viewport, opts.state.deferred);

  // Event loop primitives
  let pendingResolver: ((evt: Event) => void) | null = null;
  const queue: Event[] = [];
  const push = (evt: Event): void => {
    if (pendingResolver) {
      const r = pendingResolver;
      pendingResolver = null;
      r(evt);
    } else {
      queue.push(evt);
    }
  };
  const next = (): Promise<Event> =>
    new Promise((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else pendingResolver = resolve;
    });

  // Wire input
  const unsubKeys = subscribeKeys(stdin, (key) => push({ type: "key", key }));

  // Resize: native event + 1s poll for older Windows consoles that don't fire it.
  const onResize = (): void => push({ type: "resize", viewport: currentViewport(stdout) });
  stdout.on("resize", onResize);
  let lastV = viewport;
  const pollTimer = setInterval(() => {
    const v = currentViewport(stdout);
    if (v.cols !== lastV.cols || v.rows !== lastV.rows) {
      lastV = v;
      onResize();
    }
  }, 1000);

  // Signal handlers — Ctrl-C should quit cleanly, not crash the process.
  const onSigInt = (): void => push({ type: "key", key: { name: "c", ctrl: true } });
  process.on("SIGINT", onSigInt);

  // Enter alt-screen + hide cursor
  stdout.write(ANSI_ALT_SCREEN_ON + ANSI_HIDE_CURSOR);

  const cleanup = (): void => {
    try { unsubKeys(); } catch { /* ignore */ }
    try { stdout.off("resize", onResize); } catch { /* ignore */ }
    clearInterval(pollTimer);
    process.off("SIGINT", onSigInt);
    stdout.write(ANSI_SHOW_CURSOR + ANSI_ALT_SCREEN_OFF);
  };

  try {
    // Prime first frame
    stdout.write(renderFrame(state));

    while (!state.applyConfirmed && !state.quit) {
      const evt = await next();
      const before = state;
      state = reduce(state, evt);

      // Dispatch any sentinel-message side effects.
      if (state.message && state.message !== before.message) {
        const m = state.message;
        if (m.startsWith("__merge__:"))  void runMerge(parseInt(m.slice("__merge__:".length), 10), state, opts, push);
        if (m.startsWith("__editor__:")) void runEditor(parseInt(m.slice("__editor__:".length), 10), state, opts, stdout, push, () => state);
      }

      // Lazy diff load when the user opens the modal
      if (state.view === "diff" && before.view !== "diff") {
        const idx = state.cursor;
        const row = state.rows[idx];
        if (row && !row.diffLines) {
          void loadDiff(idx, opts).then((diff) => push({ type: "diff-loaded", rowIndex: idx, diff }));
        }
      }

      stdout.write(renderFrame(state));
    }
  } finally {
    cleanup();
  }

  return { applied: state.applyConfirmed, quit: state.quit, state };
}

function currentViewport(stdout: NodeJS.WriteStream): Viewport {
  return {
    cols: typeof stdout.columns === "number" && stdout.columns > 0 ? stdout.columns : 80,
    rows: typeof stdout.rows === "number" && stdout.rows > 0 ? stdout.rows : 24,
  };
}

// ────────────────────────────────────────────────────────────
// Side-effect helpers (only called from runTui)
// ────────────────────────────────────────────────────────────

async function loadDiff(rowIndex: number, opts: RunTuiOptions): Promise<string> {
  const row = opts.changes[rowIndex];
  const root = opts.manifest.roots.find((r) => r.repo === row.rootName);
  if (!root) return "(root not in manifest)";
  const localFile = join(root.local, row.relativePath);
  const repoFile = join(opts.cwd, root.repo, row.relativePath);
  try {
    if (row.action === "added" && row.side === "local") {
      const content = await readFile(localFile, "utf-8").catch(() => "(unreadable)");
      return `+++ local (new file)\n${prefix(content, "+ ")}`;
    }
    if (row.action === "added" && row.side === "repo") {
      const content = await readFile(repoFile, "utf-8").catch(() => "(unreadable)");
      return `+++ repo (new file)\n${prefix(content, "+ ")}`;
    }
    if (row.action === "deleted" && row.side === "local") {
      const content = await readFile(repoFile, "utf-8").catch(() => "(unreadable)");
      return `--- local (deleted)\n${prefix(content, "- ")}`;
    }
    if (row.action === "deleted" && row.side === "repo") {
      const content = await readFile(localFile, "utf-8").catch(() => "(unreadable)");
      return `--- repo (deleted)\n${prefix(content, "- ")}`;
    }
    return await gitDiffFiles(repoFile, localFile);
  } catch (err) {
    return `(diff failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function prefix(s: string, p: string): string {
  return s.split("\n").map((l) => p + l).join("\n");
}

async function runMerge(
  rowIndex: number,
  state: AppState,
  opts: RunTuiOptions,
  push: (e: Event) => void,
): Promise<void> {
  const row = state.rows[rowIndex];
  if (!row) return;
  const root = opts.manifest.roots.find((r) => r.repo === row.change.rootName);
  if (!root) {
    push({ type: "merge-failure", rowIndex, error: "root not in manifest" });
    return;
  }
  const localFile = join(root.local, row.change.relativePath);
  const repoFile = join(opts.cwd, root.repo, row.change.relativePath);
  let local = "";
  let repo = "";
  try {
    local = await readFile(localFile, "utf-8");
  } catch {
    push({ type: "merge-failure", rowIndex, error: "local unreadable" });
    return;
  }
  try {
    repo = await readFile(repoFile, "utf-8");
  } catch {
    push({ type: "merge-failure", rowIndex, error: "repo unreadable" });
    return;
  }

  const token = await loadToken().catch(() => null);
  const result = await mergeViaLLM(token, {
    path: row.change.rootName + "/" + row.change.relativePath,
    base: null, // We don't store base content; LLM is told to treat as new.
    local,
    repo,
  });
  if (result.ok) {
    push({ type: "merge-success", rowIndex, merged: result.content });
  } else {
    push({ type: "merge-failure", rowIndex, error: `${result.error}: ${result.detail}` });
  }
}

async function runEditor(
  rowIndex: number,
  state: AppState,
  opts: RunTuiOptions,
  stdout: NodeJS.WriteStream,
  push: (e: Event) => void,
  getState: () => AppState,
): Promise<void> {
  const row = state.rows[rowIndex];
  if (!row) return;
  const root = opts.manifest.roots.find((r) => r.repo === row.change.rootName);
  if (!root) return;
  const localFile = join(root.local, row.change.relativePath);
  const repoFile = join(opts.cwd, root.repo, row.change.relativePath);

  // Suspend alt-screen so the editor takes over the terminal cleanly.
  stdout.write(ANSI_ALT_SCREEN_OFF + ANSI_SHOW_CURSOR);
  try {
    spawnSync("code", ["--diff", repoFile, localFile, "--wait"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  } catch {
    // ignore — push a message via failure event
  }
  stdout.write(ANSI_ALT_SCREEN_ON + ANSI_HIDE_CURSOR);
  // Re-render the *current* state, not the snapshot we captured.
  stdout.write(renderFrame(getState()));
  // Editor return is a "diff-loaded" no-op; actual rehash will happen on
  // next sync re-run. We surface a benign info nudge by re-marking the row
  // as conflict so the user re-decides.
  push({
    type: "merge-failure",
    rowIndex,
    error: "editor closed — re-run sync to pick up your edits",
  });
}
