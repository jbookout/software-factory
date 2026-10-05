import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../src/process-runner.mjs";
import { writeJson } from "../src/pr-delivery-state.mjs";
import { monotonicNow } from "../src/deadline.mjs";

export const recoveryPattern =
  "fix12: kill after|fix12: restored requested checkpoint|PR46 finding 1: admission quota|PR46 finding 7: undispatched quota|fix12: cancelled pending job|fix30: 48-hour virtual";
export async function rehearse({
  output,
  wallclock = false,
  run = runProcess,
  clock = monotonicNow,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!output) throw Error("receipt path required");
  const started = clock(),
    duration = wallclock ? 48 * 3600000 : 0,
    cycles = [];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const options = env.NODE_OPTIONS ?? "";
  env.NODE_OPTIONS = /(?:^|\s)--test-reporter=tap(?:\s|$)/.test(options)
    ? options
    : `${options} --test-reporter=tap`.trim();
  do {
    const at = clock(),
      result = await run(
        [
          process.execPath,
          "--test",
          `--test-name-pattern=${recoveryPattern}`,
          "test/pr-delivery.test.mjs",
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env,
          timeoutMs: 600000,
          maxOutputBytes: 8 * 1024 * 1024,
        },
      );
    const output = result.stdout ?? "",
      total = Number(/^# tests ([0-9]+)$/m.exec(output)?.[1]),
      passed = Number(/^# pass ([0-9]+)$/m.exec(output)?.[1]),
      failed = Number(/^# fail ([0-9]+)$/m.exec(output)?.[1]);
    const healthy =
      result.code === 0 &&
      !result.timedOut &&
      /^TAP version 13$/m.test(output) &&
      Number.isInteger(total) &&
      total >= 10 &&
      total ===
        passed + Number(/^# skipped ([0-9]+)$/m.exec(output)?.[1] ?? 0) &&
      passed >= 10 &&
      failed === 0;
    cycles.push({
      elapsedSeconds: (at - started) / 1000,
      durationSeconds: (clock() - at) / 1000,
      status: healthy ? "passed" : "failed",
      tests: Number.isInteger(total) ? total : null,
      recoverySeconds: /^# FIX30_RECOVERY_SECONDS ([0-9.]+)$/m.test(output)
        ? Number(/^# FIX30_RECOVERY_SECONDS ([0-9.]+)$/m.exec(output)[1])
        : null,
    });
    if (!healthy) break;
    if (!wallclock || clock() - started >= duration) break;
    while (clock() - at < 3600000 && clock() - started < duration)
      await sleep(
        Math.min(
          60000,
          3600000 - (clock() - at),
          duration - (clock() - started),
        ),
      );
  } while (true);
  const verified = cycles.every((c) => c.status === "passed");
  const receipt = {
    schema: "recovery-rehearsal.v1",
    mode: "shadow",
    gateAuthority: false,
    effects: "disposable-local-git-and-fake-provider",
    exercise: wallclock ? "wall-clock" : "acceptance-replay",
    requiredHours: 48,
    elapsedHours: (clock() - started) / 3600000,
    cycles,
    status:
      verified &&
      (!wallclock || clock() - started >= duration)
        ? "passed"
        : "failed",
    owner: "orchestrator",
    nextAction: !verified
      ? "inspect-failed-disposable-replay-before-rehearsal"
      : wallclock
        ? "inspect-conservation-and-recovery-assertions"
        : "run-opt-in-48-hour-wall-clock-rehearsal",
    measurements: {
      cycleSeconds: cycles.map((c) => c.durationSeconds),
      operationalRecoverySeconds: cycles.map((c) => c.recoverySeconds),
      conservation: verified ? "asserted-by-existing-queue-tests" : "unproven",
      waitingOwnership: verified
        ? "queue-consumer-with-persisted-availableAt"
        : "unproven",
    },
    pendingWallclockProof: !wallclock,
  };
  await writeJson(output, receipt);
  return receipt;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    if (
      args[0] !== "--disposable" ||
      !["--replay", "--wallclock-48h"].includes(args[1]) ||
      args[2] !== "--output" ||
      args.length !== 4
    )
      throw Error();
    const receipt = await rehearse({
      output: args[3],
      wallclock: args[1] === "--wallclock-48h",
    });
    process.stdout.write(JSON.stringify(receipt) + "\n");
    process.exitCode = receipt.status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write(
      "disposable recovery rehearsal failed; owner orchestrator; inspect receipt before retry\n",
    );
    process.exitCode = 1;
  }
}
