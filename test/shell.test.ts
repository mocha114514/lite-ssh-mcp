/**
 * Unit tests for shell-integration script generation (M0, local only).
 *
 * These assert the generated text and protocol shape. Zsh and Fish scripts are
 * validated as strings only: this M0 host is Windows and no real Zsh/Fish is
 * executed (only Bash is exercised natively by the private M0 check). The tests
 * below cover the corrections: PS0 preservation, the Zsh special-`precmd`
 * wrapper, READY coming from the first prompt hook rather than the bootstrap,
 * and Fish syntax-error handling.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LiteSshError } from '../src/core/errors.js';
import {
  detectShell,
  makeShellBootstrap,
  makeShellProbe,
} from '../src/shell/integration.js';
import { parseMarker } from '../src/shell/protocol.js';

const NONCE = 'abc123';
/** Identifier fragment the generator derives from {@link NONCE}. */
const ID = '__lssh_abc123_';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LiteSshError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw');
}

test('probe is a portable /bin/sh program that ends with CR', () => {
  const probe = makeShellProbe(NONCE);
  assert.ok(probe.endsWith('\r'));
  assert.ok(probe.includes('/bin/sh -c '));
  // Parent process identity must come from /proc, not from $SHELL.
  assert.ok(probe.includes('/proc/$PPID/comm'));
  assert.ok(probe.includes('stty -g'));
  assert.ok(probe.includes('stty -echo'));
  // Both markers are emitted with printable octal escapes.
  assert.ok(probe.includes('STTY;%s'));
  assert.ok(probe.includes('PROBE;%s'));
  assert.ok(probe.includes('\\033]777;LSSH;' + NONCE + ';'));
  assert.ok(probe.includes('\\007'));
});

test('probe rejects unsafe nonces', () => {
  assert.equal(codeOf(() => makeShellProbe('bad;nonce')), 'INVALID_NONCE');
  assert.equal(codeOf(() => makeShellProbe("bad'nonce")), 'INVALID_NONCE');
  assert.equal(codeOf(() => makeShellProbe('')), 'INVALID_NONCE');
});

test('bash prepends BEGIN to the existing PS0 instead of replacing it', () => {
  const script = makeShellBootstrap('bash', NONCE, '');
  // The old PS0 text must survive: our escape is concatenated with "$PS0".
  assert.ok(script.includes("PS0=$'\\033]777;LSSH;" + NONCE + ";BEGIN\\007'\"$PS0\""));
});

test('bash keeps its PROMPT_COMMAND shape and leaves the DEBUG trap alone', () => {
  const script = makeShellBootstrap('bash', NONCE, '');
  assert.ok(script.includes('PROMPT_COMMAND'));
  assert.ok(script.includes(ID + 'pc_array'));
  // Both the string and array branches are generated.
  assert.ok(script.includes('PROMPT_COMMAND=(' + ID + 'precmd'));
  assert.ok(script.includes('PROMPT_COMMAND="' + ID + 'precmd;'));
  assert.ok(!script.includes('trap'));
  assert.ok(!script.includes('.bashrc'));
  assert.ok(!script.includes('exec '));
});

test('bash captures the exit status first and emits READY from the first prompt', () => {
  const script = makeShellBootstrap('bash', NONCE, '');
  // $? is captured on the first statement of the prepended prompt function.
  assert.ok(new RegExp(ID + 'precmd\\(\\) \\{ local ' + ID + 'ec=\\$\\?;').test(script));
  const precmd = script.indexOf(ID + 'precmd() {');
  const ready = script.indexOf('READY;bash');
  const end = script.indexOf('END;%d');
  assert.ok(precmd >= 0);
  assert.ok(ready > precmd, 'READY must be emitted inside the prompt hook, not the bootstrap');
  assert.ok(end > precmd);
  // Exactly one READY site, so the bootstrap never emits it directly.
  assert.equal(script.split('READY;bash').length - 1, 1);
  assert.ok(script.includes(ID + 'ready=0'));
  assert.ok(script.endsWith('fi\r'));
});

