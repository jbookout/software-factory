import assert from "node:assert/strict";
import test from "node:test";
import { deliveryPrompt } from "../src/pr-delivery-prompts.mjs";
const input = { repo: "example/repo", pr: 1, head: "1".repeat(40), branch: "topic" };
for (const kind of ["fix", "ci-fix"]) test(`${kind}: returns a committed candidate for runner-owned delivery`, () => {
  const prompt = deliveryPrompt(kind, input);
  assert.match(prompt, /Return a committed source artifact/);
  assert.match(prompt, /Never push yourself/);
  assert.match(prompt, /Run focused tests in the foreground/);
  assert.match(prompt, /commit by named paths/);
  assert.match(prompt, /runner executes repository-owned full checks, pushes the tested commit, and reads the remote head back/);
  assert.match(prompt, /Never invoke gh directly/);
  assert.match(prompt, /Never merge/);
});
test("review remains read-only and never publishes a candidate", () => {
  const prompt = deliveryPrompt("review", input);
  assert.match(prompt, /Review only: never edit source, push, merge/);
  assert.doesNotMatch(prompt, /Publish once per verified candidate/);
});
