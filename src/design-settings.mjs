import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function loadDesignSettings(
  file = join(homedir(), ".config/software-factory/design-manager/settings.json"),
) {
  const settings = JSON.parse(await readFile(file, "utf8"));
  if (!settings.workers || typeof settings.workers !== "object")
    throw new Error("worker settings required");
  for (const worker of Object.values(settings.workers)) {
    if (
      ![worker.provider, worker.model, worker.effort].every(
        (value) => typeof value === "string" && value.trim(),
      )
    )
      throw new Error("each worker needs a provider, model and effort");
  }
  return settings;
}
