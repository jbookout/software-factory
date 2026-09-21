---
name: jev-browser-select
description: Use Jev to choose one operation and visible browser control from a fresh accessibility snapshot when supervised browser work would benefit from a fast typed decision.
---

# Jev browser selection

Use this only on public pages or pages the user explicitly cleared for TypeSafe. The user authorized sending the goal, page origin/path, and visible control roles/names. Do not send form values, URL queries, raw page text, hidden controls, cookies, or accessibility descriptions beyond the control name.

1. Capture a fresh accessibility snapshot with the available browser controller. Project only visible controls into `{index, role, name}` and record the page URL. Keep the controller's target handles locally; indices are temporary positions in this one snapshot.
2. Pipe JSON with `goal`, `url`, `site_clearance` (`public` or `user_cleared`), and `controls` into `python3 <this-skill-directory>/select.py`. Supply `TYPESAFE_API_KEY` through the environment; never include it in JSON or logs.
3. Treat the output as an advisory. If `selected` is false, reason locally or ask for a different page. For `type_text`, write the literal text yourself; Jev selects the operation and target but does not compose the text.
4. Immediately take a fresh browser snapshot. Execute only if the URL origin/path and target's role/name still match the selection snapshot. A changed target, ambiguous match, navigation, or low confidence means take another selection step. Verify the resulting page after the browser action.

The script never clicks, types, scrolls, or marks a task complete. It sends the bounded state and two typed questions in one TypeSafe request, returning the operation, target index, and a digest of the selection snapshot. The browser controller remains the executor and completion authority.
