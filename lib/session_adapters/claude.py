def normalize(payload, harness):
    latest = payload.get('latest_usage', {})
    fields = ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens')
    values = [latest.get(k) for k in fields] if isinstance(latest, dict) else []
    used = sum(values) if len(values) == 4 and all(type(v) is int and v >= 0 for v in values) else None
    kind = {'PreCompact': 'before_compact', 'SessionStart': 'resume', 'Stop': 'usage'}.get(payload.get('hook_event_name'))
    return used, payload.get('context_window'), kind, payload.get('session_id')


def render(checkpoint, receipt):
    import json
    return {'hookSpecificOutput': {'hookEventName': 'SessionStart',
            'additionalContext': json.dumps({'checkpoint': checkpoint, 'receipt': receipt}, sort_keys=True)}}
