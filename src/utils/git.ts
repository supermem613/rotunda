import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a git command in the given directory.
 */
export async function git(
  args: string[],
  cwd: string
): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string; code?: number };
    // git diff --no-index exits with 1 when files differ — that's not an error
    if (args[0] === "diff" && error.code === 1) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    throw err;
  }
}

/**
 * Check if a directory is the root of a git repository
 * (has its own .git, not merely nested inside another repo).
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await git(["rev-parse", "--show-toplevel"], dir);
    return normalizePath(stdout.trim()) === normalizePath(dir);
  } catch {
    return false;
  }
}

/**
 * Normalise a filesystem path for equality comparison: resolve symlinks and
 * Windows 8.3 short names via realpath, unify separators, strip trailing
 * separators, and lowercase on case-insensitive filesystems (Windows).
 */
function normalizePath(p: string): string {
  let resolved = p;
  try {
    resolved = realpathSync.native(p);
  } catch {
    // Path may not exist or be inaccessible; fall back to the input.
  }
  resolved = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Get the git status (porcelain) for specific paths.
 */
export async function gitStatus(
  cwd: string,
  paths: string[]
): Promise<string> {
  const result = await git(
    ["status", "--porcelain", ...paths],
    cwd
  );
  return result.stdout.trim();
}

function isLineEndingConversionError(err: unknown): boolean {
  const error = err as Error & { stdout?: string; stderr?: string };
  const combined = [
    error.message ?? "",
    error.stdout ?? "",
    error.stderr ?? "",
  ].join("\n");

  return combined.includes("LF would be replaced by CRLF") ||
    combined.includes("CRLF would be replaced by LF");
}

async function gitAddWithTransientLineEndingConfig(
  cwd: string,
  paths: string[],
): Promise<void> {
  await git([
    "-c", "core.autocrlf=false",
    "-c", "core.safecrlf=false",
    "add", "--", ...paths,
  ], cwd);
}

/**
 * Stage, commit, and optionally push.
 */
export async function gitCommitAndPush(
  cwd: string,
  paths: string[],
  message: string,
  push = false
): Promise<void> {
  try {
    await git(["add", "--", ...paths], cwd);
  } catch (err) {
    if (!isLineEndingConversionError(err)) {
      throw err;
    }
    await gitAddWithTransientLineEndingConfig(cwd, paths);
  }
  await git(["commit", "-m", message], cwd);
  if (push) {
    await git(["push"], cwd);
  }
}

/**
 * Pull the latest changes from the remote.
 * Returns true if new changes were pulled, false if already up to date.
 * Throws if the pull fails (e.g., merge conflicts).
 */
export async function gitPull(cwd: string): Promise<boolean> {
  const result = await git(["pull", "--ff-only"], cwd);
  const output = result.stdout + result.stderr;
  return !output.includes("Already up to date");
}

/**
 * Check whether a path would be ignored by git (via .gitignore, core.excludesFile,
 * .git/info/exclude, etc). Uses `git check-ignore`, which honours all ignore
 * sources rather than just the repo-root .gitignore.
 *
 * Returns true if the path is ignored, false otherwise. Returns false (rather
 * than throwing) if `cwd` is not a git repository or git is not available.
 */
export async function isPathIgnored(path: string, cwd: string): Promise<boolean> {
  // Bypass the git() wrapper so we can read the raw exit code.
  // git check-ignore exits 0 if path is ignored, 1 if not, 128 on error.
  return new Promise((resolve) => {
    execFile(
      "git",
      ["check-ignore", "-q", "--", path],
      { cwd },
      (err) => {
        if (!err) {
          resolve(true);
          return;
        }
        const code = (err as Error & { code?: number }).code;
        if (code === 1) {
          resolve(false);
          return;
        }
        // 128 (or other) → not a git repo / git missing → treat as "unknown",
        // fall back to "not ignored" so callers don't false-alarm.
        resolve(false);
      },
    );
  });
}

/**
 * Get a unified diff between two files using git diff --no-index.
 */
export async function gitDiffFiles(
  file1: string,
  file2: string,
  color = false
): Promise<string> {
  const args = ["diff", "--no-index"];
  if (color) args.push("--color");
  args.push("--", file1, file2);

  // git diff --no-index doesn't need a repo, cwd doesn't matter
  const result = await git(args, ".");
  return result.stdout;
}
