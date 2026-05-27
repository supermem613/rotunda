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

import { copyFile, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, dirname, relative, resolve, sep } from "node:path";
import type { Manifest, SyncState, FileChange, SyncRoot } from "../core/types.js";
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
    if (row.action === "skip" || row.action === "conflict") {
      continue;
    }
    ops.push({ row, kind: row.action });
    if (touchesGit(row.action)) {
      gitTouches++;
    }
    if (touchesLocal(row.action)) {
      localTouches++;
    }
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
          const localBoundary = resolvePruneBoundary(localFile, rootDef.local, rootDef.pruneEmptyDirs);
          if (localBoundary) {
            const pruned = await pruneEmptyParents(localFile, localBoundary);
            for (const dir of pruned) {
              log.push(`PRUNE-LOCAL ${change.rootName}/${dir}`);
            }
          }
          break;
        }
        case "delete-repo": {
          await rm(repoFile, { recursive: true, force: true });
          gitPaths.push(join(rootDef.repo, change.relativePath));
          state = removeFromState(state, rootDef.repo, [change.relativePath]);
          log.push(`DEL-REPO ${change.rootName}/${change.relativePath}`);
          const repoRootAbs = join(cwd, rootDef.repo);
          const repoBoundary = resolvePruneBoundary(repoFile, repoRootAbs, rootDef.pruneEmptyDirs);
          if (repoBoundary) {
            const pruned = await pruneEmptyParents(repoFile, repoBoundary);
            for (const dir of pruned) {
              log.push(`PRUNE-REPO ${change.rootName}/${dir}`);
            }
          }
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

/**
 * Sweep empty dirs under every configured pruneEmptyDirs boundary for every
 * root in the manifest. This runs independently of any apply pass so empty
 * dirs created by the user (or other tools) are cleaned up on every sync,
 * not just syncs that happen to delete files. Returns log lines using the
 * same PRUNE-LOCAL / PRUNE-REPO prefixes the apply pass uses, so the sync
 * summary counter picks them up unchanged.
 */
export async function sweepAllConfiguredRoots(
  manifest: { roots: SyncRoot[] },
  cwd: string,
): Promise<string[]> {
  const log: string[] = [];
  for (const rootDef of manifest.roots) {
    if (!rootDef.pruneEmptyDirs) continue;
    const boundaries = boundaryAbsList(rootDef.pruneEmptyDirs);
    for (const sub of boundaries) {
      const localBoundary = resolve(join(rootDef.local, sub));
      const repoBoundary = resolve(join(cwd, rootDef.repo, sub));
      try {
        const prunedLocal = await sweepEmptyDirsUnderBoundary(localBoundary);
        for (const dir of prunedLocal) {
          log.push(`PRUNE-LOCAL ${rootDef.repo}/${joinBoundaryRel(sub, dir)}`);
        }
      } catch {
        // Sweep is best-effort; swallow.
      }
      try {
        const prunedRepo = await sweepEmptyDirsUnderBoundary(repoBoundary);
        for (const dir of prunedRepo) {
          log.push(`PRUNE-REPO ${rootDef.repo}/${joinBoundaryRel(sub, dir)}`);
        }
      } catch {
        // Sweep is best-effort; swallow.
      }
    }
  }
  return log;
}

/**
 * Return the set of sub-paths to sweep for a root, relative to the root side.
 * For `true`, the only boundary is the root itself (sub-path = ""). For a
 * string list, each entry is its own boundary. Sub-paths are normalized so
 * leading/trailing separators don't sneak through.
 */
function boundaryAbsList(setting: boolean | string[]): string[] {
  if (setting === true) return [""];
  if (!Array.isArray(setting)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of setting) {
    const norm = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** Compose the log path "boundary-sub/inner" while collapsing empty pieces. */
function joinBoundaryRel(sub: string, inner: string): string {
  if (!sub) return inner;
  if (!inner) return sub;
  return `${sub}/${inner}`;
}

/**
 * Walk the directory tree rooted at `boundary` and rmdir any empty subtree.
 * The boundary directory itself is preserved even when it ends up empty —
 * roots and explicit prune sub-paths are structural anchors users opted into.
 *
 * Returns the boundary-relative paths of removed directories, deepest-first,
 * so the caller can stitch them into PRUNE-* log lines the same way the
 * delete-driven pruneEmptyParents does.
 *
 * Robustness:
 *   - Missing boundary (ENOENT) returns []; the user may have configured a
 *     sub-path that doesn't exist on this side yet, which is not an error.
 *   - Per-dir readdir/rmdir failures are swallowed so one broken subtree
 *     doesn't stop the rest of the sweep.
 */
export async function sweepEmptyDirsUnderBoundary(
  boundary: string,
): Promise<string[]> {
  const removed: string[] = [];
  const boundaryResolved = resolve(boundary);

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name));
      }
    }
    if (dir === boundaryResolved) return;
    let after;
    try {
      after = await readdir(dir);
    } catch {
      return;
    }
    if (after.length === 0) {
      try {
        await rmdir(dir);
        const rel = relative(boundaryResolved, dir).split(/[\\/]/).join("/");
        if (rel) removed.push(rel);
      } catch {
        // ignore
      }
    }
  }

  await visit(boundaryResolved);
  return removed;
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

