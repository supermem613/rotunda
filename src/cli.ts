#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { diffCommand } from "./commands/diff.js";
import { pushCommand } from "./commands/push.js";
import { pullCommand } from "./commands/pull.js";
import { syncCommand } from "./commands/sync.js";
import { doctorCommand } from "./commands/doctor.js";
import { listCommand } from "./commands/list.js";
import { authCommand } from "./commands/auth.js";

const program = new Command();

program
  .name("rotunda")
  .description("Bidirectional config sync with LLM-assisted review")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize rotunda.json and state in current repo")
  .action(initCommand);

program
  .command("status")
  .description("Show what changed since last sync")
  .action(statusCommand);

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
  .command("push")
  .description("Push local changes to repo with LLM-assisted review")
  .option("-y, --yes", "Push all changes without review")
  .action(pushCommand);

program
  .command("pull")
  .description("Pull repo changes to local with LLM-assisted review")
  .option("-y, --yes", "Pull all changes without review")
  .action(pullCommand);

program
  .command("sync")
  .description("Bidirectional sync with LLM-assisted conflict resolution")
  .option("-y, --yes", "Sync all non-conflicting changes without review")
  .action(syncCommand);

program
  .command("doctor")
  .description("Structural health check of manifest, state, repo, and local")
  .option("--fix", "Use LLM to analyze issues and suggest/apply fixes")
  .action(doctorCommand);

program
  .command("list")
  .description("Show manifest roots and what files are actually captured")
  .option("--local", "Show only local files")
  .option("--repo", "Show only repo files")
  .action(listCommand);

program
  .command("auth")
  .description("Authenticate with GitHub Copilot (device flow)")
  .action(authCommand);

program.parse();
