import { runIncludeLifecycleCommand } from "./include-lifecycle.js";

export async function addCommand(
  path: string,
  options: { pruneEmptyDirs?: boolean } = {},
): Promise<void> {
  await runIncludeLifecycleCommand("add", path, options);
}
