import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessNightly, recordDiagnosis } from "../src/nightly-backstop.mjs";
import { observeNightly } from "../src/nightly-observation.mjs";
import { assessRecovery } from "../src/recovery-observation.mjs";
import { rehearse, recoveryScenarios } from "../scripts/recovery-rehearsal.mjs";

const base = Date.UTC(2026, 9, 1, 4), sha = "a".repeat(40);
const policy = { repository: "jbookout/software-factory", suite: "factory", workflow: "ci.yml", cadenceSeconds: 86400, deadlineSeconds: 3300 };
const receipt = (runId = "123", attempt = "1", offset = 0) => ({
  schema: "full-main-receipt.v1", ...policy, mode: "shadow", gateAuthority: false,
  source: { sha, tree: "b".repeat(40) }, workflow: { runId, attempt }, event: "schedule",
  startedAt: new Date(base + offset).toISOString(), completedAt: new Date(base + offset + 1000).toISOString(),
  command: ["npm", "test"], inventoryDigest: "c".repeat(64), status: "passed",
  counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
});
const temporary = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr60-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
const job = (state = "acknowledged") => ({
  id: "job", repo: policy.repository, pr: 60, head: sha, state,
  attemptId: "attempt", effectId: "d".repeat(64), availableAt: base + 1000,
  outcome: { status: "pass" },
});
const recovery = { offeredIds: ["job"], expectedEffectIds: ["effect-a"], effectIds: ["effect-a"], now: base, owner: "factory-queue-consumer" };

test("PR60 finding 2: later reads of older runs or attempts cannot clear or replace owned failure", async t => {
  const root = await temporary(t);
  const failed = assessNightly({ ...receipt("124", "2", 2000), status: "failed" }, policy, base + 4000);
  await recordDiagnosis(root, failed);
  for (const older of [receipt(), receipt("124", "1", 1000), receipt("124", "2", 2000)]) {
    const held = await recordDiagnosis(root, assessNightly(older, policy, base + 5000));
    assert.equal(held.status, "open");
    assert.deepEqual(held.workflow, { runId: "124", attempt: "2" });
  }
  const newer = assessNightly(receipt("124", "3", 4000), policy, base + 6000);
  assert.equal((await recordDiagnosis(root, newer)).status, "closed");
  const staleFailure = { ...failed, observedAt: new Date(base + 7000).toISOString() };
  assert.equal((await recordDiagnosis(root, staleFailure)).status, "closed");
});

test("PR60 finding 3: incomplete run and artifact pages cannot certify green", async () => {
  const r = receipt();
  const run = { id: 123, run_attempt: 1, head_sha: sha, event: "schedule", head_branch: "main", status: "completed", conclusion: "success", created_at: r.startedAt, updated_at: r.completedAt };
  const artifact = { id: 99, name: "full-main-factory-receipt", expired: false, size_in_bytes: 1000 };
  for (const collection of ["runs", "artifacts"]) {
    const result = await observeNightly(policy, { now: base + 2000, download: async () => r,
      get: async route => route.includes("/workflows/")
        ? { total_count: collection === "runs" ? 2 : 1, workflow_runs: [run] }
        : { total_count: collection === "artifacts" ? 2 : 1, artifacts: [artifact] },
    });
    assert.equal(result.state, "unknown", collection);
  }
});

test("PR60 finding 4: distinct surplus effects breach conservation", () => {
  const result = assessRecovery([job()], { ...recovery, effectIds: ["effect-a", "effect-b"] });
  assert.equal(result.state, "breach");
  assert.equal(result.unexpected, 1);
});

test("PR60 finding 5: recovery refuses unbound claims and missing reconciled outcomes", () => {
  for (const state of ["claimed", "effect-requested", "reconciled"]) {
    for (const field of ["attemptId", "effectId", ...(state === "reconciled" ? ["outcome"] : [])]) {
      const entry = job(state);
      delete entry[field];
      assert.equal(assessRecovery([entry], recovery).state, "unknown", `${state}: ${field}`);
    }
  }
});

test("PR60 finding 6: skipped or omitted required scenarios cannot qualify replay or wallclock proof", async t => {
  const root = await temporary(t);
  for (const wallclock of [false, true]) for (const fault of ["counters-only", "skip", "missing-marker", "duplicate"]) {
    let tick = 0;
    const result = await rehearse({ output: path.join(root, `${wallclock}.json`), wallclock,
      clock: () => tick, sleep: async ms => { tick += ms; },
      run: async () => {
        tick += 1000;
        const records = recoveryScenarios.map((name, i) => `ok ${i + 1} - ${fault === "duplicate" && i === 10 ? recoveryScenarios[0] : name}${fault === "skip" && i === 10 ? " # SKIP" : ""}`).join("\n");
        const stdout = fault === "counters-only"
          ? "TAP version 13\n# tests 11\n# pass 10\n# fail 0\n# skipped 1\n"
          : `TAP version 13\n${records}\n${fault === "missing-marker" ? "" : "# FIX30_RECOVERY_SECONDS 1\n"}# tests 11\n# pass ${fault === "skip" ? 10 : 11}\n# fail 0\n# skipped ${fault === "skip" ? 1 : 0}\n`;
        return { code: 0, stdout };
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.pendingWallclockProof, true);
    assert.equal(result.measurements.conservation, "unproven");
  }
});

test("provider errors after green open a diagnosis and retain the run needed to clear it", async t => {
  const root = await temporary(t);
  await recordDiagnosis(root, assessNightly({ ...receipt(), status: "failed" }, policy, base + 2000));
  await recordDiagnosis(root, assessNightly(receipt("124", "1", 2000), policy, base + 4000));
  const unknown = await recordDiagnosis(root, assessNightly(null, policy, base + 5000));
  assert.equal(unknown.status, "open");
  assert.deepEqual(unknown.workflow, { runId: "124", attempt: "1" });
  assert.equal((await recordDiagnosis(root, assessNightly(receipt(), policy, base + 6000))).status, "open");
});

test("PR60 finding 7: unrepresentable wakeup and clock produce diagnostics without throwing", () => {
  assert.equal(assessRecovery([{ ...job("pending"), availableAt: Number.MAX_SAFE_INTEGER }], recovery).state, "breach");
  assert.equal(assessRecovery([job("pending")], { ...recovery, now: Number.MAX_SAFE_INTEGER }).state, "unknown");
});
