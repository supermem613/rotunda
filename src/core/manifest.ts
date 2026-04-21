/**
 * Manifest loader — reads, validates, and writes rotunda.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, normalize, sep } from "node:path";
import { z } from "zod";
import type { Manifest, SyncRoot } from "./types.js";

// ── Error ────────────────────────────────────────────────────────────
export class RotundaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RotundaError";
  }
}

// ── Zod schema ───────────────────────────────────────────────────────
const SyncRootSchema = z.object({
  name: z.string().min(1, "root name must be non-empty"),
  local: z.string().min(1, "local path must be non-empty"),
  repo: z.string().min(1, "repo path must be non-empty"),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
});

const MachineRootOverrideSchema = z.object({
  exclude: z.array(z.string()).optional(),
});

const MachineOverrideSchema = z.object({
  exclude: z.array(z.string()).optional(),
  roots: z.record(z.string(), MachineRootOverrideSchema).optional(),
});

export const ManifestSchema = z.object({
  version: z
    .number()
    .int()
    .refine((v) => v === 1, { message: "unsupported manifest version (expected 1)" }),
  roots: z.array(SyncRootSchema),
  globalExclude: z.array(z.string()).default([]),
  machineOverrides: z.record(z.string(), MachineOverrideSchema).optional(),
});

export type ManifestDocument = z.infer<typeof ManifestSchema>;

// ── Path helpers ─────────────────────────────────────────────────────
function resolveTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function normalizePath(p: string): string {
  return normalize(p).split(/[\\/]/).join(sep);
}

function resolveRoot(raw: z.infer<typeof SyncRootSchema>): SyncRoot {
  return {
    ...raw,
    local: normalizePath(resolveTilde(raw.local)),
    repo: normalizePath(raw.repo),
  };
}

// ── Public API ───────────────────────────────────────────────────────

function formatManifestIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
    .join("\n");
}

function readManifestDocument(repoPath?: string): {
  filePath: string;
  data: ManifestDocument;
} {
  const dir = repoPath ?? process.cwd();
  const filePath = join(dir, "rotunda.json");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new RotundaError(
      `Could not read manifest at ${filePath}`,
      { cause: err },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RotundaError(
      `Invalid JSON in ${filePath}`,
      { cause: err },
    );
  }

  const result = ManifestSchema.safeParse(json);
  if (!result.success) {
    throw new RotundaError(
      `Invalid manifest at ${filePath}:\n${formatManifestIssues(result.error.issues)}`,
    );
  }

  return { filePath, data: result.data };
}

/**
 * Load the raw manifest document exactly as stored on disk (with defaults
 * applied), but without resolving `~` or applying machine-specific overrides.
 */
export function loadManifestDocument(repoPath?: string): ManifestDocument {
  return readManifestDocument(repoPath).data;
}

/**
 * Validate and write a manifest document to disk using the repository's
 * canonical formatting.
 */
export function saveManifestDocument(
  repoPath: string,
  manifest: ManifestDocument,
): void {
  const filePath = join(repoPath, "rotunda.json");
  const result = ManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new RotundaError(
      `Refusing to write invalid manifest at ${filePath}:\n${formatManifestIssues(result.error.issues)}`,
    );
  }

  writeFileSync(filePath, JSON.stringify(result.data, null, 2) + "\n", "utf-8");
}

/**
 * Load and validate rotunda.json, applying machine-specific overrides.
 * @param repoPath — directory containing rotunda.json (default: cwd)
 * @param hostnameOverride — override os.hostname() for testing
 */
export function loadManifest(repoPath?: string, hostnameOverride?: string): Manifest {
  const data = loadManifestDocument(repoPath);
  let roots = data.roots.map(resolveRoot);
  let globalExclude = [...data.globalExclude];
  let appliedMachine: string | undefined;

  // Apply machine-specific overrides (case-insensitive hostname match)
  if (data.machineOverrides) {
    const currentHost = (hostnameOverride ?? hostname()).toLowerCase();
    for (const [machineName, override] of Object.entries(data.machineOverrides)) {
      if (machineName.toLowerCase() === currentHost) {
        appliedMachine = machineName;

        // Merge global excludes
        if (override.exclude) {
          globalExclude = [...globalExclude, ...override.exclude];
        }

        // Merge per-root excludes
        if (override.roots) {
          roots = roots.map((root) => {
            const rootOverride = override.roots?.[root.name];
            if (rootOverride?.exclude) {
              return {
                ...root,
                exclude: [...root.exclude, ...rootOverride.exclude],
              };
            }
            return root;
          });
        }
        break; // Only one machine can match
      }
    }
  }

  return {
    version: data.version,
    roots,
    globalExclude,
    machineOverrides: data.machineOverrides,
    appliedMachine,
  };
}
