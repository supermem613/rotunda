import { runIncludeLifecycleCommand } from "./include-lifecycle.js";

export async function removeCommand(path: string): Promise<void> {
  await runIncludeLifecycleCommand("remove", path);
}
