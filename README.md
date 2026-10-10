# lite-ssh-mcp

[简体中文](README.zh-CN.md)

A local MCP server that lets an AI operate remote terminals over SSH and upload or download files and directories over SFTP.

The AI calls the tools. You connect the server to your client, configure SSH logins, and describe your tasks in natural language. Terminals and file transfers are independent; transfers do not require an open terminal.

## Install and connect

Requires **Node.js 22+** and an AI client that can launch local MCP servers over stdio. Local use currently focuses on Windows; compatibility with other local platforms is not guaranteed.

After obtaining the source, run these commands in the project directory:

```sh
npm ci --ignore-scripts
npm run build
```

Add the server to your MCP client, adapting the configuration format to your client:

```json
{
  "mcpServers": {
    "lite-ssh": {
      "command": "node",
      "args": ["D:/path/to/lite-ssh-mcp/dist/cli.js"]
    }
  }
}
```

Replace the example path with the absolute path to your local `dist/cli.js`. If the client cannot find `node`, set `command` to the full path of the Node.js executable.

Save the configuration, then start or reconnect the server in your client. After updating the source, rebuild and reconnect.

## Configure SSH logins

The remote host needs SSH, and file transfers also require SFTP. Interactive terminals use Bash, Zsh or Fish.

On first startup, the server creates these files in `.lite-ssh` under the current user's home directory:

- `config.json`: the active connection configuration, initially empty.
- `config.example.json`: an example for reference.

Existing files are not overwritten. Edit **`config.json`** with your server's IP address, port and account:

```json
{
  "version": 2,
  "servers": {
    "192.0.2.10": {
      "22": {
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

On the first connection or after a server host-key change, check the fingerprint reported by the AI with the server administrator or another trusted source before explicitly confirming it. Do not skip fingerprint verification.

## Use

Once connected, describe what you want the AI to do, for example:

- “Connect to 192.0.2.10 and check disk usage.”
- “Start a build on the server and monitor its output.”
- “Upload this local directory to `/srv/project` without overwriting existing files.”
- “Download the server logs to the local directory I specify.”

You do not need to fill in tool arguments or call the interfaces manually.

## Important notes

- Keep connection configuration and private keys local. Do not commit them to Git or share them. If the server reports unsafe file permissions, adjust them yourself; it does not automatically change permissions on existing files.
- Transfers do not overwrite existing content or follow symbolic links by default. Explicitly authorize the AI when either is needed.
- Terminal output is stored in temporary local logs and may contain sensitive information. Save any output you need to retain before closing the terminal.
- Closing a terminal does not guarantee that remote background tasks stop. Cancelling a transfer does not roll back files already transferred.

## License

[MIT](LICENSE) © 2026 mocha114514.
