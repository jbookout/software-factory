---
name: intake
description: Turn a request into a triaged GitHub issue an agent can build and verify. Use when someone describes new work, a bug or an idea in words, or an issue still carries the needs-triage label.
---

# Intake

Turn a sentence into a **spec**: an issue whose acceptance checks a script or a person can run. The issue is the only spec; nothing else holds it.

1. **Read.** Read the request, the repo's `CLAUDE.md`, and any issue it mentions (`gh issue view <n> --comments`). Done when you can state the outcome in one sentence.
2. **Triage.** Put the request in exactly one lane:
   - `ready-for-agent`: the outcome is clear, the checks can be written now, and it touches nothing on CLAUDE.md's "What goes to the owner" list.
   - `needs-info`: an agent could build it once questions are answered.
   - `ready-for-human`: it needs a person's hands or yes (credentials, money, customer-facing first release, anything irreversible).

   Done when you have picked one lane and can say why in one sentence.
3. **Find the gaps.** Check the four fields: Outcome, Acceptance checks, Must not change, Size. Ask about the gaps only: at most five questions, in one message, each with your recommended answer so the requester can reply "yes". When every gap is answered, move a `needs-info` request to `ready-for-agent`. Done when every field has an answer or a stated assumption.
4. **Write the checks.** Each acceptance check is a command and the output it prints, or a page and what a person sees on it. "Works well" is a wish; rewrite it as something observable. Done when every check could fail.
5. **Size it.** S = one session, one PR. M = needs `/grill-with-docs` before building. L = more than one session: file this issue as the map, then run `/wayfinder` to split it into sub-issues.
6. **File it.** Write the body under the Request form's headings (`### Outcome`, `### Acceptance checks`, `### Must not change`, `### Size`), then:
   `gh issue create --title "<outcome in under 70 characters>" --label <lane> --label size:<S|M|L> --body-file <file>`
   For an issue that already exists, update its body with `gh issue edit <n> --body-file <file> --remove-label needs-triage --add-label <lane> --add-label size:<S|M|L>` instead.
   Done when `gh` prints the issue URL.
7. **Report.** Reply with the issue URL, the lane, and the one-sentence outcome.

The repository may be public. Name clients, deals and people by role ("the client", "the broker"); the private details stay in the requester's own records.
