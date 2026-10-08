import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../src/process-runner.mjs";
import { writeJson } from "../src/pr-delivery-state.mjs";
import { monotonicNow } from "../src/deadline.mjs";
import { fullSuiteEnvironment } from "../src/nightly-backstop.mjs";

export const recoveryScenarios = [
  ...["claimed", "effect-requested", "reconciled", "acknowledged"].map(state =>
    `fix12: kill after ${state} recovers one logical job/effect`),
  ...["comment", "merge"].map(effect =>
    `fix12: kill after provider ${effect} success before recording acknowledgement`),
  "fix12: restored requested checkpoint reconciles success before another write",
  "PR46 finding 1: admission quota expires without a permanent capacity wait",
  "PR46 finding 7: undispatched quota refusal retires update intent and recovers after reset",
  "fix12: cancelled pending job never starts when PR capacity frees",
  "fix30: 48-hour virtual quota wait, provider recovery and repeated consumption conserve one effect",
];
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const recoveryPattern = `^(?:${recoveryScenarios.map(escapePattern).join("|")})$`;
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
  do {
    const at = clock();
    let result;
    try {
      result = await run(
        [
          process.execPath,
          "--test",
          `--test-name-pattern=${recoveryPattern}`,
          "test/pr-delivery.test.mjs",
          "test/pr-delivery.shard-1.test.mjs",
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: fullSuiteEnvironment(env),
          timeoutMs: 600000,
          maxOutputBytes: 8 * 1024 * 1024,
        },
      );
    } catch {
      result = { code: 1 };
    }
    const output = result.stdout ?? "",
      total = Number(/^# tests ([0-9]+)$/m.exec(output)?.[1]),
      passed = Number(/^# pass ([0-9]+)$/m.exec(output)?.[1]),
      failed = Number(/^# fail ([0-9]+)$/m.exec(output)?.[1]);
    const recoverySeconds = Number(/^# FIX30_RECOVERY_SECONDS ([0-9.]+)$/m.exec(output)?.[1]);
    const healthy =
      result.code === 0 &&
      !result.timedOut &&
      /^TAP version 13$/m.test(output) &&
      Number.isInteger(total) &&
      total >= recoveryScenarios.length &&
      total ===
        passed + Number(/^# skipped ([0-9]+)$/m.exec(output)?.[1] ?? 0) &&
      passed === recoveryScenarios.length &&
      failed === 0 &&
      Number.isFinite(recoverySeconds) && recoverySeconds >= 0 &&
      recoveryScenarios.every(name =>
        [...output.matchAll(new RegExp(`^ok [0-9]+ - ${escapePattern(name)}$`, "gm"))].length === 1);
    cycles.push({
      elapsedSeconds: (at - started) / 1000,
      durationSeconds: (clock() - at) / 1000,
      status: healthy ? "passed" : "failed",
      tests: Number.isInteger(total) ? total : null,
      recoverySeconds: Number.isFinite(recoverySeconds) ? recoverySeconds : null,
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
  const elapsed = clock() - started;
  const complete = verified && (!wallclock || elapsed >= duration);
  const receipt = {
    schema: "recovery-rehearsal.v1",
    mode: "shadow",
    gateAuthority: false,
    effects: "disposable-local-git-and-fake-provider",
    exercise: wallclock ? "wall-clock" : "acceptance-replay",
    requiredHours: 48,
    elapsedHours: elapsed / 3600000,
    cycles,
    status: complete ? "passed" : "failed",
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
    pendingWallclockProof: !(wallclock && complete),
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
