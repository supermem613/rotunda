import chalk from "chalk";
import { loadManifest } from "../core/manifest.js";
import { loadState, saveState, updateStateFiles, removeFromState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import { withLock } from "../utils/lock.js";
import { copyFile, mkdir, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import type { FileChange } from "../core/types.js";

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

async function promptChoice(question: string, choices: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const lower = answer.toLowerCase().trim();
      resolve(choices.includes(lower) ? lower : choices[0]);
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function syncCommand(options: { yes?: boolean }): Promise<void> {
  const cwd = process.cwd();

  let manifest;
  try {
    manifest = loadManifest(cwd);
  } catch {
    console.error(chalk.red("Error:") + " Could not load rotunda.json. Run `rotunda init` first.");
    process.exit(1);
  }

  await withLock(cwd, "sync", async () => {
  const state = await loadState(cwd);
  const allChanges = await computeAllChanges(manifest, cwd, state);

  if (allChanges.length === 0) {
    console.log(chalk.green("✓") + " Everything in sync. No changes detected.");
    return;
  }

  // Categorize changes
  const localChanges = allChanges.filter((c) => c.side === "local");
  const repoChanges = allChanges.filter((c) => c.side === "repo");
  const conflicts = allChanges.filter((c) => c.action === "conflict");

  // Show summary
  console.log(chalk.bold("\n  Sync Summary:\n"));
  if (localChanges.length > 0) {
    console.log(chalk.cyan(`  → Push (local → repo): ${localChanges.length} file(s)`));
    for (const c of localChanges) {
      const label = c.action === "added" ? chalk.green("added") :
        c.action === "modified" ? chalk.yellow("modified") : chalk.red("deleted");
      console.log(`      ${label}  ${c.rootName}/${c.relativePath}`);
    }
  }
  if (repoChanges.length > 0) {
    console.log(chalk.cyan(`\n  ← Pull (repo → local): ${repoChanges.length} file(s)`));
    for (const c of repoChanges) {
      const label = c.action === "added" ? chalk.green("added") :
        c.action === "modified" ? chalk.yellow("modified") : chalk.red("deleted");
      console.log(`      ${label}  ${c.rootName}/${c.relativePath}`);
    }
  }
  if (conflicts.length > 0) {
    console.log(chalk.magenta(`\n  ⚠ Conflicts: ${conflicts.length} file(s)`));
    for (const c of conflicts) {
      console.log(`      ${chalk.magenta("CONFLICT")}  ${c.rootName}/${c.relativePath}`);
    }
  }

  console.log();

  // Confirm non-conflicts
  const autoApply = [...localChanges, ...repoChanges];
  if (!options.yes && autoApply.length > 0) {
    const ok = await confirm(`  Apply ${autoApply.length} non-conflicting change(s)? [y/N] `);
    if (!ok) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }
  }

  // Apply non-conflicting changes
  let updatedState = { ...state, files: { ...state.files } };

  for (const c of autoApply) {
    const rootDef = manifest.roots.find((r) => r.name === c.rootName);
    if (!rootDef) continue;

    const localFile = join(rootDef.local, c.relativePath);
    const repoFile = join(cwd, rootDef.repo, c.relativePath);

    if (c.side === "local") {
      // Push: local → repo
      if (c.action === "added" || c.action === "modified") {
        await mkdir(dirname(repoFile), { recursive: true });
        await copyFile(localFile, repoFile);
        const synced = new Map([[c.relativePath, c.localHash!]]);
        updatedState = updateStateFiles(updatedState, rootDef.repo, synced);
        console.log(chalk.green("  → ✓") + ` ${c.rootName}/${c.relativePath}`);
      } else if (c.action === "deleted") {
        await rm(repoFile, { recursive: true, force: true }).catch(() => {});
        updatedState = removeFromState(updatedState, rootDef.repo, [c.relativePath]);
        console.log(chalk.red("  → ✗") + ` ${c.rootName}/${c.relativePath} ${chalk.dim("(removed from repo)")}`);
      }
    } else if (c.side === "repo") {
      // Pull: repo → local
      if (c.action === "added" || c.action === "modified") {
        await mkdir(dirname(localFile), { recursive: true });
        await copyFile(repoFile, localFile);
        const synced = new Map([[c.relativePath, c.repoHash!]]);
        updatedState = updateStateFiles(updatedState, rootDef.repo, synced);
        console.log(chalk.green("  ← ✓") + ` ${c.rootName}/${c.relativePath}`);
      } else if (c.action === "deleted") {
        if (await fileExists(localFile)) {
          await rm(localFile, { recursive: true, force: true });
        }
        updatedState = removeFromState(updatedState, rootDef.repo, [c.relativePath]);
        console.log(chalk.red("  ← ✗") + ` ${c.rootName}/${c.relativePath} ${chalk.dim("(removed from local)")}`);
      }
    }
  }

  // Handle conflicts interactively
  if (conflicts.length > 0 && !options.yes) {
    console.log(chalk.magenta("\n  Resolving conflicts:\n"));

    for (const c of conflicts) {
      const rootDef = manifest.roots.find((r) => r.name === c.rootName);
      if (!rootDef) continue;

      const localFile = join(rootDef.local, c.relativePath);
      const repoFile = join(cwd, rootDef.repo, c.relativePath);

      console.log(chalk.magenta(`  CONFLICT: ${c.rootName}/${c.relativePath}`));
      const choice = await promptChoice(
        `    Keep [l]ocal, keep [r]epo, or [s]kip? `,
        ["l", "r", "s"]
      );

      if (choice === "l") {
        // Keep local → push to repo
        if (await fileExists(localFile)) {
          await mkdir(dirname(repoFile), { recursive: true });
          await copyFile(localFile, repoFile);
          const synced = new Map([[c.relativePath, c.localHash!]]);
          updatedState = updateStateFiles(updatedState, rootDef.repo, synced);
        } else {
          await rm(repoFile, { recursive: true, force: true }).catch(() => {});
          updatedState = removeFromState(updatedState, rootDef.repo, [c.relativePath]);
        }
        console.log(chalk.green("    ✓") + " Kept local version");
      } else if (choice === "r") {
        // Keep repo → pull to local
        if (await fileExists(repoFile)) {
          await mkdir(dirname(localFile), { recursive: true });
          await copyFile(repoFile, localFile);
          const synced = new Map([[c.relativePath, c.repoHash!]]);
          updatedState = updateStateFiles(updatedState, rootDef.repo, synced);
        } else {
          await rm(localFile, { recursive: true, force: true }).catch(() => {});
          updatedState = removeFromState(updatedState, rootDef.repo, [c.relativePath]);
        }
        console.log(chalk.green("    ✓") + " Kept repo version");
      } else {
        console.log(chalk.dim("    Skipped"));
      }
    }
  }

  // Save state
  await saveState(cwd, updatedState);
  console.log(chalk.green(`\n  ✓ Sync complete.`));
  }); // end withLock
}
