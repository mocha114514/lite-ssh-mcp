# lite-ssh-mcp

[English](README.md)

让 AI 通过 SSH 操作远端终端，并通过 SFTP 上传、下载文件和目录的本地 MCP 服务。

AI 负责调用工具；你只需要接入服务、配置 SSH 连接，再用自然语言描述任务。终端与文件传输相互独立，不需要为传输先打开终端。

## 安装与接入

需要 **Node.js 22+**，以及能够启动本地 MCP（stdio）服务的 AI 客户端。当前主要面向 Windows 本地使用，其他本地平台暂不作兼容性保证。

在 MCP 客户端中添加服务，配置格式按客户端要求调整：

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

`npx` 会下载并运行 npm 包，不需要获取源码或全局安装。如果客户端找不到 `npx`，请确认它能够访问 Node.js 的安装路径，或将 `command` 改为 `npx` 的完整路径。

### 从源码运行

本地开发时，获取源码后，在项目目录中执行：

```sh
npm ci --ignore-scripts
npm run build
```

将上面客户端配置中的 `command` 改为 `node`，`args` 改为 `["D:/path/to/lite-ssh-mcp/dist/cli.js"]`，并将示例路径替换为本机构建产物的绝对路径。

## 配置 SSH 连接

首次启动时，服务会在当前用户主目录的 `.lite-ssh` 文件夹中创建：

- `config.json`：实际使用的连接配置，初始为空。
- `config.example.json`：配置示例，供参考。

已有文件不会被覆盖。编辑 **`config.json`**，按服务器 IP、端口和账号填写连接信息：

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

替换示例 IP、端口、账号和密码。使用私钥时，将 `auth` 替换为：

```json
{
  "type": "privateKey",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "passphrase": "<your-key-passphrase>"
}
```

未加密的私钥可以省略 `passphrase`。

首次连接或服务器主机密钥变化时，会提示来源核对。

## 许可证

[MIT](LICENSE) © 2026 mocha114514。
