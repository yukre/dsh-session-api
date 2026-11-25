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

## 配套技能（内置，装好即用）

本插件自带一个 skill：**`dsh-session-status`**。它的作用是让 agent 在遇到
「任务都跑完了吗 / 查一下所有会话 / 有需要我审批的吗 / 那个会话开发得如何了」
这类**状态问题**时，走本插件的接口去查，而不是去读磁盘投影缓存或临时写脚本。

- **随插件安装**：激活时自动复制到技能库（`~/.agents/skills/dsh-session-status`）
- **升级随插件**：插件版本变化时整目录覆盖，源头始终在插件里
- **可禁用**：在「技能管理」里关掉即可，文件仍在但不注入模型
- **不覆盖你的改动**：若 SKILL.md 的 `x-provider` 不再是 `dsh-session-api`，插件会认为该目录已被你接管，之后既不覆盖也不删除

技能正文会教 agent：端口要动态探测（DSH 重启会换端口）、token 从
`~/.dsh/session-api/token` 取、先查 `GET /capabilities` 再按需用只读接口，
以及**接口（实时真源）与磁盘投影缓存（含历史归档）口径不同**这一点。

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
| GET | `/sessions/:id/approvals` | 列出本插件持有的待决审批 |
| GET | `/sessions/:id/questions` | 列出待答提问（`answerable` 标出能否从此处回答） |
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
| POST | `/sessions/:id/approvals/:decisionId` | `{decision: "allow"\|"deny"}` | 裁决一条待决审批（仅本次生效） |
| POST | `/sessions/:id/questions/:callId` | `{answers:[{id,selected,custom?}]}` | 回答一条待答提问（与界面 / QQ 通道**赛跑**，先到先得） |

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

## 示例：跨会话裁决挂起的审批

当某个会话卡在审批卡片上（Auto review 拦截了命令），可以从外部放行：

```bash
# 1. 看有哪些待决审批
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/approvals?format=md"

# 2. 放行其中一条（或 deny 拒绝）
curl -s -X POST "$BASE/sessions/$SID/approvals/$DECISION_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"decision":"allow"}'
```

返回：

```json
{ "ok": true, "decisionId": "3f2a…", "decision": "allow", "applied": "allowed-once" }
```

裁决后该会话立即继续运行，`pendingInput` 随之清空。

> **只影响这一条审批**。DSH 的审批结果只有「单次放行 / 拒绝」两种，没有「以后都放行」。若要让某类命令以后不再询问，请用 `POST /sessions/:id/permission` 切换权限档位——那才是 DSH 提供的持久机制。

## 示例：回答一个提问

`ask_user_question` 让 agent 停下来等选择时，可以从外部作答。**回答是「赛跑」的**：谁先答谁生效，先到先得——界面上的卡片、QQ 通道、这个接口三者地位相同。

```bash
# 1. 看有什么在等回答（含问题 id、选项、以及能否从此处回答）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/questions?format=md"

# 2. 回答（answers 要为每个问题各提供一项）
curl -s -X POST "$BASE/sessions/$SID/questions/$CALL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"answers":[{"id":"q1","selected":["方案 A"]}]}'
```

**单选场景**可以简写，`selected` 会自动展开成该问题的 id：

```bash
curl -s -X POST "$BASE/sessions/$SID/questions/$CALL_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"selected":"方案 A"}'
```

答成功返回：

```json
{ "ok": true, "callId": "…", "answered": 1, "via": "api" }
```

`via: "api"` 表示这次回答**赢了赛跑**，被驱动的会话就像在对话里回答了那样继续往下跑；`via: "service"` 表示走的是 DSH 自己的迟到回答通道（该提问插件没接管，通常是 `timed` 且已超时）。

### 两种「答不上」的返回，含义不同

| 返回码 | 含义 | 怎么处理 |
|---|---|---|
| `QUESTION_ALREADY_SETTLED`（409） | 别人先答了（界面或 QQ），你的答案没有生效 | 以先答的为准，不用重试 |
| `QUESTION_NOT_FOUND`（404） | 没有这个待答提问：已回答 / 已超时 / 已随取消撤回 | 重新 `GET /questions` 看现状 |

### 为什么需要这个（不只是「方便」）

DSH 自带的提问有两条通道，**都覆盖不到无头会话**：

