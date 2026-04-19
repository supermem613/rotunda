import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SyncState, FileState, DeferredEntry } from "./types.js";

const STATE_DIR = ".rotunda";
const STATE_FILE = "state.json";

/**
 * Get the path to the state file for a given repo.
 */
export function getStatePath(repoPath: string): string {
  return join(repoPath, STATE_DIR, STATE_FILE);
}

/**
 * Get the path to the state directory for a given repo.
 */
export function getStateDir(repoPath: string): string {
  return join(repoPath, STATE_DIR);
}

/**
 * Create an empty initial state.
 */
export function emptyState(): SyncState {
  return {
    lastSync: new Date().toISOString(),
    files: {},
    deferred: {},
  };
}

/**
 * Load the sync state from disk.
 * Returns an empty state if the file doesn't exist.
 */
export async function loadState(repoPath: string): Promise<SyncState> {
  const statePath = getStatePath(repoPath);

  try {
    await access(statePath);
  } catch {
    return emptyState();
  }

  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as SyncState;

    // Validate basic structure
    if (!parsed.lastSync || typeof parsed.files !== "object") {
      console.warn("Warning: state file has invalid structure, starting fresh.");
      return emptyState();
    }

    // Backfill optional fields added in newer schema versions so the rest of
    // the codebase can treat them as required.
    if (!parsed.deferred || typeof parsed.deferred !== "object") {
      parsed.deferred = {};
    }

    return parsed;
  } catch (err) {
    console.warn(`Warning: failed to read state file: ${err}. Starting fresh.`);
    return emptyState();
  }
}

/**
 * Save the sync state to disk atomically.
 * Writes to a temp file first, then renames — prevents corruption
 * if the process is interrupted.
 */
export async function saveState(
  repoPath: string,
  state: SyncState
): Promise<void> {
  const statePath = getStatePath(repoPath);
  const stateDir = dirname(statePath);
  const tempPath = statePath + ".tmp";

  await mkdir(stateDir, { recursive: true });

  const content = JSON.stringify(state, null, 2) + "\n";
  await writeFile(tempPath, content, "utf-8");

  try {
    await rename(tempPath, statePath);
  } catch {
    // On Windows, rename can fail if the target exists. Fallback to direct write.
    await writeFile(statePath, content, "utf-8");
  }
}

/**
 * Update the state after a successful sync operation.
 * Records the hash for each synced file.
 */
export function updateStateFiles(
  state: SyncState,
  rootRepo: string,
  syncedFiles: Map<string, string> // relativePath → hash
): SyncState {
  const updated = { ...state, files: { ...state.files } };

  for (const [relPath, hash] of syncedFiles) {
    const stateKey = rootRepo + "/" + relPath;
    updated.files[stateKey] = {
      hash,
      size: 0, // We don't track size for now
      syncedAt: new Date().toISOString(),
    };
  }

  updated.lastSync = new Date().toISOString();
  return updated;
}

/**
 * Remove files from state that were deleted during sync.
 */
export function removeFromState(
  state: SyncState,
  rootRepo: string,
  deletedPaths: string[]
): SyncState {
  const updated = {
    ...state,
    files: { ...state.files },
    deferred: { ...(state.deferred ?? {}) },
  };

  for (const relPath of deletedPaths) {
    const stateKey = rootRepo + "/" + relPath;
    delete updated.files[stateKey];
    // A deleted file can no longer be deferred-as-conflict; clear the marker
    // so a future sync doesn't surface a phantom row.
    delete updated.deferred[stateKey];
  }

  updated.lastSync = new Date().toISOString();
  return updated;
}

/**
 * Mark a root-prefixed path as deferred. Idempotent.
 * Used by the conflict toolbox 'defer' action — the file's snapshots are
 * written to .rotunda/conflicts/<root>/<path>/ separately.
 */
export function setDeferred(
  state: SyncState,
  stateKey: string,
  reason: DeferredEntry["reason"] = "conflict"
): SyncState {
  const updated = {
    ...state,
    deferred: { ...(state.deferred ?? {}) },
  };
  updated.deferred[stateKey] = {
    reason,
    capturedAt: new Date().toISOString(),
  };
  return updated;
}

/**
 * Clear a deferral marker. Used when the user resolves a deferred row
 * (e.g. by editing the working file and re-running sync, then picking a side).
 */
export function clearDeferred(state: SyncState, stateKey: string): SyncState {
  if (!state.deferred?.[stateKey]) return state;
  const updated = {
    ...state,
    deferred: { ...state.deferred },
  };
  delete updated.deferred[stateKey];
  return updated;
}
