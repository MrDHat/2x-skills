"""No-model RPC smoke test of actual Pi package discovery in isolated settings."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PI = ROOT / 'node_modules/.bin/pi'


@unittest.skipUnless(PI.exists(), 'npm install is required for the Pi smoke test')
class PiSmokeTests(unittest.TestCase):
    def test_package_loads_ten_skills_and_extension(self):
        with tempfile.TemporaryDirectory() as agent, tempfile.TemporaryDirectory() as cwd:
            Path(agent, 'settings.json').write_text(json.dumps({'packages': [str(ROOT)]}))
            env = {**os.environ, 'PI_CODING_AGENT_DIR': agent, 'PI_OFFLINE': '1'}
            result = subprocess.run(
                [str(PI), '--mode', 'rpc', '--no-session', '--offline'],
                input='{"id":"commands","type":"get_commands"}\n', text=True,
                capture_output=True, cwd=cwd, env=env, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('Failed to load', result.stderr)
            responses = [json.loads(line) for line in result.stdout.split('\n') if line]
            response = next(r for r in responses if r.get('id') == 'commands')
            self.assertTrue(response['success'])
            commands = response['data']['commands']
            own = {c['name'] for c in commands if c.get('sourceInfo', {}).get('source') == str(ROOT)}
            self.assertEqual(own, {
                'fin-2x', 'skill:skill-review', 'skill:secure-github-actions',
                'skill:fix-flaky-tests', 'skill:thermo-nuclear-code-review',
                'skill:create-pr', 'skill:attach-github-assets', 'skill:tool-misses',
                'skill:permissions-analyzer', 'skill:audit-memory', 'skill:pi-cost-analysis',
            })
            # No auth, provider request, watcher, or persistent session was needed.
            self.assertFalse(Path(agent, 'sessions').exists())
