# lite-ssh-mcp

[简体中文](README.zh-CN.md)

A lightweight **stdio MCP server for SSH terminals and independent SFTP transfers**. Open named PTYs, send text, keys or paste, and read parsed screens, styles and shell command status. Each terminal keeps a local readable context log. Shell integration is temporary and does not modify shell startup files.

There are **13 tools**. Transfers have their own channels, identifiers and lifecycle; they do not require a terminal.

## Configuration

### Build and connect your MCP client

Requires **Node.js 22+**.

```sh
npm ci --ignore-scripts
npm run build
```

Add the local server to your MCP client (adapt the configuration format for your client):

```json
{
  "mcpServers": {
    "lite-ssh": {
      "command": "node",
      "args": ["/absolute/path/to/lite-ssh-mcp/dist/cli.js"]
    }
  }
}
```

Replace the script path with your absolute path; use the full path to `node` if it is not on PATH.

### SSH logins

On normal startup, the server creates missing `~/.lite-ssh/config.json` (empty) and `config.example.json` files. Existing files are not overwritten. Edit **`config.json`**, using the hierarchy **IP → port → account**:

```json
{
  "version": 2,
  "servers": {
    "192.0.2.10": {
      "22": {
        "label": "development",
        "accounts": {
          "deploy": {
            "auth": {
              "type": "password",
              "password": "<your-password>"
            }
          }
        }
      }
    }
  }
}
```

Replace the example address, port, account and credentials. For private-key authentication, use this `auth` object; omit `passphrase` for an unencrypted key:

```json
{
  "type": "privateKey",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "passphrase": "<your-key-passphrase>"
}
```

Keep SSH configuration and credentials local; do not commit them. Existing configuration, credentials and cache must pass platform privacy and trusted-namespace checks. Existing user permissions are **verified, not automatically repaired**. Configuration reads/writes are limited to **4 MiB**, JSON nesting to 128 levels and parsed values/keys to 100,000; over-budget updates leave the original file unchanged. Private keys must be regular files of at most **1 MiB**; trusted links are followed without rewriting their permissions. Key rotation at an unchanged path creates a new connection generation for new requests and leaves existing resources alone.

Unknown or changed host keys stop authentication. Independently verify the reported SHA256 fingerprint, explicitly confirm it with `lite_ssh_confirm_host_key`, then retry the terminal or transfer request.

## Tools

| Tool | Purpose |
|---|---|
| `lite_ssh_list_configurations` | Filter and paginate configured IP/port/account combinations without exposing credentials. |
| `lite_ssh_confirm_host_key` | Record a previously observed host fingerprint after user verification and confirmation. |
| `lite_ssh_terminal_open` | Open a named PTY using a configured login. |
| `lite_ssh_terminal_list` | List this instance's terminal names, states and local log paths. |
| `lite_ssh_terminal_write` | Send `text`, `paste` or named `key` actions. Text does not implicitly press Enter; paste requires bracketed-paste mode. |
| `lite_ssh_terminal_read` | Read the current parsed screen, cursor, styles and command-round state—not historical output. |
| `lite_ssh_terminal_resize` | Resize the PTY and screen: 2–240 columns, 2–100 rows. |
| `lite_ssh_terminal_close` | Close the selected PTY and remove its own local context log. |
| `lite_ssh_upload` | Submit an independent local-to-remote SFTP task. |
| `lite_ssh_download` | Submit an independent remote-to-local SFTP task. |
| `lite_ssh_transfer_list` | Filter and paginate this instance's tasks and retained finished-task results. |
| `lite_ssh_transfer_status` | Query actual progress, planning completeness, paginated per-entry results and cleanup. |
| `lite_ssh_transfer_cancel` | Request stopping and subsequently query the actual stopped/cleanup result. |

Opening requires `ip`, `port`, `username` and a unique snake_case `codename`, such as `build_main`. Subsequent terminal operations use `ip`, `port` and `codename`.

Use the returned `cachePath` with local file tools for readable history; save what you need **before closing**. `pending` or `screen_updated` is not a reason to resend input, and a reply is not a per-key acknowledgement. Closing does not guarantee termination of remote background processes.

## Transfers

Upload and download require `ip`, `port`, `username`, `localPath` and `remotePath`. The local path is native absolute or `~/`; the remote path is Linux POSIX absolute. **Both paths name the final object, not its containing folder.** Copying `/source/tree` to `/destination/tree` maps its children directly beneath `/destination/tree`, including hidden files.

