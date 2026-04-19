/**
 * On-disk staging area for deferred conflicts.
 *
 * Stored under `<repo>/.rotunda/conflicts/<root>/<relativePath>/` with files:
 *   local     — local snapshot at defer time
 *   repo      — repo snapshot at defer time
 *   meta.json — provenance + hashes
 *
 * Located in `.rotunda/` (which is gitignored by `rotunda init`) so the
 * snapshots never enter git history. Crucially, NEVER write sibling files
 * inside the sync roots themselves — they would be re-discovered as
 * `added local` rows on the next sync.
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const CONFLICTS_SUBDIR = ".rotunda/conflicts";

/**
 * Resolve (and create) the per-file conflict directory for a deferred row.
 * Returns the absolute path; caller writes its `local`/`repo`/`meta.json`.
 */
export async function getDeferDir(
  cwd: string,
  rootName: string,
  relativePath: string,
): Promise<string> {
  // Path components are user-controlled but already validated by sync — we
  // still resist `..` segments by joining piece-by-piece.
  const safeRel = relativePath.split(/[/\\]/).filter((p) => p && p !== "..").join("/");
  const dir = join(cwd, CONFLICTS_SUBDIR, rootName, safeRel);
  await mkdir(dir, { recursive: true });
  return dir;
}
