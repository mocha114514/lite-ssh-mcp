# lite-ssh-mcp

[简体中文](README.zh-CN.md)

A lightweight **stdio MCP server for SSH terminals**. Open independent named PTYs, send text, keys or paste, and read parsed screens, styles and shell command status. Each terminal keeps a local readable context log. Shell integration is temporary and does not modify shell startup files.

Current scope: SSH terminals. SFTP transfer tools are not implemented.

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

Keep SSH configuration and credentials local; do not commit them. Unknown or changed host keys stop authentication. Verify the reported SHA256 fingerprint, explicitly confirm it with `lite_ssh_confirm_host_key`, then retry opening the terminal.

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

Opening requires `ip`, `port`, `username` and a unique snake_case `codename`, such as `build_main`. Subsequent terminal operations use `ip`, `port` and `codename`.

Use the returned `cachePath` with local file tools for readable history; save what you need **before closing**. `pending` or `screen_updated` is not a reason to resend input, and a reply is not a per-key acknowledgement. Closing does not guarantee termination of remote background processes.

## License

[MIT](LICENSE) © 2026 mocha114514.
