import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SyncState, FileState } from "./types.js";

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
  const updated = { ...state, files: { ...state.files } };

  for (const relPath of deletedPaths) {
    const stateKey = rootRepo + "/" + relPath;
    delete updated.files[stateKey];
  }

  updated.lastSync = new Date().toISOString();
  return updated;
}
