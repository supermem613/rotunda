#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { authCommand } from "./commands/auth.js";
import { bindCommand } from "./commands/bind.js";
import { cdCommand } from "./commands/cd.js";
import { diffCommand } from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { homeCommand } from "./commands/home.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { pullCommand } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { updateCommand } from "./commands/update.js";
import { whereCommand } from "./commands/where.js";

// Read version from package.json so it stays in sync with the published version.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("rotunda")
  .description("Bidirectional config sync with LLM-assisted review");

// Bare `rotunda` (no args) prints version + help. No version banner is printed
// before sub-commands so machine-parseable output stays clean.
if (process.argv.slice(2).length === 0) {
  process.stdout.write(`rotunda v${VERSION}\n\n`);
  program.outputHelp();
  process.exit(0);
}

// Commands are registered in alphabetical order so `rotunda --help` lists
// them alphabetically (commander preserves registration order in help).
program
  .command("auth")
  .description("Authenticate with GitHub Copilot (device flow)")
  .option("-f, --force", "Clear existing token and re-authenticate")
  .action(authCommand);

program
  .command("bind")
  .description("Bind a dotfiles repo for use from any directory")
  .argument("[path]", "Path to bind (default: current directory)")
  .option("--unset", "Remove the current binding")
  .option("--show", "Print the current binding without changing it")
  .action(bindCommand);

program
  .command("cd")
  .description("Open a subshell inside the bound dotfiles repo (exit to return)")
  .action(cdCommand);

program
  .command("diff")
  .description("Show file-level diffs for modified files")
  .argument("[root]", "Filter to a specific sync root")
  .option("--stat", "Summary only (files changed, insertions, deletions)")
  .option("--name-only", "Just list changed file paths")
  .option("--open", "Open each changed file in VS Code diff viewer")
  .option("--html", "Generate interactive HTML diff report in browser")
  .action(diffCommand);

program
  .command("doctor")
  .description("Structural health check of manifest, state, repo, and local")
  .option("--fix", "Use LLM to analyze issues and suggest/apply fixes")
  .action(doctorCommand);

program
  .command("home")
  .description("Open a subshell inside the rotunda source repo (exit to return)")
  .action(homeCommand);

program
  .command("init")
  .description("Initialize rotunda.json and bind this directory as your dotfiles repo")
  .action(initCommand);

program
  .command("list")
  .description("Show manifest roots and what files are actually captured")
  .option("--local", "Show only local files")
  .option("--repo", "Show only repo files")
  .action(listCommand);

program
  .command("pull")
  .description("Pull repo changes to local with LLM-assisted review")
  .option("-y, --yes", "Pull all changes without review")
  .action(pullCommand);

program
  .command("push")
  .description("Push local changes to repo with LLM-assisted review")
  .option("-y, --yes", "Push all changes without review")
  .action(pushCommand);

program
  .command("status")
  .description("Show what changed since last sync")
  .action(statusCommand);

program
  .command("sync")
  .description("Bidirectional sync with LLM-assisted conflict resolution")
  .option("-y, --yes", "Sync all non-conflicting changes without review")
  .action(syncCommand);

program
  .command("update")
  .description("Self-update: git pull, npm install, and rebuild rotunda")
  .action(updateCommand);

program
  .command("where")
  .description("Print the path of the bound dotfiles repo")
  .action(whereCommand);

program.parse();
