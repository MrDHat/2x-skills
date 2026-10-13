import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'plugins/pr-tools/scripts/pr-check-watcher.sh'
MOCK = r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
mode = os.environ['MODE']
with open('calls.jsonl', 'a') as stream:
    stream.write(json.dumps(args) + '\n')
endpoint = next((arg for arg in args if arg.startswith('repos/')), '')
if '/pulls/' in endpoint:
    calls = Path('head-count')
    count = int(calls.read_text()) if calls.exists() else 0
    calls.write_text(str(count + 1))
    print('old' if mode == 'push' and count == 0 else 'new')
    sys.exit()
if 'check-runs' in endpoint:
    run = {'name': 'test', 'status': 'completed', 'conclusion': 'action_required' if mode == 'unknown' else 'success', 'html_url': 'https://example.test'}
    body = {'total_count': 2 if mode == 'pages' else 1, 'check_runs': [run]}
    if '--paginate' in args:
        bad = {**run, 'name': 'second', 'conclusion': 'failure'}
        print(json.dumps([body, {'total_count': 2, 'check_runs': [bad]}]))
        sys.exit()
else:
    body = {'total_count': 0, 'statuses': []}
if mode == 'error' and '/status' in endpoint:
    print('HTTP/2.0 503 Service Unavailable\n\n{}')
else:
    print('HTTP/2.0 200 OK\n\n' + json.dumps(body))
'''


@unittest.skipUnless(shutil.which('jq'), 'jq is required for shell watcher regression tests')
class CheckWatcherTests(unittest.TestCase):
    def run_watcher(self, mode, cursor=''):
        with tempfile.TemporaryDirectory() as directory:
            gh = Path(directory, 'gh')
            gh.write_text(f'#!{sys.executable}\n' + MOCK)
            gh.chmod(0o755)
            result = subprocess.run(
                ['bash', str(SCRIPT), 'https://github.com/MrDHat/2x-skills/pull/3', cursor],
                cwd=directory, env={**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'MODE': mode, 'WATCH_MAX_WAIT': '1', 'WATCH_INTERVAL': '0'},
                capture_output=True, text=True, timeout=10,
            )
            calls = [json.loads(line) for line in Path(directory, 'calls.jsonl').read_text().splitlines()]
            return result, calls

    def test_header_without_etag_does_not_crash(self):
        result, _ = self.run_watcher('success')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('All 1 checks completed successfully', result.stdout)

    def test_unrecognized_completed_conclusion_is_not_green(self):
        result, _ = self.run_watcher('unknown')
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertIn('action_required', result.stdout)

    def test_new_head_invalidates_old_check_state(self):
        result, calls = self.run_watcher('push')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        endpoints = [arg for call in calls for arg in call if '/commits/' in arg]
        self.assertTrue(endpoints)
        self.assertTrue(all('/commits/new/' in arg for arg in endpoints))

    def test_resumption_fetches_bodies_before_using_etags(self):
        result, calls = self.run_watcher('success', '"runs"|||"statuses"')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertFalse(any('If-None-Match' in arg for call in calls for arg in call))

    def test_failed_endpoint_never_produces_green(self):
        result, _ = self.run_watcher('error')
        self.assertEqual(result.returncode, 3, result.stderr + result.stdout)
        self.assertNotIn('completed successfully', result.stdout)

    def test_failure_on_later_page_is_not_ignored(self):
        result, _ = self.run_watcher('pages')
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertIn('second: failure', result.stdout)
