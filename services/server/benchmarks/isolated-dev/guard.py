#!/usr/bin/env python3
"""Verify the fixed dev endpoint before/during a benchmark; performs only GETs."""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone

BASE = 'https://relayer.dev.memwal.ai'

def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f]{40}', sys.argv[1]):
        raise SystemExit('Usage: python3 guard.py FULL_40_CHARACTER_COMMIT_SHA')
    expected = sys.argv[1]
    responses = {}
    for path in ('/version', '/health'):
        result = subprocess.run(
            ['curl', '--fail', '--silent', '--show-error', '--max-time', '20', BASE + path],
            capture_output=True, text=True, check=True,
        )
        responses[path] = json.loads(result.stdout)
    version, health = responses['/version'], responses['/health']
    actual = version.get('build', {}).get('commit')
    health_commit = health.get('build', {}).get('commit')
    ok = (actual == expected and health_commit == expected
          and health.get('write_ready') is True and health.get('writes') == 'ok')
    print(json.dumps({'checked_at': datetime.now(timezone.utc).isoformat(),
                     'endpoint': BASE, 'expected_commit': expected,
                     'version_commit': actual, 'health_commit': health_commit,
                     'write_ready': health.get('write_ready'),
                     'writes': health.get('writes'), 'ok': ok}, indent=2))
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main())
