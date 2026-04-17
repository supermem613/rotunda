import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  FileChange,
  Manifest,
  SyncRoot,
  SyncState,
} from "./types.js";
import { hashFile } from "../utils/hash.js";
import { shouldInclude } from "../utils/glob.js";

/**
 * Recursively discover all managed files in a directory,
 * filtered by include/exclude patterns.
 * Returns a map of relativePath → absolutePath.
 */
export async function discoverFiles(
  rootDir: string,
  include: string[],
  exclude: string[],
  globalExclude: string[]
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or not readable
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        // Check if the directory name itself is excluded
        if (shouldInclude(relPath, [], exclude, globalExclude)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (shouldInclude(relPath, include, exclude, globalExclude)) {
          files.set(relPath, fullPath);
        }
      }
    }
  }

  await walk(rootDir);
  return files;
}

/**
 * Hash all files in a file map.
 * Returns a map of relativePath → sha256 hash.
 */
export async function hashFiles(
  files: Map<string, string>
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const entries = [...files.entries()];

  // Hash in parallel with concurrency limit
  const BATCH_SIZE = 50;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ([relPath, absPath]) => {
        const hash = await hashFile(absPath);
        return [relPath, hash] as const;
      })
    );
    for (const [relPath, hash] of results) {
      hashes.set(relPath, hash);
    }
  }

  return hashes;
}

/**
 * Compute three-way diff between local files, repo files, and last sync state.
 *
 * The state records the hash of each file at the time of the last sync.
 * By comparing current local/repo hashes against the state, we can determine
 * what changed on each side.
 *
 * Change detection matrix:
 * | State | Local | Repo | Meaning                         |
 * |-------|-------|------|---------------------------------|
 * | -     | ✓     | -    | Added locally                   |
 * | -     | -     | ✓    | Added in repo                   |
 * | -     | ✓     | ✓    | Added both → conflict if differ |
 * | ✓     | ✓*    | ✓    | Modified locally                |
 * | ✓     | ✓     | ✓*   | Modified in repo                |
 * | ✓     | ✓*    | ✓*   | Modified both → conflict        |
 * | ✓     | -     | ✓    | Deleted locally                 |
 * | ✓     | ✓     | -    | Deleted in repo                 |
 * | ✓     | -     | -    | Deleted both (clean)            |
 * | ✓     | ✓     | ✓    | Unchanged (skip)                |
 */
export function computeChanges(
  rootName: string,
  localHashes: Map<string, string>,
  repoHashes: Map<string, string>,
  stateFiles: Record<string, { hash: string }>
): FileChange[] {
  const changes: FileChange[] = [];

  // Collect all unique file paths
  const allPaths = new Set<string>([
    ...localHashes.keys(),
    ...repoHashes.keys(),
    ...Object.keys(stateFiles),
  ]);

  for (const path of allPaths) {
    const localHash = localHashes.get(path);
    const repoHash = repoHashes.get(path);
    const stateHash = stateFiles[path]?.hash;

    const inLocal = localHash !== undefined;
    const inRepo = repoHash !== undefined;
    const inState = stateHash !== undefined;

    // Skip unchanged files
    if (inLocal && inRepo && inState &&
        localHash === stateHash && repoHash === stateHash) {
      continue;
    }

    // Also skip if local and repo match but state is different/missing
    // (both sides are in sync, state just needs updating)
    if (inLocal && inRepo && !inState && localHash === repoHash) {
      continue;
    }

    const change: FileChange = {
      relativePath: path,
      rootName,
      action: "modified", // default, will be overwritten
      side: "both",
      localHash,
      repoHash,
      stateHash,
    };

    if (!inState) {
      // Not in last sync state
      if (inLocal && !inRepo) {
        change.action = "added";
        change.side = "local";
      } else if (!inLocal && inRepo) {
        change.action = "added";
        change.side = "repo";
      } else if (inLocal && inRepo) {
        if (localHash === repoHash) {
          continue; // Both added same content — no action needed
        }
        change.action = "conflict";
        change.side = "both";
      }
    } else {
      // Was in last sync state
      const localChanged = inLocal && localHash !== stateHash;
      const localDeleted = !inLocal;
      const repoChanged = inRepo && repoHash !== stateHash;
      const repoDeleted = !inRepo;

      if (localDeleted && repoDeleted) {
        continue; // Both deleted — clean, no action
      } else if (localDeleted && !repoChanged) {
        change.action = "deleted";
        change.side = "local";
      } else if (repoDeleted && !localChanged) {
        change.action = "deleted";
        change.side = "repo";
      } else if (localDeleted && repoChanged) {
        change.action = "conflict";
        change.side = "both";
      } else if (repoDeleted && localChanged) {
        change.action = "conflict";
        change.side = "both";
      } else if (localChanged && !repoChanged) {
        change.action = "modified";
        change.side = "local";
      } else if (repoChanged && !localChanged) {
        change.action = "modified";
        change.side = "repo";
      } else if (localChanged && repoChanged) {
        if (localHash === repoHash) {
          continue; // Both changed to the same content
        }
        change.action = "conflict";
        change.side = "both";
      }
    }

    changes.push(change);
  }

  // Sort by path for deterministic output
  changes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return changes;
}

/**
 * Compute all changes across all sync roots.
 */
export async function computeAllChanges(
  manifest: Manifest,
  repoPath: string,
  state: SyncState
): Promise<FileChange[]> {
  const allChanges: FileChange[] = [];

  for (const root of manifest.roots) {
    const localDir = root.local;
    const repoDir = join(repoPath, root.repo);

    const [localFiles, repoFiles] = await Promise.all([
      discoverFiles(localDir, root.include, root.exclude, manifest.globalExclude),
      discoverFiles(repoDir, root.include, root.exclude, manifest.globalExclude),
    ]);

    const [localHashes, repoHashes] = await Promise.all([
      hashFiles(localFiles),
      hashFiles(repoFiles),
    ]);

    // Extract state files for this root (they're stored with root-prefixed paths)
    const rootPrefix = root.repo + "/";
    const stateFiles: Record<string, { hash: string }> = {};
    for (const [key, value] of Object.entries(state.files)) {
      if (key.startsWith(rootPrefix)) {
        stateFiles[key.slice(rootPrefix.length)] = value;
      }
    }

    const changes = computeChanges(
      root.name,
      localHashes,
      repoHashes,
      stateFiles
    );
    allChanges.push(...changes);
  }

  return allChanges;
}
