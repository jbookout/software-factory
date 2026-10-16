import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process-runner.mjs";

export async function openDesignJournal({
  root = join(homedir(), ".local/share/software-factory/design-manager"),
  userId,
  projectId,
  version,
}) {
  if (
    ![userId, projectId].every((value) => typeof value === "string" && value.trim()) ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new Error("user, project and positive version required");
  const scope = { userId, projectId, version };
  return {
    async execute({ command, kind, record, destination }) {
      if (!["read", "append", "backup"].includes(command))
        throw new Error("unknown journal command");
      if (command === "append" && (typeof kind !== "string" || !kind || record === undefined))
        throw new Error("record and kind required");
      const result = await runProcess(
        ["python3", fileURLToPath(new URL("./design-journal-store.py", import.meta.url))],
        {
          input: JSON.stringify({ root, scope, op: command, kind, record, destination }),
          timeoutMs: 30_000,
        },
      );
      if (result.timedOut || result.uncertain)
        throw new Error("journal outcome unknown; read before retry");
      const value = JSON.parse(result.stdout);
      if (result.code || value.error) throw new Error(value.error ?? "journal operation failed");
      return value;
    },
  };
}
