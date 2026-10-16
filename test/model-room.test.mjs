import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPinnedBuildContext,
  verifyPinnedBuildContext,
  routeDoctorCreBuild,
} from "../src/model-room.mjs";
const excerpt = "Required source contract";
const contract = {
  source_revision: "a".repeat(40),
  path: "src/contract.mjs",
  excerpt,
  content_digest: "sha256:" + createHash("sha256").update(excerpt).digest("hex"),
};
const route = { provider: "codex", model: "fixture-model", effort: "high" };
test("Model Room receives required source and verifies the actual model", async () => {
  const execute = async (request) => {
    assert.equal(request.context.contracts[0].excerpt, excerpt);
    return { ...route, result: "done" };
  };
  assert.equal(
    (await routeDoctorCreBuild({ task: "Use the contract", contracts: [contract], route, execute }))
      .result,
    "done",
  );
  await assert.rejects(
    routeDoctorCreBuild({
      task: "Use the contract",
      contracts: [contract],
      route,
      execute: async () => ({ ...route, model: "other" }),
    }),
    /actual route/,
  );
});
test("source context refuses modified bytes", () => {
  const context = createPinnedBuildContext([contract]);
  assert.equal(verifyPinnedBuildContext(context), true);
  context.contracts[0].excerpt = "changed";
  assert.equal(verifyPinnedBuildContext(context), false);
});
