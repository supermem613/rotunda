import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Compute SHA256 hash of a file.
 * Returns the hex-encoded hash string.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA256 hash of a string/buffer.
 */
export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
