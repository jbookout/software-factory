import assert from "node:assert/strict";
import test from "node:test";
import { deliveryPrompt } from "../src/pr-delivery-prompts.mjs";
const input = { repo: "example/repo", pr: 1, head: "1".repeat(40), branch: "topic" };
for (const kind of ["fix", "ci-fix"]) test(`${kind}: publishes a stable locally verified candidate once`, () => {
  const prompt = deliveryPrompt(kind, input);
  assert.match(prompt, /Complete the bounded fix set and relevant local proofs before publishing/);
  assert.match(prompt, /Publish once per verified candidate/);
  assert.match(prompt, /Do not push speculative intermediate fixes/);
  assert.match(prompt, /Run every test and CI command in the foreground/);
  assert.match(prompt, /the factory observes the remote head and hosted CI/);
  assert.match(prompt, /Never invoke gh directly/);
  assert.match(prompt, /Never merge/);
});
test("review remains read-only and never publishes a candidate", () => {
  const prompt = deliveryPrompt("review", input);
  assert.match(prompt, /Review only: never edit source, push, merge/);
  assert.doesNotMatch(prompt, /Publish once per verified candidate/);
});
