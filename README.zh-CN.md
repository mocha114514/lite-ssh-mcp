# lite-ssh-mcp

[English](README.md)

让 AI 通过 SSH 操作远端终端，并通过 SFTP 上传、下载文件和目录的本地 MCP 服务。

AI 负责调用工具；你只需要接入服务、配置 SSH 连接，再用自然语言描述任务。终端与文件传输相互独立，不需要为传输先打开终端。

## 安装与接入

需要 **Node.js 22+**，以及能够启动本地 MCP（stdio）服务的 AI 客户端。当前主要面向 Windows 本地使用，其他本地平台暂不作兼容性保证。

获取源码后，在项目目录中执行：

```sh
npm ci --ignore-scripts
npm run build
```

在 MCP 客户端中添加服务，配置格式按客户端要求调整：

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

将示例路径替换为你本机 `dist/cli.js` 的绝对路径。如果客户端找不到 `node`，将 `command` 改为 Node.js 可执行文件的完整路径。

保存配置后，在客户端启动或重新连接该服务。更新源码后，需要重新构建并重新连接。

## 配置 SSH 连接

远端需要提供 SSH；文件传输还需要启用 SFTP。交互式终端使用 Bash、Zsh 或 Fish。

首次启动时，服务会在当前用户主目录的 `.lite-ssh` 文件夹中创建：

- `config.json`：实际使用的连接配置，初始为空。
- `config.example.json`：配置示例，供参考。

已有文件不会被覆盖。编辑 **`config.json`**，按服务器 IP、端口和账号填写连接信息：

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

替换示例 IP、端口、账号和密码。使用私钥时，将 `auth` 替换为：

```json
{
  "type": "privateKey",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "passphrase": "<your-key-passphrase>"
}
```

未加密的私钥可以省略 `passphrase`。

首次连接或服务器主机密钥变化时，先将 AI 返回的指纹与服务器管理员或其他可信来源核对，再明确确认。不要跳过指纹核验。

## 使用

接入完成后，直接向 AI 描述你要做的事，例如：

- “连接 192.0.2.10，查看磁盘使用情况。”
- “在服务器上启动构建，并帮我观察输出。”
- “把本地这个目录上传到服务器的 `/srv/project`，不要覆盖已有文件。”
- “把服务器上的日志下载到我指定的本地目录。”

不需要手动填写工具参数或调用接口。

## 注意事项

- 连接配置和私钥应只保留在本地，不要提交到 Git 或发给他人。如果服务提示文件权限不安全，请自行调整；服务不会自动修改已有文件的权限。
- 文件传输默认不覆盖已有内容，也不跟随符号链接。确有需要时，应明确授权 AI。
- 终端输出会生成本地临时记录，可能包含敏感内容；需要长期保留的输出应在关闭前另行保存。
- 关闭终端不保证停止远端后台任务；取消传输也不会回滚已完成的文件。

## 许可证

[MIT](LICENSE) © 2026 mocha114514。
