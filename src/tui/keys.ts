/**
 * Keyboard input wiring for the TUI.
 *
 * Wraps Node's built-in readline.emitKeypressEvents into a typed event
 * stream. Centralising name normalisation here keeps the reducer free of
 * platform quirks (e.g., Windows reporting "return" vs Linux "enter").
 */

import * as readline from "node:readline";
import type { Key } from "./state.js";

/**
 * Window we wait after a standalone \x1b byte before deciding it's the
 * ESC key (vs. the start of a CSI sequence like \x1b[A). Node's built-in
 * readline uses a hardcoded 500 ms for this — far too long for a TUI
 * where ESC is the primary way to dismiss a modal. 30 ms is plenty for
 * follow-up bytes on a local terminal (they arrive within microseconds)
 * and imperceptible to the user.
 *
 * Exported for tests; callers shouldn't depend on the exact value.
 */
export const FAST_ESCAPE_WAIT_MS = 30;

/**
 * How long the dedupe window lasts. Readline fires its delayed escape
 * keypress ~500 ms after the ESC byte arrived, so any dedupe window
 * longer than that is safe. 600 ms gives a little headroom without
 * suppressing a rapid second ESC press.
 */
const ESCAPE_DEDUPE_MS = 600;

/** Normalise a raw readline keypress into our Key shape. */
export function normalizeKey(
  str: string | undefined,
  raw: readline.Key | undefined,
): Key {
  let name = raw?.name ?? str ?? "";
  // readline reports ENTER as 'return' on macOS/Linux but the user thinks
  // ENTER. Normalise to 'enter' so reducers only check one symbol.
  if (name === "return") name = "enter";
  // Space comes through as str=' ', name='space' on most platforms but on
  // some Windows builds str=' ', name=undefined. Treat both as 'space'.
  if (!raw?.name && str === " ") name = "space";
  // ESC: on most terminals readline sets raw.name='escape' after its
  // ~500 ms escape-sequence timeout. On some Windows ConPTY paths the
  // bare ESC arrives as str='\x1b' with raw.name undefined — normalise.
  if (name === "\x1b" || raw?.sequence === "\x1b" || str === "\x1b") {
    name = "escape";
  }
  return {
    name,
    ctrl: raw?.ctrl,
    shift: raw?.shift,
    meta: raw?.meta,
    sequence: raw?.sequence,
  };
}

/**
 * Subscribe to keypress events on the given input stream.
 * Returns a cleanup function that unsubscribes and restores cooked mode.
 *
 * Caller is responsible for ensuring `input.isTTY` before calling.
 */
export function subscribeKeys(
  input: NodeJS.ReadStream,
  onKey: (key: Key) => void,
): () => void {
  // Attach our fast-ESC 'data' listener BEFORE emitKeypressEvents so it
  // sees raw bytes first. Node's readline installs its own 'data' listener
  // when emitKeypressEvents is called; both fire on every chunk, in the
  // order they were registered.
  const fastEscape = attachFastEscape(input, onKey);

  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);

  const handler = (str: string | undefined, raw: readline.Key | undefined): void => {
    const key = normalizeKey(str, raw);
    // Dedupe: if the fast path already emitted this escape, swallow the
    // delayed one that readline's 500 ms timer produces.
    if (key.name === "escape" && fastEscape.consumeIfRecent()) return;
    onKey(key);
  };
  input.on("keypress", handler);

  return (): void => {
    input.off("keypress", handler);
    fastEscape.detach();
    if (input.isTTY) {
      try { input.setRawMode(false); } catch { /* may already be torn down */ }
    }
    // emitKeypressEvents puts stdin into flowing mode; pause it so the
    // event loop can exit after the TUI returns. Without this the process
    // hangs on Windows after a clean quit.
    try { input.pause(); } catch { /* ignore */ }
  };
}

interface FastEscape {
  /** Remove the 'data' listener and cancel any pending timer. */
  detach(): void;
  /**
   * Returns true if we emitted a fast escape within the dedupe window and
   * clears the marker so repeated readline events don't all get swallowed.
   */
  consumeIfRecent(): boolean;
}

/**
 * Watch the raw byte stream for a lone \x1b and dispatch ESC immediately
 * instead of waiting out readline's 500 ms timeout. Exported as a helper so
 * tests can exercise the byte-stream logic without a real TTY.
 */
export function attachFastEscape(
  input: NodeJS.ReadStream,
  onKey: (key: Key) => void,
  waitMs: number = FAST_ESCAPE_WAIT_MS,
): FastEscape {
  let timer: NodeJS.Timeout | null = null;
  let lastFastEmitAt = 0;

  const onData = (chunk: Buffer | string): void => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    // A solo \x1b byte is either the ESC key pressed alone or the first
    // byte of a CSI sequence whose continuation is still in flight. Arm
    // a short timer — if more bytes arrive first, we cancel; otherwise
    // we commit to "it was the ESC key" and dispatch immediately.
    if (buf.length === 1 && buf[0] === 0x1b) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        lastFastEmitAt = Date.now();
        onKey({ name: "escape", sequence: "\x1b" });
      }, waitMs);
      return;
    }
    // Any other chunk (including one that begins with \x1b followed by
    // the rest of a CSI sequence in the same read, or a continuation
    // chunk) cancels the pending fast-escape decision — readline's
    // decoder will handle it.
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  input.on("data", onData);

  return {
    detach(): void {
      input.off("data", onData);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    consumeIfRecent(): boolean {
      if (lastFastEmitAt === 0) return false;
      const fresh = Date.now() - lastFastEmitAt < ESCAPE_DEDUPE_MS;
      if (fresh) lastFastEmitAt = 0;
      return fresh;
    },
  };
}
