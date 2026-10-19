import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";

export async function runVerification({
  cwd,
  argv,
  timeoutMs = 3600_000,
  admission,
  signal,
  root = os.tmpdir(),
}) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, "factory-check-"));
  const log = path.join(directory, "output.log");
  await fs.writeFile(log, "", { mode: 0o600 });
  const result = await runProcess(argv, {
    cwd,
    timeoutMs,
    signal,
    env: { ...process.env, ...admission?.env },
    captureOutput: false,
    onOutput: (chunk) => appendFileSync(log, chunk),
    onSpawn: (job, bindingSignal) => admission?.bindJob(job, bindingSignal),
  });
  return { argv, code: result.code, log };
}
