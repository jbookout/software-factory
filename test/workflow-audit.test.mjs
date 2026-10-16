import test from "node:test";
import assert from "node:assert/strict";
import { auditWorkflow } from "../src/workflow-audit.mjs";
const clean = `on: pull_request
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          persist-credentials: false
      - run: npm test
`;
test("validation workflow accepts read-only pinned actions", () =>
  assert.deepEqual(auditWorkflow(clean), []));
for (const [property, source] of [
  ["readonly-default", clean.replace("contents: read", "contents: write")],
  ["persisted-checkout-token", clean.replace("false", "true")],
  ["mutable-ref", clean.replace("a".repeat(40), "main")],
  ["missing-timeout", clean.replace("    timeout-minutes: 20\n", "")],
  [
    "event-shell-injection",
    clean.replace("npm test", "echo ${{ github.event.pull_request.title }}"),
  ],
  [
    "event-shell-injection",
    clean.replace("npm test", "echo ${{ github['event']['pull_request']['title'] }}"),
  ],
  [
    "build-credentials",
    clean.replace(
      "npm test",
      "npm test\n        env:\n          GH_TOKEN: ${{ secrets.GH_TOKEN }}",
    ),
  ],
  ["publication-in-validation", clean.replace("npm test", "npm publish")],
  [
    "artifact-execution-review-required",
    clean.replace("run: npm test", `uses: actions/download-artifact@${"a".repeat(40)}`),
  ],
  [
    "private-artifact",
    clean.replace(
      "run: npm test",
      `uses: actions/upload-artifact@${"a".repeat(40)}\n        with:\n          path: .env`,
    ),
  ],
])
  test(property + source.slice(-50), () =>
    assert.ok(auditWorkflow(source).some((f) => f.property === property)),
  );
