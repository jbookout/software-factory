---
name: dispatch
description: Start one worker on one GitHub issue in its own worktree and collect its PR. Use when an issue is ready to build or someone says to dispatch, assign or start work on an issue.
---

# Dispatch

One issue, one **worker**, one worktree, one PR. Every dispatch carries three things: the issue as its **spec**, a **stop rule**, and a **reviewer** on a different model from the builder. A worker runs once on its brief; a fresh run gets a fresh brief.

1. **Check the spec.** `gh issue view <n> --comments`. It needs the `ready-for-agent` label, an outcome, and acceptance checks a script or person can run. Anything less goes back through the `intake` skill. Done when all three are present.
2. **Claim it.** `gh issue edit <n> --add-assignee @me`. An issue that already has an assignee belongs to that worker; pick another. Done when you are the only assignee.
3. **Pick the pair.** Builder and reviewer run on different models: a Claude builder gets a Codex reviewer, a Codex builder gets a Claude reviewer. Done when both are named.
4. **Start the builder** with the Bash tool's `run_in_background`, so its exit arrives as a notification:
   - Claude: `claude -p --worktree issue-<n> --max-turns 60 "<brief>"` (stop rule: 60 turns).
   - Codex: `git worktree add ../<repo>-issue-<n> -b issue-<n> origin/main`, then `codex exec -C ../<repo>-issue-<n> "<brief>"` (stop rule: one `exec` pass).

   The brief, filled in:
   > Build issue #<n> in <owner/repo>. Read CLAUDE.md first and follow it. Work on branch issue-<n>. Open one PR whose first line is `Issue: #<n>` and fill every template line. If you reach your turn limit, comment on the issue what is done and what is left. End with: PR URL, head SHA, the check command and its last lines, anything unmet.

   Done when the command is running in the background.
5. **Collect.** On the exit notification, read the builder's final report. Done when you hold a PR URL with CI green, or you have commented the blocker on the issue (`gh issue comment <n>`).
6. **Hand off.** Start the `review` skill on the PR, run by the reviewer from step 3. Report the PR URL to whoever asked.

Run as many workers in parallel as the machine handles, each on its own issue.
