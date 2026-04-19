import chalk from "chalk";
import { loadRepoContext } from "../core/repo-context.js";
import { loadState, saveState, updateStateFiles, removeFromState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import { loadToken } from "../llm/auth.js";
import { reviewChanges } from "../llm/review.js";
import { withLock } from "../utils/lock.js";
import { isGitRepo, gitPull, gitCommitAndPush } from "../utils/git.js";
import { copyFile, mkdir, rm, access, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { hashContent } from "../utils/hash.js";
import type { FileChange, ReviewResult } from "../core/types.js";

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function pullCommand(options: { yes?: boolean }): Promise<void> {
  const { cwd, manifest } = loadRepoContext();

  await withLock(cwd, "pull", async () => {
  // Pull latest from remote before computing changes
  if (await isGitRepo(cwd)) {
    try {
      const pulled = await gitPull(cwd);
      if (pulled) {
        console.log(chalk.dim("  ↓ Pulled latest from remote."));
      }
    } catch {
      console.log(chalk.yellow("  ⚠ git pull failed — continuing with local state."));
    }
  }

  const state = await loadState(cwd);
  const allChanges = await computeAllChanges(manifest, cwd, state);

  // Filter to repo-side changes (things that should be pulled to local).
  // A locally-deleted file whose repo copy is unchanged is also pullable:
  // pull (repo → local) restores the missing file from the repo.
  const pullable = allChanges
    .filter(
      (c) =>
        c.side === "repo" ||
        (c.side === "both" && c.action !== "conflict") ||
        (c.side === "local" && c.action === "deleted" && c.repoHash !== undefined),
    )
    .map((c) =>
      c.side === "local" && c.action === "deleted" && c.repoHash !== undefined
        ? { ...c, action: "modified" as const, side: "repo" as const }
        : c,
    );

  if (pullable.length === 0) {
    console.log(chalk.green("✓") + " Nothing to pull. Local is up to date.");
    return;
  }

  // Show preview
  console.log(chalk.bold(`\n  Changes to pull (repo → local):\n`));
  for (const c of pullable) {
    const actionLabel =
      c.action === "added" ? chalk.green("added") :
      c.action === "modified" ? chalk.yellow("modified") :
      chalk.red("deleted");
    console.log(`    ${actionLabel}  ${c.rootName}/${c.relativePath}`);
  }

  // Show conflicts separately
  const conflicts = allChanges.filter((c) => c.action === "conflict");
  if (conflicts.length > 0) {
    console.log(chalk.magenta(`\n  ⚠ ${conflicts.length} conflict(s) skipped (use rotunda sync to resolve):`));
    for (const c of conflicts) {
      console.log(`    ${chalk.magenta("CONFLICT")}  ${c.rootName}/${c.relativePath}`);
    }
  }

  console.log();

  // LLM-assisted review or simple confirm
  let approved: FileChange[] = pullable;
  const reshapedContents = new Map<string, string>();

  if (!options.yes) {
    const token = await loadToken();
    if (token) {
      const results = await reviewChanges(token, pullable, manifest, cwd, "pull");
      approved = [];
      for (const r of results) {
        if (r.decision === "approve") {
          approved.push(r.change);
          if (r.reshapedContent) {
            reshapedContents.set(
              `${r.change.rootName}/${r.change.relativePath}`,
              r.reshapedContent
            );
          }
        }
      }

      if (approved.length === 0) {
        console.log(chalk.dim("\n  No changes approved. Nothing pulled."));
        return;
      }
      console.log(chalk.bold(`\n  Pulling ${approved.length} approved file(s)...`));
    } else {
      console.log(chalk.dim("  (No GitHub auth — using basic review. Run `rotunda auth` for LLM review.)"));
      const ok = await confirm(`  Pull ${pullable.length} file(s)? [y/N] `);
      if (!ok) {
        console.log(chalk.dim("  Cancelled."));
        return;
      }
    }
  }

  // Apply changes
  let updatedState = { ...state, files: { ...state.files } };

  for (const c of approved) {
    const rootDef = manifest.roots.find((r) => r.repo === c.rootName);
    if (!rootDef) continue;

    const localFile = join(rootDef.local, c.relativePath);
    const repoFile = join(cwd, rootDef.repo, c.relativePath);
    const reshapeKey = `${c.rootName}/${c.relativePath}`;

    if (c.action === "added" || c.action === "modified") {
      await mkdir(dirname(localFile), { recursive: true });

      // Use reshaped content if available, otherwise copy.
      // CRITICAL: state must record the hash of the bytes actually written,
      // not c.repoHash — they differ when reshape rewrote the content.
      let writtenHash: string;
      if (reshapedContents.has(reshapeKey)) {
        const reshaped = reshapedContents.get(reshapeKey)!;
        await writeFile(localFile, reshaped, "utf-8");
        writtenHash = hashContent(reshaped);
      } else {
        await copyFile(repoFile, localFile);
        writtenHash = c.repoHash!;
      }

      // Update state with the actual content hash
      const synced = new Map([[c.relativePath, writtenHash]]);
      updatedState = updateStateFiles(updatedState, rootDef.repo, synced);

      console.log(chalk.green("  ✓") + ` ${c.rootName}/${c.relativePath}`);
    } else if (c.action === "deleted") {
      // CLEAN DELETE from local — this is the key orphan cleanup!
      if (await fileExists(localFile)) {
        await rm(localFile, { recursive: true, force: true });

        // Clean up empty parent directories
        try {
          const parentDir = dirname(localFile);
          const { readdir: readdirAsync } = await import("node:fs/promises");
          const remaining = await readdirAsync(parentDir);
          if (remaining.length === 0) {
            await rm(parentDir, { recursive: true, force: true });
          }
        } catch {
          // Ignore cleanup failures
        }
      }
      updatedState = removeFromState(updatedState, rootDef.repo, [c.relativePath]);
      console.log(chalk.red("  ✗") + ` ${c.rootName}/${c.relativePath} ${chalk.dim("(removed from local)")}`);
    }
  }

  // Save state
  await saveState(cwd, updatedState);

  // No git commit: pull only mutates local files and per-machine state (.rotunda/),
  // neither of which belongs in a commit.

  console.log(chalk.green(`\n  ✓ Pull complete. ${approved.length} file(s) applied.`));
  }); // end withLock
}
