"""One Jev request chooses an operation and visible control; never acts on a page."""

import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
OPERATIONS = {
    "click": "Click a visible control to advance the user's goal.",
    "type_text": "Type caller-authored text into a visible editable control.",
    "finish": "The requested browser step is already complete.",
    "abstain": "The visible controls do not support a reliable next step.",
}


def _refuse(reason):
    return {"schema": "jev-browser-selection.v1", "selected": False, "reason": reason}


def _state(raw):
    if not isinstance(raw, dict) or set(raw) != {"goal", "url", "site_clearance", "controls"}:
        raise ValueError("snapshot must contain only goal, url, site_clearance, controls")
    goal = raw["goal"]
    if not isinstance(goal, str) or not goal.strip() or len(goal) > 1000:
        raise ValueError("goal must be 1-1000 characters")
    if raw["site_clearance"] not in ("public", "user_cleared"):
        raise ValueError("site clearance must be public or user_cleared")
    url = urllib.parse.urlsplit(raw["url"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise ValueError("url must be an ordinary HTTP(S) page")
    controls = raw["controls"]
    if not isinstance(controls, list) or not 0 < len(controls) <= 80:
        raise ValueError("controls must contain 1-80 visible controls")
    projected = []
    seen = set()
    for item in controls:
        if not isinstance(item, dict) or set(item) != {"index", "role", "name"}:
            raise ValueError("controls may contain only index, role, name")
        index, role, name = item["index"], item["role"], item["name"]
        if not isinstance(index, int) or index < 0 or index in seen:
            raise ValueError("control indices must be unique nonnegative integers")
        if not isinstance(role, str) or not role or len(role) > 40:
            raise ValueError("role must be 1-40 characters")
        if not isinstance(name, str) or len(name) > 120:
            raise ValueError("name must be at most 120 characters")
        seen.add(index)
        projected.append({"index": index, "role": role, "name": name})
    state = {
        "goal": goal.strip(),
        "page": {"origin": f"{url.scheme}://{url.netloc}", "path": url.path or "/"},
        "controls": projected,
    }
    return state


def select(raw, *, api_key=None, opener=None):
    """Return a typed recommendation bound to a fresh snapshot digest."""
    state = _state(raw)
    digest = hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()
    key = api_key or os.environ.get("TYPESAFE_API_KEY")
    if not key:
        return {**_refuse("jev_unavailable"), "snapshot_sha256": digest}
    options = {f"control_{c['index']}": f"Visible {c['role']}: {c['name']}" for c in state["controls"]}
    options["none"] = "No visible control is a reliable target for this step."
    body = json.dumps({
        "model": "jev-latest", "state": state,
        "questions": {
            "operation": {"type": "choice", "instructions": "Which single operation best advances the goal from this visible page? Prefer abstain if unsure.", "criteria": OPERATIONS},
            "target": {"type": "choice", "instructions": "Which visible control is the target for that operation? Choose none for finish or abstain.", "criteria": options},
        },
    }).encode()
    request = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json",
    })
    try:
        with (opener or urllib.request.urlopen)(request, timeout=12) as response:
            answer = json.load(response).get("answers", {})
    except (OSError, ValueError, urllib.error.HTTPError):
        return {**_refuse("jev_unavailable"), "snapshot_sha256": digest}
    operation = answer.get("operation", {}).get("choice")
    target = answer.get("target", {}).get("choice")
    if operation not in OPERATIONS or target not in options:
        return {**_refuse("invalid_jev_answer"), "snapshot_sha256": digest}
    for question in ("operation", "target"):
        confidence = answer.get(question, {}).get("confidence")
        if not isinstance(confidence, (int, float)) or not 0.6 <= confidence <= 1:
            return {**_refuse("low_or_missing_confidence"), "snapshot_sha256": digest}
    if operation in ("finish", "abstain"):
        if target != "none":
            return {**_refuse("incompatible_answer"), "snapshot_sha256": digest}
        return {"schema": "jev-browser-selection.v1", "selected": operation == "finish",
                "operation": operation, "target_index": None, "snapshot_sha256": digest}
    if target == "none":
        return {**_refuse("no_target"), "snapshot_sha256": digest}
    return {"schema": "jev-browser-selection.v1", "selected": True,
            "operation": operation, "target_index": int(target.removeprefix("control_")),
            "snapshot_sha256": digest}


if __name__ == "__main__":
    try:
        print(json.dumps(select(json.load(sys.stdin)), sort_keys=True))
    except (ValueError, TypeError) as exc:
        print(json.dumps(_refuse(f"invalid_snapshot: {exc}"), sort_keys=True))
