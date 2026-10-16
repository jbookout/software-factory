export function createDesignBrief({ objective, questions = [], acceptanceTests }) {
  if (
    typeof objective !== "string" ||
    !objective.trim() ||
    !Array.isArray(questions) ||
    !Array.isArray(acceptanceTests) ||
    !acceptanceTests.length ||
    [...questions, ...acceptanceTests].some((text) => typeof text !== "string" || !text.trim())
  )
    throw new Error("provide an objective, task questions and acceptance tests");
  return { objective, questions: [...questions], acceptanceTests: [...acceptanceTests] };
}

export const designGuidance =
  "Describe the user outcome, ask only questions needed for this task, and verify the acceptance tests.";
