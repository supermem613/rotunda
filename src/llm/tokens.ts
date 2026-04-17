/**
 * Token estimation and prompt-size management.
 *
 * Uses a conservative chars-per-token ratio (3) so that budget calculations
 * over-estimate rather than under-estimate — we'd rather truncate a little
 * too eagerly than hit a hard API limit.
 */

/** Conservative estimate — 3 chars ≈ 1 token for code-heavy content. */
export const CHARS_PER_TOKEN = 3;

/**
 * Model token limit.  gpt-5-mini supports 128 000 tokens.
 */
export const MODEL_TOKEN_LIMIT = 128_000;

/** Max tokens reserved for the LLM response. */
export const MAX_RESPONSE_TOKENS = 4096;

/**
 * Maximum prompt tokens we'll send (model limit minus response budget
 * minus a 2 000-token safety margin for framing / overhead).
 */
export const MAX_PROMPT_TOKENS =
  MODEL_TOKEN_LIMIT - MAX_RESPONSE_TOKENS - 2_000; // ≈ 121 904

// ─── Utilities ───────────────────────────────────────────────

/** Rough token count for a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Convert a token budget to an approximate character budget. */
export function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

/**
 * Truncate `text` on the nearest preceding line boundary so that the
 * result fits within `maxTokens`.  Appends a marker when truncation
 * occurs so the LLM (and the user) knows content was omitted.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  label = "content",
): string {
  const maxChars = tokensToChars(maxTokens);
  if (text.length <= maxChars) return text;

  // Cut on a line boundary when possible
  const cutoff = text.lastIndexOf("\n", maxChars);
  const truncAt = cutoff > 0 ? cutoff : maxChars;
  const omitted = text.length - truncAt;
  return (
    text.slice(0, truncAt) +
    `\n... (${label} truncated — ~${Math.ceil(omitted / CHARS_PER_TOKEN)} tokens omitted)`
  );
}

/**
 * Truncate a unified diff on hunk boundaries so that the result fits
 * within `maxTokens`.  Preserves complete hunks rather than slicing
 * mid-hunk, which would confuse the LLM.
 */
export function truncateDiff(diff: string, maxTokens: number): string {
  const maxChars = tokensToChars(maxTokens);
  if (diff.length <= maxChars) return diff;

  const lines = diff.split("\n");
  const kept: string[] = [];
  let charCount = 0;
  let omittedHunks = 0;
  let inHunk = false;
  let hunkStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHunkHeader = line.startsWith("@@");

    if (isHunkHeader) {
      // If a previous hunk was being tracked, it's complete
      inHunk = true;
      hunkStart = kept.length;
    }

    const lineLen = line.length + 1; // +1 for newline
    if (charCount + lineLen > maxChars) {
      // If we're mid-hunk, roll back to the hunk header
      if (inHunk && hunkStart < kept.length) {
        kept.splice(hunkStart);
      }
      omittedHunks++;
      break;
    }

    kept.push(line);
    charCount += lineLen;
  }

  // Count remaining hunks we skipped
  for (let i = kept.length; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) omittedHunks++;
  }

  if (omittedHunks > 0) {
    kept.push(`\n... (${omittedHunks} diff hunk(s) omitted to fit token limit)`);
  }

  return kept.join("\n");
}

// ─── Overflow detection ──────────────────────────────────────

/** Typed error so callers can catch and react to token overflow. */
export class TokenOverflowError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly limitTokens: number,
  ) {
    super(
      `Estimated prompt size (~${estimatedTokens} tokens) exceeds ` +
      `limit (${limitTokens} tokens)`,
    );
    this.name = "TokenOverflowError";
  }
}
