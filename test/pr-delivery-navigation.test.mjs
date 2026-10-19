import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keyFor } from "../src/pr-delivery-state.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repo = "fixture/navigation";
const head = "a".repeat(40);
const binding = { repo, pr: 7, head };
const guard = fileURLToPath(new URL("./fixtures/navigation-write-guard.cjs", import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "factory-navigation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  const stateDir = path.join(directory, "state");
  await fs.writeFile(config, JSON.stringify({
    repos: { [repo]: { checkout: root, worktreeRoot: directory,
      requiredChecks: [{ name: "test", appId: 15368 }] } },
    stateDir, privateSetting: "CANARY_PRIVATE",
  }));
  const env = { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", NODE_OPTIONS: `--require=${guard}` };
  return { config, stateDir, directory, env, run: (action, ...args) => spawnSync(process.execPath,
    [path.join(root, "bin/pr-delivery.mjs"), config, action, ...args], {
      encoding: "utf8", env,
    }) };
}
function result(run) {
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout + run.stderr, /CANARY_PRIVATE|WRITE_ATTEMPT/);
  return JSON.parse(run.stdout);
}

test("installation navigation identifies the invoked source and configured policy without creating state", async (t) => {
  const f = await fixture(t);
  const status = result(f.run("installation-status"));
  assert.equal(status.sourceRevision, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
  assert.equal(Object.hasOwn(status, "sourceModified"), false);
  assert.equal(status.entrypoint, path.join(root, "bin/pr-delivery.mjs"));
  assert.equal(status.configFile, f.config);
  assert.equal(status.policySource, path.join(root, "docs/pr-delivery-cutover.md"));
  assert.deepEqual(status.checkPolicy[repo], [{ name: "test", appId: 15368 }]);
  assert.equal(status.installation, "unverified");
  assert.equal(status.paths.deliveryLog, path.join(f.stateDir, "delivery.jsonl"));
  await assert.rejects(fs.access(f.stateDir), { code: "ENOENT" });
});

test("job navigation selects current journal states and evidence paths without changing recorded history", async (t) => {
  const f = await fixture(t);
  const key = keyFor(repo, 7);
  await fs.mkdir(path.join(f.stateDir, "waits"), { recursive: true });
  await fs.mkdir(path.join(f.stateDir, "repairs"));
  const waitReceipt = path.join(f.stateDir, "waits", `${key}.json`);
  const repairReceipt = path.join(f.stateDir, "repairs", `${key}.json`);
  const worker = { receipt: "/synthetic/worker.json", log: "/synthetic/worker.log" };
  const check = { receipt: "/synthetic/check.json", log: "/synthetic/check.log" };
  await fs.writeFile(waitReceipt, JSON.stringify({ schema: "factory-delivery-wait/v1", repo, pr: 7,
    head, status: "suspended", cause: "mutation-uncertain", code: 130, message: "CANARY_PRIVATE" }));
  await fs.writeFile(repairReceipt, JSON.stringify({ schema: "factory-repair-delivery/v1", repo, pr: 7,
    id: "repair-1", head, status: "building", worktree: "/synthetic/worktree",
    builderJob: { ...worker, input: "CANARY_PRIVATE" }, checkJob: check, prompt: "CANARY_PRIVATE" }));
  const queue = [
    { id: "q1", repo, pr: 7, head, state: "effect-requested", attemptId: "attempt-1", effectId: "b".repeat(64), note: "CANARY_PRIVATE" },
    { id: "legacy", repo, pr: 7, head: "c".repeat(40), outcome: { status: "pass" } },
    { id: "other", repo: "fixture/other", pr: 7, head, state: "pending" },
  ];
  await fs.writeFile(path.join(f.stateDir, "queue.json"), JSON.stringify(queue));
  await fs.writeFile(path.join(f.stateDir, "delivery.jsonl"), "CANARY_PRIVATE not parsed\n");
  const snapshot = async () => Promise.all((await fs.readdir(f.stateDir, { recursive: true })).sort().map(async name => {
    const file = path.join(f.stateDir, name), stat = await fs.stat(file);
    return [name, stat.mtimeMs, stat.mode, stat.isFile() ? await fs.readFile(file, "utf8") : null];
  }));
  const before = await snapshot();
  const status = result(f.run("job-status", repo, "7"));
  assert.equal(status.observation, "recorded history, not process liveness");
  assert.deepEqual(status.queue, [
    { id: "q1", head, state: "effect-requested", outcome: null },
    { id: "legacy", head: "c".repeat(40), state: "acknowledged", outcome: "pass" },
  ]);
  assert.deepEqual(status.wait, { head, status: "suspended", cause: "mutation-uncertain", code: 130 });
  assert.deepEqual(status.repair, { id: "repair-1", head, status: "building", worktree: "/synthetic/worktree",
    builderJob: worker, checkJob: check });
  assert.equal(status.paths.waitReceipt, waitReceipt);
  assert.equal(status.paths.repairReceipt, repairReceipt);
  assert.deepEqual(await snapshot(), before);
});

test("unobserved jobs return null records and create no state", async (t) => {
  const f = await fixture(t);
  const status = result(f.run("job-status", repo, "7"));
  assert.deepEqual(status.queue, []);
  assert.equal(status.wait, null);
  assert.equal(status.repair, null);
  await assert.rejects(fs.access(f.stateDir), { code: "ENOENT" });
});

for (const [name, relative, record] of [
  ["malformed queue", "queue.json", "CANARY_PRIVATE not JSON"],
  ["invalid queue transition", "queue.json", JSON.stringify([{ id: "q", repo, pr: 7, head, state: "CANARY_PRIVATE" }])],
  ["wrong wait binding", `waits/${keyFor(repo, 7)}.json`, JSON.stringify({ schema: "factory-delivery-wait/v1", repo, pr: 8, head, message: "CANARY_PRIVATE" })],
  ["non-record wait", `waits/${keyFor(repo, 7)}.json`, "false"],
  ["literal null wait", `waits/${keyFor(repo, 7)}.json`, "null"],
  ["literal null repair", `repairs/${keyFor(repo, 7)}.json`, "null"],
  ["wrong repair schema", `repairs/${keyFor(repo, 7)}.json`, JSON.stringify({ schema: "CANARY_PRIVATE", repo, pr: 7, head })],
  ...[
    ["non-string queue identity", { id: {}, state: "pending" }],
    ["blank queue identity", { id: " ", state: "pending" }],
    ["empty attempt identity", { id: "q", state: "claimed", attemptId: "", effectId: "b".repeat(64) }],
    ["blank attempt identity", { id: "q", state: "claimed", attemptId: " ", effectId: "b".repeat(64) }],
    ["non-string effect identity", { id: "q", state: "claimed", attemptId: "attempt", effectId: ["b".repeat(64)] }],
    ["empty effect identity", { id: "q", state: "claimed", attemptId: "attempt", effectId: "" }],
    ["contradictory pending outcome", { id: "q", state: "pending", outcome: { status: "pass" } }],
  ].map(([name, row]) => [name, "queue.json", JSON.stringify([{ ...binding, ...row }])]),
  ...[
    ["partial wait", "waits", { schema: "factory-delivery-wait/v1" }],
    ["invalid wait status", "waits", { schema: "factory-delivery-wait/v1", status: "CANARY_PRIVATE", cause: "slot-wait", code: 75 }],
    ["blank wait cause", "waits", { schema: "factory-delivery-wait/v1", status: "suspended", cause: " ", code: 75 }],
    ["invalid wait code", "waits", { schema: "factory-delivery-wait/v1", status: "suspended", cause: "slot-wait", code: "75" }],
    ["partial repair", "repairs", { schema: "factory-repair-delivery/v1" }],
    ["blank repair identity", "repairs", { schema: "factory-repair-delivery/v1", id: " ", status: "building", worktree: "/synthetic/worktree" }],
    ["invalid repair status", "repairs", { schema: "factory-repair-delivery/v1", id: "repair", status: "CANARY_PRIVATE", worktree: "/synthetic/worktree" }],
    ["relative repair worktree", "repairs", { schema: "factory-repair-delivery/v1", id: "repair", status: "building", worktree: "relative" }],
    ...[
      ["non-record worker paths", "builderJob", true],
      ["partial worker paths", "builderJob", { receipt: "/synthetic/worker.json" }],
      ["relative check paths", "checkJob", { receipt: "relative", log: "/synthetic/check.log" }],
      ["invalid check path type", "checkJob", { receipt: "/synthetic/check.json", log: 7 }],
      ["invalid worker path bytes", "builderJob", { receipt: "/synthetic/worker\0.json", log: "/synthetic/worker.log" }],
    ].map(([name, field, job]) => [name, "repairs", { schema: "factory-repair-delivery/v1", id: "repair", status: "building", worktree: "/synthetic/worktree", [field]: job }]),
  ].map(([name, directory, record]) => [name, `${directory}/${keyFor(repo, 7)}.json`, JSON.stringify({ ...binding, ...record })]),
]) {
  test(`job navigation refuses ${name} without echoing or writing evidence`, async (t) => {
    const f = await fixture(t), file = path.join(f.stateDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, record);
    const before = await fs.readdir(f.stateDir, { recursive: true });
    const run = f.run("job-status", repo, "7");
    assert.equal(run.status, 9);
    assert.match(run.stderr, /Delivery navigation unavailable/);
    assert.doesNotMatch(run.stdout + run.stderr, /CANARY_PRIVATE|WRITE_ATTEMPT/);
    assert.equal(await fs.readFile(file, "utf8"), record);
    assert.deepEqual(await fs.readdir(f.stateDir, { recursive: true }), before);
  });
}

test("navigation accepts current wait and repair states without requiring optional jobs", async t => {
  const f = await fixture(t), key = keyFor(repo, 7);
  await fs.mkdir(path.join(f.stateDir, "waits"), { recursive: true });
  await fs.mkdir(path.join(f.stateDir, "repairs"));
  for (const status of ["suspended", "resumable", "complete"]) {
    await fs.writeFile(path.join(f.stateDir, "waits", `${key}.json`), JSON.stringify({ ...binding,
      schema: "factory-delivery-wait/v1", status, cause: "slot-wait", code: 75 }));
    assert.equal(result(f.run("job-status", repo, "7")).wait.status, status);
  }
  for (const status of ["building", "built", "no_progress", "checking", "check_interrupted", "check_failed",
    "push_pending", "early_publication", "candidate_unconfirmed", "delivered"]) {
    await fs.writeFile(path.join(f.stateDir, "repairs", `${key}.json`), JSON.stringify({ ...binding,
      schema: "factory-repair-delivery/v1", id: "repair", status, worktree: "/synthetic/worktree", checkJob: null }));
    const record = result(f.run("job-status", repo, "7")).repair;
    assert.equal(record.status, status);
    assert.equal(record.builderJob, null);
    assert.equal(record.checkJob, null);
  }
});

test("the write detector catches a filesystem mutation", async t => {
  const f = await fixture(t), marker = path.join(f.directory, "write-probe");
  const probe = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'x')", marker],
    { encoding: "utf8", env: f.env });
  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /WRITE_ATTEMPT/);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

for (const action of ["installation-status", "job-status"]) {
  test(`${action} does not invoke a writing fsmonitor hook`, async t => {
    const f = await fixture(t), marker = path.join(f.directory, "fsmonitor-write"), hook = path.join(f.directory, "fsmonitor.sh");
    await fs.writeFile(hook, '#!/bin/sh\nprintf x >> "$REVIEW_MARKER"\nprintf "token\\0"\n', { mode: 0o700 });
    Object.assign(f.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: hook, REVIEW_MARKER: marker });
    result(f.run(action, repo, "7"));
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
  });
}

test("unknown repositories and invalid PRs fail without creating state", async (t) => {
  const f = await fixture(t);
  for (const args of [["fixture/unknown", "7"], [repo, "0"], [repo, "1.5"]]) {
    const run = f.run("job-status", ...args);
    assert.notEqual(run.status, 0);
    assert.doesNotMatch(run.stdout + run.stderr, /CANARY_PRIVATE|WRITE_ATTEMPT/);
    await assert.rejects(fs.access(f.stateDir), { code: "ENOENT" });
  }
});

test("malformed navigation configuration fails without echoing its contents", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.config, "CANARY_PRIVATE not JSON");
  const run = f.run("installation-status");
  assert.equal(run.status, 9);
  assert.doesNotMatch(run.stdout + run.stderr, /CANARY_PRIVATE|WRITE_ATTEMPT/);
  await assert.rejects(fs.access(f.stateDir), { code: "ENOENT" });
});
