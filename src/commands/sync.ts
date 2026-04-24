import chalk from "chalk";
import { loadRepoContext } from "../core/repo-context.js";
import { loadManifest } from "../core/manifest.js";
import { loadState, saveState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import { withLock } from "../utils/lock.js";
import { isGitRepo, gitPull, gitCommitAndPush } from "../utils/git.js";
import { runTui } from "../tui/screen.js";
import { initialState, type Row } from "../tui/state.js";
import { planApply, executeApply } from "../sync/apply.js";

export async function syncCommand(options: { yes?: boolean }): Promise<void> {
  const ctx = loadRepoContext();
  const cwd = ctx.cwd;
  let manifest = ctx.manifest;

  await withLock(cwd, "sync", async () => {
    if (await isGitRepo(cwd)) {
      try {
        const pulled = await gitPull(cwd);
        if (pulled) {
          console.log(chalk.dim("  ↓ Pulled latest from remote."));
          // Reload manifest: the pull may have brought in new include/exclude
          // patterns or roots. Without this, the first sync after a remote
          // manifest change would still use the pre-pull manifest, missing
          // any newly-mapped files until a second sync.
          manifest = loadManifest(cwd);
        }
      } catch {
        console.log(chalk.yellow("  ⚠ git pull failed — continuing with local state."));
      }
    }

    const state = await loadState(cwd);
    const allChanges = await computeAllChanges(manifest, cwd, state);

    if (allChanges.length === 0) {
      console.log(chalk.green("✓") + " Everything in sync. No changes detected.");
      return;
    }

    // Interactive TUI when stdout is a TTY and the user hasn't asked for non-interactive.
    const interactive = !options.yes && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

    let rowsToApply: Row[];
    if (interactive) {
      const result = await runTui({
        changes: allChanges,
        manifest,
        cwd,
        state,
      });
      if (result.quit || !result.applied) {
        console.log(chalk.dim("  Cancelled — no changes applied."));
        return;
      }
      rowsToApply = result.state.rows;
    } else {
      // Headless: build engine-default rows and refuse to apply when conflicts exist.
      const initial = initialState(allChanges, { cols: 80, rows: 24 }, state.deferred);
      const conflicts = initial.rows.filter((r) => r.action === "conflict");
      if (conflicts.length > 0) {
        console.log(chalk.magenta(`  ⚠ ${conflicts.length} unresolved conflict(s):`));
        for (const r of conflicts) {
          console.log(`      ${chalk.magenta("CONFLICT")}  ${r.change.rootName}/${r.change.relativePath}`);
        }
        console.log(chalk.dim("  Re-run `rotunda sync` in an interactive terminal to resolve them."));
        process.exit(1);
      }
      rowsToApply = initial.rows;
    }

    const plan = planApply(rowsToApply);
    if (plan.ops.length === 0) {
      console.log(chalk.dim("  Nothing to apply."));
      return;
    }

    const exec = await executeApply(plan, manifest, cwd, state);
    for (const line of exec.log) console.log("  " + line);

    await saveState(cwd, exec.state);

    if (exec.gitPaths.length > 0 && (await isGitRepo(cwd))) {
      const commitMsg = `rotunda sync — ${exec.gitPaths.length} file(s)`;
      try {
        await gitCommitAndPush(cwd, exec.gitPaths, commitMsg, true);
        console.log(chalk.green(`  ✓ Committed and pushed: "${commitMsg}"`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow("  ⚠ Changes applied but git commit/push failed. Commit manually."));
        console.log(chalk.dim("    " + msg.split("\n").join("\n    ")));
      }
    }

    console.log(chalk.green("  ✓ Sync complete."));
  });
}