- **界面卡片**：走 `user-questions/request` waterfall，需要有人盯着 GUI。
- **QQ 通道**：`im-qqbot` 直接**替换** `userQuestions.ask`，不加入 waterfall——所以任何只监听 waterfall 的插件对 QQ 会话完全失明。

这个插件改为**包装 `ask` 方法本身**，所以上面两条路径上的提问它都看得见，也都能抢答。QQ 驱动的会话没有人在 GUI 前点时，这就是唯一的救援通道。

> 早期版本（≤1.6.1）只读 DSH 的 `userQuestions` 投影，而**那份投影只跟踪 `timed` schema 的调用**；profile 默认是 `legacy` 阻塞模式，于是列表恒空、作答恒 `QUESTION_NOT_FOUND`。1.7 起改为包装 `ask`，两种 schema、两种通道都覆盖。

配置项 `answerQuestions`（默认 `true`）可关掉这一行为，回到「只读列表」。

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
- **连接信任检查**：路由入口先过 `connection.requestRejection`（DSH 自己的准入判定），挡住跨站 Origin 与 DNS 重绑定。`webServer.register` 本身不做这层检查，光靠回环绑定和对端地址是不够的
- **技能同步可关闭**：`cordis.patch.yml` 里设 `syncSkills: false` 后插件不再写技能库（已同步的副本不会被自动删除，可在技能管理里移除）
- **新建会话要求目录已存在**：`cwd` / `path` 必须是**已经存在的目录**，插件不会替你创建。原因：宿主创建会话时会对 `cwd` 执行 `mkdir --recursive`，若不设限，持有 token 的调用方可在磁盘任意位置造目录树。这与界面「添加工作区」的约束一致——工作区只能从已存在的目录登记。
- **不能指定 sessionId**：会话 ID 由 DSH 生成，接口不提供自定义，避免与「复用已有会话」的语义混淆。
- **权限切换要求会话已打开**：`/permission` 需要活的 Agent；未打开的会话会返回 `NOT_OPEN`
- **审批裁决只放行一次**：DSH 的 `ApprovalOutcome` 只有 `allowed-once` / `rejected` / `cancelled` / `unavailable`，没有「记住放行」。持久放行请改权限档位。
- **只裁决本插件持有的审批**：`GET /approvals` 列出的是本插件挂起的项。若审批由界面卡片持有，这里会显示为空，而 `pendingInput` 仍可能有值——两者含义不同。
- **未裁决的审批 5 分钟后自动撤回**：超时按 `cancelled` 处理并释放回合，避免外部长期不响应把会话卡死。
- **提问裁决走「赛跑」**：本插件包装 `userQuestions.ask`，把提问同时发布到 HTTP 面；界面卡片、QQ 通道、本接口谁先答谁生效，另外两方的答案被丢弃（不会报错、也不会覆盖）。只有回落到 DSH 自己的迟到回答通道（`via: "service"`）时才要求会话已打开，此时未打开返回 `NOT_OPEN`。
- **回答必须覆盖每个问题**：一个问题组里有几项就要给几项，且 id 不能重复（插件在赛跑路径上自己校验，服务在迟到通道上校验），`answers: []` 会被拒绝而不是静默成功。
- **简写只支持单问题**：一次提问有多个问题时，简写无法表达「每个问题各答一项」，会直接返回 `409 BAD_ANSWERS` 并列出所有问题 id——而不是只答第一题再报错。
- **回答成功会撤回失败方**：接口先答后，会中止下游的等待信号，界面卡片随之消失、QQ 通道撤掉条目。**不会**给你发「提问已超时」——那条消息是没被回答时才会出现的。
- **提问 30 分钟未答自动下架**：只从 HTTP 面撤下，**不打断**下游（界面卡片照常等、`timed` 照常超时）。下架后再答返回 `QUESTION_NOT_FOUND`。
- **插件卸载时未答的提问会失败**：工具调用收到明确的失败，而不是永远挂着；同一进程内重装/热重载时，只回收本实例持有的提问，不影响新实例。
- **legacy 提问没有真实 callId**：阻塞式 schema 不传工具调用 id，插件用 `sessionId#ask-N` 合成一个供外部寻址；它只在本插件队列里有效。

## 测试

```bash
node --test tests/api.test.mjs
```

32 项断言，覆盖三层安全门、全部路由、输入校验与错误路径。

## 许可

MIT
