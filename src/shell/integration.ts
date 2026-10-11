/**
 * Shell-integration script generation.
 *
 * The flow is: (1) run a portable `/bin/sh -c ...` probe from the interactive
 * shell to learn the real shell process and save `stty -g`; (2) install
 * temporary, process-local hooks for that shell; (3) emit READY at the first
 * genuine prompt transition (never directly from the bootstrap), then BEGIN on
 * each command start and END with the real exit status on each command end.
 *
 * Guarantees and deliberate limits (M0):
 *  - Nothing permanent is written: no `.bashrc`/`.zshrc`/`fish` config files
 *    are created or modified, and the shell is never replaced.
 *  - Existing user hooks are preserved. Bash keeps its string/array
 *    PROMPT_COMMAND, its PS0 text and its DEBUG trap; Zsh keeps its special
 *    `preexec`, its `preexec_functions` and every `precmd_functions` entry, and
 *    its special `precmd` is copied and still invoked; Fish keeps every user
 *    event handler because we subscribe with `--on-event`.
 *  - The real exit status is captured before any of our own commands run, so
 *    BEGIN/END never clobber the user's `$?`.
 *  - READY is emitted by the first owned prompt/postexec hook, not by the
 *    bootstrap line, so `terminal_open` cannot observe READY and then an
 *    unsolicited initialization END.
 *  - The saved `stty -g` string is restored verbatim (including a case where
 *    echo was originally off) before the first prompt.
 *  - Bash < 4.4 has no `PS0`; that case reports UNSUPPORTED instead of
 *    pretending integration is ready. Zsh/Fish scripts are generated and are
 *    validated as strings only on this Windows M0 host; they are not executed
 *    against a real remote Zsh/Fish here (Bash is exercised natively by the M0
 *    check only).
 *  - Every returned command ends with CR, the byte an interactive PTY expects
 *    after a submitted line.
 *
 * Markers use the printable OSC 777 form from `./protocol.js`; the emitters
 * embed octal escapes so generated command lines stay copy-safe.
 */
import { LiteSshError } from '../core/errors.js';
import type { ShellKind } from '../core/types.js';
import { MARKER_NAMESPACE, MARKER_OSC_ID } from './protocol.js';

/** Nonces are embedded in shell identifiers and quoted strings, so keep them tame. */
const NONCE_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Portable probe. `$PPID` is expanded by `/bin/sh`, whose parent is the real
 * interactive shell, so `/proc/$PPID/comm` names the actual shell process
 * rather than a possibly-modified `$SHELL`. Echo is switched off so the hook
 * installation that follows is not echoed back into the readable stream.
 */
export function makeShellProbe(nonce: string): string {
  assertNonce(nonce);
  const format = oscFormat(nonce, 'STTY;%s') + oscFormat(nonce, 'PROBE;%s');
  const program =
    'p=$(cat /proc/$PPID/comm 2>/dev/null || true); ' +
    's=$(stty -g 2>/dev/null || true); ' +
    'stty -echo 2>/dev/null || true; ' +
    'printf "' + format + '" "$s" "$p"';
  return '/bin/sh -c ' + shQuote(program) + '\r';
}

/**
 * Builds the one-shot bootstrap that installs temporary hooks for the detected
 * shell and restores stty. READY is NOT printed here: it is emitted by the
 * first prompt/postexec hook so it corresponds to a genuine prompt transition
 * (or by an UNSUPPORTED path when integration is impossible). Returns a command
 * ending with CR.
 */
export function makeShellBootstrap(shell: ShellKind, nonce: string, savedStty: string): string {
  assertNonce(nonce);
  switch (shell) {
    case 'bash':
      return bashBootstrap(nonce, savedStty);
    case 'zsh':
      return zshBootstrap(nonce, savedStty);
    case 'fish':
      return fishBootstrap(nonce, savedStty);
    default: {
      // Exhaustiveness guard for JS callers passing an out-of-range shell.
      throw new LiteSshError('SHELL_INTEGRATION_UNSUPPORTED', `Unsupported shell: ${String(shell)}.`);
    }
  }
}

/**
 * Resolves the interactive shell from a PROBE payload (a `/proc/<ppid>/comm`
 * value such as `bash`, `-zsh`, or a full path). Throws for anything else so
 * the caller reports SHELL_INTEGRATION_UNSUPPORTED instead of guessing.
 */
