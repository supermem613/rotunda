/**
 * LLM prompt templates for review and reshape flows.
 *
 * - `buildExplainPrompt` — single-file change explanation (used by review).
 * - `buildReshapePrompt` — interactive content reshape proposal (used by review).
 * - `buildConflictPrompt` — three-way conflict explanation (used by review).
 *
 * All prompts return a `PromptPair` (system + user message) which callers feed
 * directly into `ask()` from `llm/copilot.ts`. Keeping templates pure and
 * dependency-free means they're trivially unit-testable.
 */

import type { FileChange } from "../core/types.js";
import { estimateTokens, truncateToTokenBudget, truncateDiff, MAX_PROMPT_TOKENS } from "./tokens.js";

/** A system + user prompt pair, ready to send to the LLM. */
export interface PromptPair {
  system: string;
  user: string;
}

// ─── Per-file budget helper ──────────────────────────────────

/** Cap diff and content for a single file to stay within a token budget. */
function capFilePayload(
  diff: string,
  content: string | null,
  budgetTokens: number,
): { diff: string; content: string | null } {
  const metaOverhead = 50;
  let remaining = budgetTokens - metaOverhead;
  if (remaining < 200) remaining = 200;

  let cappedDiff = diff;
  let cappedContent = content;

  if (diff) {
    const diffBudget = content != null
      ? Math.floor(remaining * 0.7)
      : remaining;
    cappedDiff = truncateDiff(diff, diffBudget);
    remaining -= estimateTokens(cappedDiff);
  }

  if (content != null) {
    const contentBudget = Math.max(remaining, 200);
    cappedContent = truncateToTokenBudget(content, contentBudget, "file content");
  }

  return { diff: cappedDiff, content: cappedContent };
}

export function buildExplainPrompt(
  change: FileChange,
  repoContent: string | null,
  localContent: string | null,
  diff: string,
): PromptPair {
  const system =
    "You are a code review assistant helping a developer review configuration file changes before syncing. " +
    "Be concise. Show the actual diff chunks in your explanation. Focus on what changed and why it matters.";

  // Budget: total limit minus system prompt
  const budget = MAX_PROMPT_TOKENS - estimateTokens(system) - 200;
  const { diff: cappedDiff, content: cappedContent } = capFilePayload(
    diff,
    localContent ?? repoContent,
    budget,
  );

  let body: string;

  switch (change.action) {
    case "added": {
      const content = cappedContent ?? "";
      body =
        `File: ${change.relativePath}\n` +
        `Change type: added (${change.side})\n\n` +
        `Full content of the new file:\n\`\`\`\n${content}\n\`\`\`\n\n` +
        `Please explain what this new file contains and its purpose.`;
      break;
    }
    case "deleted":
      body =
        `File: ${change.relativePath}\n` +
        `Change type: deleted (${change.side})\n\n` +
        `This file is being removed.\n\n` +
        `Previous content:\n\`\`\`\n${cappedContent ?? ""}\n\`\`\`\n\n` +
        `Please explain what is being removed and any implications.`;
      break;
    case "modified":
    case "conflict":
    default:
      body =
        `File: ${change.relativePath}\n` +
        `Change type: ${change.action} (${change.side})\n\n` +
        `Diff:\n\`\`\`diff\n${cappedDiff}\n\`\`\`\n\n` +
        `Please provide a clear explanation of these changes.`;
      break;
  }

  return { system, user: body };
}

export function buildReshapePrompt(
  repoContent: string | null,
  localContent: string | null,
  diff: string,
  userInstruction: string,
): PromptPair {
  const system =
    "You are a code editor. The user wants to modify a file before syncing. " +
    "Apply their instruction to the local version of the file. " +
    "Output ONLY the complete new file content, nothing else. No markdown fences, no explanation.";

  // Budget: total limit minus system prompt minus instruction overhead
  const budget = MAX_PROMPT_TOKENS - estimateTokens(system) - estimateTokens(userInstruction) - 300;
  // Split budget: repo content, local content, and diff each get a third
  const sliceBudget = Math.floor(budget / 3);

  const parts: string[] = [];

  if (repoContent != null) {
    const capped = truncateToTokenBudget(repoContent, sliceBudget, "repo content");
    parts.push(`Repo version:\n\`\`\`\n${capped}\n\`\`\``);
  }
  if (localContent != null) {
    const capped = truncateToTokenBudget(localContent, sliceBudget, "local content");
    parts.push(`Local version:\n\`\`\`\n${capped}\n\`\`\``);
  }
  if (diff) {
    const capped = truncateDiff(diff, sliceBudget);
    parts.push(`Diff:\n\`\`\`diff\n${capped}\n\`\`\``);
  }
  parts.push(`Instruction: ${userInstruction}`);

  return { system, user: parts.join("\n\n") };
}

export function buildConflictPrompt(
  _repoContent: string,
  _localContent: string,
  repoDiff: string,
  localDiff: string,
): PromptPair {
  const system =
    "You are a merge assistant. Both the local and repo versions of this file have changed since the last sync. " +
    "Analyze whether the changes overlap. If they don't overlap, suggest a merged version. " +
    "If they do overlap, explain the conflict clearly and show both versions.";

  // Each diff gets half the remaining budget
  const budget = MAX_PROMPT_TOKENS - estimateTokens(system) - 300;
  const perDiffBudget = Math.floor(budget / 2);

  const cappedRepoDiff = truncateDiff(repoDiff, perDiffBudget);
  const cappedLocalDiff = truncateDiff(localDiff, perDiffBudget);

  const user =
    `Changes in the repo since last sync:\n\`\`\`diff\n${cappedRepoDiff}\n\`\`\`\n\n` +
    `Changes locally since last sync:\n\`\`\`diff\n${cappedLocalDiff}\n\`\`\`\n\n` +
    `Please analyze whether these changes overlap and suggest how to merge them.`;

  return { system, user };
}