/**
 * Pick the boundary directory for a pruning walk, honoring the root's
 * `pruneEmptyDirs` setting:
 *
 *   - `undefined` / `false` / `[]`: no pruning → returns `null`.
 *   - `true`: prune up to the root → returns the root side absolute path.
 *   - `string[]`: each entry is a sub-path relative to the root side. The
 *     deleted file must sit under one of those sub-paths; the longest
 *     matching sub-path wins (so nested sub-paths can refine an outer one).
 *     Returns the resolved absolute boundary, or `null` if no sub-path
 *     covers this file.
 *
 * `rootSideAbs` is the absolute path of either `rootDef.local` or
 * `cwd + rootDef.repo` depending on which side is being deleted. The
 * sub-paths are interpreted symmetrically against whichever side we're
 * called from, so the same manifest setting governs both sides.
 */
export function resolvePruneBoundary(
  absFile: string,
  rootSideAbs: string,
  setting: boolean | string[] | undefined,
): string | null {
  if (!setting) {
    return null;
  }
  const rootResolved = resolve(rootSideAbs);
  if (setting === true) {
    return rootResolved;
  }
  if (!Array.isArray(setting) || setting.length === 0) {
    return null;
  }
  const fileResolved = resolve(absFile);
  let best: string | null = null;
  for (const sub of setting) {
    const candidate = resolve(rootResolved, sub);
    // Boundary must live inside the root (or BE the root) and must be a
    // strict ancestor of the file (not the file itself).
    const insideRoot = candidate === rootResolved || candidate.startsWith(rootResolved + sep);
    if (!insideRoot) continue;
    if (fileResolved === candidate) continue;
    if (!fileResolved.startsWith(candidate + sep)) continue;
    if (best === null || candidate.length > best.length) {
      best = candidate;
    }
  }
  return best;
}

/**
 * empty, and stop at the first non-empty directory or when we hit
 * `rootBoundary`. The boundary directory itself is NEVER removed: roots are
 * structural anchors and removing them would invalidate the manifest mapping.
 *
 * Returns the list of root-relative directory paths removed, in deepest-first
 * order, ready to be appended to `ExecuteResult.log` as PRUNE-* lines.
 *
 * Implementation notes:
 *   - Uses non-recursive `rmdir`, which fails fast with ENOTEMPTY when a
 *     sibling file is present — this is the natural stop condition, no need
 *     to enumerate directory contents ourselves.
 *   - Any error other than ENOTEMPTY/ENOTDIR/ENOENT is swallowed: the file
 *     delete already succeeded and we won't fail the apply over a pruning
 *     hiccup. ENOENT can occur if a concurrent process already removed the
 *     parent.
 *   - Boundary check uses resolved absolute paths so symlinks or `..`
 *     segments in the manifest can't trick the walk into deleting outside
 *     the root.
 */
export async function pruneEmptyParents(
  absFile: string,
  rootBoundary: string,
): Promise<string[]> {
  const boundary = resolve(rootBoundary);
  let dir = resolve(dirname(absFile));
  const removed: string[] = [];
  while (dir !== boundary && dir.startsWith(boundary + sep)) {
    try {
      await rmdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EEXIST") {
        break;
      }
      if (code === "ENOENT") {
        // Already gone; keep walking so we still surface higher empty parents.
        const rel = relative(boundary, dir).split(/[\\/]/).join("/");
        if (rel) {
          removed.push(rel);
        }
        dir = dirname(dir);
        continue;
      }
      break;
    }
    const rel = relative(boundary, dir).split(/[\\/]/).join("/");
    if (rel) {
      removed.push(rel);
    }
    dir = dirname(dir);
  }
  return removed;
}
