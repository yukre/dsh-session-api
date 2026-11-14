# dsh-session-api

给 DeepSeek Harness 开一个**本机 HTTP 控制接口**：从页面外读取会话运行状态，并驱动输入框里的那些操作——发消息（含即时插话）、切模型、切权限、取消、改队列。

## 为什么需要它

DSH 自己的接口是给浏览器用的（带认证的 Remote 通道），外部脚本拿不到。这个插件在**同一个 web server** 上开一个 `/session-api` 前缀，让你能用 curl / Python / 另一个 agent 直接操作。

## 安全（三层，全部强制）

| 层 | 机制 |
|---|---|
| 监听 | 复用 DSH 的 webServer，实测只绑 `127.0.0.1`（DSH 加载时拒绝 `0.0.0.0`） |
| 来源 | 校验 socket 对端地址必须是回环；即使有人反代这个端口也进不来 |
| 密钥 | 每个请求必须带 `Authorization: Bearer <token>` |

密钥默认自动生成，落在 `<DSH home>/session-api/token`（权限 0600）。也可以在 profile 的 `cordis.patch.yml` 里配置：

```yaml
- id: dsh-session-api
  config:
    token: "你的自定义密钥"   # 留空则自动生成
    requireLoopback: true
```

## 快速开始

```bash
TOKEN=$(cat ~/.dsh/session-api/token)
BASE=http://127.0.0.1:56164/session-api   # 端口以 DSH 实际 URL 为准

# 看服务状态
curl -s -H "Authorization: Bearer $TOKEN" $BASE/status

# 列出所有会话
curl -s -H "Authorization: Bearer $TOKEN" $BASE/sessions
```

## 输出格式：JSON 或 Markdown

所有**只读**接口都支持 `?format=md` 返回 Markdown 文本（表格、标题、列表），方便直接阅读或塞进聊天窗口。

```bash
# JSON（默认）
curl -s -H "Authorization: Bearer $TOKEN" $BASE/sessions

# Markdown
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions?format=md"
```

**哪些接口支持 Markdown，由接口自己公布**——不用猜：

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BASE/capabilities
```

它返回每个接口的 `method` / `path` / `formats` / `write` / `summary`，调用方看一眼就知道该用哪种格式。

> 写入接口只返回 JSON：回执渲染成散文没有意义。

## 接口清单

### 只读

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 服务状态与安全姿态 |
| GET | `/capabilities` | 接口能力清单（含格式支持） |
| GET | `/workspaces` | 工作区列表（含 workspaceId，用于新建会话） |
| GET | `/sessions` | 会话列表 |
| GET | `/sessions/:id` | 单个会话 |
| GET | `/sessions/:id/state` | 运行状态、队列、待输入 |
| GET | `/sessions/:id/queue` | 排队消息列表 |
| GET | `/sessions/:id/conversation` | 对话内容（`?limit=N`，默认 40，上限 200） |
| GET | `/sessions/:id/projections` | 投影数据 |
| GET | `/models` | 可选模型目录 |
| GET | `/permissions` | 权限预设与当前值 |

### 写入

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| POST | `/sessions/:id/prompt` | `{text, mode?}` | 发消息。`mode` 为 `steer`（默认，即时插话）或 `queue`（排队） |
| POST | `/sessions/:id/cancel` | 无 | 取消当前轮 |
| POST | `/sessions/:id/model` | `{provider, model, reasoningEffort?}` | 切模型 |
| POST | `/sessions/:id/permission` | `{preset}` | 切权限（走与界面相同的命令路径） |
| DELETE | `/sessions/:id/queue/:itemId` | 无 | 移除排队项 |
| POST | `/workspaces` | `{path, title?}` | 登记工作区（目录须**已存在**） |
| POST | `/workspaces/:id/sessions` | `{text, mode?, agentPreset?}` | **在指定工作区新建会话并立即执行首条任务** |
| POST | `/sessions/create` | `{cwd, text, mode?, agentPreset?}` | 在指定目录（须**已存在**）新建会话并执行首条任务 |

## 示例：在指定工作区新建会话并下达任务

```bash
# 1. 先看有哪些工作区，拿到 workspaceId
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/workspaces?format=md"

# 2. 在该工作区新建会话，并立即让它开始干活
curl -s -X POST $BASE/workspaces/$WSID/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"分析这个仓库的依赖风险","mode":"steer"}'
```

返回：

```json
{
  "ok": true,
  "accepted": true,
  "mode": "steer",
  "sessionId": "session-102ab2d6-...",
  "cwd": "/Users/you/project",
  "workspaceId": "c16dd40a-...",
  "workspacePath": "/Users/you/project",
  "agentPreset": "standard"
}
```

拿这个 `sessionId` 就能继续用 `/sessions/:id/*` 那一套接口操作它。

也可以在任意**已存在**的目录直接开会话，不要求先登记工作区：

```bash
curl -s -X POST $BASE/sessions/create \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"cwd":"/Users/you/project","text":"先看一下目录结构"}'
```

## 示例：即时插话

```bash
curl -s -X POST $BASE/sessions/$SID/prompt \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"先别改配置文件，先给我看方案","mode":"steer"}'
```

`mode: "steer"` 会插进当前正在跑的回合（等同你在输入框里打断它）；`mode: "queue"` 则排到队列末尾。

## 实现说明

- **读写会话** → 调用 `sessionController` 服务本体方法（不是 Remote 网关）
- **切权限** → 走 `commands.execute(agent, '/permission <preset>')`，与界面点选完全同路径，所有预设（含 `auto`、`danger-full-access`）行为一致
- **切模型** → `sessionController.selectModel`
- **发消息** → `sessionController.prompt`，`mode` 原生支持 `steer` / `queue`

## 限制

- **仅本机**：设计如此，不提供外网访问
- **新建会话要求目录已存在**：`cwd` / `path` 必须是**已经存在的目录**，插件不会替你创建。原因：宿主创建会话时会对 `cwd` 执行 `mkdir --recursive`，若不设限，持有 token 的调用方可在磁盘任意位置造目录树。这与界面「添加工作区」的约束一致——工作区只能从已存在的目录登记。
- **不能指定 sessionId**：会话 ID 由 DSH 生成，接口不提供自定义，避免与「复用已有会话」的语义混淆。
- **权限切换要求会话已打开**：`/permission` 需要活的 Agent；未打开的会话会返回 `NOT_OPEN`
- **确认授权暂未开放**（阶段 2）：审批/提问涉及异步 waterfall 生命周期，接入错误会导致审批永久挂起，因此单独实现

## 测试

```bash
node --test tests/api.test.mjs
```

32 项断言，覆盖三层安全门、全部路由、输入校验与错误路径。

## 许可

MIT
