import { runIncludeLifecycleCommand } from "./include-lifecycle.js";

export async function addCommand(path: string): Promise<void> {
  await runIncludeLifecycleCommand("add", path);
}