export function detectShell(probe: string): ShellKind {
  const first = probe.trim().split(/\s+/)[0] ?? '';
  const base = first.replace(/^.*\//, '').replace(/^-+/, '').toLowerCase();
  if (base === 'bash' || base === 'zsh' || base === 'fish') return base;
  throw new LiteSshError(
    'SHELL_INTEGRATION_UNSUPPORTED',
    `Unsupported interactive shell: ${base || 'unknown'}.`,
  );
}

/**
 * Bash. BEGIN rides on PS0 (expanded after a command line is read, before it
 * runs) with the user's existing PS0 text appended, never replaced. END/READY
 * ride on a PROMPT_COMMAND entry prepended to whatever shape the user had it in
 * (string or array). The user's DEBUG trap is left untouched.
 *
 * Initialization: the bootstrap command itself is read while the *old* PS0 is
 * still installed, so it emits no BEGIN. The first prompt afterwards invokes our
 * prepended function, which emits READY instead of END and flips a flag; every
 * later prompt emits END with the command's real exit status.
 */
function bashBootstrap(nonce: string, savedStty: string): string {
  const id = '__lssh_' + identifier(nonce) + '_';
  // Concatenate our BEGIN escape with the user's PS0 so their prompt text stays.
  const begin = "PS0=$'" + oscFormat(nonce, 'BEGIN') + "'\"$PS0\"";
  // $? is captured on the first line, before our printf can clobber it.
  const precmd =
    id + 'precmd() { local ' + id + 'ec=$?; ' +
    'local ' + id + 'ps0="${PS0-}"; ' +
    'local ' + id + 'h=0; ' +
    'if [ -n "$' + id + 'ps0" ] && [ "${' + id + 'ps0#$\'' + oscFormat(nonce, 'BEGIN') + '\'}" != "$' + id + 'ps0" ]; then ' +
    id + 'h=1; fi; ' +
    'if [ "${' + id + 'ready}" = "1" ]; then ' +
    'printf "' + oscFormat(nonce, 'END;%d;%d') + '" "$' + id + 'ec" "$' + id + 'h"; ' +
    'else ' + id + 'ready=1; printf "' + oscFormat(nonce, 'READY;bash') + '"; fi; ' +
    'return $' + id + 'ec; }';
  // `case` on `declare -p` output avoids depending on grep being present.
  const install = joinCommands([
    id + 'ready=0',
    'case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in ' +
      'declare\\ -a*) ' + id + 'pc_array=1; ' + id + 'pc_old=("${PROMPT_COMMAND[@]}");; ' +
      '*) ' + id + 'pc_array=0; ' + id + 'pc_old="$PROMPT_COMMAND";; esac',
    precmd,
    begin,
    'if [ "$' + id + 'pc_array" = "1" ]; then PROMPT_COMMAND=(' + id +
      'precmd "${' + id + 'pc_old[@]}"); else PROMPT_COMMAND="' + id +
      'precmd; ${' + id + 'pc_old[*]}"; fi',
    restoreStty(savedStty),
  ]);
  const supported =
    '[ "${BASH_VERSINFO[0]}" -gt 4 ] || ' +
    '{ [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }';
  const unsupported = joinCommands([
    restoreStty(savedStty),
    'printf "' + oscFormat(nonce, 'UNSUPPORTED;bash_lt_4_4') + '"',
  ]);
  return 'if ' + supported + '; then ' + install + '; else ' + unsupported + '; fi\r';
}

/**
 * Zsh. BEGIN rides on `preexec_functions` (prepended, so user hooks still run).
 *
 * The status capture needs care: the *special* `precmd` function runs before the
 * `precmd_functions` array, so merely prepending to the array would observe an
 * already-clobbered `$?`. We therefore copy any existing special `precmd` into an
 * ephemeral function and install our own `precmd` which is genuinely first. It
 * captures `$?`, emits READY (first prompt) or END, then restores the captured
 * status and runs the saved original, returning its status so the user's hook
 * chain and return value are preserved.
 *
 * The status is restored through a helper called in `if`-condition position
 * (`if <id>ret "$ec"; then <id>orig_precmd; else <id>orig_precmd; fi`): the helper
 * simply `return $ec`, so the saved hook sees the original `$?` as its own entry
 * status instead of the 0 left by our `printf`. Condition position is also exempt
 * from `ERR_EXIT`/`ERR_RETURN` (set -e / set -E), so neither our helper nor the
 * branch selection can abort the user's precmd chain. When there is no original
 * special `precmd` we return 0 to avoid a stray non-zero status aborting the
 * user's `precmd_functions` chain. No rc file is touched.
 */
function zshBootstrap(nonce: string, savedStty: string): string {
  const id = '__lssh_' + identifier(nonce) + '_';
  const save = 'if (( $+functions[precmd] )); then functions[' + id + 'orig_precmd]=$functions[precmd]; fi';
  // Trivial status restorer: `return $1` lets the saved hook observe the
  // original `$?` while running in an ERR_EXIT/ERR_RETURN-exempt condition.
  const restore = id + 'ret() { return $1; }';
  const preexec = id + 'preexec() { printf "' + oscFormat(nonce, 'BEGIN') + '"; }';
  const precmd =
    'precmd() { local ' + id + 'ec=$?; ' +
    'local ' + id + 'h=0; ' +
    'if (( $+functions[' + id + 'preexec] )) && (( $+preexec_functions )) && (( ${preexec_functions[(Ie)' + id + 'preexec]} )); then ' + id + 'h=1; fi; ' +
    'if (( ' + id + 'ready )); then ' +
    'printf "' + oscFormat(nonce, 'END;%d;%d') + '" "$' + id + 'ec" "$' + id + 'h"; ' +
    'else ' + id + 'ready=1; printf "' + oscFormat(nonce, 'READY;zsh') + '"; fi; ' +
    'if (( $+functions[' + id + 'orig_precmd] )); then ' +
    'if ' + id + 'ret "$' + id + 'ec"; then ' + id + 'orig_precmd; else ' + id + 'orig_precmd; fi; ' +
    'return $?; fi; ' +
    'return 0; }';
  // Ensure the array exists (nounset-safe) before prepending, then keep order.
  const array = 'typeset -ga preexec_functions; preexec_functions=(' + id + 'preexec $preexec_functions)';
  const install = joinCommands([
    save,
    'typeset -g ' + id + 'ready=0',
    restore,
    preexec,
    precmd,
    array,
    restoreStty(savedStty),
  ]);
  return install + '\r';
}

/**
 * Fish. All handlers are added with `--on-event`, so every user handler survives.
 *
 * state: `ready` flips on the first postexec/posterror/prompt (that one emits
 * READY instead of END); `round` is 1 between BEGIN and END.
 *
 *  - preexec: BEGIN, opens the round.
 *  - postexec: closes the round with the real `$status`; does nothing if the
 *    round was already closed (e.g. by a syntax error's posterror).
 *  - posterror: a parser error with no preceding `fish_preexec`. It emits exactly
 *    one END carrying the (non-zero) `$status` and no BEGIN, because nothing was
 *    executed; Session sees no real BEGIN and treats the round as not started.
 *    Never invents success, never hangs the round.
 *  - prompt: a READY fallback in case postexec was not delivered.
 */
function fishBootstrap(nonce: string, savedStty: string): string {
  const id = '__lssh_' + identifier(nonce) + '_';
  const begin = 'printf "' + oscFormat(nonce, 'BEGIN') + '"';
  const end = 'printf "' + oscFormat(nonce, 'END;%d;%d') + '" $' + id + 'ec $' + id + 'h';
  const readyPrint = 'printf "' + oscFormat(nonce, 'READY;fish') + '"';
  const preexec =
    'function ' + id + 'preexec --on-event fish_preexec; ' + begin + '; ' +
    'set -g ' + id + 'round 1; end';
  const postexec =
    'function ' + id + 'postexec --on-event fish_postexec; ' +
    'set -l ' + id + 'ec $status; ' +
    'set -l ' + id + 'h 0; ' +
    'if functions -q ' + id + 'preexec; and string match -q -r \'^function[[:space:]]+.*--on-event[[:space:]]+fish_preexec\' (functions ' + id + 'preexec 2>/dev/null); set ' + id + 'h 1; end; ' +
    'if test $' + id + 'ready -eq 0; set -g ' + id + 'ready 1; set -g ' + id + 'round 0; ' +
    readyPrint + '; else; ' +
    'if test $' + id + 'round -eq 1; ' + end + '; set -g ' + id + 'round 0; end; ' +
    'end; end';
  const posterror =
    'function ' + id + 'posterror --on-event fish_posterror; ' +
    'set -l ' + id + 'ec $status; ' +
    'set -l ' + id + 'h 0; ' +
    'if functions -q ' + id + 'preexec; and string match -q -r \'^function[[:space:]]+.*--on-event[[:space:]]+fish_preexec\' (functions ' + id + 'preexec 2>/dev/null); set ' + id + 'h 1; end; ' +
    'if test $' + id + 'ready -eq 0; set -g ' + id + 'ready 1; set -g ' + id + 'round 0; ' +
    readyPrint + '; else; ' +
    // No BEGIN: parser-rejected input never ran, so there is no real round start.
    end + '; set -g ' + id + 'round 0; ' +
    'end; end';
  const prompt =
    'function ' + id + 'prompt --on-event fish_prompt; ' +
    'if test $' + id + 'ready -eq 0; set -g ' + id + 'ready 1; ' + readyPrint + '; end; end';
  const install = joinCommands([
    'set -g ' + id + 'ready 0',
    'set -g ' + id + 'round 0',
    preexec,
    postexec,
    posterror,
    prompt,
    restoreStty(savedStty),
  ]);
  return install + '\r';
}

/** Restores the saved stty line (verbatim) if one is available; no trailing separator. */
function restoreStty(savedStty: string): string {
  return savedStty.length > 0 ? 'stty ' + shQuote(savedStty) + ' 2>/dev/null' : '';
}

/** Joins non-empty shell commands with `; ` and never leaves a trailing separator. */
function joinCommands(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join('; ');
}

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new LiteSshError(
      'INVALID_NONCE',
      'Nonce must contain only ASCII letters, digits, dot, underscore or dash.',
    );
  }
}

/** Identifier-safe token derived from the nonce for shell function/variable names. */
function identifier(nonce: string): string {
  return nonce.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Single-quotes a value for POSIX shells, escaping embedded single quotes. */
function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Printable printf/$'...' escape for one OSC marker payload. printf and bash's
 * `$'...'` both turn the `\033`/`\007` pairs into ESC/BEL; nothing here depends
 * on the locale.
 */
function oscFormat(nonce: string, payload: string): string {
  return '\\033]' + MARKER_OSC_ID + ';' + MARKER_NAMESPACE + ';' + nonce + ';' + payload + '\\007';
}
