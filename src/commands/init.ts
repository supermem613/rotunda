import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { loadManifest } from "../core/manifest.js";
import { loadState, saveState, getStateDir } from "../core/state.js";
import { discoverFiles, hashFiles } from "../core/engine.js";

const DEFAULT_MANIFEST = {
  version: 1,
  roots: [
    {
      name: "claude",
      local: "~/.claude",
      repo: ".claude",
      include: [
        "skills/**",
        "agents/**",
        "hooks/**",
        "CLAUDE.md",
        "settings.json",
        "mcp.json",
      ],
      exclude: [
        "node_modules",
        "cache",
        "sessions",
        "history.jsonl",
        "*.credentials*",
        "telemetry",
        "debug",
        "downloads",
        "file-history",
        "paste-cache",
        "plans",
        "session-env",
        "shell-snapshots",
        "stats-cache.json",
        "statsig",
        "tasks",
        "todos",
        "transcripts",
        "ide",
        "backups",
        "commands",
        "plugins",
        "projects",
        "policy-limits.json",
        "settings.local.json",
        "config.json",
      ],
    },
    {
      name: "copilot",
      local: "~/.copilot",
      repo: ".copilot",
      include: [
        "agents/**",
        "extensions/**",
        "hooks/**",
        "config.json",
        "permissions-config.json",
      ],
      exclude: [
        "node_modules",
        "logs",
        "session-state",
        "session-store*",
        "crash-context",
        "ide",
        "installed-plugins",
        "marketplace-cache",
        "mcp-oauth-config",
        "pkg",
        "restart",
        "command-history-state.json",
      ],
    },
  ],
  globalExclude: ["node_modules", ".git", "*.log", "*.tmp", "__pycache__"],
};

export async function initCommand(): Promise<void> {
  const cwd = process.cwd();
  const manifestPath = join(cwd, "rotunda.json");
  const stateDir = getStateDir(cwd);
  const gitignorePath = join(cwd, ".gitignore");

  // Check if already initialized
  if (existsSync(manifestPath)) {
    console.log(chalk.yellow("rotunda.json already exists. Skipping manifest creation."));
  } else {
    writeFileSync(
      manifestPath,
      JSON.stringify(DEFAULT_MANIFEST, null, 2) + "\n",
      "utf-8"
    );
    console.log(chalk.green("✓") + " Created rotunda.json");
  }

  // Create .rotunda/ state directory
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
    console.log(chalk.green("✓") + " Created .rotunda/ directory");
  }

  // Ensure .rotunda/ is in .gitignore
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(".rotunda")) {
      writeFileSync(gitignorePath, gitignore.trimEnd() + "\n.rotunda/\n", "utf-8");
      console.log(chalk.green("✓") + " Added .rotunda/ to .gitignore");
    }
  } else {
    writeFileSync(gitignorePath, ".rotunda/\n", "utf-8");
    console.log(chalk.green("✓") + " Created .gitignore with .rotunda/");
  }

  // Build initial state from files that exist in BOTH local and repo (already synced)
  try {
    const manifest = loadManifest(cwd);
    console.log(chalk.dim("\nScanning existing files..."));

    let totalFiles = 0;
    let localCount = 0;
    let repoCount = 0;
    const state = await loadState(cwd);

    for (const root of manifest.roots) {
      const localDir = root.local;
      const repoDir = join(cwd, root.repo);

      const [localFiles, repoFiles] = await Promise.all([
        discoverFiles(localDir, root.include, root.exclude, manifest.globalExclude),
        discoverFiles(repoDir, root.include, root.exclude, manifest.globalExclude),
      ]);

      localCount += localFiles.size;
      repoCount += repoFiles.size;

      const [localHashes, repoHashes] = await Promise.all([
        hashFiles(localFiles),
        hashFiles(repoFiles),
      ]);

      // Only track files that exist in BOTH local and repo with matching content
      // Files only in one side will show up as "added" on first push/pull
      for (const [relPath, localHash] of localHashes) {
        const repoHash = repoHashes.get(relPath);
        if (repoHash && repoHash === localHash) {
          const stateKey = root.repo + "/" + relPath;
          if (!state.files[stateKey]) {
            state.files[stateKey] = {
              hash: localHash,
              size: 0,
              syncedAt: new Date().toISOString(),
            };
            totalFiles++;
          }
        }
      }
    }

    state.lastSync = new Date().toISOString();
    await saveState(cwd, state);
    console.log(
      chalk.green("✓") +
        ` Initial state: ${totalFiles} synced, ${localCount} local-only, ${repoCount} repo-only`
    );
    if (localCount > totalFiles) {
      console.log(chalk.dim(`  Run \`rotunda push\` to push ${localCount - totalFiles} local-only file(s) to repo.`));
    }
    if (repoCount > totalFiles) {
      console.log(chalk.dim(`  Run \`rotunda pull\` to pull ${repoCount - totalFiles} repo-only file(s) to local.`));
    }
  } catch (err) {
    console.log(
      chalk.yellow("⚠") +
        " Could not scan files (run rotunda init again after setting up roots)"
    );
  }

  console.log(chalk.green("\n✓ Rotunda initialized."));
  console.log(chalk.dim("  Run `rotunda status` to see current state."));
}
