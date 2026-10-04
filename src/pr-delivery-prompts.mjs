import { fileURLToPath } from "node:url"
import { builderRequirements } from "./pr-delivery-receipts.mjs"

const receiptSchema = fileURLToPath(new URL("../schemas/pr-delivery.schema.json", import.meta.url))
const skills = "Apply ~/.agents/skills/codebase-design/SKILL.md and ~/.agents/skills/zero-tech-debt/SKILL.md to the diff. If it touches any .swift file, also apply ~/.agents/skills/swiftui-pro/SKILL.md, loading only the references needed for changed code."
const rules = "RULES, all required: Report to the orchestrator. No subagents. Public repositories: never quote client names, PII or credentials in code, fixtures, logs or comments; cite file:line only. Never merge, force-push, approve by button, or enable GitHub auto-merge."

export const fullReviewChecklist = `(a) correctness and edge cases of every changed function;
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

export function deliveryPrompt(kind, { repo, pr, head, branch, prior, brief, resolution, base, environment, builderId }) {
  const builderHead = ["fix", "ci-fix"].includes(kind) ? "the final pushed HEAD (read it after repairs)" : head
  const task = `${repo} PR ${pr} at head ${head}.`
  const selfReview = `${rules}\nBUILDER SELF-REVIEW: before PR creation or updating this PR, read the final diff and all callers locally. Run the same full-review checklist; repair every issue and replay its failing control against the repair. No posting, review verdict, approval or independent-review credit. All checklist items are required:\n${fullReviewChecklist}\nAll six requirements apply by diff; every N/A needs the failed relevance test:\n${Object.entries(builderRequirements).map(([id, text]) => `${id}: ${text}`).join("\n")}\nDeclare fixture ownership, resources, selection dependencies and absence of undeclared global state. Registered steering changes require their instruction eval. Emit factory-self-review/v1 per ${receiptSchema}: issues/repairs reference executed checks, not unchecked headings. Bind repo ${repo}, head ${builderHead}, base ${base}, environment ${environment}, builderId ${builderId}. Check argv must print an exact acknowledgement line after exercising the named property; control exits 1 and repaired exits 0. The factory replays these commands on their declared sources before accepting the receipt. Replay is isolated: no inherited credentials, network, home or shared Git metadata; use public pinned source files and FACTORY_* proof pins, with artifacts inside the disposable worktree.`
  if (kind === "self-review" || kind === "build") return selfReview
  if (kind === "review") {
    const scope = prior
      ? `REVIEW MODE: confirm. The complete review at ${prior.sha} found:\n${prior.body}\nExecutor resolution proof: ${JSON.stringify(resolution)}\nVerify every numbered original finding is resolved with evidence. Check only the fix diff (git diff ${prior.sha} ${head}) for regressions. ${skills} Confirm hosted CI is green. Do not run a fresh open-ended hunt. Unrelated problems belong under Follow-ups (non-blocking).`
      : `REVIEW MODE: full. This is the ONE complete review; find EVERY blocking defect up front. Read the PR description and full diff (gh pr diff ${pr} -R ${repo}), all callers, and run the repository's tests and checks. State a verdict for every checklist item:\n${fullReviewChecklist}`
    return `${rules}\nReview only: never edit source, push, merge or approve your own work. You are an independent reviewer in a fresh process, not the builder.\nTASK: ${task}\n${scope}\nReturn ONE review comment as your final message; the factory posts it. First line exactly APPROVE or REVIEW: BLOCKED, second line Reviewed-SHA: ${head}. Then ALL blocking findings numbered with file:line and reproduction, per-finding status for confirmation, then Non-blocking or Follow-ups (non-blocking). Do not post the comment yourself. If blocked, append Delivery-Brief: followed by one-line JSON factory-delivery-brief/v1 from ${receiptSchema}. Use each numbered finding's ID, original reproduction argv and exact acknowledgement, owning repo/paths, consumer repo/revision and contract pin. Bind repo ${repo}, pr ${pr}, head ${head}, base ${base}, environment ${environment}, builderId ${builderId}; reviewDigest is calculated by the factory from the comment before the Delivery-Brief line. For findings owned by this repository, originalHead and contractPin must equal the reviewed head. For its consumer, the original consumer head must equal the reviewed head. Indent reproduction instructions beneath their finding. Cross-repo findings must name their owner; never assign them to the wrong repo.`
  }
  const scope = kind === "ci-fix"
    ? `CI-FIX: This approved PR has red CI and/or conflicts with main. Merge origin/main into ${branch} and resolve conflicts preserving both sides' intent. Never rebase. Read gh pr checks ${pr} -R ${repo} and gh run view --log-failed. Fix every root cause, including unrelated test flakes properly.`
    : `Read the latest REVIEW: BLOCKED or CHANGES REQUESTED comment (gh pr view ${pr} -R ${repo} --comments), resolve every numbered blocking finding, and update from origin/main if behind.`
  return `${rules}\nNever approve your own work. Ordinary pushes to this PR's branch ${branch} only. Tests first: each fix gets a test that fails before it.\nTASK: ${task}\n${scope}\nBound finding brief: ${JSON.stringify(brief)}\nRepair only findings owned by ${repo}; cross-repo work becomes a named dependency with owner, exact head/contract pin, wake condition and deadline. A reseal or main merge is not functional repair.\n${selfReview}\nRun focused applicable local proofs, push, confirm hosted CI starts; full required hosted checks remain mandatory. Return ONLY JSON {fix: factory-fix-receipt/v1, selfReview: factory-self-review/v1} per ${receiptSchema}, with every finding accounted for. The factory binds and replays each proof; prose completion cannot start confirmation.`
}
