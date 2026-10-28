---
name: dispatch
description: Start one worker on one GitHub issue in its own worktree and collect its PR. Use when an issue is ready to build or someone says to dispatch, assign or start work on an issue.
---

# Dispatch

One issue, one **worker**, one worktree, one PR. The brief is the issue itself plus `CLAUDE.md`; write nothing the issue does not say.

1. **Check the issue.** `gh issue view <n> --comments`. It needs an outcome and acceptance checks a script or person can run. If either is missing, run the `intake` skill on it first. Done when both are present.
2. **Claim it.** `gh issue edit <n> --add-assignee @me --remove-label needs-triage`. An issue that already has an assignee belongs to that worker; pick another. Done when you are the only assignee.
3. **Start the worker** with the Bash tool's `run_in_background`, so its exit arrives as a notification. Pick one:
   - Claude: `claude -p --worktree issue-<n> --max-turns 60 "<brief>"`
   - Codex: `git worktree add ../<repo>-issue-<n> -b issue-<n> origin/main`, then `codex exec -C ../<repo>-issue-<n> "<brief>"`

   The brief, filled in:
   > Build issue #<n> in <owner/repo>. Read CLAUDE.md first and follow it. Work on branch issue-<n>. Open one PR whose first line is `Issue: #<n>` and fill every template line. End with: PR URL, head SHA, the check command and its last lines, anything unmet.

   Done when the command is running in the background.
4. **Collect.** On the exit notification, read the worker's final report. Done when you hold a PR URL with CI green, or you have commented the blocker on the issue (`gh issue comment <n>`).
5. **Hand off.** Start the `review` skill in a fresh session on the PR. Report the PR URL to whoever asked.

Run as many workers in parallel as the machine handles, each on its own issue.
