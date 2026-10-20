import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShellBootstrap } from '../src/shell/integration.js';

const nonce = 'p2_nounset';

// These assertions cover the actual installation expressions, not the already
// nounset-safe PS0 health check in the prompt hook. Real Bash execution is also
// exercised in the scoped synthetic validation, without changing login files.
test('F11 BEGIN installation treats an unset PS0 as empty without losing existing text', () => {
  const script = makeShellBootstrap('bash', nonce, '');
  assert.ok(script.includes(
    "PS0=$'\\033]777;LSSH;" + nonce + ";BEGIN;1\\007'\"${PS0-}\""
  ));
});

test('F11 scalar PROMPT_COMMAND capture tolerates nounset and an unset variable', () => {
  const script = makeShellBootstrap('bash', nonce, '');
  assert.ok(script.includes('pc_old="${PROMPT_COMMAND-}"'));
  assert.ok(!script.includes('pc_old="$PROMPT_COMMAND"'));
});

test('F11 retains array capture, status-first hooks and no permanent configuration writes', () => {
  const script = makeShellBootstrap('bash', nonce, '');
  assert.ok(script.includes('pc_old=("${PROMPT_COMMAND[@]}")'));
  assert.ok(script.includes('precmd() { local __lssh_' + nonce + '_ec=$?;'));
  assert.ok(!script.includes('trap'));
  assert.ok(!script.includes('.bashrc'));
  assert.ok(!script.includes('exec '));
});
