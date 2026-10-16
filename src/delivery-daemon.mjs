import fs from "node:fs/promises";
import path from "node:path";

export async function deliveryStatus(
  config,
  { repo, pr, step, code = 1, message, nextAction = "inspect-and-resume" },
) {
  const file = config.statusFile ?? path.join(config.stateDir, "status.txt");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const clean = (value) => String(value ?? "").replace(/[\r\n]/g, " ");
  await fs.appendFile(
    file,
    `${new Date().toISOString()} ${clean(repo)}#${pr ?? "-"} ${clean(step)} code=${code} ${clean(message)} next=${clean(nextAction)}\n`,
    { mode: 0o600 },
  );
}
