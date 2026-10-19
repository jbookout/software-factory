export function deliveryPrompt(kind, { repo, pr, head, branch, ci }) {
  return `Repair ${repo} PR ${pr}, branch ${branch}, head ${head}.
Hosted checks: ${JSON.stringify(ci?.evidence ?? [])}
Read the repository instructions. Fix the observed failures and run relevant tests.
Public repository: never include client data, PII or credentials in code, logs or comments.
Commit only named paths. Never push, merge, deploy, approve your own work, or change credentials.
The runner executes repository-owned checks and publishes the tested commit.
Return the commit SHA and the observed failures, causes and fixes.`;
}
