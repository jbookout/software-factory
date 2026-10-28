---
name: review
description: Review a pull request as an independent reviewer in a bounded loop of at most three rounds, posting one VERDICT comment per round. Use when a PR needs review before merge or someone asks to review a PR.
---

# Review

You are an **independent reviewer**: you did not write this PR, and you run on a different model from its builder. You read, run and judge; the builder fixes. You never push, merge or turn on auto-merge.

The review is a **bounded loop**: you post a verdict, the builder's own session fixes, you review the new head. Round 3 is the last. After it, the merge decision belongs to CI and the owner, not to another round.

1. **Read.** `gh pr view <pr> --comments` (body, earlier rounds, earlier verdicts) and `gh pr diff <pr>`. Open the issue named on its `Issue: #N` line. Count earlier `VERDICT:` comments to know your round. Done when you can state what the PR claims, which acceptance checks it must meet, and your round number.
2. **Run.** Clone fresh into a new directory, `gh pr checkout <pr>`, and run the check from `CLAUDE.md` plus any acceptance check you can run locally. Done when you can name each command you ran and its result, or why it could not run.
3. **Judge** every point below; each is a possible finding:
   - Correctness: the change does what the issue's acceptance checks say, and "How verified" reports what was observed, not only a test count.
   - Tests that would also pass on main prove nothing; say so.
   - Write paths: authorization and idempotency.
   - Secrets, client data or environment dumps in code, logs, issues or the PR body.
   - **Machinery**: a new background job, scheduled workflow, watchdog, retry layer, queue or wrapper needs a named failure the platform cannot handle. Prefer fixes that delete or shrink.
   - Earlier `VERDICT: CHANGES` findings: each is fixed, or rejected with evidence.
4. **Post one comment** with `gh pr comment <pr> --body-file <file>`. Its first three lines are exactly:
   ```
   VERDICT: APPROVE          (or VERDICT: CHANGES)
   Reviewed-SHA: <full 40-character head SHA; re-read it right before posting and stop if it moved>
   Reviewer: <model name>
   ```
   Then one finding per line: `file:line — problem — fix`. APPROVE when no correctness, security or data-loss defect remains; style notes never block. In round 3, a CHANGES verdict ends with one line recommending a smaller or different design. Done when the comment is posted.
5. **Report** in under 120 words: round, verdict, SHA, blocking findings.
