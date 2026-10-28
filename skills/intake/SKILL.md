---
name: intake
description: Turn a request into a GitHub issue an agent can build and verify. Use when someone describes new work, a bug or an idea in words rather than as a filed issue.
---

# Intake

Turn a sentence into a **spec**: an issue whose acceptance checks a script or a person can run. The issue is the only spec; nothing else holds it.

1. **Read.** Read the request, the repo's `CLAUDE.md`, and any issue it mentions (`gh issue view <n> --comments`). Done when you can state the outcome in one sentence.
2. **Find the gaps.** Check the four fields: Outcome, Acceptance checks, Must not change, Size. Ask about the gaps only: at most five questions, in one message, each with your recommended answer so the requester can reply "yes". Done when every field has an answer or a stated assumption.
3. **Write the checks.** Each acceptance check is a command and the output it prints, or a page and what a person sees on it. "Works well" is a wish; rewrite it as something observable. Done when every check could fail.
4. **Size it.** S = one session, one PR. M = needs `/grill-with-docs` before building. L = more than one session: file this issue as the map, then run `/wayfinder` to split it into sub-issues.
5. **File it.** Write the body under the issue form's headings, then:
   `gh issue create --title "<outcome in under 70 characters>" --label needs-triage --label size:<S|M|L> --body-file <file>`
   Body headings, in order: `### Outcome`, `### Acceptance checks`, `### Must not change`, `### Size`. Done when `gh` prints the issue URL.
6. **Report.** Reply with the issue URL and the one-sentence outcome.

The repository may be public. Name clients, deals and people by role ("the client", "the broker"); the private details stay in the requester's own records.
