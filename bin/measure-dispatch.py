#!/usr/bin/env python3
"""Count synthetic preparation exchange bytes. Excludes the unchanged T3 delegation."""
import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
from test_coordinator_dispatch import DispatchTest


def measure():
    fixture = DispatchTest()
    fixture.setUp()
    try:
        result = fixture.run_cli()
        if result.returncode:
            raise RuntimeError(result.stderr)
        card, path = result.stdout.strip().split(' ', 1)
        brief = Path(path).read_text()
        assert (fixture.archive / Path(path).name).read_text() == brief
        assert len(fixture.calls()) == 1
        assert card == fixture.reply['card_id']
        before = [
            {'command': fixture.calls()[0], 'output': fixture.reply},
            {'write': path, 'content': brief,
             'copy_to': str(fixture.archive / Path(path).name), 'output': 'brief copies written'},
        ]
        after = {'request': fixture.request, 'command': fixture.command(), 'output': result.stdout}
        size = lambda value: len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())
        return size(before), size(after)
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    runs = [measure() for _ in range(5)]
    print(json.dumps({'unit': 'UTF-8 bytes of compact JSON synthetic preparation exchanges',
                      'before': statistics.median(x for x, _ in runs),
                      'after': statistics.median(y for _, y in runs), 'runs': runs,
                      'errors': 0, 'successful_mints': 5,
                      'scope': 'Includes request-file contents and command arguments; excludes unchanged T3 delegation, model envelopes, hooks, and server-internal traffic. Not tokens, quota or latency.'}, indent=2))
