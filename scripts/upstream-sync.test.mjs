import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Exercise the actual workflow shell with real disposable Git repositories.
// Only the GitHub PR API is stubbed; no network or project Git writes occur.
const workflow = readFileSync(new URL('../.github/workflows/upstream-sync.yml', import.meta.url), 'utf8');
const script = workflow.split('        run: |\n')[1].split('\n  validate:')[0]
  .split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');

function fixture(t, { conflict = false, current = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(seed, 'shared.txt'), 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'base');
  const upstream = join(root, 'upstream.git');
  const origin = join(root, 'origin.git');
  git(root, 'clone', '--bare', seed, upstream);
  if (!current) {
    writeFileSync(join(seed, conflict ? 'shared.txt' : 'upstream.txt'), 'upstream\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'upstream');
    git(seed, 'push', upstream, 'main');
    git(seed, 'reset', '--hard', 'HEAD~1');
  }
  writeFileSync(join(seed, conflict ? 'shared.txt' : 'fork.txt'), 'fork\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'fork');
  git(root, 'clone', '--bare', seed, origin);
  const checkout = join(root, 'checkout');
  git(root, 'clone', origin, checkout);
  const main = git(origin, 'rev-parse', 'main');
  const tip = git(upstream, 'rev-parse', 'main');
  const branch = `codex/upstream-${tip.slice(0, 12)}`;
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/bash', 'set -eu', 'if [[ "$2" == list ]]; then',
    '  printf "%s" "${TEST_EXISTING_PR:-}"', 'else',
    '  printf "%s\\n" "$@" > "$RUNNER_TEMP/pr-args"',
    '  if [[ "${TEST_FAIL_CREATE:-}" == 1 ]]; then exit 1; fi',
    '  echo "https://example.invalid/pull/1"', 'fi', '',
  ].join('\n'), { mode: 0o755 });
  const run = (extra = {}) => {
    // Each Actions retry starts from a fresh checkout of fork main.
    git(checkout, 'checkout', 'main');
    writeFileSync(join(root, 'summary'), '');
    writeFileSync(join(root, 'output'), '');
    return spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
      cwd: checkout, encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${env.PATH}`, RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: join(root, 'summary'), GITHUB_OUTPUT: join(root, 'output'),
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${upstream}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/hardbeat920/monocode.git', ...extra },
    });
  };
  return { root, git, checkout, origin, upstream, main, tip, branch, run,
    read: (name) => readFileSync(join(root, name), 'utf8') };
}

test('already included upstream does not create a proposal', (t) => {
  const f = fixture(t, { current: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.read('summary'), /Already includes upstream/);
  assert.equal(f.read('output'), '');
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), f.main);
});

test('clean merge preserves both histories and validates the exact pushed commit', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const merge = f.git(f.origin, 'rev-parse', f.branch);
  assert.equal(f.git(f.origin, 'rev-parse', `${merge}^1`), f.main);
  assert.equal(f.git(f.origin, 'rev-parse', `${merge}^2`), f.tip);
  assert.equal(f.read('output'), `commit=${merge}\n`);
  assert.doesNotMatch(f.read('pr-args'), /--draft/);
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), f.main);
});

test('conflicts create an actionable draft without validation or changes to main', (t) => {
  const f = fixture(t, { conflict: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(f.origin, 'rev-parse', f.branch), f.tip);
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), f.main);
  assert.equal(f.read('output'), '');
  assert.match(f.read('pr-args'), /--draft/);
  assert.match(f.read('upstream-pr.md'), /No merged commit was produced or validated/);
  assert.match(f.read('upstream-pr.md'), /shared.txt/);
  assert.match(f.read('summary'), /shared.txt/);
  assert.equal(f.git(f.checkout, 'status', '--porcelain'), '');
});

test('existing proposal is preserved, including human branch changes', (t) => {
  const f = fixture(t);
  f.git(f.checkout, 'push', 'origin', `HEAD:refs/heads/${f.branch}`);
  const result = f.run({ TEST_EXISTING_PR: 'https://example.invalid/pull/1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(f.origin, 'rev-parse', f.branch), f.main);
  assert.equal(f.read('output'), '');
  assert.match(f.read('summary'), /Existing proposal/);
});

test('failed PR creation stays failed and retry recovers without rewriting branch', (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ TEST_FAIL_CREATE: '1' }).status, 0);
  assert.equal(f.read('output'), '');
  const pushed = f.git(f.origin, 'rev-parse', f.branch);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git(f.origin, 'rev-parse', f.branch), pushed);
  assert.match(f.read('pr-args'), /--draft/);
  assert.equal(f.read('output'), '');
});

test('fetch failures stay failed instead of becoming conflict drafts', (t) => {
  const f = fixture(t);
  rmSync(f.upstream, { recursive: true, force: true });
  assert.notEqual(f.run().status, 0);
  assert.equal(f.read('output'), '');
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), f.main);
});

test('all signing and publishing gates exclude reusable proposal refs', () => {
  const build = readFileSync(new URL('../.github/workflows/fork-build.yml', import.meta.url), 'utf8');
  const gates = build.split('\n').filter((line) => line.includes("github.ref == 'refs/heads/main'"));
  assert.equal(gates.length, 5);
  for (const gate of gates) assert.ok(gate.includes("inputs.ref == ''"), gate);
});
