const skills = "Apply ~/.agents/skills/codebase-design/SKILL.md and ~/.agents/skills/zero-tech-debt/SKILL.md to the diff. If it touches any .swift file, also apply ~/.agents/skills/swiftui-pro/SKILL.md, loading only the references needed for changed code."
const rules = "RULES, all required: Report to the orchestrator. No subagents. Public repositories: never quote client names, PII or credentials in code, fixtures, logs or comments; cite file:line only. Never merge, force-push, approve by button, or enable GitHub auto-merge."
const jevEvidence = "Jev value claims: require a verdict bound to the reviewed source, the action taken because of it, source/change evidence, and the stated savings baseline. Matching timestamps, an unusable answer, a coincident commit, or an unchanged decision leave causal value unproven. Distinguish commit-attributed CI proxies from verified interventions. For a verified intervention, name the action and measurement basis. If independent discovery or the counterfactual is uncertain, lower the evidence status; never invent dollars or tokens saved."
const checklist = `(a) correctness and edge cases of every changed function;
(b) concurrency, races and stale async results;
(c) error handling and failure paths: network, timeouts, partial data;
(d) security: injection, bypasses, secrets;
(e) data exposure: no client names, PII or credentials in code, fixtures, logs or text;
(f) tests: each claim is exercised, failure cases covered;
(g) UI where relevant: phone width, accessibility, reduced motion, empty and error states;
(h) contracts and schema compatibility with callers;
(i) CI, lint and repository policy checks (launchd, migrations, gate baselines, where applicable);
(j) regressions to existing behaviour;
(k) design and debt: ${skills} A shallow module, hypothetical seam, dead compatibility path or duplicated rule introduced by this PR is blocking. Deprecated APIs, accessibility gaps or performance pitfalls in changed Swift lines are blocking.
(l) ${jevEvidence}`

export function deliveryPrompt(kind, { repo, pr, head, branch, prior, decision }) {
  const task = `${repo} PR ${pr} at head ${head}.`
  if (kind === "review") {
    const scope = prior
      ? `REVIEW MODE: confirm. The complete review at ${prior.sha} found:\n${prior.body}\nVerify every numbered original finding is resolved with evidence. Check only the fix diff (git diff ${prior.sha} ${head}) for regressions. ${skills} ${jevEvidence} Confirm hosted CI is green. Do not run a fresh open-ended hunt. Unrelated problems belong under Follow-ups (non-blocking).`
      : `REVIEW MODE: full. This is the ONE complete review; find EVERY blocking defect up front. Read the PR description and full diff (gh pr diff ${pr} -R ${repo}), run the repository's tests and checks. State a verdict for every checklist item:\n${checklist}`
    const policy = decision ? `Repository review tier: ${decision.tier}. Policy revision: ${decision.policy_revision}. Diff digest: ${decision.diff_digest}.` : ""
    return `${rules}\nReview only: never edit source, push, merge or approve your own work. You are an independent reviewer in a fresh process, not the builder.\nTASK: ${task}\n${policy}\n${scope}\nReturn ONE review comment as your final message; the factory posts it. First line exactly APPROVE or REVIEW: BLOCKED, second line Reviewed-SHA: ${head}. Then ALL blocking findings numbered with file:line and reproduction, per-finding status for confirmation, then Non-blocking or Follow-ups (non-blocking). Do not post the comment yourself.`
  }
  const scope = kind === "ci-fix"
    ? `CI-FIX: This approved PR has red CI and/or conflicts with main. Merge origin/main into ${branch} and resolve conflicts preserving both sides' intent. Never rebase. Read gh pr checks ${pr} -R ${repo} and gh run view --log-failed. Fix every root cause, including unrelated test flakes properly.`
    : `Read the latest REVIEW: BLOCKED or CHANGES REQUESTED comment (gh pr view ${pr} -R ${repo} --comments), resolve every numbered blocking finding, and update from origin/main if behind.`
  return `${rules}\nNever approve your own work. Ordinary pushes to this PR's branch ${branch} only. Tests first: each fix gets a test that fails before it.\nTASK: ${task}\n${scope}\n${skills}\nRun every test and CI command in the foreground. Complete the bounded fix set and relevant local proofs before publishing. Publish once per verified candidate. Do not push speculative intermediate fixes. Run the repository's full local checks, push, confirm hosted CI starts. End with new head SHA and each finding or failure -> cause -> fix or why-not.`
}
