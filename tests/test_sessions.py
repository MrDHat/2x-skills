import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sessions', ROOT / 'pi/scripts/sessions.py')
sessions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sessions)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def session(self, entries, name='test.jsonl'):
        path = self.root / name
        path.write_text('\n'.join(json.dumps(e) for e in entries))
        return path

    def call(self, id='a', parent=None):
        return {'type': 'message', 'id': id, 'parentId': parent, 'message': {'role': 'assistant', 'content': [{'type': 'toolCall', 'name': 'bash', 'id': 'c', 'arguments': {'command': 'jq --version'}}]}}

    def result(self, parent='a', error=True, output='bash: jq: command not found'):
        return {'type': 'message', 'id': 'b', 'parentId': parent, 'message': {'role': 'toolResult', 'toolName': 'bash', 'toolCallId': 'c', 'isError': error, 'content': [{'type': 'text', 'text': output}]}}

    def test_failed_ancestor_pairs_only(self):
        self.assertEqual(len(sessions.bash_pairs(self.session([self.call(), self.result()]))), 1)
        self.assertEqual(sessions.bash_pairs(self.session([self.call(), self.result(parent=None)])), [])
        self.assertEqual(sessions.bash_pairs(self.session([self.call(), self.result(error=False)])), [])
        self.assertEqual(len(sessions.bash_pairs(self.session([self.call(), self.result(error=False, output='bash: jq: command not found\nCommand exited with code 127')]))), 1)

    def test_miss_report_ignores_success_and_prose(self):
        with patch.dict(os.environ, {'PI_CODING_AGENT_DIR': str(self.root)}):
            path = self.session([self.call(), self.result()])
            self.assertIn('jq', sessions.misses([path])['missing_tools'])
            path = self.session([self.call(), self.result(output='docs say jq: command not found')])
            self.assertEqual(sessions.misses([path])['missing_tools'], {})

    def test_costs_include_usage_summaries_and_deduplicate_forks(self):
        usage = {'input': 100, 'output': 2, 'cost': {'total': 0.2}}
        entries = [
            {'type': 'message', 'id': 'a', 'message': {'role': 'assistant', 'provider': 'p', 'model': 'm', 'usage': usage}},
            {'type': 'usage', 'id': 'b', 'provider': 'p', 'model': 'm', 'usage': usage},
            {'type': 'compaction', 'id': 'c', 'usage': {'input': 10}},
            {'type': 'branch_summary', 'id': 'd', 'usage': usage},
        ]
        a = self.session(entries)
        b = self.session(entries, 'fork.jsonl')
        groups = sessions.costs([a, b])['models']
        self.assertEqual(groups['p/m']['requests'], 2)
        self.assertAlmostEqual(groups['p/m']['recorded_cost_usd'], 0.4)
        self.assertEqual(groups['unattributed/unattributed']['missing_cost_records'], 1)

    def test_memory_root_never_falls_back_or_follows_symlinks(self):
        with self.assertRaises(ValueError):
            sessions.memories(self.root / 'missing')
        (self.root / 'note.md').write_text('claim')
        (self.root / 'alias.md').symlink_to(self.root / 'note.md')
        self.assertEqual(len(sessions.memories(self.root)['files']), 1)

    def test_custom_agent_dir(self):
        with patch.dict(os.environ, {'PI_CODING_AGENT_DIR': str(self.root)}):
            self.assertEqual(sessions.agent_dir(), self.root)