test('bash < 4.4 reports UNSUPPORTED and still restores stty', () => {
  const saved = '500:5:bf';
  const script = makeShellBootstrap('bash', NONCE, saved);
  assert.ok(script.includes('UNSUPPORTED;bash_lt_4_4'));
  assert.ok(script.includes('BASH_VERSINFO'));
  assert.ok(script.includes('stty ' + "'" + saved + "'"));
});

test('zsh wraps the existing special precmd so status is captured first', () => {
  const script = makeShellBootstrap('zsh', NONCE, '');
  // The user's special precmd (which runs before precmd_functions) is copied.
  assert.ok(script.includes('functions[' + ID + 'orig_precmd]=$functions[precmd]'));
  // Our own special precmd is genuinely first and captures $? immediately.
  assert.ok(new RegExp('precmd\\(\\) \\{ local ' + ID + 'ec=\\$\\?;').test(script));
  assert.ok(script.includes(ID + 'orig_precmd'));
  // When there is no original, return 0 so a stray status cannot abort the chain.
  assert.ok(script.includes('return 0; }'));
});

test('zsh restores the original status into the saved precmd via if-condition', () => {
  const script = makeShellBootstrap('zsh', NONCE, '');
  // A trivial `return $1` helper is defined...
  assert.ok(script.includes(ID + 'ret() { return $1; }'));
  // ...and invoked in if-condition position, so the saved hook sees the original
  // $? (0 would otherwise come from our own printf) and ERR_EXIT/ERR_RETURN is
  // suppressed for the branch selection.
  assert.ok(
    script.includes(
      'if ' + ID + 'ret "$' + ID + 'ec"; then ' + ID + 'orig_precmd; else ' + ID + 'orig_precmd; fi',
    ),
  );
  // The saved hook's own status is propagated out of our precmd.
  assert.ok(script.includes('fi; return $?; fi;'));
});

test('zsh prepends BEGIN to preexec_functions without touching precmd_functions', () => {
  const script = makeShellBootstrap('zsh', NONCE, '');
  assert.ok(script.includes('typeset -ga preexec_functions'));
  assert.ok(script.includes('preexec_functions=(' + ID + 'preexec $preexec_functions)'));
  assert.ok(script.includes(ID + 'preexec()'));
  assert.ok(!script.includes('precmd_functions='));
  assert.ok(!script.includes('.zshrc'));
});

test('zsh emits READY from the prompt hook, not the bootstrap', () => {
  const script = makeShellBootstrap('zsh', NONCE, '');
  const precmd = script.indexOf('precmd() {');
  const ready = script.indexOf('READY;zsh');
  assert.ok(precmd >= 0);
  assert.ok(ready > precmd);
  assert.equal(script.split('READY;zsh').length - 1, 1);
  assert.ok(script.endsWith('\r'));
});

test('fish uses --on-event handlers so user hooks survive', () => {
  const script = makeShellBootstrap('fish', NONCE, '');
  for (const event of ['fish_preexec', 'fish_postexec', 'fish_posterror', 'fish_prompt']) {
    assert.ok(script.includes('--on-event ' + event), event);
  }
  assert.ok(!script.includes('functions -e'));
  assert.ok(!script.includes('config.fish'));
  assert.ok(script.endsWith('\r'));
});

test('fish posterror emits END once and never a synthetic BEGIN', () => {
  const script = makeShellBootstrap('fish', NONCE, '');
  const posterror = script.slice(script.indexOf('posterror'), script.indexOf('prompt'));
  // Parser-rejected input never ran, so posterror must not open a round.
  assert.ok(!posterror.includes(';BEGIN'));
  // It still reports the (real, non-zero) status as a single END.
  assert.ok(posterror.includes('END;%d'));
  assert.ok(posterror.includes('$' + ID + 'ec'));
  // The round flag is cleared so a following postexec cannot add a second END.
  assert.ok(posterror.includes('set -g ' + ID + 'round 0'));
  // Only the preexec handler is allowed to emit BEGIN.
  const preexec = script.slice(script.indexOf('preexec --on-event'), script.indexOf('postexec'));
  assert.ok(preexec.includes(';BEGIN'));
  assert.equal(script.split(';BEGIN' + '\\007').length - 1, 1);
});

