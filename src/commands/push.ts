import chalk from "chalk";
import { loadRepoContext } from "../core/repo-context.js";
import { loadState, saveState, updateStateFiles, removeFromState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import { gitCommitAndPush, isGitRepo, gitPull } from "../utils/git.js";
import { withLock } from "../utils/lock.js";
import { loadToken } from "../llm/auth.js";
import { reviewChanges } from "../llm/review.js";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
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

export async function pushCommand(options: { yes?: boolean }): Promise<void> {
  const { cwd, manifest } = loadRepoContext();

  await withLock(cwd, "push", async () => {
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

  // Filter to local-side changes (things that should be pushed to repo)
  const pushable = allChanges.filter(
    (c) => c.side === "local" || (c.side === "both" && c.action !== "conflict")
  );

  if (pushable.length === 0) {
    console.log(chalk.green("✓") + " Nothing to push. Local and repo are in sync.");
    return;
  }

  // Show preview
  console.log(chalk.bold(`\n  Changes to push (local → repo):\n`));
  for (const c of pushable) {
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
  let approved: FileChange[] = pushable;
  const reshapedContents = new Map<string, string>();

  if (!options.yes) {
    const token = await loadToken();
    if (token) {
      // LLM review mode
      const results = await reviewChanges(token, pushable, manifest, cwd, "push");
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
        console.log(chalk.dim("\n  No changes approved. Nothing pushed."));
        return;
      }
      console.log(chalk.bold(`\n  Pushing ${approved.length} approved file(s)...`));
    } else {
      // Fallback: simple confirm
      console.log(chalk.dim("  (No GitHub auth — using basic review. Run `rotunda auth` for LLM review.)"));
      const ok = await confirm(`  Push ${pushable.length} file(s)? [y/N] `);
      if (!ok) {
        console.log(chalk.dim("  Cancelled."));
        return;
      }
    }
  }

  // Apply changes
  let updatedState = { ...state, files: { ...state.files } };
  const gitPaths: string[] = [];

  for (const c of approved) {
    const rootDef = manifest.roots.find((r) => r.repo === c.rootName);
    if (!rootDef) continue;

    const localFile = join(rootDef.local, c.relativePath);
    const repoFile = join(cwd, rootDef.repo, c.relativePath);
    const reshapeKey = `${c.rootName}/${c.relativePath}`;

    if (c.action === "added" || c.action === "modified") {
      await mkdir(dirname(repoFile), { recursive: true });

      // Use reshaped content if available, otherwise copy the file.
      // CRITICAL: state must record the hash of the bytes actually written,
      // not c.localHash — they differ when reshape rewrote the content.
      let writtenHash: string;
      if (reshapedContents.has(reshapeKey)) {
        const reshaped = reshapedContents.get(reshapeKey)!;
        await writeFile(repoFile, reshaped, "utf-8");
        writtenHash = hashContent(reshaped);
      } else {
        await copyFile(localFile, repoFile);
        writtenHash = c.localHash!;
      }
      gitPaths.push(join(rootDef.repo, c.relativePath));

      // Update state with the actual content hash
      const synced = new Map([[c.relativePath, writtenHash]]);
      updatedState = updateStateFiles(updatedState, rootDef.repo, synced);

      console.log(chalk.green("  ✓") + ` ${c.rootName}/${c.relativePath}`);
    } else if (c.action === "deleted") {
      // Delete from repo
      try {
        await rm(repoFile, { recursive: true, force: true });
        gitPaths.push(join(rootDef.repo, c.relativePath));
      } catch {
        // File might already be gone
      }
      updatedState = removeFromState(updatedState, rootDef.repo, [c.relativePath]);
      console.log(chalk.red("  ✗") + ` ${c.rootName}/${c.relativePath} ${chalk.dim("(removed from repo)")}`);
    }
  }

  // Save state
  await saveState(cwd, updatedState);

  // Git commit
  if (gitPaths.length > 0) {
    const reshapeCount = reshapedContents.size;
    const commitMsg = reshapeCount > 0
      ? `rotunda push — ${approved.length} file(s) (${reshapeCount} reshaped)`
      : `rotunda push — ${approved.length} file(s)`;
    try {
      await gitCommitAndPush(cwd, gitPaths, commitMsg, true);
      console.log(chalk.green(`\n  ✓ Committed and pushed: "${commitMsg}"`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow("\n  ⚠ Changes applied but git commit failed. Commit manually."));
      console.log(chalk.dim("    " + msg.split("\n").join("\n    ")));
    }
  }

  console.log(chalk.green(`  ✓ Push complete.`));
  }); // end withLock
}
