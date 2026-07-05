import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadManifestDocument } from "../core/manifest.js";
import { gitCommitAndPush, gitPull, isGitRepo } from "./git.js";

const execFileAsync = promisify(execFile);

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

interface SodaPullData {
  status: string;
}

const defaultSodaRunner: SodaRunner = async (args: string[], cwd: string): Promise<SodaRunResult> => {
  const result = (await execFileAsync("sd", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  })) as { stdout: string; stderr: string };
  return { stdout: result.stdout, stderr: result.stderr };
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
    const data = await this.sd<SodaPullData>(["pull"], cwd);
    return data.status !== "up-to-date";
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
    await this.sd(["reopen", "-c", changelist, ...relPaths], cwd);
    await this.sd(["submit", "-c", changelist, "-d", message], cwd);
    await this.sd(["push"], cwd);
  }
}

/**
 * Backend selection is driven by the committed manifest `vcs` field.
 * A repo with no rotunda.json defaults to git, which keeps rotunda's own
 * self-update (a repo without a manifest) on the git read/pull path.
 */
export function resolveBackend(cwd: string): VcsBackend {
  if (!existsSync(join(cwd, "rotunda.json"))) {
    return new GitBackend();
  }
  const doc = loadManifestDocument(cwd);
  return doc.vcs === "soda" ? new SodaBackend() : new GitBackend();
}
