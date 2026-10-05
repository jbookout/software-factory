import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assessNightly,
  recordDiagnosis,
  runFullMain,
  assignment,
} from "../src/nightly-backstop.mjs";
const sha = "a".repeat(40),
  tree = "b".repeat(40);
const base = Date.UTC(2026, 9, 1, 4);
const receipt = () => ({
  schema: "full-main-receipt.v1",
  repository: "jbookout/software-factory",
  suite: "factory",
  mode: "shadow",
  gateAuthority: false,
  source: { sha, tree },
  workflow: { runId: "123", attempt: "1" },
  event: "schedule",
  startedAt: new Date(base).toISOString(),
  completedAt: new Date(base + 1000).toISOString(),
  command: ["npm", "test"],
  inventoryDigest: "c".repeat(64),
  status: "passed",
  counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
});
const policy = {
  repository: "jbookout/software-factory",
  suite: "factory",
  cadenceSeconds: 86400,
  deadlineSeconds: 3300,
};
const tmp = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "backstop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
test("one cadence plus bound expires green; copied receipt never refreshes its age", () => {
  assert.equal(
    assessNightly(receipt(), policy, base + 86400_000 + 3300_000 - 1).state,
    "fresh",
  );
  const injected = receipt();
  injected.source.privateField = "CANARY_PRIVATE_CLIENT_SECRET";
  assert.doesNotMatch(
    JSON.stringify(assessNightly(injected, policy, base + 2000)),
    /CANARY_PRIVATE/,
  );
  assert.equal(
    assessNightly(
      { ...receipt(), completedAt: new Date(base + 4000_000).toISOString() },
      policy,
      base + 5000_000,
    ).state,
    "stale",
  );
  const seeded = {
    ...receipt(),
    status: "failed",
    regressionIntroducedAt: new Date(base - 5000).toISOString(),
  };
  assert.equal(
    assessNightly(seeded, policy, base + 2000).escapeDelaySeconds,
    6,
  );
  const old = receipt();
  old.observedAt = new Date(base + 90000_000).toISOString();
  const expired = assessNightly(old, policy, base + 86400_000 + 3300_000);
  assert.equal(expired.state, "stale");
  assert.equal(expired.gateAuthority, false);
  assert.equal(expired.staleGreenAgeSeconds, 89700);
  for (const bad of [
    null,
    { ...receipt(), status: "failed" },
    { ...receipt(), status: "unknown" },
    { ...receipt(), counts: null },
    { ...receipt(), completedAt: new Date(base + 4000_000).toISOString() },
    { ...receipt(), event: "pull_request" },
  ])
    assert.notEqual(assessNightly(bad, policy, base + 5000_000).state, "fresh");
});
test("failed run and concurrent observations create one owned diagnosis; reopen after clear", async (t) => {
  const root = await tmp(t),
    observation = assessNightly(
      {
        ...receipt(),
        status: "failed",
        counts: {
          tests: 2,
          passed: 1,
          failed: 1,
          cancelled: 0,
          skipped: 0,
          todo: 0,
        },
      },
      policy,
      base + 2000,
    );
  await Promise.all(
    Array.from({ length: 3 }, () => recordDiagnosis(root, observation)),
  );
  const files = (await fs.readdir(root)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const entry = JSON.parse(await fs.readFile(path.join(root, files[0])));
  assert.equal(entry.owner, "orchestrator");
  assert.equal(entry.status, "open");
  assert.ok(entry.wakeupAt);
  assert.ok(entry.nextAction);
  await recordDiagnosis(root, assessNightly(receipt(), policy, base + 2000));
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, files[0]))).status,
    "closed",
  );
  await recordDiagnosis(root, observation);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, files[0]))).status,
    "open",
  );
});
test("app browser suite receipt is compatible with the shared nightly contract", () => {
  const appPolicy = {
    ...policy,
    repository: "jbookout/doctorcre-app",
    suite: "app-e2e",
  };
  const appReceipt = {
    ...receipt(),
    repository: appPolicy.repository,
    suite: appPolicy.suite,
  };
  assert.equal(assessNightly(appReceipt, appPolicy, base + 2000).state, "fresh");
});
test("full suite child executes seeded regression, binds counts and omits private output", async (t) => {
  const root = await tmp(t);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "node --test test.mjs" },
    }),
  );
  await fs.writeFile(
    path.join(root, "test.mjs"),
    "import test from 'node:test';import assert from 'node:assert/strict';test('control',()=>assert.equal(process.env.BROKEN,'1','CANARY_PRIVATE_CLIENT_SECRET'))",
  );
  const options = {
    cwd: root,
    repository: policy.repository,
    suite: "factory",
    source: { sha, tree },
    workflow: { runId: "123", attempt: "1" },
    event: "schedule",
    timeoutMs: 30000,
  };
  const healthy = await runFullMain({
    ...options,
    env: { ...process.env, NODE_OPTIONS: "--test-reporter=tap", BROKEN: "1" },
  });
  assert.equal(healthy.status, "passed");
  assert.equal(healthy.counts.tests, 1);
  const failed = await runFullMain({
    ...options,
    env: { ...process.env, BROKEN: "0" },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.counts.failed, 1);
  assert.doesNotMatch(JSON.stringify(failed), /CANARY|PRIVATE|SECRET/);
  await recordDiagnosis(
    path.join(root, "diagnoses"),
    assessNightly(failed, policy, Date.now()),
  );
  assert.equal(
    (await fs.readdir(path.join(root, "diagnoses"))).filter((f) =>
      f.endsWith(".json"),
    ).length,
    1,
  );
});
for (const [name, script] of [
  ["empty", ""],
  ["refusal", "process.exit(75)"],
  ["nonzero", "process.exit(1)"],
  ["partial", "console.log('# tests 2')"],
  ["exception", "throw Error('CANARY_PRIVATE_CLIENT_SECRET')"],
  [
    "missing-ack",
    "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0')",
  ],
  ["timeout", "setInterval(()=>{},1000)"],
])
  test(`exit/result ${name} cannot certify full coverage`, async (t) => {
    const root = await tmp(t);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node child.cjs" } }),
    );
    await fs.writeFile(path.join(root, "child.cjs"), script);
    const result = await runFullMain({
      cwd: root,
      repository: policy.repository,
      suite: "factory",
      source: { sha, tree },
      workflow: { runId: "123", attempt: "1" },
      event: "schedule",
      timeoutMs: name === "timeout" ? 500 : 30000,
    });
    assert.notEqual(result.status, "passed");
    assert.doesNotMatch(JSON.stringify(result), /CANARY_PRIVATE/);
  });
