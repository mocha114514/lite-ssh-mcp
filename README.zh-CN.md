# lite-ssh-mcp

[English](README.md)

轻量的 **SSH 终端 stdio MCP 服务**。可打开独立命名的 PTY，发送文本、按键或粘贴，读取解析后的画面、样式及 shell 命令状态。每个终端都有本地可读上下文日志；shell 集成仅在当前会话生效，不修改 shell 启动文件。

当前范围是 SSH 终端，尚未实现 SFTP 传输工具。

## 配置

### 构建与接入 MCP 客户端

需要 **Node.js 22+**。

```sh
npm ci --ignore-scripts
npm run build
```

在 MCP 客户端中添加本地服务（配置格式按客户端调整）：

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

将脚本路径替换为你的绝对路径；若 `node` 不在 PATH 中，也需填写其完整路径。

### SSH 登录配置

正常启动时，服务会创建缺失的 `~/.lite-ssh/config.json`（空配置）和 `config.example.json`，不会覆盖已有文件。编辑实际使用的 **`config.json`**，结构为 **IP → 端口 → 账号**：

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

替换示例地址、端口、账号及认证信息。使用私钥认证时，将 `auth` 改为下列对象；未加密的私钥可省略 `passphrase`：

```json
{
  "type": "privateKey",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "passphrase": "<your-key-passphrase>"
}
```

SSH 配置及凭据仅保留在本地，不要提交到 Git。未知或变化的主机密钥会阻止认证；核验返回的 SHA256 指纹后，明确调用 `lite_ssh_confirm_host_key` 确认，再重试打开终端。

## 工具

| 工具 | 用途 |
|---|---|
| `lite_ssh_list_configurations` | 过滤、分页列出配置的 IP／端口／账号组合，不暴露凭据。 |
| `lite_ssh_confirm_host_key` | 经用户核验并确认后，保存此前实际观察到的主机指纹。 |
| `lite_ssh_terminal_open` | 使用配置的登录项打开命名 PTY。 |
| `lite_ssh_terminal_list` | 列出本实例的终端名称、状态及本地日志路径。 |
| `lite_ssh_terminal_write` | 发送 `text`、`paste` 或命名 `key` 动作；文本不会隐式按 Enter，粘贴需要括号粘贴模式。 |
| `lite_ssh_terminal_read` | 读取当前解析画面、光标、样式及命令轮次状态，不读取历史输出。 |
| `lite_ssh_terminal_resize` | 调整 PTY 和画面尺寸：2–240 列、2–100 行。 |
| `lite_ssh_terminal_close` | 关闭指定 PTY，并删除它自己的本地上下文日志。 |

打开终端需要 `ip`、`port`、`username` 及唯一的 snake_case `codename`，例如 `build_main`；后续终端操作使用 `ip`、`port`、`codename`。

通过返回的 `cachePath` 配合本地文件工具读取可读历史，**关闭前保存**所需内容。`pending` 或 `screen_updated` 不是重发输入的理由，工具回复也不代表逐键确认。关闭终端不保证终止远端后台进程。

## 许可证

[MIT](LICENSE) © 2026 mocha114514。
