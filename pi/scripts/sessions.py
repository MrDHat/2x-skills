#!/usr/bin/env python3
"""Read-only Pi session reports. No network calls, model calls, or config writes."""
import argparse
import importlib.util
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('detector', ROOT / 'plugins/claude-code-tools/skills/tool-misses/scripts/detect-tool-misses.py')
detector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(detector)


def agent_dir():
    return Path(os.environ.get('PI_CODING_AGENT_DIR', '~/.pi/agent')).expanduser()


def records(path):
    with path.open(encoding='utf-8') as stream:
        for number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise ValueError('expected an object')
                yield item
            except (ValueError, TypeError) as error:
                print(f'Warning: {path}:{number}: {error}', file=sys.stderr)


def files(root, days):
    if not root.is_dir():
        raise ValueError(f'Session root is not a directory: {root}')
    cutoff = time.time() - days * 86400
    return sorted(p for p in root.rglob('*.jsonl') if p.stat().st_mtime >= cutoff)


def text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def bash_pairs(path):
    """Match results against ancestor calls, not an unrelated abandoned branch."""
    entries = {}
    pairs = []
    for entry in records(path):
        message = entry.get('message', {})
        if entry.get('type') == 'message' and message.get('role') == 'toolResult' and message.get('toolName') == 'bash':
            output = text(message.get('content'))
            failed = message.get('isError') or bool(re.search(r'(?:^|\n)Command exited with code [1-9]\d*', output))
            if failed:
                ancestor = entry.get('parentId')
                visited = set()
                while ancestor in entries and ancestor not in visited:
                    visited.add(ancestor)
                    parent = entries[ancestor]
                    pm = parent.get('message', {})
                    blocks = pm.get('content', [])
                    match = next((b for b in blocks if isinstance(b, dict) and b.get('type') == 'toolCall' and b.get('name') == 'bash' and b.get('id') == message.get('toolCallId')), None) if isinstance(blocks, list) else None
                    if match:
                        pairs.append({'command': match.get('arguments', {}).get('command', ''), 'output': output, 'file': str(path), 'tool_use_id': message.get('toolCallId')})
                        break
                    ancestor = parent.get('parentId')
        if entry.get('id'):
            entries[entry['id']] = entry
    return pairs


def misses(paths):
    pairs = [pair for path in paths for pair in bash_pairs(path)]
    # Reuse the Claude detector's formula database and BSD/GNU patterns.
    # Keep only structured shell diagnostic lines to avoid prose false positives.
    diagnostic = re.compile(r'^\s*(?:[\w./-]+: |line \d+: )*(?:[A-Za-z_][\w.-]*: command not found|command not found: [A-Za-z_][\w.-]*)\s*$')
    missing_pairs = [{**pair, 'output': '\n'.join(line for line in pair['output'].splitlines() if diagnostic.fullmatch(line))} for pair in pairs]
    ignored_path = agent_dir() / 'fin-2x/tool-misses-ignored.json'
    ignored = set(json.loads(ignored_path.read_text()).get('ignored', [])) if ignored_path.exists() else set()
    missing = detector.detect_missing_tools(missing_pairs)
    wrong = detector.detect_wrong_version(pairs)
    return {'missing_tools': {k: v for k, v in missing.items() if k not in ignored}, 'wrong_version_tools': {k: v for k, v in wrong.items() if k not in ignored}, 'ignored_tools': sorted(ignored), 'ignore_file': str(ignored_path), 'files_scanned': len(paths), 'failed_pairs_analyzed': len(pairs)}


def costs(paths, cutoff=None):
    groups = defaultdict(lambda: {'usage_records': 0, 'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'recorded_cost_usd': 0, 'missing_cost_records': 0, 'missing_timestamp_records': 0})
    seen = set()
    for path in paths:
        for entry in records(path):
            message = entry.get('message', {})
            source = message if entry.get('type') == 'message' else entry
            usage = source.get('usage')
            if not isinstance(usage, dict):
                continue
            timestamp = entry.get('timestamp', source.get('timestamp'))
            try:
                epoch = timestamp / 1000 if isinstance(timestamp, (int, float)) else datetime.fromisoformat(timestamp.replace('Z', '+00:00')).timestamp()
            except (AttributeError, ValueError, TypeError):
                epoch = None
            if cutoff is not None and epoch is not None and epoch < cutoff:
                continue
            # Forks copy entry IDs: count copied history once across the report.
            identity = (entry.get('id'), entry.get('timestamp'), json.dumps(usage, sort_keys=True))
            if entry.get('id') and identity in seen:
                continue
            seen.add(identity)
            key = f"{source.get('provider', 'unattributed')}/{source.get('model', 'unattributed')}"
            group = groups[key]
            group['usage_records'] += 1
            if epoch is None:
                group['missing_timestamp_records'] += 1
            for field in ('input', 'output', 'cacheRead', 'cacheWrite'):
                group[field] += usage.get(field, 0) or 0
            total = (usage.get('cost') or {}).get('total')
            if isinstance(total, (int, float)):
                group['recorded_cost_usd'] += total
            else:
                group['missing_cost_records'] += 1
    return {'scope': 'all recorded branches; copied fork history deduplicated', 'models': dict(groups), 'files_scanned': len(paths), 'note': 'Recorded estimates, not invoices. Missing prices are unknown, not free. Summary usage without model attribution is grouped as unattributed.'}


def memories(root):
    if not root.is_dir():
        raise ValueError(f'Memory root is not a directory: {root}')
    found = []
    for path in sorted(root.rglob('*.md')):
        # Do not traverse symlinked files outside the approved corpus.
        resolved = path.resolve()
        if not resolved.is_relative_to(root.resolve()) or path.is_symlink():
            continue
        found.append({'path': str(path), 'bytes': path.stat().st_size, 'modified': path.stat().st_mtime})
    return {'root': str(root.resolve()), 'files': found, 'note': 'Inventory only. Verify claims against the named repositories before proposing changes.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', choices=('misses', 'costs', 'memories'))
    parser.add_argument('--root', type=Path, help='Explicit session or memory root')
    parser.add_argument('--days', type=int, default=14)
    args = parser.parse_args()
    if args.days <= 0:
        parser.error('--days must be positive')
    root = args.root.expanduser() if args.root else Path(os.environ.get('PI_CODING_AGENT_SESSION_DIR', str(agent_dir() / 'sessions'))).expanduser()
    if args.report == 'memories' and not args.root:
        parser.error('memories requires --root; Pi has no built-in saved-memory store')
    try:
        result = memories(root) if args.report == 'memories' else {'root': str(root.resolve()), **(misses(files(root, args.days)) if args.report == 'misses' else costs(files(root, args.days), cutoff=time.time() - args.days * 86400)), 'days': args.days}
        json.dump(result, sys.stdout, indent=2)
        print()
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