test("permutation/repartition prints reproducible seed, assignment and order-leak reproduction", async (t) => {
  const root = await tmp(t);
  await fs.writeFile(
    path.join(root, "writer.mjs"),
    "import fs from 'node:fs';fs.writeFileSync('shared','leak');",
  );
  await fs.writeFile(
    path.join(root, "reader.mjs"),
    "import fs from 'node:fs';if(fs.existsSync('shared'))throw Error('order leak');",
  );
  const files = ["writer.mjs", "reader.mjs"];
  let seed = 1;
  while (assignment(files, seed, 1)[0][0] !== "writer.mjs") seed++;
  const plan = assignment(files, seed, 1);
  assert.deepEqual(assignment(files, seed, 1), plan);
  assert.deepEqual(assignment(files, seed, 2).flat().sort(), files.toSorted());
  const writer = spawnSync(process.execPath, [plan[0][0]], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(writer.status, 0);
  const run = spawnSync(process.execPath, [plan[0][1]], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  await fs.unlink(path.join(root, "shared"));
  const cli = spawnSync(
    process.execPath,
    [
      "scripts/order-replay.mjs",
      "--seed",
      String(seed),
      "--partitions",
      "1",
      "--root",
      root,
      ...files,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 1);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.seed, seed);
  assert.deepEqual(report.assignment, plan);
  assert.equal(report.gateAuthority, false);
  await fs.unlink(path.join(root, "shared"));
  assert.equal(
    spawnSync(process.execPath, ["reader.mjs"], { cwd: root }).status,
    0,
    "remove only leaked state to restore control",
  );
});

test("REST observation binds latest scheduled source/attempt and never falls back to cached green", async () => {
  const { observeNightly } = await import("../src/nightly-observation.mjs");
  const p = { ...policy, workflow: "ci.yml" },
    r = receipt(),
    run = {
      id: 123,
      run_attempt: 1,
      event: "schedule",
      head_branch: "main",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      created_at: r.startedAt,
      updated_at: r.completedAt,
    };
  let latest = run,
    downloaded = r;
  const routes = [];
  const get = async (route) => {
    routes.push(route);
    return route.includes("/workflows/")
      ? { total_count: 2, workflow_runs: [{ ...run, id: 122 }, latest] }
      : {
          total_count: 1,
          artifacts: [
            {
              name: "full-main-factory-receipt",
              id: 99,
              expired: false,
              size_in_bytes: 1000,
            },
          ],
        };
  };
  const observe = () =>
    observeNightly(p, {
      get,
      download: async () => downloaded,
      now: base + 2000,
    });
  assert.equal((await observe()).state, "fresh");
  assert.ok(routes.every((route) => !route.includes("graphql")));
  for (const mutation of [
    { source: { ...r.source, sha: "d".repeat(40) } },
    { workflow: { runId: "122", attempt: "1" } },
    { workflow: { runId: "123", attempt: "2" } },
  ]) {
    downloaded = { ...r, ...mutation };
    assert.equal((await observe()).state, "unknown");
  }
  downloaded = r;
  latest = { ...run, conclusion: "failure" };
  assert.equal((await observe()).state, "failed");
  latest = { ...run, status: "in_progress" };
  assert.equal((await observe()).state, "pending");
  assert.equal(
    (await observeNightly(p, { get, now: base + 3300_000 })).state,
    "stale",
  );
  assert.equal(
    (
      await observeNightly(p, {
        get: async () => {
          throw Error("CANARY_PRIVATE_SECRET");
        },
        now: base + 2000,
      })
    ).state,
    "unknown",
  );
});

test("48-hour wall-clock driver survives restarts at quota/worker/provider seams only on disposable adapters", async (t) => {
  const { rehearse, recoveryPattern } = await import(
    "../scripts/recovery-rehearsal.mjs"
  );
  const root = await tmp(t);
  let tick = 0,
    calls = 0;
  const result = await rehearse({
    output: path.join(root, "receipt.json"),
    wallclock: true,
    clock: () => tick,
    sleep: async (ms) => {
      assert.ok(ms <= 60000);
      tick += ms;
    },
    run: async (argv, options) => {
      calls++;
      assert.equal(argv.at(-1), "test/pr-delivery.test.mjs");
      assert.ok(argv.some((v) => v.includes(recoveryPattern)));
      assert.ok(!options.env.NODE_TEST_CONTEXT);
      tick += 1000;
      return {
        code: 0,
        stdout: "TAP version 13\n# tests 10\n# pass 10\n# fail 0\n",
        stderr: "CANARY_PRIVATE_SECRET",
      };
    },
  });
  assert.equal(calls, 49);
  assert.equal(result.elapsedHours, 48 + 1 / 3600);
  assert.equal(result.status, "passed");
  assert.equal(result.pendingWallclockProof, false);
  assert.doesNotMatch(
    await fs.readFile(path.join(root, "receipt.json"), "utf8"),
    /CANARY_PRIVATE/,
  );
  const interrupted = await rehearse({
    output: path.join(root, "failed.json"),
    run: async () => ({ code: 0, stdout: "" }),
  });
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.pendingWallclockProof, true);
  assert.equal(interrupted.measurements.conservation, "unproven");
  assert.equal(interrupted.measurements.waitingOwnership, "unproven");
  assert.equal(interrupted.nextAction, "inspect-failed-disposable-replay-before-rehearsal");
  const incompleteWallclock = await rehearse({
    output: path.join(root, "incomplete-wallclock.json"),
    wallclock: true,
    run: async () => ({ code: 142, timedOut: true, stdout: "" }),
  });
  assert.equal(incompleteWallclock.status, "failed");
  assert.equal(incompleteWallclock.pendingWallclockProof, true);
});
test("workflow backstop runs full main suites in shadow with preserved gates", async () => {
  const { parse } = await import("yaml");
  const ci = parse(await fs.readFile(".github/workflows/ci.yml", "utf8"));
  assert.ok(ci.on.schedule?.length);
  const job = ci.jobs.test;
  const step = job.steps.find((s) =>
    s.run?.startsWith("node scripts/full-main.mjs"),
  );
  assert.ok(step, "schedule executes count-bound canonical full suite");
  assert.match(step.if, /schedule/);
  const upload = job.steps.find(
    (s) => s.with?.name === "full-main-factory-receipt",
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.match(upload.if, /always/);
});

test("conservation oracle rejects dropped/duplicate effects and waiting without an owner/wakeup", async () => {
  const { assessRecovery } = await import("../src/recovery-observation.mjs");
  const waiting = {
    id: "job",
    state: "effect-requested",
    availableAt: base + 1000,
    nextAction: "reconcile-provider",
    effectId: "effect",
  };
  const expected = {
    offeredIds: ["job"],
    effectIds: [],
    now: base,
    owner: "factory-queue-consumer",
  };
  const healthy = assessRecovery([waiting], expected);
  assert.equal(healthy.state, "waiting");
  assert.equal(healthy.waiting[0].owner, "factory-queue-consumer");
  assert.equal(
    healthy.waiting[0].wakeupAt,
    new Date(base + 1000).toISOString(),
  );
  assert.equal(assessRecovery([], expected).state, "breach");
  assert.equal(assessRecovery([waiting, waiting], expected).state, "breach");
  assert.equal(
    assessRecovery([waiting], { ...expected, effectIds: ["effect", "effect"] })
      .state,
    "breach",
  );
  assert.equal(
    assessRecovery([{ ...waiting, availableAt: null }], expected).state,
    "breach",
  );
  const done = {
    ...waiting,
    state: "acknowledged",
    outcome: { status: "pass" },
  };
  assert.equal(
    assessRecovery([done], {
      ...expected,
      effectIds: ["effect"],
      expectedEffectIds: ["effect"],
    }).state,
    "recovered",
  );
  assert.equal(
    assessRecovery([done], {
      ...expected,
      effectIds: [],
      expectedEffectIds: ["effect"],
    }).state,
    "breach",
  );
  assert.equal(
    assessRecovery([{ ...done, outcome: { status: "fail" } }], {
      ...expected,
      effectIds: [],
    }).state,
    "owned-failure",
  );
});

for (const scale of [1, 10, 25])
  test(`bursty ${scale}x offered identities conserve queued/terminal jobs without effects`, async () => {
    const { assessRecovery } = await import("../src/recovery-observation.mjs");
    const offeredIds = Array.from({ length: 20 * scale }, (_, i) => `job-${i}`);
    const queue = offeredIds.map((id, i) => ({
      id,
      state: i % 2 ? "pending" : "acknowledged",
      availableAt: base + 1000,
      outcome: { status: "pass" },
    }));
    const result = assessRecovery(queue, {
      offeredIds,
      effectIds: [],
      now: base,
      owner: "factory-queue-consumer",
    });
    assert.equal(result.state, "waiting");
    assert.equal(result.offered, result.terminal + result.waiting.length);
    assert.equal(result.duplicates, 0);
    assert.equal(result.lost, 0);
    assert.ok(JSON.stringify(result).length < queue.length * 300);
  });
