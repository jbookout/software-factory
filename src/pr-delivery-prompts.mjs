const skills = "Apply ~/.agents/skills/codebase-design/SKILL.md and ~/.agents/skills/zero-tech-debt/SKILL.md to the diff. If it touches any .swift file, also apply ~/.agents/skills/swiftui-pro/SKILL.md, loading only the references needed for changed code."
const rules = "RULES, all required: Report to the orchestrator. No subagents. Public repositories: never quote client names, PII or credentials in code, fixtures, logs or comments; cite file:line only. Never merge, force-push, approve by button, or enable GitHub auto-merge."
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
(k) design and debt: ${skills} A shallow module, hypothetical seam, dead compatibility path or duplicated rule introduced by this PR is blocking. Deprecated APIs, accessibility gaps or performance pitfalls in changed Swift lines are blocking.`

export function deliveryPrompt(kind, { repo, pr, head, branch, prior, evidence, description = "", ci, reader }) {
  const hostedEvidence = ci?.evidence?.map(c => ({id:c.id,details_url:c.details_url,check_suite:c.check_suite,name:c.name ?? c.context,status:c.status ?? c.state,conclusion:c.conclusion,output:c.output ? {title:c.output.title,summary:c.output.summary?.slice(0,2000)} : undefined}))
  const task = `${repo} PR ${pr} at head ${head}.\nPR description: ${description}\nHosted checks: ${JSON.stringify(hostedEvidence ?? [])}\nPrior review: ${prior?.body ?? "none"}\nGitHub observation owner: the factory. Never invoke gh directly. For additional JSON evidence use node "${reader?.root ?? "$FACTORY_ROOT"}/bin/pr-delivery.mjs" "$FACTORY_PR_CONFIG" github-read ${repo} <repository-relative-REST-route>. For full hosted job logs use the same command with github-logs ${repo} <job-id> (job id comes from details_url or the Actions jobs JSON). The reader shares the request budget and retry hold. Stop on quota_hold/auth_error/unknown; never infer red CI from a query refusal.`
  if (kind === "review") {
    if(!evidence?.manifest || !evidence.files?.diff)throw new Error("review requires owner-captured input")
    const scope = prior
      ? `REVIEW MODE: confirm. The complete review at ${prior.sha} found:\n${prior.body}\nVerify every numbered original finding is resolved with evidence. Check only the owner-captured fix diff for regressions. ${skills} Use the captured hosted-check evidence; the factory reobserves checks before delivery. Do not run a fresh open-ended hunt. Unrelated problems belong under Follow-ups (non-blocking).`
      : `REVIEW MODE: full. This is the ONE complete review; find EVERY blocking defect up front. Read the owner-captured PR description and full diff, run the repository's tests and checks. State a verdict for every checklist item:\n${checklist}`
    const input=`OWNER-CAPTURED INPUT: ${evidence.manifest}\nRead this manifest and its description, diff, hosted checks${evidence.files.fixDiff ? " and fix diff" : ""} first. It binds repo, exact base/head/tree, observation time and file digests. Use these read-only artifacts without a worker network credential. For any additional read, report client, route, probe and typed TLS/transport error. A failed probe leaves service availability unproven; a successful sanctioned same-endpoint alternate read establishes reachability. Never bypass TLS verification.\n`
    return `${rules}\n${input}Review only: never edit source, push, merge or approve your own work. You are an independent reviewer in a fresh process, not the builder.\nTASK: ${task}\n${scope}\nReturn ONE review comment as your final message; the factory posts it. First line exactly APPROVE or REVIEW: BLOCKED, second line Reviewed-SHA: ${head}. Then ALL blocking findings numbered with file:line and reproduction, per-finding status for confirmation, then Non-blocking or Follow-ups (non-blocking). Do not post the comment yourself.`
  }
  const scope = kind === "ci-fix"
    ? `CI-FIX: This approved PR has an observed failed required check. Merge origin/main into ${branch} and resolve conflicts preserving both sides' intent. Never rebase. Read the supplied hosted-check evidence. Request additional REST evidence through the shared factory reader. Fix every root cause, including unrelated test flakes properly.`
    : `Read the supplied latest REVIEW: BLOCKED or CHANGES REQUESTED comment, resolve every numbered blocking finding, and update from origin/main if behind.`
  return `${rules}\nNever approve your own work. Return a committed source artifact on branch ${branch}. The factory runner owns full checks and push. Never push yourself. Tests first: each fix gets a test that fails before it.\nTASK: ${task}\n${scope}\n${skills}\nRun focused tests in the foreground. Complete the bounded fix set, commit by named paths, then return the commit SHA and each finding or failure -> cause -> fix or why-not. The runner executes repository-owned full checks, pushes the tested commit, and reads the remote head back. Your exit or prose cannot mark delivery complete.`
}
