def normalize(payload, harness):
    if harness == 'acp':
        update = payload.get('update', {})
        if not isinstance(update, dict):
            update = {}
        return update.get('used'), update.get('size'), ('usage' if update.get('sessionUpdate') == 'usage_update' else None), payload.get('sessionId')
    kind = {'PreCompact': 'before_compact', 'SessionStart': 'resume', 'Stop': 'usage'}.get(payload.get('hookEventName'))
    return None, None, kind, payload.get('sessionId')


def render(checkpoint, receipt):
    # Passive hook stdout is not recovery delivery.
    return None
