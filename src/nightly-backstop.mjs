import fs from "node:fs/promises";
import path from "node:path";
import { canonicalDigest } from "./canonical.mjs";
import { runProcess } from "./process-runner.mjs";
import { readJson, writeJson, withLease } from "./pr-delivery-state.mjs";

const countKeys = ["tests", "passed", "failed", "cancelled", "skipped", "todo"];
const validCounts = (c) =>
  c &&
  countKeys.every((k) => Number.isSafeInteger(c[k]) && c[k] >= 0) &&
  c.tests > 0 &&
  c.tests === c.passed + c.failed + c.cancelled + c.skipped + c.todo;
const sha = (value) => /^[0-9a-f]{40}$/.test(value ?? "");

export function fullSuiteEnvironment(env = process.env) {
  const result = { ...env };
  delete result.NODE_TEST_CONTEXT;
  const options = result.NODE_OPTIONS ?? "";
  const normalized = options.replaceAll("_", "-");
  if (
    /(?:^|\s|["'])--test-(?:name-pattern|skip-pattern|only|shard|rerun-failures)(?:=|\s|["']|$)/.test(normalized)
  )
    throw Error("filtered selection cannot acknowledge a full suite");
  result.NODE_OPTIONS = /(?:^|\s|["'])--test-reporter=tap(?:\s|["']|$)/.test(normalized)
    ? options
    : `${options} --test-reporter=tap`.trim();
  return result;
}

export function assessNightly(receipt, policy, now = Date.now()) {
  if (
    !/^jbookout\/(software-factory|doctorcre-app)$/.test(policy.repository) ||
    !/^[a-z0-9-]+$/.test(policy.suite) ||
    ![policy.cadenceSeconds, policy.deadlineSeconds].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    !Number.isFinite(now)
  )
    throw Error("invalid nightly policy");
  const start = Date.parse(receipt?.startedAt),
    end = Date.parse(receipt?.completedAt);
  const valid =
    receipt?.schema === "full-main-receipt.v1" &&
    receipt.repository === policy.repository &&
    receipt.suite === policy.suite &&
    receipt.mode === "shadow" &&
    receipt.gateAuthority === false &&
    receipt.event === "schedule" &&
    sha(receipt.source?.sha) &&
    sha(receipt.source?.tree) &&
    /^[0-9a-f]{64}$/.test(receipt.inventoryDigest ?? "") &&
    /^[1-9][0-9]*$/.test(String(receipt.workflow?.runId ?? "")) &&
    /^[1-9][0-9]*$/.test(String(receipt.workflow?.attempt ?? "")) &&
    Array.isArray(receipt.command) &&
    receipt.command.length > 0 &&
    validCounts(receipt.counts) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= end &&
    end <= now;
  const introduced = Date.parse(receipt?.regressionIntroducedAt);
  const age =
    Number.isFinite(start) && start <= now ? (now - start) / 1000 : null;
  let state = "unknown",
    reason = "missing-or-invalid-completion";
  if (valid) {
    if (end - start > policy.deadlineSeconds * 1000) {
      state = "stale";
      reason = "scheduled-run-deadline-exceeded";
    } else if (
      receipt.status === "failed" ||
      receipt.counts.failed ||
      receipt.counts.cancelled
    ) {
      state = "failed";
      reason = "full-suite-regression";
    } else if (receipt.status === "passed" && receipt.counts.passed > 0) {
      state =
        age >= policy.cadenceSeconds + policy.deadlineSeconds
          ? "stale"
          : "fresh";
      reason =
        state === "stale" ? "missed-cadence-or-deadline" : "bound-completion";
    }
  }
  return {
    schema: "nightly-observation.v1",
    mode: "shadow",
    gateAuthority: false,
    repository: policy.repository,
    suite: policy.suite,
    state,
    reason,
    source: valid
      ? { sha: receipt.source.sha, tree: receipt.source.tree }
      : null,
    workflow: valid
      ? { runId: String(receipt.workflow.runId), attempt: String(receipt.workflow.attempt) }
      : null,
    completedAt: valid ? receipt.completedAt : null,
    staleGreenAgeSeconds: receipt?.status === "passed" ? age : null,
    escapeDelaySeconds:
      state === "failed" && Number.isFinite(introduced) && introduced <= end
        ? (end - introduced) / 1000
        : null,
    observationLagSeconds:
      Number.isFinite(end) && end <= now ? (now - end) / 1000 : null,
    observedAt: new Date(now).toISOString(),
    owner: "orchestrator",
    nextAction: "inspect-full-suite-receipt-and-reproduce-at-bound-source",
    verification: "fresh-complete-full-suite-at-current-source",
    autoClear: "next-valid-fresh-full-suite",
    wakeupAt: new Date(
      now + Math.min(3600, policy.deadlineSeconds) * 1000,
    ).toISOString(),
  };
}

export async function recordDiagnosis(root, observation) {
  const id = canonicalDigest([observation.repository, observation.suite]),
    file = path.join(root, `${id}.json`);
  return withLease(
    path.join(root, "locks"),
    id,
    async () => {
      const prior = await readJson(file, null);
      if (observation.state === "pending") return prior;
      const at = Date.parse(observation.observedAt);
      const previousAt = Date.parse(prior?.observedAt);
      if (
        prior &&
        (at < previousAt ||
          (at === previousAt && prior.status === "open" && observation.state === "fresh"))
      )
        return prior;
      if (observation.state === "fresh" && !prior) return null;
      if (prior?.workflow && observation.workflow) {
        const run = BigInt(observation.workflow.runId), previousRun = BigInt(prior.workflow.runId);
        const attempt = BigInt(observation.workflow.attempt), previousAttempt = BigInt(prior.workflow.attempt);
        const order = run === previousRun ? attempt - previousAttempt : run - previousRun;
        if (order < 0 || (order === 0 && observation.state === "fresh" && prior.status === "open")) return prior;
      }
      if (observation.state === "fresh" &&
          !(Date.parse(observation.completedAt) > Date.parse(prior.completedAt ?? prior.observedAt))) return prior;
      const status = observation.state === "fresh" ? "closed" : "open";
      const record = {
        ...observation,
        workflow: observation.workflow ?? prior?.workflow ?? null,
        completedAt: observation.completedAt ?? prior?.completedAt ?? null,
        id,
        status,
        fingerprint: canonicalDigest([
          observation.state,
          observation.reason,
          observation.source,
        ]),
        firstObservedAt:
          prior?.status === "open"
            ? prior.firstObservedAt
            : observation.observedAt,
        occurrences:
          status === "open" ? (prior?.occurrences ?? 0) + 1 : prior.occurrences,
      };
      await writeJson(file, record);
      return record;
    },
    { waitMs: 10000, pollMs: 10 },
  );
}

async function inventory(cwd) {
  const entries = [];
  async function visit(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "out"
      )
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (
        entry.isFile() &&
        /\.(mjs|cjs|js|json|py|sh|yml|yaml)$/.test(entry.name)
      )
        entries.push([
          path.relative(cwd, file),
          canonicalDigest(await fs.readFile(file, "utf8")),
        ]);
    }
  }
  await visit(cwd);
  return canonicalDigest(entries);
}
export async function runFullMain({
  cwd,
  repository,
  suite,
  source,
  workflow,
  event = "manual",
  timeoutMs = 2700000,
  env = process.env,
  regressionIntroducedAt,
}) {
  const startedAt = new Date().toISOString(),
    counts = {},
    command = ["npm", "test"];
  let buffer = "",
    ack = false,
    overflow = false,
    bytes = 0,
    result,
    inventoryDigest;
  try {
    inventoryDigest = await inventory(cwd);
    const childEnv = fullSuiteEnvironment(env);
    result = await runProcess(command, {
      cwd,
      env: childEnv,
      timeoutMs,
      captureOutput: false,
      onOutput(chunk, stream) {
        if (stream !== "stdout") return;
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) {
          overflow = true;
          return;
        }
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop().slice(-8192);
        for (const line of lines) {
          if (line === "TAP version 13") ack = true;
          const match =
            /^# (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)$/.exec(line);
          if (match)
            counts[{ pass: "passed", fail: "failed" }[match[1]] ?? match[1]] =
              Number(match[2]);
        }
      },
    });
    if ((await inventory(cwd)) !== inventoryDigest) ack = false;
  } catch {
    result = { code: 1 };
    ack = false;
  }
  const complete =
    ack &&
    !overflow &&
    validCounts(counts) &&
    !result?.timedOut &&
    !result?.cancelled;
  const status = complete
    ? result.code === 0 &&
      counts.failed === 0 &&
      counts.cancelled === 0 &&
      counts.passed > 0
      ? "passed"
      : "failed"
    : "unknown";
  return {
    schema: "full-main-receipt.v1",
    repository,
    suite,
    mode: "shadow",
    gateAuthority: false,
    source: { sha: source?.sha, tree: source?.tree },
    workflow: { runId: workflow?.runId, attempt: workflow?.attempt },
    event,
    startedAt,
    regressionIntroducedAt:
      Number.isFinite(Date.parse(regressionIntroducedAt)) &&
      Date.parse(regressionIntroducedAt) <= Date.parse(startedAt)
        ? new Date(regressionIntroducedAt).toISOString()
        : null,
    completedAt: new Date().toISOString(),
    command,
    inventoryDigest: inventoryDigest ?? null,
    status,
    counts: complete ? counts : null,
    reason: complete
      ? "full-suite-completion"
      : "missing-or-invalid-completion",
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export function assignment(files, seed, partitions) {
  if (
    !Number.isSafeInteger(seed) ||
    seed < 1 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger(partitions) ||
    partitions < 1 ||
    partitions > 8 ||
    !Array.isArray(files) ||
    !files.length ||
    files.some(
      (f) => typeof f !== "string" || f.startsWith("-") || f.includes("\0"),
    ) ||
    new Set(files).size !== files.length
  )
    throw Error("invalid permutation");
  let state = seed;
  const shuffled = [...files].sort();
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const groups = Array.from(
    { length: Math.min(partitions, files.length) },
    () => [],
  );
  shuffled.forEach((file, i) => groups[i % groups.length].push(file));
  return groups;
}