Two policies are independent and default to off:

| Parameter | Off | On |
|---|---|---|
| `conflictPolicy` | `overwrite_merge_off`: existing same-name targets block the task. | `overwrite_merge_on`: replace regular files and merge directories, preserving extra target entries. |
| `symlinkPolicy` | `symlink_follow_off`: encountering source/target/parent/recursive links blocks a complete transfer. | `symlink_follow_on`: follow linked content, preserve source logical names and existing target link nodes. |

Use the full enum strings, not booleans or shortened aliases. Permission to overwrite does not imply permission to follow links, or vice versa. Type mismatches, broken links, cycles, special objects, unsafe paths, incompatible mappings and resource limits fail explicitly rather than being silently skipped or renamed.

### Submit, observe, stop

1. Submit `lite_ssh_upload` or `lite_ssh_download`. Configuration, authentication and channel acquisition precede acceptance. An accepted response supplies `transferId` but **does not mean completion**.
2. Poll `lite_ssh_transfer_status` and page its `results` with `offset`/`limit`. Totals can be `null` until known. Complete bounded planning precedes target mutation; a known blocked plan performs zero target writes.
3. Use `lite_ssh_transfer_list` for context recovery. Terminal records are retained for 15 minutes, subject to the record budget; consult `recordExpiresAt`. Restart does not restore the in-memory registry.
4. To stop, request `lite_ssh_transfer_cancel`, then poll. Cancellation is not instantaneous, never converts an already completed task to cancelled, and does not roll back committed files or created directories.

Closing a PTY does **not** cancel a transfer. Temporary files are cleaned only with proven ownership and an unchanged boundary. Inspect `cleanup`, `residualPaths`, `possibleResidualPaths`, `stopped` and `guardCapabilities`; an uncertain outcome is not a reason to blindly resubmit. Public terminal phases are published after owned channel/lease teardown has settled.

### Publication and safety limits

Files are streamed into exclusive same-directory temporaries. Remote create-only publication requires `hardlink@openssh.com`; overwrite publication requires `posix-rename@openssh.com`. Missing/refused capabilities fail before mutation when files need publication; directory-only tasks do not require them. There is no delete-the-old-file fallback.

This is not a cross-client filesystem transaction: detectable changes stop work, but remote SFTP-v3 metadata may lack strong file IDs or timestamp precision. Already committed content is preserved on partial failure. Defaults bound concurrent transfers (4), admitted tasks (20), retained records (128), planned entries (20,000), depth (128), per-plan memory (16 MiB) and aggregate estimated task memory (64 MiB). Physical connections remain budgeted until actual close; credential reads have separate bounded admission.

## Verification status

The latest Windows-local builds and regressions on Node **22.0.0 and 26.6.0** each report **298 passed, 1 POSIX-only test skipped, 0 failed**, including 13 real loopback ssh2/SFTP-wire cases, private-file/ACL and post-effect lost-ACK cases, plus bounded configuration/JSON and failed-lock-initialization tests. Test-file concurrency is bounded to 4 without changing assertions or deadlines. The minimum-version run includes the latest configuration-budget fixes; its portable runtime and test artifacts were cleaned up afterward without changing system Node or workspace dependencies.

On Node **26.6.0**, a separate clean `npm ci --ignore-scripts` installation downloaded 109 locked packages, rebuilt the source/tests with its own compiler, and passed the same **298 tests with 1 POSIX-only skip**. A current 127-file tgz then passed genuine npx first-install/help in a second, empty cache, followed by cached stdio startup, 13 strict tools, empty-configuration listing and normal exit with no stderr. Neither installation used workspace dependencies or a dependency junction; third-party installation scripts were disabled, and both installations/caches/test homes/tgz were cleaned up afterward.

The preceding snapshot also passed **290 tests with the same 1 POSIX-only skip** on Node **22.23.3**. That snapshot's Node 22.0.0 tgz smoke reused existing dependencies; it is separate historical evidence, not the current clean-install run.

The SFTP tests use an owned synthetic server backed by the Windows test filesystem—not OpenSSH/Linux interoperability or native Bash/Zsh/Fish proof. Three-platform, published-package/`@latest` update and actual client deployment acceptance remain incomplete. The npx result above is for a local tgz on Windows with installation scripts disabled, not a published release or a full V2 acceptance claim.

## License

[MIT](LICENSE) © 2026 mocha114514.
