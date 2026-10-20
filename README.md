# lite-ssh-mcp

[简体中文](README.zh-CN.md)

A local MCP server that lets an AI operate remote terminals over SSH and upload or download files and directories over SFTP.

The AI calls the tools. You connect the server to your client, configure SSH logins, and describe your tasks in natural language. Terminals and file transfers are independent; transfers do not require an open terminal.

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
        "lite-ssh-mcp@0.1.0"
      ]
    }
  }
}
```

`npx` downloads and runs the npm package; no source checkout or global installation is required. If the client cannot find `npx`, make sure it can access your Node.js installation, or use the full path to `npx`.

### Run from source

For local development, obtain the source and run these commands in the project directory:

```sh
npm ci --ignore-scripts
npm run build
```

In the client configuration above, change `command` to `node` and `args` to `["D:/path/to/lite-ssh-mcp/dist/cli.js"]`. Replace the example path with the absolute path to your local build.

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

## License

[MIT](LICENSE) © 2026 mocha114514.
