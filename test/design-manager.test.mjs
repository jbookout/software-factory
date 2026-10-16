import test from "node:test";
import assert from "node:assert/strict";
import { createDesignBrief } from "../src/design-manager.mjs";
test("a brief carries only the task, questions and acceptance tests", () => {
  assert.deepEqual(
    createDesignBrief({
      objective: "Save a task",
      questions: ["Who can edit?"],
      acceptanceTests: ["Saved tasks survive reload"],
    }),
    {
      objective: "Save a task",
      questions: ["Who can edit?"],
      acceptanceTests: ["Saved tasks survive reload"],
    },
  );
  assert.throws(() => createDesignBrief({ objective: "Save a task", acceptanceTests: [] }));
});
