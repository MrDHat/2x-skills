import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    def test_manifest_resources_exist(self):
        manifest = json.loads((ROOT / 'package.json').read_text())['pi']
        for kind, paths in manifest.items():
            for path in paths:
                resource = ROOT / path
                self.assertTrue(resource.exists(), path)
                if kind == 'skills':
                    self.assertTrue(list(resource.rglob('SKILL.md')), path)

    def test_shared_executable_examples_are_portable(self):
        for name in ('create-pr', 'attach-github-assets'):
            folder = ROOT / 'plugins/pr-tools/skills' / name
            text = (folder / 'SKILL.md').read_text()
            for block in text.split('```bash\n')[1:]:
                code = block.split('```')[0]
                self.assertNotIn('CLAUDE_PLUGIN_ROOT', code)
            self.assertTrue((folder / 'scripts').is_dir())

    def test_claude_plugins_still_present(self):
        marketplace = json.loads((ROOT / '.claude-plugin/marketplace.json').read_text())
        self.assertTrue(marketplace['plugins'])
        for plugin in marketplace['plugins']:
            self.assertTrue((ROOT / plugin['source'] / '.claude-plugin/plugin.json').exists())
