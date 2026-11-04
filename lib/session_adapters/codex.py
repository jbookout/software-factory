def normalize(payload, harness):
    if harness == 'app-server':
        usage = payload.get('tokenUsage', {})
        required = ('cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens')
        valid = isinstance(usage, dict) and all(
            isinstance(usage.get(part), dict) and all(type(usage[part].get(k)) is int and usage[part][k] >= 0 for k in required)
            for part in ('last', 'total'))
        valid = valid and isinstance(payload.get('turnId'), str)
        return (usage['last']['totalTokens'] if valid else None,
                usage.get('modelContextWindow') if isinstance(usage, dict) else None,
                'usage', payload.get('threadId'))
    info = payload.get('info', {})
    last = info.get('last_token_usage', {}) if isinstance(info, dict) else {}
    kind = {'PreCompact': 'before_compact', 'SessionStart': 'resume', 'token_count': 'usage'}.get(payload.get('hook_event_name'))
    return (last.get('total_tokens') if isinstance(last, dict) else None,
            info.get('model_context_window') if isinstance(info, dict) else None,
            kind, payload.get('session_id'))


def render(checkpoint, receipt):
    # App-server usage notifications do not define a recovery injection response.
    return None
