/**
 * Apply pass: take resolved Rows from the TUI and execute them against
 * disk + git, then update sync state.
 *
 * Split into two layers:
 *   1. `planApply(rows)`  — pure: classifies rows into ApplyOps
 *   2. `executeApply(...)` — does the I/O (fs + git stage) given the plan
 *
 * The reducer + TUI never call `executeApply` directly; the sync command
 * does, and it does so only after the user confirms in the preview AND
 * after the apply gate has verified there are no unresolved-conflict rows.
 */

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Manifest, SyncState, FileChange } from "../core/types.js";
import { hashContent } from "../utils/hash.js";
import {
  updateStateFiles,
  removeFromState,
  setDeferred,
  clearDeferred,
} from "../core/state.js";
import { getDeferDir } from "./conflicts.js";
import type { ResolvedAction, Row } from "../tui/state.js";

export interface ApplyOp {
  row: Row;
  /** What this op will do at I/O time. Renamed/normalized from row.action. */
  kind: ResolvedAction;
}

export interface ApplyPlan {
  ops: ApplyOp[];
  /** Number of rows that will produce git changes (push/delete-repo/keep-local/merge). */
  gitTouches: number;
  /** Number of rows that will modify local disk (pull/delete-local/keep-repo/merge). */
  localTouches: number;
}

/** Pure: classify rows into ops, dropping skip/conflict. */
export function planApply(rows: Row[]): ApplyPlan {
  const ops: ApplyOp[] = [];
  let gitTouches = 0;
  let localTouches = 0;
  for (const row of rows) {
    if (row.action === "skip" || row.action === "conflict") continue;
    ops.push({ row, kind: row.action });
    if (touchesGit(row.action)) gitTouches++;
    if (touchesLocal(row.action)) localTouches++;
  }
  return { ops, gitTouches, localTouches };
}

function touchesGit(a: ResolvedAction): boolean {
  return a === "push" || a === "delete-repo" || a === "keep-local" || a === "merge";
}

function touchesLocal(a: ResolvedAction): boolean {
  return a === "pull" || a === "delete-local" || a === "keep-repo" || a === "merge";
}

export interface ExecuteResult {
  /** Final sync state after the apply pass (caller persists it). */
  state: SyncState;
  /** Repo-relative paths that should be staged + committed. */
  gitPaths: string[];
  /** Per-op result lines for printing. */
  log: string[];
}

/**
 * Execute a plan against the filesystem.
 *
 * Throws only on truly unrecoverable errors (e.g., manifest root missing).
 * Per-op failures are caught and reported in the log so one bad row
 * doesn't abort the rest of the apply.
 */
export async function executeApply(
  plan: ApplyPlan,
  manifest: Manifest,
  cwd: string,
  initialState: SyncState,
): Promise<ExecuteResult> {
  let state: SyncState = { ...initialState, files: { ...initialState.files }, deferred: { ...(initialState.deferred ?? {}) } };
  const gitPaths: string[] = [];
  const log: string[] = [];

  for (const op of plan.ops) {
    const change = op.row.change;
    const rootDef = manifest.roots.find((r) => r.repo === change.rootName);
    if (!rootDef) {
      log.push(`SKIP ${change.rootName}/${change.relativePath} (root not in manifest)`);
      continue;
    }
    const localFile = join(rootDef.local, change.relativePath);
    const repoFile = join(cwd, rootDef.repo, change.relativePath);

    try {
      switch (op.kind) {
        case "push":
        case "keep-local": {
          await mkdir(dirname(repoFile), { recursive: true });
          await copyFile(localFile, repoFile);
          gitPaths.push(join(rootDef.repo, change.relativePath));
          state = updateStateFiles(state, rootDef.repo,
            new Map([[change.relativePath, mustHash(change.localHash, "local")]]));
          state = clearDeferred(state, rootDef.repo + "/" + change.relativePath);
          log.push(`PUSH ${change.rootName}/${change.relativePath}`);
          break;
        }
        case "pull":
        case "keep-repo": {
          await mkdir(dirname(localFile), { recursive: true });
          await copyFile(repoFile, localFile);
          state = updateStateFiles(state, rootDef.repo,
            new Map([[change.relativePath, mustHash(change.repoHash, "repo")]]));
          state = clearDeferred(state, rootDef.repo + "/" + change.relativePath);
          log.push(`PULL ${change.rootName}/${change.relativePath}`);
          break;
        }
        case "delete-local": {
          await rm(localFile, { recursive: true, force: true });
          state = removeFromState(state, rootDef.repo, [change.relativePath]);
          log.push(`DEL-LOCAL ${change.rootName}/${change.relativePath}`);
          break;
        }
        case "delete-repo": {
          await rm(repoFile, { recursive: true, force: true });
          gitPaths.push(join(rootDef.repo, change.relativePath));
          state = removeFromState(state, rootDef.repo, [change.relativePath]);
          log.push(`DEL-REPO ${change.rootName}/${change.relativePath}`);
          break;
        }
        case "merge": {
          const merged = op.row.mergedContent;
          if (typeof merged !== "string") {
            log.push(`SKIP ${change.rootName}/${change.relativePath} (merge content missing)`);
            break;
          }
          await mkdir(dirname(localFile), { recursive: true });
          await mkdir(dirname(repoFile), { recursive: true });
          await writeFile(localFile, merged, "utf-8");
          await writeFile(repoFile, merged, "utf-8");
          gitPaths.push(join(rootDef.repo, change.relativePath));
          const mergedHash = hashContent(merged);
          state = updateStateFiles(state, rootDef.repo,
            new Map([[change.relativePath, mergedHash]]));
          state = clearDeferred(state, rootDef.repo + "/" + change.relativePath);
          log.push(`MERGE ${change.rootName}/${change.relativePath}`);
          break;
        }
        case "defer": {
          const dir = await getDeferDir(cwd, rootDef.repo, change.relativePath);
          await snapshotForDefer(dir, change, localFile, repoFile);
          state = setDeferred(state, rootDef.repo + "/" + change.relativePath, "conflict");
          log.push(`DEFER ${change.rootName}/${change.relativePath} → ${dir}`);
          break;
        }
        case "skip":
        case "conflict":
          // planApply already dropped these; unreachable.
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push(`FAIL ${change.rootName}/${change.relativePath} (${op.kind}): ${msg}`);
    }
  }

  return { state, gitPaths, log };
}

function mustHash(h: string | undefined, side: "local" | "repo"): string {
  if (typeof h !== "string") {
    // This indicates a bug: we accepted a row whose engine classification
    // promised content on this side but didn't supply a hash. Fail loud.
    throw new Error(`apply: missing ${side}Hash for change`);
  }
  return h;
}

async function snapshotForDefer(
  dir: string,
  change: FileChange,
  localFile: string,
  repoFile: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Best-effort copy: a missing side just isn't snapshotted.
  await copyFile(localFile, join(dir, "local")).catch(() => undefined);
  await copyFile(repoFile, join(dir, "repo")).catch(() => undefined);
  const meta = {
    rootName: change.rootName,
    relativePath: change.relativePath,
    capturedAt: new Date().toISOString(),
    localHash: change.localHash,
    repoHash: change.repoHash,
    stateHash: change.stateHash,
  };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
}
