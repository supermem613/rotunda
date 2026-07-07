import { existsSync } from "node:fs";
import { join } from "node:path";
import spawn from "cross-spawn";
import { loadManifestDocument } from "../core/manifest.js";
import { gitCommitAndPush, gitPull, isGitRepo } from "./git.js";

/**
 * Publish is one atomic verb (stage + commit + push), not separate git steps,
 * to prevent over-commit leakage in future backends.
 */
export interface VcsBackend {
  isRepo(cwd: string): Promise<boolean>;
  pull(cwd: string): Promise<boolean>;
  publish(cwd: string, paths: string[], message: string): Promise<void>;
}

export interface SodaRunResult {
  stdout: string;
  stderr: string;
}

export type SodaRunner = (args: string[], cwd: string) => Promise<SodaRunResult>;

export interface SodaCapability {
  ok: boolean;
  reason?: string;
}

interface SodaEnvelope<TData> {
  ok: boolean;
  command: string;
  schemaVersion: number;
  timingMs: number;
  data?: TData;
  error?: string;
  hint?: string;
}

interface SodaStatusData {
  summary: {
    opened: number;
    ahead: number;
  };
  files: string[];
}

/**
 * `sd pull` reports one reconcile outcome per branch. `worktreeUpdated` is true
 * only when remote commits were actually brought into the working tree, which
 * is the signal rotunda uses to decide whether the manifest and backend need
 * reloading. `up-to-date`, `ahead`, `published`, and `refuse` outcomes leave the
 * working tree untouched and report worktreeUpdated false.
 */
interface SodaPullOutcome {
  status: string;
  worktreeUpdated: boolean;
}

// `sd` is installed as an npm bin, so on Windows it resolves to a `sd.cmd`
// shim rather than a native executable. Node's execFile neither searches
// PATHEXT nor (since the CVE-2024-27980 fix) spawns `.cmd` files without a
// shell, so a bare execFile("sd") fails with ENOENT/EINVAL. cross-spawn does
// the PATHEXT resolution and Windows argument quoting correctly, so soda paths
// with spaces survive intact.
const defaultSodaRunner: SodaRunner = (args: string[], cwd: string): Promise<SodaRunResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn("sd", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
      reject(new Error(`sd ${args[0]} failed: ${detail}`));
    });
  });
};

/**
 * soda's git-interlock hooks block raw git writes in an sd-powered repo.
 * We detect that guard so we can tell the user to select the soda backend
 * instead of surfacing a cryptic git hook failure.
 */
export function isSodaHookBlock(message: string): boolean {
  return message.includes("sd-powered repo");
}

export async function sodaPreflight(cwd: string, run: SodaRunner = defaultSodaRunner): Promise<SodaCapability> {
  try {
    const result = await run(["status"], cwd);
    try {
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error?: string; data?: { summary?: { repoRoot?: string } } };
      if (!envelope.ok) {
        return { ok: false, reason: envelope.error ?? "sd status failed" };
      }
      if (envelope.data?.summary?.repoRoot) {
        return { ok: true };
      }
      return { ok: false, reason: "sd status missing repoRoot" };
    } catch {
      return { ok: false, reason: "unparseable sd status output" };
    }
  } catch {
    return { ok: false, reason: "sd command not available" };
  }
}

export class GitBackend implements VcsBackend {
  async isRepo(cwd: string): Promise<boolean> {
    return isGitRepo(cwd);
  }

  async pull(cwd: string): Promise<boolean> {
    return gitPull(cwd);
  }

  async publish(cwd: string, paths: string[], message: string): Promise<void> {
    try {
      await gitCommitAndPush(cwd, paths, message, true);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (isSodaHookBlock(detail)) {
        throw new Error(
          `This repository is soda-managed, so raw git writes are blocked. ` +
            `Set "vcs": "soda" in rotunda.json (or run \`rotunda bind\` to auto-detect) to publish through soda.`,
          { cause: err },
        );
      }
      throw err;
    }
  }
}

export class SodaBackend implements VcsBackend {
  constructor(private readonly run: SodaRunner = defaultSodaRunner) {}

  private async sd<T>(args: string[], cwd: string): Promise<T> {
    const { stdout } = await this.run(args, cwd);
    const envelope = JSON.parse(stdout) as SodaEnvelope<T>;
    if (!envelope.ok) {
      throw new Error(`sd ${args[0]} failed: ${envelope.error ?? "unknown error"}`);
    }
    return envelope.data as T;
  }

  async isRepo(cwd: string): Promise<boolean> {
    return (await sodaPreflight(cwd, this.run)).ok;
  }

  async pull(cwd: string): Promise<boolean> {
    const outcomes = await this.sd<SodaPullOutcome[]>(["pull"], cwd);
    return outcomes.some((outcome) => outcome.worktreeUpdated === true);
  }

  async publish(cwd: string, paths: string[], message: string): Promise<void> {
    const changelist = "rotunda";
    const relPaths = paths.map((path) => path.replace(/\\/g, "/"));
    const status = await this.sd<SodaStatusData>(["status"], cwd);

    if (status.summary.opened === 0 && status.summary.ahead > 0) {
      await this.sd(["push"], cwd);
      return;
    }

    await this.sd(["change", changelist], cwd);
    await this.sd(["assign", "-c", changelist, ...relPaths], cwd);
    await this.sd(["submit", "-c", changelist, "-d", message], cwd);
    await this.sd(["push"], cwd);
  }
}

/**
 * Backend selection for dotfiles repos is driven by the committed manifest
 * `vcs` field. A repo with no rotunda.json defaults to git.
 */
export function resolveBackend(cwd: string): VcsBackend {
  if (!existsSync(join(cwd, "rotunda.json"))) {
    return new GitBackend();
  }
  const doc = loadManifestDocument(cwd);
  return doc.vcs === "soda" ? new SodaBackend() : new GitBackend();
}

/**
 * Backend selection for rotunda's own self-update (`rotunda update`).
 *
 * The rotunda install repo has no rotunda.json, so manifest-driven selection
 * does not apply. Instead we detect at runtime whether the install repo is
 * itself soda-managed and, if so, self-update through sd primitives so we do
 * not fight soda's git-interlock. `initialized === true` is the authoritative
 * signal: a plain git repo that the sd CLI can merely read reports false, and
 * anything that cannot answer (sd missing, not a repo) stays on git.
 */
export async function resolveSelfUpdateBackend(
  cwd: string,
  run: SodaRunner = defaultSodaRunner,
): Promise<VcsBackend> {
  return (await isSodaManagedRepo(cwd, run)) ? new SodaBackend(run) : new GitBackend();
}

async function isSodaManagedRepo(cwd: string, run: SodaRunner): Promise<boolean> {
  try {
    const result = await run(["status"], cwd);
    const envelope = JSON.parse(result.stdout) as SodaEnvelope<{
      summary?: { initialized?: boolean };
    }>;
    return envelope.ok === true && envelope.data?.summary?.initialized === true;
  } catch {
    return false;
  }
}
