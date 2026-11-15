---
name: dsh-session-status
x-provider: dsh-session-api
x-version: 1
description: "Use when the user asks about the state of sessions, tasks, background jobs, running work, pending approvals, pending questions, or development progress — e.g. 「任务都跑完了吗」「查一下所有会话」「有需要我审批的吗」「看看那个会话开发得如何了」「最后两个任务结果是什么」「后台作业还在跑吗」. Answers them by calling the local dsh-session-api HTTP surface (GET /sessions, /sessions/:id/state, /approvals, /questions, /queue, /conversation, /workspaces), which reports the LIVE state of this DSH host, instead of reading the on-disk projection cache or writing a one-off script. Trigger words: 会话状态, 任务进度, 审批, 提问, 待办作业, session status, running tasks, pending approval."
---
<!-- 本技能由 dsh-session-api 插件内置提供：随插件安装即可用，源头随插件升级同步。禁用请到「技能管理」。 -->

# 查询 DSH 会话与任务状态

用户问「任务跑完了吗 / 有哪些会话 / 有要审批的吗 / 那个会话进展如何」这类**状态问题**时，用本插件提供的本机 HTTP 接口回答。

**不要**去读 `~/.dsh/storages/session_projcache/`（那是磁盘投影缓存，见下方口径说明），**也不要**临时写脚本或 `ls` 会话目录来拼状态——口径会不一致。

## 第一步：确定 base URL 和 token

### base URL（**端口会变，不要写死**）

DSH 每次启动监听的端口可能不同。**动态取当前端口**：

```sh
# 方法一：从监听端口取（推荐）
PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
  | awk '/DeepSeek|dsh/ && /127\.0\.0\.1/ {split($9,a,":"); print a[2]; exit}')
BASE="http://127.0.0.1:$PORT/session-api"

# 方法二：DSH 会话上下文里通常已给出当前 GUI URL，取它的端口
#   （system prompt 里的 "Current DeepSeek Harness Web GUI URL"）
```

校验一下确实取到：

```sh
echo "$BASE"          # 应形如 http://127.0.0.1:52405/session-api
```

### token

```sh
TOKEN=$(cat ~/.dsh/session-api/token)
```

- 文件权限为 `0600`，内容就是 Bearer token
- 若文件不存在：说明插件未安装或尚未初始化，告知用户去「设置 → 会话远程控制」查看/生成
- **不要**把 token 打印到最终回复里，也不要写进任何提交的文件

### 请求头

每个请求都要带：

```sh
-H "Authorization: Bearer $TOKEN"
```

插件只绑 `127.0.0.1` 回环，并校验 socket 对端必须是本机。

## 第二步：先自查接口清单

接口可能随插件版本增加。**先拉一次能力清单**，确认要用哪个接口、是否支持 Markdown：

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/capabilities"
```

它返回每个接口的 `method` / `path` / `formats` / `write` / `summary`。
**所有只读接口都支持 `?format=md`**——面向用户汇报时优先用 Markdown，可读性远好于 JSON。

## 常用查询

### 所有会话（最常用）

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions?format=md"
```

返回表格：状态（🟢 运行中 / ⚪ 空闲）、标题、工作目录、最后活动、会话 ID。
这一步通常就足以回答「都有哪些任务 / 哪个还在跑」。

### 某个会话的实时状态

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/state?format=md"
```

含：运行中与否、当前轮的活跃状态、排队消息数、`pendingInput`（有 `approval` / `question` 说明正在等人）。

### 待审批 / 待回答

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/approvals?format=md"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/questions?format=md"
```

用户问「有需要我审批的吗」时，对**所有会话**跑一遍这两条，汇总非空的。

### 排队消息

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/queue?format=md"
```

### 会话具体内容 / 开发进展

```sh
# 最近的对话（默认 40 条，可 ?limit=N，上限 200）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/conversation?format=md&limit=60"
```

这是回答「那个会话开发得如何了 / 最后两个任务结果是什么」的正确入口：
读最近若干条 user/assistant 消息，再归纳进展。

### 工作区视角

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/workspaces?format=md"
```

## 口径（重要）

有两类数据源，**含义不同，不要混用**：

| 来源 | 是什么 | 用于 |
|---|---|---|
| **插件接口**（本 skill 使用的） | 当前宿主进程里的**活跃会话与其实时状态** | 一切状态类问题的**真源** |
| `~/.dsh/storages/session_projcache/` | 磁盘上的投影缓存，**含历史与已归档会话** | 追溯历史；**不要**用它回答「现在在跑什么」 |
| `~/.dsh/sessions/` 目录 | 会话日志文件，含已归档 | 只有接口给不出所需信息时才考虑，且需向用户说明这是磁盘视角 |

**结论：状态查询一律以插件接口为准。** 接口说 idle 就是 idle，即使磁盘上还留着该会话的文件。

## 汇报要求

- 先给结论（如「3 个会话在跑，1 个等你审批」），再列明细
- 用 `?format=md` 的表格直接呈现，不要改写成大段文字
- 涉及审批/提问时，给出 `decisionId` / `callId`，并说明可以用插件接口裁决
- 不要回显 token

## 写操作不在本 skill 范围

本 skill 只做**只读查询**。如果用户明确要求代他放行审批、回答问题、发消息、切权限或新建会话，那是写操作，先确认意图再调用相应 `POST` 接口（见 `GET /capabilities` 的清单）。
