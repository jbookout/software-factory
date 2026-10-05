# Verbatim from jbookout/carr-system ops/release-pipeline.py at 8d5f00b6a81b0cc0a3756989a1f7226efff1b7f7
# (class Blocked and the verdict, approval and Fixes-Forward readers), so the factory tests its
# comments against the release pipeline's own parser. Refresh by re-extracting the same line ranges.
from __future__ import annotations
import re
from typing import Callable


class Blocked(Exception):
    """The lane cannot proceed and no retry of the same inputs would help it
    today, but nothing failed: re-evaluated on the next tick."""

    def __init__(self, reason: str, detail: str, capability: str | None = None):
        super().__init__(f"{reason}: {detail}")
        self.reason, self.detail, self.capability = reason, detail, capability


def verdict(body: str, cfg: dict) -> str | None:
    """'approve', 'block' or None, read from the comment's FIRST line only."""
    first = (body or "").strip().splitlines()[0].strip().lower() if (body or "").strip() else ""
    if any(first.startswith(m.lower()) for m in cfg.get("block_markers") or []):
        return "block"
    if any(first.startswith(m.lower()) for m in cfg.get("review_markers") or []):
        return "approve"
    return None


def trusted_commenter(comment: dict, cfg: dict) -> bool:
    """Both repositories are public: anyone can comment on a merged PR. Only a
    comment from the owner, a member, a collaborator, or a configured login can
    carry a verdict."""
    assoc = str(comment.get("author_association") or "").upper()
    login = str((comment.get("user") or {}).get("login") or "").lower()
    allowed = {str(x).upper() for x in cfg.get("review_author_associations") or []}
    logins = {str(x).lower() for x in cfg.get("review_logins") or []}
    return assoc in allowed or (bool(login) and login in logins)


REVIEWED_SHA_LINE_RE = re.compile(r"Reviewed-SHA: ([0-9a-f]{40})")


def reviewed_header_sha(body: str) -> str | None:
    """Only a literal first-line APPROVE and second-line SHA authorize release."""
    lines = [line.removesuffix("\r") for line in (body or "").split("\n")]
    if len(lines) < 2 or lines[0] != "APPROVE":
        return None
    second = REVIEWED_SHA_LINE_RE.fullmatch(lines[1])
    if second is None or any("reviewed-sha:" in line.lower() for line in lines[2:]):
        return None
    return second.group(1)


def approval_of(comments: list[dict], cfg: dict, head_sha: str,
                covers: Callable[[str], str | None] | None = None) -> tuple[dict, str, str]:
    """(comment, rule, reviewed_sha). The LATEST trusted comment that carries a
    verdict decides. It must be APPROVE and carry exactly one
    `Reviewed-SHA: <40-hex>` line R. No clocks: a committer date says when a
    commit was made, not when it was pushed, so an approval of H1 posted
    between H2's commit and its push would otherwise cover H2 unreviewed.

    rule "exact": R is the merged PR head H.
    rule "main-merge-only": R != H, but `covers(R)` returns None, i.e. H is R
    plus nothing but merges of main (what `gh pr update-branch` adds after a
    review); covers() returns the reason otherwise, and the approval is stale."""
    last = _latest_approval(comments, cfg)
    header_sha = reviewed_header_sha(str(last.get("body") or ""))
    reviewed = [header_sha] if header_sha else []
    if head_sha and reviewed == [head_sha]:
        return last, "exact", head_sha
    why = "no main-merge rule available"
    if head_sha and len(reviewed) == 1 and covers is not None:
        why = covers(reviewed[0]) or ""
        if not why:
            return last, "main-merge-only", reviewed[0]
    raise Blocked("review_stale", f"the approval {last.get('html_url')} carries "
                                  f"Reviewed-SHA {reviewed or 'none'}, not the merged head {head_sha}, "
                                  f"and the main-merge-only rule does not apply: {why}")


def latest_verdict(comments: list[dict], cfg: dict, head_sha: str) -> dict:
    """The approval comment under the exact rule only (see approval_of)."""
    return approval_of(comments, cfg, head_sha)[0]


def deciding_verdict(comments: list[dict], cfg: dict) -> dict | None:
    """The LATEST trusted comment that carries a verdict, or None."""
    carrying = [c for c in comments if trusted_commenter(c, cfg) and verdict(c.get("body", ""), cfg)]
    if not carrying:
        return None
    return max(carrying, key=lambda c: (str(c.get("created_at") or ""), int(c.get("id") or 0)))


def _latest_approval(comments: list[dict], cfg: dict) -> dict:
    last = deciding_verdict(comments, cfg)
    if last is None:
        raise Blocked("no_independent_review", "no trusted comment carries a review verdict")
    if verdict(last.get("body", ""), cfg) != "approve":
        raise Blocked("review_blocked", f"the latest review verdict is BLOCK ({last.get('html_url')})")
    return last


FIXES_FORWARD_RE = re.compile(r"^Fixes-Forward:[ \t]*#([1-9][0-9]*)[ \t]*$")


def fixes_forward(approval: dict, reviewed_sha: str) -> set[int]:
    """Read only consecutive authority-header markers after exact APPROVE and
    Reviewed-SHA lines. The first prose, blank, or example line ends the
    header. This narrow grammar makes Markdown/HTML rendering irrelevant:
    a marker later in a quoted, fenced, code-span, or HTML example cannot
    confer release authority. CRLF is tolerated. The caller passes only the
    deciding approval returned by approval_of()."""
    # Split on LF only. Python's splitlines() treats U+2028 and several other
    # Unicode separators as line breaks even though approval_of()'s reviewed
    # SHA matcher and GitHub's comment text do not. All authority lines must
    # be literal LF/CRLF lines and line two must name the SHA that was accepted.
    lines = [line.removesuffix("\r") for line in str(approval.get("body") or "").split("\n")]
    if len(lines) < 3 or lines[0] != "APPROVE":
        return set()
    if reviewed_header_sha(str(approval.get("body") or "")) != reviewed_sha:
        return set()
    found: set[int] = set()
    for line in lines[2:]:
        m = FIXES_FORWARD_RE.match(line)
        if not m:
            break
        found.add(int(m.group(1)))
    return found
