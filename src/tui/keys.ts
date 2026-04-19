/**
 * Keyboard input wiring for the TUI.
 *
 * Wraps Node's built-in readline.emitKeypressEvents into a typed event
 * stream. Centralising name normalisation here keeps the reducer free of
 * platform quirks (e.g., Windows reporting "return" vs Linux "enter").
 */

import * as readline from "node:readline";
import type { Key } from "./state.js";

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
  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);

  const handler = (str: string | undefined, raw: readline.Key | undefined): void => {
    onKey(normalizeKey(str, raw));
  };
  input.on("keypress", handler);

  return (): void => {
    input.off("keypress", handler);
    if (input.isTTY) {
      try { input.setRawMode(false); } catch { /* may already be torn down */ }
    }
    // emitKeypressEvents puts stdin into flowing mode; pause it so the
    // event loop can exit after the TUI returns. Without this the process
    // hangs on Windows after a clean quit.
    try { input.pause(); } catch { /* ignore */ }
  };
}
