import { minimatch } from "minimatch";

/**
 * Test if a relative file path matches any of the given glob patterns.
 * Uses forward slashes for matching regardless of OS.
 */
export function matchesAny(
  relativePath: string,
  patterns: string[]
): boolean {
  // Normalize to forward slashes for consistent matching
  const normalized = relativePath.replace(/\\/g, "/");
  return patterns.some((pattern) =>
    minimatch(normalized, pattern, { dot: true })
  );
}

/**
 * Test if a file should be included based on include/exclude patterns.
 *
 * Logic:
 * - If include patterns exist, file must match at least one include pattern
 * - If file matches any exclude pattern, it is excluded (exclude wins)
 * - globalExclude patterns are checked in addition to per-root excludes
 */
export function shouldInclude(
  relativePath: string,
  include: string[],
  exclude: string[],
  globalExclude: string[]
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");

  // Check excludes first (exclude wins over include)
  const allExcludes = [...exclude, ...globalExclude];

  // Check if any path segment matches an exclude pattern
  // This handles patterns like "node_modules" matching "foo/node_modules/bar"
  const segments = normalized.split("/");
  for (const pattern of allExcludes) {
    // If pattern has no slash, match against any path segment
    if (!pattern.includes("/") && !pattern.includes("*")) {
      if (segments.some((seg) => minimatch(seg, pattern, { dot: true }))) {
        return false;
      }
    }
    // Otherwise match against the full path
    if (minimatch(normalized, pattern, { dot: true })) {
      return false;
    }
  }

  // If no include patterns, include everything not excluded
  if (include.length === 0) {
    return true;
  }

  // Must match at least one include pattern
  return include.some((pattern) =>
    minimatch(normalized, pattern, { dot: true })
  );
}
