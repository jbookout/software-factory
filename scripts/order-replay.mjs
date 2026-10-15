import fs from "node:fs/promises";
import path from "node:path";
import { canonicalDigest } from "../src/canonical.mjs";
import { Deadline } from "../src/deadline.mjs";
import { runProcess } from "../src/process-runner.mjs";
import { assignment, fullSuiteEnvironment } from "../src/nightly-backstop.mjs";
try {
  const args = process.argv.slice(2);
  if (
    args[0] !== "--seed" ||
    args[2] !== "--partitions" ||
    args[4] !== "--root"
  )
    throw Error();
  const seed = Number(args[1]),
    partitions = Number(args[3]),
    cwd = args[5],
    files = args.slice(6),
    groups = assignment(files, seed, partitions);
  if (
    files.some(
      (file) => path.isAbsolute(file) || file.split(/[\\/]/).includes(".."),
    )
  )
    throw Error();
  const inventoryDigest = canonicalDigest(
    await Promise.all(
      files.map(async (file) => [
        file,
        canonicalDigest(await fs.readFile(path.join(cwd, file), "utf8")),
      ]),
    ),
  );
  const deadline = new Deadline(2700000);
  const env = fullSuiteEnvironment();
  const results = await Promise.all(
    groups.map(async (group) => {
      const codes = [];
      for (const file of group) {
        if (deadline.remaining() <= 0) {
          codes.push(142);
          break;
        }
        const r = await runProcess(
          [process.execPath, "--test", file],
          { cwd, env, timeoutMs: deadline.remaining(), captureOutput: false },
        );
        codes.push(r.code);
      }
      return { code: codes.some((c) => c !== 0) ? 1 : 0 };
    }),
  );
  const status = results.every((r) => r.code === 0 && !r.timedOut)
    ? "passed"
    : "failed";
  process.stdout.write(
    JSON.stringify({
      schema: "order-replay.v1",
      mode: "shadow",
      gateAuthority: false,
      seed,
      assignment: groups,
      inventoryDigest,
      status,
      owner: "orchestrator",
      nextAction: "replay-seed-and-assignment-with-same-files",
      isolation: "process-per-test-file",
    }) + "\n",
  );
  process.exitCode = status === "passed" ? 0 : 1;
} catch {
  process.stderr.write(
    "invalid or interrupted order replay; owner orchestrator\n",
  );
  process.exitCode = 1;
}
