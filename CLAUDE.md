# Project guide for agents

Replace this line with one sentence: what this project is and who uses it.

## The check

`npm run check` is the check. CI runs it on every PR and again in the merge queue. Run it before every push and paste its last lines into the PR's "How verified".

## How work flows

1. Work starts as a GitHub issue with an outcome and acceptance checks. A request that arrives any other way goes through the `intake` skill, which also triages it: ready for an agent, needs questions first, or needs a person.
2. Size before building: **S** = one session, one PR. **M** = run `/grill-with-docs`, then one PR. **L** = map it with `/wayfinder` into sub-issues ([issue tracker](docs/agents/issue-tracker.md)), one PR each.
3. The `dispatch` skill starts one worker per issue in its own worktree. Every dispatch carries the issue as its spec, a stop rule, and a reviewer on a different model from the builder.
4. One issue, one branch, one PR. Fill every line of the PR template; the first line is `Issue: #N`. Code goes test-first (`/tdd`); a bug starts with `/diagnosing-bugs`.
5. The `review` skill runs a bounded loop: an independent reviewer posts a verdict, the builder's own session fixes, at most 3 rounds. After round 3, the next step is a smaller or different design.
6. Merge: once CI is green, the author turns on squash auto-merge (`gh pr merge --auto --squash`). A PR over 150 changed lines, or one touching `.github/`, deploy or production config, waits for `VERDICT: APPROVE` first.
7. Done means **live**: the Deploy workflow proves the live `/release` serves the merged commit, then closes the issue. A red Deploy run is the next job.
8. Visual work follows the `design` skill and its `DESIGN.md` journal.

## Budget

A worker gets `--max-turns 60`. A job that reaches its limit stops, comments on its issue what is done and what is left, and leaves the PR as a draft.

## What goes to the owner

Decide everything else and report it afterwards. Bring the owner only: money or a new recurring cost; anything a customer sees or receives; a first release of something new; credentials; anything irreversible; a direction they have not approved; changes to these rules. Ask once, as one recommendation they can answer yes or no.

## Rules

- Main changes only through a merged PR.
- Secrets live in GitHub environments. Read config through the app's own settings; leave `.env` and credential files closed, and keep environment dumps out of logs.
- This repository may be public: issues, PRs and commits carry no client data and no business records.
- Put every mechanically decidable rule in a CI check, using the ecosystem's smallest mature tool. Sentences here explain intent; CI enforces.
- Subtract before adding. New background jobs, scheduled workflows, queues or wrappers need a named failure the platform cannot handle.
- Issues an agent files on its own carry an `Expires: YYYY-MM-DD` line.
- This file, `.claude/`, `.github/` and `skills/` come from the shared factory template (README, "Improving the factory"). Improve them there, by PR, when the owner asks.

## Live proof convention

The app answers `GET /release` with `{"git_sha": "<commit>"}`, taken from the `GIT_SHA` value the Deploy step passes. The repository variable `RELEASE_URL` holds that address.
