---
name: design
description: Shape and check visual or user-experience work against a short brief, keeping a DESIGN.md journal of the owner's decisions. Use when an issue changes what people see or how they move through the product.
---

# Design

Four parts: a **brief**, a few questions, a **journal**, a visual check. The journal is `DESIGN.md` at the repo root: append-only, one dated entry per decision, read before every design job.

1. **Read the journal.** Open `DESIGN.md` (create it with a `# Design journal` heading if missing). Done when you can name every earlier decision that bears on this issue.
2. **Write the brief** as a comment on the issue, in this shape:
   ```
   Who: the person using this screen and what they came to do
   Must show: the facts or actions that have to be on the screen
   Feel: three words for the look
   Device: phone, desktop or both
   Out of scope: what this change leaves alone
   ```
   Done when each line has content or the word "unknown".
3. **Ask** about the "unknown" lines and any choice the journal does not settle: at most five questions, in one message, each with your recommended answer. Done when the owner has answered or accepted your recommendations.
4. **Record** each answer in `DESIGN.md` as it lands:
   ```
   ## YYYY-MM-DD: <decision in a few words>
   Decision: <what was chosen>
   Why: <the owner's reason, in their words where possible>
   Issue: #<n>
   ```
   Commit the journal on the same branch as the work. Done when every answer has an entry.
5. **Check the screen.** After building, take a screenshot of each changed page at the brief's device width (Playwright `page.screenshot`), attach it to the PR, and compare it line by line with the brief. Done when the PR's "How verified" names each brief line as met or not met, with the screenshot.
