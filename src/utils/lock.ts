/**
 * Lock file to prevent concurrent sync operations.
 * Uses a simple file-based lock with process PID.
 */

import { writeFile, readFile, unlink, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface LockInfo {
  pid: number;
  command: string;
  timestamp: string;
}

function getLockPath(repoPath: string): string {
  return join(repoPath, ".rotunda", "lock");
}

/**
 * Check if the lock file's PID is still running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the lock. Throws if another process holds it.
 */
export async function acquireLock(
  repoPath: string,
  command: string,
): Promise<void> {
  const lockPath = getLockPath(repoPath);

  // Check for existing lock
  try {
    await access(lockPath);
    const raw = await readFile(lockPath, "utf-8");
    const lock = JSON.parse(raw) as LockInfo;

    if (isProcessRunning(lock.pid)) {
      throw new Error(
        `Another rotunda process is running (PID ${lock.pid}, command: ${lock.command}). ` +
        `If this is stale, delete ${lockPath} and retry.`,
      );
    }
    // Stale lock — process is dead, we can take over
  } catch (err) {
    if (err instanceof Error && err.message.includes("Another rotunda")) {
      throw err;
    }
    // No lock file exists, or it's unreadable — proceed
  }

  const lock: LockInfo = {
    pid: process.pid,
    command,
    timestamp: new Date().toISOString(),
  };

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify(lock, null, 2), "utf-8");
}

/**
 * Release the lock.
 */
export async function releaseLock(repoPath: string): Promise<void> {
  const lockPath = getLockPath(repoPath);
  try {
    await unlink(lockPath);
  } catch {
    // Lock file already gone — that's fine
  }
}

/**
 * Run a function while holding the lock.
 * Automatically releases on completion or error.
 */
export async function withLock<T>(
  repoPath: string,
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireLock(repoPath, command);
  try {
    return await fn();
  } finally {
    await releaseLock(repoPath);
  }
}
