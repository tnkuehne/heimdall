"""Isolated tests: no real T3 chats, providers, recorder settings, or Git operations."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('post-transcribe')
loader = importlib.machinery.SourceFileLoader('t3_meeting_review', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
hook = importlib.util.module_from_spec(spec)
loader.exec_module(hook)


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'notes project'
        self.project.mkdir()
        (self.project / 'existing.md').write_text('Unrelated work\n')
        self.state_dir = self.root / 'state'
        self.state_dir.mkdir()
        self.config = self.root / 'config.json'
        self.settings = {'project_path': str(self.project), 'state_directory': str(self.state_dir)}
        self.config.write_text(json.dumps(self.settings))
        self.review = hook.MeetingReview(self.config)
        self.source = self.root / 'custom output ä.transcript.md'
        self.source.write_text('A short but useful meeting.\n', encoding='utf-8')
        self.state = self.state_dir / (self.review.key(self.source) + '.json')
        self.response = {'threadId': 'test-thread', 'link': 'https://example.invalid/threads/test-thread'}

    def launch(self):
        with patch.object(self.review, 't3', side_effect=[[], self.response]):
            return self.review.launch(self.source)

    def test_prompt_and_start_arguments(self):
        with patch.object(self.review, 't3', side_effect=[[], self.response]) as t3:
            self.assertIn(self.response['link'], self.review.launch(self.source))
        args = t3.call_args.args
        self.assertEqual(args[0], 'start')
        self.assertEqual(args[-2:], (str(self.project), '-'))
        self.assertNotIn('--wait', args)
        prompt = t3.call_args.kwargs['prompt']
        self.assertIn(str(self.source), prompt)
        self.assertIn('NOT approval', prompt)
        self.assertIn('explicit approval', prompt)
        self.assertNotIn('{{CONTEXT}}', prompt)
        self.assertEqual((self.project / 'existing.md').read_text(), 'Unrelated work\n')
        self.assertEqual(list(self.project.iterdir()), [self.project / 'existing.md'])

    def test_repeat_and_updated_source_do_not_start_or_message_another_chat(self):
        self.launch()
        with patch.object(self.review, 't3', side_effect=AssertionError('Unexpected T3 call')):
            self.assertIn(self.response['link'], self.review.launch(self.source))
            self.source.write_text('Updated transcript.\n')
            self.assertIn('Transcript changed', self.review.launch(self.source))

    def test_same_basename_in_other_directory_has_distinct_identity(self):
        other = self.root / 'other' / self.source.name
        other.parent.mkdir()
        other.write_bytes(self.source.read_bytes())
        self.assertNotEqual(self.review.key(self.source), self.review.key(other))

    def test_unreachable_t3_leaves_no_launch_record(self):
        failure = subprocess.CalledProcessError(1, ['t3'], stderr='server unreachable')
        with patch.object(self.review, 't3', side_effect=failure):
            with self.assertRaises(subprocess.CalledProcessError):
                self.review.launch(self.source)
        self.assertFalse(self.state.exists())

    def test_lost_launch_reply_is_recovered_by_title(self):
        failure = subprocess.TimeoutExpired(['t3', 'thread', 'start'], 90)
        with patch.object(self.review, 't3', side_effect=[[], failure]):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.review.launch(self.source)
        saved = json.loads(self.state.read_text())
        self.assertEqual(saved['status'], 'uncertain')
        recovered = dict(self.response, title=saved['title'])
        with patch.object(self.review, 't3', return_value=[recovered]) as t3:
            self.assertIn(self.response['link'], self.review.launch(self.source))
        self.assertEqual(t3.call_count, 1)
        self.assertEqual(json.loads(self.state.read_text())['status'], 'started')

    def test_unknown_outcome_blocks_a_second_launch(self):
        with patch.object(self.review, 't3', side_effect=[[], {}]):
            with self.assertRaisesRegex(ValueError, 'no threadId'):
                self.review.launch(self.source)
        with patch.object(self.review, 't3', return_value=[]) as t3:
            with self.assertRaisesRegex(RuntimeError, 'unknown outcome'):
                self.review.launch(self.source)
        self.assertEqual(t3.call_count, 1)

    def test_link_lookup_happens_after_persisting_thread_id(self):
        def t3(*args, **kwargs):
            if args[0] == 'list':
                return []
            if args[0] == 'start':
                return {'threadId': 'test-thread'}
            self.assertEqual(args, ('show', 'test-thread', '--messages', '0'))
            self.assertEqual(json.loads(self.state.read_text())['status'], 'started')
            return {'thread': self.response}
        with patch.object(self.review, 't3', side_effect=t3):
            self.assertIn(self.response['link'], self.review.launch(self.source))

    def test_failed_link_lookup_keeps_launch_record(self):
        failure = subprocess.CalledProcessError(1, ['t3', 'thread', 'show'])
        with patch.object(self.review, 't3', side_effect=[[], {'threadId': 'test-thread'}, failure]):
            self.assertIn('test-thread', self.review.launch(self.source))
        self.assertEqual(json.loads(self.state.read_text())['status'], 'started')

    def test_dry_run_and_empty_transcript_never_call_t3(self):
        with patch.object(self.review, 't3', side_effect=AssertionError('Unexpected T3 call')):
            self.assertIn('Dry run', self.review.launch(self.source, dry_run=True))
            self.source.write_text(' \n')
            self.assertIn('Skipped', self.review.launch(self.source))
        self.assertFalse(self.state.exists())

    def test_notes_path_cannot_escape_project(self):
        for directory in ('../outside', str(self.root)):
            self.config.write_text(json.dumps(dict(self.settings, notes_directory=directory)))
            with self.assertRaises(ValueError):
                hook.MeetingReview(self.config)
        (self.project / 'link').symlink_to(self.root, target_is_directory=True)
        self.config.write_text(json.dumps(dict(self.settings, notes_directory='link')))
        with self.assertRaisesRegex(ValueError, 'link outside'):
            hook.MeetingReview(self.config)

    def test_subprocess_uses_stdin_and_expands_t3_home(self):
        self.review.t3_home = '~/.t3'
        with patch.object(hook.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{}')) as run:
            self.review.t3('start', str(self.project), '-', prompt='literal $(touch never)')
        self.assertEqual(run.call_args.kwargs['input'], 'literal $(touch never)')
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertIn(str(Path.home() / '.t3'), run.call_args.args[0])

    def fake_cli(self):
        binary = self.root / 'fake-t3'
        binary.write_text('#!' + sys.executable + '\n' + '''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ['FAKE_T3_CALLS']).open('a') as calls:
    calls.write(json.dumps({'args': args, 'input': sys.stdin.read()}) + '\\n')
if os.environ.get('FAKE_T3_FAIL'):
    print('T3 unavailable', file=sys.stderr)
    sys.exit(1)
if args[1] == 'list':
    print('[]')
elif args[1] == 'start':
    print(json.dumps({'threadId': 'fake-thread', 'runId': 'fake-run'}))
elif args[1] == 'show':
    print(json.dumps({'thread': {'link': 'https://example.invalid/fake-thread'}}))
else:
    sys.exit(2)
''')
        binary.chmod(0o700)
        self.config.write_text(json.dumps(dict(self.settings, t3_binary=str(binary))))
        env = dict(os.environ, MEETING_RECORDER_TRANSCRIPT_FILE=str(self.source),
                   MEETING_RECORDER_AUDIO_FILE=str(self.root / 'recording.mp3'),
                   FAKE_T3_CALLS=str(self.root / 'calls.jsonl'))
        return env

    def test_executable_hook_environment_logs_and_duplicate_protection(self):
        env = self.fake_cli()
        for _ in range(2):
            result = subprocess.run([str(SCRIPT), '--config', str(self.config)], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual([call['args'][1] for call in calls], ['list', 'start', 'show'])
        self.assertIn(env['MEETING_RECORDER_AUDIO_FILE'], calls[1]['input'])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        log = self.state.with_suffix('.log')
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertIn('https://example.invalid/fake-thread', log.read_text())
        self.assertEqual(self.source.read_text(), 'A short but useful meeting.\n')

    def test_executable_failure_is_logged_without_launch_record(self):
        env = dict(self.fake_cli(), FAKE_T3_FAIL='1')
        result = subprocess.run([str(SCRIPT), '--config', str(self.config)], env=env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.state.exists())
        self.assertIn('T3 unavailable', self.state.with_suffix('.log').read_text())


if __name__ == '__main__':
    unittest.main(verbosity=2)
