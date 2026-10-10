# lite-ssh-mcp

[English](README.md)

轻量的 **SSH 终端与独立 SFTP 传输 stdio MCP 服务**。可打开命名 PTY，发送文本、按键或粘贴，读取解析后的画面、样式及 shell 命令状态。每个终端都有本地可读上下文日志；shell 集成仅在当前会话生效，不修改 shell 启动文件。

提供 **13 个工具**。传输使用自己的通道、标识和生命周期，不需要先打开终端。

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

SSH 配置及凭据仅保留在本地，不要提交到 Git。已有配置、凭据和缓存需通过平台私有权限及可信路径边界检查；已有用户权限**只验证，不自动修复**。配置读写最多 **4 MiB**，JSON 嵌套最多 128 层、解析值／键最多 100,000 个；超预算更新不改变原文件。私钥必须是最多 **1 MiB** 的普通文件；允许跟随可信链接，不改写权限。同一路径的密钥内容轮换后，新申请使用新的连接代次，已有资源不受影响。

未知或变化的主机密钥会阻止认证；独立核验返回的 SHA256 指纹后，明确调用 `lite_ssh_confirm_host_key` 确认，再重试终端或传输申请。

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
| `lite_ssh_upload` | 提交独立的本地到远端 SFTP 任务。 |
| `lite_ssh_download` | 提交独立的远端到本地 SFTP 任务。 |
| `lite_ssh_transfer_list` | 过滤、分页列出本实例的任务及保留的终态结果。 |
| `lite_ssh_transfer_status` | 查询实际进度、规划完整性、分页逐项结果和清理情况。 |
| `lite_ssh_transfer_cancel` | 请求停止，随后查询实际停止与清理结果。 |

打开终端需要 `ip`、`port`、`username` 及唯一的 snake_case `codename`，例如 `build_main`；后续终端操作使用 `ip`、`port`、`codename`。

通过返回的 `cachePath` 配合本地文件工具读取可读历史，**关闭前保存**所需内容。`pending` 或 `screen_updated` 不是重发输入的理由，工具回复也不代表逐键确认。关闭终端不保证终止远端后台进程。

## 传输

上传和下载需要 `ip`、`port`、`username`、`localPath`、`remotePath`。本地路径使用原生绝对路径或 `~/`；远端使用 Linux POSIX 绝对路径。**两侧路径都指最终对象，不是容纳它的父目录。** 将 `/source/tree` 复制到 `/destination/tree`，其子项直接映射到 `/destination/tree` 下，包括隐藏文件。

两项策略彼此独立，默认均关闭：

| 参数 | 关闭 | 开启 |
|---|---|---|
| `conflictPolicy` | `overwrite_merge_off`：已有同名目标阻断整个任务。 | `overwrite_merge_on`：替换普通文件、合并目录，保留目标额外条目。 |
| `symlinkPolicy` | `symlink_follow_off`：源、目标、父路径或递归条目遇到链接时，阻断完整传输。 | `symlink_follow_on`：跟随链接内容，保留源逻辑名称及已有目标链接节点。 |

必须使用完整枚举字符串，不接受布尔值或短别名。覆盖许可不代表跟随链接许可，反之亦然。类型不匹配、断链、环路、特殊对象、不安全路径、映射冲突和资源超限都会明确失败，不静默跳过或改名。

### 提交、观察、停止

1. 提交 `lite_ssh_upload` 或 `lite_ssh_download`。配置、认证及通道获取先于接受；返回 `transferId` 的接受响应**不代表完成**。
2. 轮询 `lite_ssh_transfer_status`，用 `offset`／`limit` 读取全部 `results`。尚未确定的总量可为 `null`。完整、有界规划先于目标修改；已知阻断的计划不会写入目标。
3. 用 `lite_ssh_transfer_list` 恢复上下文。终态记录保留 15 分钟并受记录预算约束，以 `recordExpiresAt` 为准；重启不恢复内存任务登记表。
4. 停止时请求 `lite_ssh_transfer_cancel`，然后轮询。取消不是瞬时成功，不会把已完成任务改成取消，也不回滚已提交文件或已创建目录。

关闭 PTY **不会**取消传输。只有能证明属于本任务且路径边界未变的临时文件才会被清理。检查 `cleanup`、`residualPaths`、`possibleResidualPaths`、`stopped` 和 `guardCapabilities`；未知结果不是盲目重新提交的理由。终态在所属通道与连接占用收尾结果确定后发布。

### 发布与安全边界

文件流式写入同目录独占临时文件。远端“仅创建”发布需要 `hardlink@openssh.com`，覆盖发布需要 `posix-rename@openssh.com`。需要发布文件时，能力缺失或被拒绝会在修改目标前失败；纯目录任务不依赖这些扩展。没有“先删旧文件再复制”的降级方案。

这不是跨客户端文件系统事务：检测到变化会停止，但远端 SFTP v3 元数据可能缺乏强文件标识或精确时间戳。部分失败保留已提交内容。默认预算限制并行传输（4）、已接纳任务（20）、保留记录（128）、规划条目（20,000）、深度（128）、单计划内存（16 MiB）及任务总估算内存（64 MiB）。物理连接在真实关闭前持续占用预算；凭据读取另有有界并发与队列。

## 验证状态

最新 Windows、**Node 22.0.0 和 26.6.0** 本地构建与回归结果均为 **298 项通过、1 项仅限 POSIX 的测试跳过、0 项失败**，包括 13 项真实 loopback ssh2/SFTP 协议测试、私有文件／ACL、操作生效后丢失 ACK，以及配置／JSON 预算和锁初始化失败测试。文件级并行数限制为 4，没有改动断言或期限。最低版本测试已覆盖最新配置预算修复；测后便携版与测试文件已清理，系统 Node 和工程依赖未改动。

在 **Node 26.6.0** 下，另一次独立的 `npm ci --ignore-scripts` 干净安装下载了 109 个锁定包，使用新安装的编译器重新构建源码与测试，同样通过 **298 项测试，另有 1 项 POSIX 专项跳过**。最新 127 文件 tgz 随后在另一份空缓存中通过真正的 npx 初次安装／help，再通过缓存后的 stdio 启动、13 个严格工具、空配置读取与正常退出测试，stderr 为空。两次安装均未使用工程依赖或依赖引用链接，第三方安装脚本被禁用；测后安装目录、两份缓存、测试 home 与 tgz 已清理。

此前版本在 **Node 22.23.3** 上还通过 **290 项测试，另有相同的 1 项 POSIX 专项跳过**。此前 Node 22.0.0 的 tgz 冒烟复用了已有依赖，只作为独立历史证据，不混同本次干净安装。

SFTP 服务端是 Windows 自有测试文件系统支撑的合成实现，不等于 OpenSSH／Linux 互操作或原生 Bash／Zsh／Fish 验证。三平台、公开发布包／`@latest` 更新及实际客户端部署验收尚未完成。上述 npx 结果仅针对 Windows、本地 tgz、禁用安装脚本的环境，不代表正式发布或完整 V2 验收通过。

## 许可证

[MIT](LICENSE) © 2026 mocha114514。
