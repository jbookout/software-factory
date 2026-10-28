# Software factory

This repository is a **starting kit for new software projects**. Every new project is a copy of it, so every project begins with the same way of taking requests, building them with AI agents, checking the work, and putting it live. There is no factory program running anywhere: everything here is a handful of files that GitHub and the agents already know how to use.

Products built from it run on their own; nothing here has to stay running for them. This repository is public and holds no credentials or client data. No open-source license has been chosen, so public visibility alone grants no reuse rights.

## How a new project is born

1. On GitHub, open this repository and click **Use this template**, then **Create a new repository**. Give it a name.
2. In the new repository, work through the [settings checklist](#settings-checklist) below once.
3. Edit the first lines of `CLAUDE.md` to say in one sentence what the project is.
4. When the project has something to put live, follow the three steps at the top of `.github/workflows/deploy.yml` (a `/release` page, a deploy command, the `RELEASE_URL` setting).
5. Open the first issue with **New issue → Request**.

## How work flows

```
Idea  →  Issue  →  Agent builds  →  Pull request  →  Review  →  Merge queue  →  Deploy  →  Live check  →  Issue closed
```

- **Idea to issue.** Say what you want in a sentence, in chat or on the Request form. The `intake` skill sorts it: ready for an agent, needs a few questions first, or needs a person. It asks at most five questions and writes the issue: the outcome, the checks that prove it is done, what must not change, and a size (S, M or L).
- **Issue to pull request.** The `dispatch` skill hands the issue to one agent working in its own copy of the code. The agent writes tests first, makes the change, and opens a pull request whose form says what changed, how it was checked, and what it cost.
- **Review.** A second agent, on a different AI model from the one that built the change, reviews it with the `review` skill and posts one verdict: APPROVE or CHANGES. The builder fixes and the reviewer looks again, three rounds at most; after that the next step is a smaller or different design, not a fourth round.
- **Merge.** When the automatic tests (the check named **CI**) pass, GitHub's merge queue tests the change once more against the latest code and merges it. Nobody clicks merge.
- **Live.** Every merge runs the **Deploy** workflow: it puts the change live, then reads the live site's `/release` page and fails unless it shows the exact version just merged. Only then does it close the issue with a "Live" comment. "Done" means live, not merged.
- **Screens and look.** Visual work also uses the `design` skill: a five-line brief, a few questions, a `DESIGN.md` journal of your decisions, and a screenshot compared against the brief.

## What you look at

- **Issues** show what is asked, who is on it, and what is finished; a closed issue with a "Live" comment is shipped.
- **Pull requests** show the work in progress with its test results and verdicts.
- **A failed run** (red X on the Actions tab) sends a GitHub notification. A red Deploy means merged but not live: that is the next job.
- Optional: a GitHub Project board over the issues gives a one-page view (Idea, Building, In review, Live).

## Improving the factory

The setup is shared and versioned here, so a better rule or skill reaches every project. Improve it in this repository, by pull request, then bring it into a project with a pull request there:

```
git remote add factory https://github.com/jbookout/software-factory   # once per project
git fetch factory
git checkout -b factory-update
git checkout factory/main -- skills .claude/settings.json .github AGENTS.md
git diff --staged                                                      # keep the project's own edits
```

`CLAUDE.md` holds the project's own first line, so compare it by hand (`git diff factory/main -- CLAUDE.md`). Agents change these files only when the owner asks, so the factory never edits itself unattended.

## Settings checklist

Done once per new repository, under **Settings**. Each is a GitHub feature; nothing extra is installed.

- [ ] **Template repository** on (only for this factory repository itself).
- [ ] **Allow auto-merge** on.
- [ ] **Squash merging only**: merge commits off, rebase merging off.
- [ ] **Automatically delete head branches** on.
- [ ] **Ruleset on `main`**: require a pull request and require the status check **CI**.
- [ ] **One required approving review** in that ruleset, only when a second person or reviewer account can approve; with a single GitHub account the review is the `VERDICT: APPROVE` comment instead.
- [ ] **Merge queue** in that ruleset: squash, only merge non-failing pull requests, build at most 2 at once.
- [ ] **Labels** created: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `size:S`, `size:M`, `size:L` (`wontfix` exists by default).

## What is in the box

| Path | What it does |
|---|---|
| `CLAUDE.md` | The one guide every agent reads first. `AGENTS.md` points to it. |
| `skills/` | The four skills: `intake`, `dispatch`, `review`, `design`. `.claude/skills` links here so Claude Code finds them. |
| `.claude/settings.json` | What agents may run without asking, and what they may never read or push. |
| `.github/workflows/ci.yml` | The **CI** check: installs and runs `npm run check`. |
| `.github/workflows/deploy.yml` | Deploy, prove it live, close the issue. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Issue, what changed, how verified, cost. |
| `.github/ISSUE_TEMPLATE/request.yml` | The Request form. |
| `.github/CODEOWNERS` | Who is asked to review. |
| `capabilities/client-presentation/` | A ready skill that builds an interactive property-review website for a client. |

The owner-question list in `CLAUDE.md` and the "Still unverified" line in the PR template are adapted from [OskarGroth/orchestrating-agents](https://github.com/OskarGroth/orchestrating-agents) (MIT license).