test('fish captures $status before anything else in postexec/posterror', () => {
  const script = makeShellBootstrap('fish', NONCE, '');
  assert.ok(script.includes('postexec --on-event fish_postexec; set -l ' + ID + 'ec $status;'));
  assert.ok(script.includes('posterror --on-event fish_posterror; set -l ' + ID + 'ec $status;'));
});

test('fish emits READY from the first postexec/posterror/prompt', () => {
  const script = makeShellBootstrap('fish', NONCE, '');
  // Once in postexec, once in posterror and once in the prompt fallback.
  assert.equal(script.split('READY;fish').length - 1, 3);
  assert.ok(script.includes(ID + 'prompt --on-event fish_prompt'));
  assert.ok(script.includes(ID + 'ready 0'));
});

test('empty saved stty means no restore command is emitted', () => {
  const script = makeShellBootstrap('bash', NONCE, '');
  assert.ok(!script.includes('stty '));
});

test('saved stty containing a quote is escaped when restored', () => {
  const script = makeShellBootstrap('zsh', NONCE, "500:a'b");
  assert.ok(script.includes("'500:a'\\''b'"));
});

test('detectShell resolves real process names and rejects the rest', () => {
  assert.equal(detectShell('bash'), 'bash');
  assert.equal(detectShell('-zsh'), 'zsh');
  assert.equal(detectShell('/usr/local/bin/fish'), 'fish');
  assert.equal(detectShell('bash\n'), 'bash');
  assert.equal(codeOf(() => detectShell('tcsh')), 'SHELL_INTEGRATION_UNSUPPORTED');
  assert.equal(codeOf(() => detectShell('')), 'SHELL_INTEGRATION_UNSUPPORTED');
});

test('every bootstrap marker carries the nonce and printable escapes', () => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const script = makeShellBootstrap(shell, NONCE, '');
    assert.ok(script.includes('\\033]777;LSSH;' + NONCE + ';'), shell);
    assert.ok(script.includes('\\007'), shell);
  }
});

test('F03 parseMarker preserves legacy END shape and decodes explicit hook health', () => {
  assert.deepEqual(parseMarker('LSSH;test;END;0', 'test'), {
    nonce: 'test',
    kind: 'end',
    exitCode: 0,
  });
  assert.deepEqual(parseMarker('LSSH;test;END;0;1', 'test'), {
    nonce: 'test',
    kind: 'end',
    exitCode: 0,
    hookHealthy: true,
  });
  assert.deepEqual(parseMarker('LSSH;test;END;0;0', 'test'), {
    nonce: 'test',
    kind: 'end',
    exitCode: 0,
    hookHealthy: false,
  });
  assert.deepEqual(parseMarker('LSSH;test;END;130;1', 'test'), {
    nonce: 'test',
    kind: 'end',
    exitCode: 130,
    hookHealthy: true,
  });
});

test('F03 bash bootstrap checks installed PS0 prefix for hook health without promptvars dependency', () => {
  const script = makeShellBootstrap('bash', NONCE, '');
  assert.ok(!script.includes('shopt -q promptvars'));
  assert.ok(script.includes('local ' + ID + 'ps0="${PS0-}";'));
  assert.ok(script.includes('"${' + ID + 'ps0#$\'\\033]777;LSSH;' + NONCE + ';BEGIN\\007\'}" != "$' + ID + 'ps0"'));
  assert.ok(script.includes('END;%d;%d'));
});

test('F03 zsh bootstrap checks function definition and preexec_functions binding for hook health', () => {
  const script = makeShellBootstrap('zsh', NONCE, '');
  assert.ok(script.includes('$+functions[' + ID + 'preexec]'));
  assert.ok(script.includes('preexec_functions[(Ie)' + ID + 'preexec]'));
  assert.ok(script.includes('END;%d;%d'));
});

test('F03 fish bootstrap checks function definition and on-event binding for hook health', () => {
  const script = makeShellBootstrap('fish', NONCE, '');
  assert.ok(script.includes('functions -q ' + ID + 'preexec'));
  assert.ok(script.includes("string match -q -r '^function[[:space:]]+.*--on-event[[:space:]]+fish_preexec' (functions " + ID + 'preexec 2>/dev/null)'));
  assert.ok(script.includes('END;%d;%d'));
});
