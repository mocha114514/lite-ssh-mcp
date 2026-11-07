# lite-ssh-mcp

[简体中文](README.zh-CN.md)

A local MCP server that lets an AI operate remote terminals over SSH and upload or download files and directories over SFTP.

The AI calls the tools. You connect the server to your client, configure SSH logins, and describe your tasks in natural language. Terminals and file transfers are independent; transfers do not require an open terminal.

## Available tools

| Tool | Purpose |
|---|---|
| `lite_ssh_list_configurations` | List configured servers, ports and login accounts. |
| `lite_ssh_confirm_host_key` | Confirm and save an observed server host-key fingerprint. |
| `lite_ssh_terminal_open` | Open a named SSH terminal with the specified account. |
| `lite_ssh_terminal_list` | List current terminals and their states. |
| `lite_ssh_terminal_write` | Type text, paste content or send keys to a terminal. |
| `lite_ssh_terminal_read` | Read the current terminal screen, cursor and state. |
| `lite_ssh_terminal_resize` | Adjust terminal rows and columns. |
| `lite_ssh_terminal_close` | Close a terminal and clean up its cache. |
| `lite_ssh_upload` | Submit a file or directory upload. |
| `lite_ssh_download` | Submit a file or directory download. |
| `lite_ssh_transfer_list` | List transfers and their states. |
| `lite_ssh_transfer_status` | Query a transfer's progress and results. |
| `lite_ssh_transfer_cancel` | Request cancellation of a transfer. |

## Install and connect

Requires **Node.js 22+** and an AI client that can launch local MCP servers over stdio. Local use currently focuses on Windows; compatibility with other local platforms is not guaranteed.

Add the server to your MCP client, adapting the configuration format to your client:

```json
{
  "mcpServers": {
    "lite-ssh": {
      "command": "npx",
      "args": [
        "-y",
        "lite-ssh-mcp@latest"
      ]
    }
  }
}
```

### Run from source

For local development, obtain the source and run these commands in the project directory:

```sh
npm ci --ignore-scripts
npm run build
```

In the client configuration above, change `command` to `node` and `args` to `["D:/path/to/lite-ssh-mcp/dist/cli.js"]`. Replace the example path with the absolute path to your local build.

### Development tests

Run the full suite with `npm test`. To run selected compiled test files:

```sh
npm run build
npm run build:test
node dist-test/test/run.js dist-test/test/shell-sequence.test.js
```

The common runner prints its fixture root and passes it to every child test. Windows defaults to a new run under `<user-home>/vb-test/lite-ssh-mcp/`; other platforms use `vb-test/full-v2/portable/` in the checkout. `LSSH_TEST_ROOT` overrides the base (relative paths use the invoking working directory). Choose a dedicated, owned directory—not real SSH configuration or key folders. Tests do not repair existing parent-directory permissions. Remove only the reported run-specific fixtures after testing.

### Real Linux shell tests (opt-in)

With Bash, Zsh, Fish, and util-linux `script`/`stty` available on Linux, run after building:

```sh
LSSH_REAL_SHELLS=1 node dist-test/test/run.js dist-test/test/real-shell.test.js
```

These tests use real PTYs and shells, a temporary SSH server bound only to `127.0.0.1`, and the production MCP stdio entrypoint. Homes, configuration, history, and caches are isolated; child PIDs are recorded beneath the fixture root. They do not modify the login shell or system sshd. Without the flag they are explicitly skipped; with it, a wrong platform or missing prerequisites fails rather than silently skipping. This does not certify production OpenSSH, custom startup files, or macOS.

## Configure SSH logins

On first startup, the server creates these files in `.lite-ssh` under the current user's home directory:

- `config.json`: the active connection configuration, initially empty.
- `config.example.json`: an example for reference.

Existing files are not overwritten. Edit **`config.json`** with your server's IP address, port and account:

```json
{
  "version": 2,
  "servers": {
    "<your-ip>": {
      "<your-port>": {
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

Replace the example IP, port, account and password. For private-key authentication, replace `auth` with:

```json
{
  "type": "privateKey",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "passphrase": "<your-key-passphrase>"
}
```

Omit `passphrase` if the private key is not encrypted.

On the first connection or after a server host-key change, you will be prompted to verify the server's identity.

Connections use SSH-level keepalives with a 30-second interval and an unanswered-probe limit of 3. These detect unresponsive connections without sending terminal input or retiring healthy idle terminals. Lost connections are not automatically reconnected, and input is never replayed.

## License

[MIT](LICENSE) © 2026 mocha114514.
