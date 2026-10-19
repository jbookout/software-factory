import { createHash } from "node:crypto";
import { createPinnedBuildContext } from "../src/model-room.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createFactory } from "../src/operating-loop.mjs";
import { reserveCheck } from "../src/check-admission.mjs";

const temporary = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
test("build repairs at most the requested rounds and always cleans up", async () => {
  const calls = [];
  const result = await createFactory().run(
    { rounds: 2 },
    {
      async execute(step) {
        calls.push(step);
        return { status: step === "check" ? "fail" : "pass" };
      },
    },
  );
  assert.equal(result.outcome, "failed");
  assert.deepEqual(calls, ["build", "check", "repair", "build", "check", "cleanup"]);
});
test("build failure still runs cleanup", async () => {
  const calls = [];
  await assert.rejects(
    createFactory().run(
      {},
      {
        async execute(step) {
          calls.push(step);
          if (step === "build") throw new Error("failed build");
          return { status: "pass" };
        },
      },
    ),
    /failed build/,
  );
  assert.deepEqual(calls, ["build", "cleanup"]);
});
test("check limiter admits only its configured concurrent owners", async (t) => {
  const root = await temporary(t);
  const first = await reserveCheck({ root, capacity: 1 });
  let admitted = false;
  const waiting = reserveCheck({ root, capacity: 1 }).then((second) => {
    admitted = true;
    return second;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(admitted, false);
  await first.release();
  const second = await waiting;
  await second.release();
  assert.equal(admitted, true);
});
test("a failed cleanup is reported as a failed job", async () => {
  const result = await createFactory().run(
    {},
    {
      async execute(step) {
        return { status: step === "cleanup" ? "fail" : "pass" };
      },
    },
  );
  assert.equal(result.outcome, "failed");
  assert.equal(result.events.at(-1).step, "cleanup");
  assert.equal(result.events.at(-1).status, "fail");
});

test("a queued check cancels without acquiring a slot", async (t) => {
  const root = await temporary(t),
    controller = new AbortController();
  const first = await reserveCheck({ root, capacity: 1 });
  try {
    const queued = reserveCheck({ root, capacity: 1, signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, { code: 130 });
  } finally {
    await first.release();
  }
  const next = await reserveCheck({ root, capacity: 1 });
  await next.release();
});

test("Model Room advice supplies the selected build route and pinned context", async () => {
  const route = { provider: "codex", model: "fixture-model", effort: "high" };
  const context = createPinnedBuildContext([
    {
      source_revision: "a".repeat(40),
      path: "contract.txt",
      excerpt: "fixture",
      content_digest: `sha256:${createHash("sha256").update("fixture").digest("hex")}`,
    },
  ]);
  let advised = 0;
  const builds = [];
  const result = await createFactory({
    modelRoomAdvisor: async ({ job }) => {
      assert.equal(job.outcome, "Build the pinned task");
      advised++;
      return {
        schema: "doctorcre-build-route.v1",
        selected_route: route,
        state_digest: "fixture-digest",
        build_context: context,
      };
    },
  }).run(
    { product: "DoctorCRE", outcome: "Build the pinned task", rounds: 2 },
    {
      async execute(step, request) {
        if (step === "build") builds.push(request);
        return { status: step === "check" && builds.length === 1 ? "fail" : "pass" };
      },
    },
  );
  assert.equal(result.outcome, "complete");
  assert.equal(advised, 1);
  assert.equal(builds.length, 2);
  for (const build of builds) {
    assert.deepEqual(build.route, route);
    assert.deepEqual(build.pinnedBuildContext, context);
    assert.equal(build.modelRoomStateDigest, "fixture-digest");
  }
});
