/**
 * LLM prompt templates for the push/pull review flow.
 */

import type { FileChange } from "../core/types.js";

interface PromptPair {
  system: string;
  user: string;
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

  let body: string;

  switch (change.action) {
    case "added": {
      const content = localContent ?? repoContent ?? "";
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
        `Previous content:\n\`\`\`\n${repoContent ?? localContent ?? ""}\n\`\`\`\n\n` +
        `Please explain what is being removed and any implications.`;
      break;
    case "modified":
    case "conflict":
    default:
      body =
        `File: ${change.relativePath}\n` +
        `Change type: ${change.action} (${change.side})\n\n` +
        `Diff:\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
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

  const parts: string[] = [];

  if (repoContent != null) {
    parts.push(`Repo version:\n\`\`\`\n${repoContent}\n\`\`\``);
  }
  if (localContent != null) {
    parts.push(`Local version:\n\`\`\`\n${localContent}\n\`\`\``);
  }
  if (diff) {
    parts.push(`Diff:\n\`\`\`diff\n${diff}\n\`\`\``);
  }
  parts.push(`Instruction: ${userInstruction}`);

  return { system, user: parts.join("\n\n") };
}

export function buildConflictPrompt(
  repoContent: string,
  localContent: string,
  repoDiff: string,
  localDiff: string,
): PromptPair {
  const system =
    "You are a merge assistant. Both the local and repo versions of this file have changed since the last sync. " +
    "Analyze whether the changes overlap. If they don't overlap, suggest a merged version. " +
    "If they do overlap, explain the conflict clearly and show both versions.";

  const user =
    `Changes in the repo since last sync:\n\`\`\`diff\n${repoDiff}\n\`\`\`\n\n` +
    `Changes locally since last sync:\n\`\`\`diff\n${localDiff}\n\`\`\`\n\n` +
    `Please analyze whether these changes overlap and suggest how to merge them.`;

  return { system, user };
}
