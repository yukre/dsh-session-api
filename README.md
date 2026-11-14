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

## 接口清单

### 只读

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 服务状态与安全姿态 |
| GET | `/sessions` | 会话列表 |
| GET | `/sessions/:id` | 单个会话 |
| GET | `/sessions/:id/state` | 运行状态、队列、待输入 |
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
- **权限切换要求会话已打开**：`/permission` 需要活的 Agent；未打开的会话会返回 `NOT_OPEN`
- **确认授权暂未开放**（阶段 2）：审批/提问涉及异步 waterfall 生命周期，接入错误会导致审批永久挂起，因此单独实现

## 测试

```bash
node --test tests/api.test.mjs
```

24 项断言，覆盖三层安全门、全部路由、输入校验与错误路径。

## 许可

MIT
