import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {parse} from "yaml";

const files = ["ci.yml"];
const read = name => readFileSync(new URL("../.github/workflows/" + name, import.meta.url), "utf8");
// A deliberately bounded reader for the scalar policy fields, not a YAML loader.
// Unknown expressions fail closed. GitHub's scheduler owns actual cancellation;
// this replay executes the policy expressions read from the deployed workflows.
function expression(value, github, success = true) {
  if (value === undefined) return success;
  const raw = String(value).replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.match(raw, /^(?:github\.(?:workflow|ref|run_id|event_name|event\.action|event\.pull_request\.number)|always\(\)|'[^']*'|[\s()=!&|]|true|false)+$/, `unsupported expression: ${raw}`);
  const result = runInNewContext(raw, { github, always: () => true }, { timeout: 1000 });
  // Actions implicitly adds success() unless a status function is present.
  return raw.includes("always()") || success ? result : false;
}
function context(event_name = "pull_request", action = "synchronize", number = 9, run_id = 1) {
  return { event_name, run_id, ref: event_name === "pull_request" ? `refs/pull/${number}/merge` : "refs/heads/main",
    event: { action, pull_request: event_name === "pull_request" ? { number } : {} } };
}
function policy(source, event, success = true) {
  const workflow = source.match(/^name: (.+)$/m)?.[1];
  const types = source.match(/^  pull_request:\n(?:    #.*\n)*    types: \[(.+)\]/m)?.[1].split(/,\s*/)
    ?? ["opened", "synchronize", "reopened"];
  const triggers = event.event_name !== "pull_request" || types.includes(event.event.action);
  const concurrency = source.match(/^concurrency:\n((?:  .+\n)+)/m)?.[1];
  const group = concurrency?.match(/^  group: (.+)$/m)?.[1].replace(/\$\{\{(.*?)\}\}/g,
    (_, expr) => expression(expr.trim(), { ...event, workflow }));
  const cancel = concurrency ? Boolean(expression(concurrency.match(/^  cancel-in-progress: (.+)$/m)?.[1], event)) : false;
  const jobText = source.split(/^jobs:\n/m)[1];
  assert.ok(jobText, "jobs must be readable");
  const jobs = [...jobText.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)];
  assert.ok(jobs.length, "jobs must be collected");
  const runnable = triggers ? jobs.filter(([, , body]) => expression(body.match(/^    if: (.+)$/m)?.[1], event, success)).map(([, name]) => name) : [];
  return { triggers, group, cancel, runnable, jobs: jobs.map(([, name]) => name) };
}
function replay(source, events) {
  const runs = [];
  for (const [tick, event] of events.entries()) {
    const current = policy(source, event);
    if (!current.triggers) continue;
    // Five seconds per synthetic suite; this is work accounting, not fleet savings.
    for (const run of runs) if (run.status === "running" && tick >= run.start + 5) run.status = "success";
    if (current.cancel && current.group) for (const run of runs) {
      if (run.status === "running" && run.group === current.group) {
        run.status = "superseded"; run.seconds = tick - run.start;
      }
    }
    runs.push({ ...current, start: tick, status: current.runnable.length ? "running" : "skipped",
      seconds: current.runnable.length ? 5 : 0 });
  }
  for (const run of runs) if (run.status === "running") run.status = "success";
  return runs;
}
for (const file of files) {
  const source = read(file);
  test(`${file}: full validation fits setup plus a representative full suite`, () => {
    const job = parse(source).jobs.test;
    const install = job.steps.find(step => step.run === "npm ci");
    const suite = job.steps.find(step => step.run === "npm test");
    // A foreground local run took 36 minutes. Round the representative workload
    // up to 40, and reserve five more minutes for Python validation and audit.
    const suiteMinutes = 40, remainingValidationMinutes = 5;
    assert.ok((suite['timeout-minutes'] ?? job['timeout-minutes']) >= suiteMinutes,
      'npm tests must finish before the step or job deadline cancels them');
    assert.ok(job['timeout-minutes'] >= install['timeout-minutes'] + suiteMinutes + remainingValidationMinutes,
      'job deadline must leave time for installation, the full suite and subsequent validation');
  });
  test(`${file}: required context identity is retained`, () => {
    assert.deepEqual(policy(source, context()).jobs, ["standards", "test", "e2e-deterministic-qualification"]);
  });
  test(`${file}: standards check runs directly with failures propagated and bounded feedback`, () => {
    const job = parse(source).jobs.standards;
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job['timeout-minutes'], 5);
    assert.deepEqual(job.steps.filter(step => step.run).map(step => step.run),
      ['node --test test/schema-artifact-authority.test.mjs']);
    for (const step of job.steps) {
      assert.equal(step['continue-on-error'], undefined);
      assert.equal(step.if, undefined);
    }
    assert.equal(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], 22);
  });
  test(`${file}: rapid A/B/C supersedes A/B and C runs every job`, () => {
    const runs = replay(source, [context("pull_request", "opened", 9, 1), context("pull_request", "synchronize", 9, 2), context("pull_request", "synchronize", 9, 3)]);
    assert.deepEqual(runs.map(run => run.status), ["superseded", "superseded", "success"]);
    assert.deepEqual(runs[2].runnable, runs[2].jobs);
    const uncancelled = replay(source.replace(/^concurrency:\n(?:  .+\n)+/m, ""), [context("pull_request", "opened", 9, 1), context("pull_request", "synchronize", 9, 2), context("pull_request", "synchronize", 9, 3)]);
    assert.equal(runs.reduce((sum, r) => sum + r.seconds, 0), 7);
    assert.equal(uncancelled.reduce((sum, r) => sum + r.seconds, 0), 15);
    assert.equal(runs.filter(r => r.runnable.length).length, 3, "supersession saves tail work, not started suites");
  });
  test(`${file}: closed event cancels prior work with zero runnable jobs; reopen recovers`, () => {
    for (const action of ["opened", "synchronize", "edited", "ready_for_review"]) {
      const runs = replay(source, [context("pull_request", action, 9, 1), context("pull_request", "closed", 9, 2)]);
      assert.deepEqual(runs.map(run => run.status), ["superseded", "skipped"]);
      assert.deepEqual(runs[1].runnable, [], "closed must not checkout/install/test/aggregate");
    }
    const reopened = policy(source, context("pull_request", "reopened"));
    assert.deepEqual(reopened.runnable, reopened.jobs);
    const removedGuards = source.replace(/^    if:.*\n/gm, "");
    assert.notDeepEqual(policy(removedGuards, context("pull_request", "closed")).runnable, [], "control removing only the close guard is rejected");
  });
  test(`${file}: workflow/PR identity is stable on close and isolated from other PR/main/manual`, () => {
    const current = policy(source, context());
    assert.ok(current.group);
    assert.equal(policy(source, context("pull_request", "closed")).group, current.group);
    assert.notEqual(policy(source, context("pull_request", "opened", 10)).group, current.group);
    assert.notEqual(policy(source.replace(/^name: .+$/m, "name: Another workflow"), context()).group, current.group);
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      const one = policy(source, context(event, "", 9, 1)), two = policy(source, context(event, "", 9, 2));
      assert.equal(one.cancel, false, `${event} must retain its completed verdict`);
      assert.notEqual(one.group, current.group);
      assert.notEqual(one.group, two.group, "pending non-PR verdicts must not replace each other");
      assert.deepEqual(one.runnable, one.jobs);
    }
  });
  test(`${file}: edits and draft-to-ready retain full validation; completed verdict survives close`, () => {
    for (const action of ["opened", "synchronize", "reopened", "edited", "ready_for_review"]) {
      assert.deepEqual(policy(source, context("pull_request", action)).runnable, policy(source, context()).jobs);
    }
    assert.doesNotMatch(source, /github\.event\.pull_request\.draft/);
    const job=parse(source).jobs.test;
    assert.equal(job['continue-on-error'],undefined,'required job must fail on validation errors');
    for(const step of job.steps) {
      if(step.run==='npm run workflow:audit -- .') assert.equal(step['continue-on-error'],true,'audit remains a non-blocking pilot');
      else assert.equal(step['continue-on-error'],undefined,'required validation step cannot suppress failure');
    }
    const events = [context("pull_request", "opened"), ...Array.from({ length: 5 }, (_, i) => context("push", "", 9, 100 + i)), context("pull_request", "closed", 9, 7)];
    assert.equal(replay(source, events)[0].status, "success", "a close event must not erase completed green evidence");
  });
}
