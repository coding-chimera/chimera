# 96 候选按真实依赖重新分诊

> 契约版本：`cr-2026-10-30-r1`。工作包：WP-04。基线：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
> 本文件回答 DoD 第 3 项：96 候选按真实依赖重新分诊，产出 host-first / 依赖 session 二分清单。

## 1. 为什么要重分诊

计划第 25 行把 inventory 的 `96 host-first` 明确标为“仅初步分类”；第 37 行说“首批不抢 W2 的 96 路由，其中大量路由依赖 TS session 语义”；第 245 行再次说“不先接 96 个含 TS session 依赖的路由”。inventory 的分组规则是**按 group 默认 + 少量 operation override**（`packages/chimera/script/httpapi-inventory.ts:104-170`），并不检查 handler 是否真的触碰 `Session`/`SessionPrompt`/`BackgroundJob`/`SessionStatus` 等运行时服务。因此必须按 handler 的真实调用链重分。

## 2. 判定标准

| verdict | 定义 | 处理建议 |
|---|---|---|
| `host-first` | handler 路径不触碰 TS session 存储或执行语义 | 可进入首批 host 候选（仍需按最小子集排序） |
| `session-storage` | handler 读写 session 行/消息，但不运行 agent loop | 等数据面/存储换权后再接；可先做只读投影 |
| `session-execution` | handler 调用 SessionPrompt / BackgroundJob / SessionStatus / SessionRunState / Session.remove 等运行语义 | 继续走 Bun 代理，不进入首批 host-first |

二分规则：`host-first = verdict host-first`；`session-dependent = verdict session-storage ∪ session-execution`。

判定证据：每个 handler 的注册行 + 实际 session 调用行；完整证据在 `triage-96.json` 的 `evidence` 列。检查程序会验证证据文件存在且行号不越界。

## 2.1 构造层依赖：handler 之外的第二道门

`host-first` 判定只看 handler 体是否触碰 session；但 Effect HttpApi 的路由组由 `HttpApiBuilder.group(...)` 构造，group 构造体里的每个 `yield* X.Service` 都会在提供该 group 时构造 X 的 layer。只要 X 的 `defaultLayer` 提供链里出现 `Session` / `SessionPrompt` / `BackgroundJob` / `SessionStatus`，即使 handler 体完全不碰 session，这条路由也无法在“无 session 的 Rust host”上独立提供。这是与 handler verdict 独立的第二道门。

已核实的构造层依赖（基线 `9600ee7`）：

| group | group 构造点 | 传递链 | 受影响 host-first 条目 |
|---|---|---|---|
| config | `handlers/config.ts:28-29` 直接 `yield* RemoteCompaction.Service` 与 `Session.Service` | group 构造即要求 `Session` | 9 |
| experimental | `handlers/experimental.ts:29` 直接 `yield* BackgroundJob.Service`；`:27` 取 `ToolRegistry.Service`；`:28` 取 `Worktree.Service` | `ToolRegistry.defaultLayer` 提供 `BackgroundJob.defaultLayer`（`src/tool/registry.ts:576`）与 `Session.defaultLayer`（`:586`）；`Worktree.defaultLayer` -> `InstanceLayer.layer`（`src/worktree/index.ts:564`）-> `InstanceBootstrap.defaultLayer`（`src/project/instance-layer.ts:4-8`）-> `Memory.defaultLayer`（`src/project/bootstrap.ts:66`）-> `Session.defaultLayer` + `SessionStatus.defaultLayer`（`src/memory/memory.ts:420-425`） | 9 |
| workspace | `handlers/workspace.ts:13` 取 `Workspace.Service` | `Workspace.layer` 构造时 `yield* Session.Service`（`src/control-plane/workspace.ts:171`）与 `yield* SessionPrompt.Service`（`:172`）；`defaultLayer` 提供 `Session.defaultLayer`（`:1085`）与 `SessionPrompt.defaultLayer`（`:1087`） | 4 |
| memory | `handlers/memory.ts:8` 取 `MemoryManagement.Service` | `MemoryManagement.layer` 构造时 `yield* Memory.Service`（`src/memory/management.ts:206-209`）；`MemoryManagement.defaultLayer` -> `Memory.defaultLayer`（`:370`）-> `Session.defaultLayer`（`src/memory/memory.ts:422`）+ `SessionStatus.defaultLayer`（`:424`） | 8 |

合计 **30 条**：handler 无依赖，但 layer 构造依赖 session。它们保留 `host-first` 的 handler 判定，但不能进入首批；在 layer 依赖解除前继续走 Bun 代理。

已核查构造层无 session 依赖的 host-first group（基线时点）：`control`、`global`、`instance`、`file`、`project`、`provider`、`graph`、`mcp`、`permission`、`question`。对应 **39 条** host-first 可作为首批候选。核查对象是 `defaultLayer` 的 provide 链，不是只看 `layer` 本体；新增/修改 layer 或 group 后必须重跑 §2.2 复核清单。

## 2.2 复核清单（新增/变更 handler group 或 defaultLayer 时）

1. 列出 group 构造体取用的服务：`rg -n 'yield\* [A-Za-z]+\.Service' src/server/routes/instance/httpapi/handlers/<group>.ts`。
2. 对每个服务检查 `defaultLayer`（不是只看 `layer`）的 provide 链：`rg -n 'export const defaultLayer' -A 30 src/<service>.ts`；递归到间接依赖，重点看 `ToolRegistry`、`Worktree`、`InstanceBootstrap`、`Memory`、`MemoryManagement` 这类会把 session 带进来的中转。
3. 链中出现 `Session.defaultLayer` / `SessionPrompt.defaultLayer` / `BackgroundJob.defaultLayer` / `SessionStatus.defaultLayer` 任一项：把该 group 的路由标为 `host-first (layer-blocked)`，继续走 Bun 代理，不计入首批。
4. 只把“handler 无 session 调用 + group/layer 构造无 session 依赖”的路由计入首批候选。
5. 更新 `triage-96.json` 的 `constructionLayerDeps`（受影响 operationId 清单与计数），并运行 `bun test/oracle/http/verify-http-contract.ts`；该脚本校验清单自洽，不替代人工走链。

## 3. 结论

| 指标 | 数量 |
|---|---|
| inventory 的 host-first 候选 | 96 |
| 重分诊后 handler 层 host-first | **69** |
| 其中构造层无 session 依赖（首批候选） | **39** |
| 其中构造层依赖 session（layer-blocked） | **30** |
| handler 层依赖 session（合计） | **27** |
| 其中 session-storage | 19 |
| 其中 session-execution | 8 |

关键含义：

- **96 不能整体当首批范围**。按真实可执行性拆成 **39 construction-clean host-first + 30 layer-blocked + 27 session-dependent**；首批最多从 39 条中选最小子集。
- **30 条 layer-blocked 是新增的硬边界**：handler 本身不碰 session，但 config/experimental/workspace/memory 四个 group 的构造会把 `Session`/`SessionPrompt`/`BackgroundJob`/`SessionStatus` 带进来。在 layer 依赖解除前，它们与 27 条 session-dependent 一样继续走 Bun 代理。
- **8 条 execution 路由是硬边界**：它们直接调用 prompt/run-state/background job/session 删除，不能在 Rust host 上“只读转发”实现。
- **19 条 storage 路由可以随数据面迁移**，但在数据面换权前仍应走 Bun 代理；其中 `v2.session.list/context/messages` 虽然是只读，但直接查 `SessionTable`/`SessionMessageTable`，不是“无依赖”。

## 4. 8 条 session-execution（硬边界）

| # | operationId | method path | cutoverOwner | touch point | evidence |
|---|---|---|---|---|---|
| 1 | `experimental.workspace.warp` | `POST /experimental/workspace/warp` | WP-10 | Workspace.sessionWarp -> SessionPrompt | `packages/chimera/src/server/routes/instance/httpapi/handlers/workspace.ts:44-70,78; packages/chimera/src/control-plane/workspace.ts:707-710` |
| 2 | `experimental.workspace.remove` | `DELETE /experimental/workspace/{id}` | WP-10 | Workspace.remove -> Session.remove -> background job cancel | `packages/chimera/src/server/routes/instance/httpapi/handlers/workspace.ts:40-42,77; packages/chimera/src/control-plane/workspace.ts:959-972; packages/chimera/src/session/session.ts:786-808` |
| 3 | `session.status` | `GET /session/status` | WP-10 | SessionStatus.list in-memory run state | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:104-106,462; packages/chimera/src/session/status.ts:62-74` |
| 4 | `session.get` | `GET /session/{sessionID}` | WP-10 | Session.get + SessionPrompt.resumeGoalOnOpen kick | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:108-118,463` |
| 5 | `session.delete` | `DELETE /session/{sessionID}` | WP-10 | Session.remove cancels background jobs and releases process registry | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:244-247,474; packages/chimera/src/session/session.ts:786-841` |
| 6 | `session.backgroundQuiescence` | `GET /session/{sessionID}/background/quiescence` | WP-10 | BackgroundJob.list/waitOwnerQuiescent | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:406-426,489` |
| 7 | `session.goalSet` | `PUT /session/{sessionID}/goal` | WP-10 | Goal.create + SessionPrompt.kickGoalContinuation | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:139-160,468` |
| 8 | `session.deleteMessage` | `DELETE /session/{sessionID}/message/{messageID}` | WP-10 | SessionRunState.assertNotBusy | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:428-434,490` |

重点发现：

- `session.get` 是 GET，但不是纯读：它调用 `promptSvc.resumeGoalOnOpen`（`handlers/session.ts:113-116`），会 kick 一个 active goal 的 continuation。把它当 host-first 只读路由会丢语义。
- `session.delete` 的 `Session.remove` 会取消该 session 拥有/派发的 background jobs（`session/session.ts:803-808`），并释放 process registry；不是简单删行。
- `experimental.workspace.remove` 会级联 `session.remove`（`control-plane/workspace.ts:971`），因此也被归入 execution，而不是普通 workspace CRUD。
- `session.status` 读的是 `SessionStatus` 的进程内 Map（`session/status.ts:62-74`），不是 DB。

## 5. 19 条 session-storage

| # | operationId | method path | cutoverOwner | touch point | evidence |
|---|---|---|---|---|---|
| 1 | `v2.session.list` | `GET /api/session` | WP-05+WP-10 | SessionV2.list direct session DB query | `packages/chimera/src/server/routes/instance/httpapi/handlers/v2/session.ts:43,62-88; packages/chimera/src/v2/session.ts:260-298` |
| 2 | `v2.session.context` | `GET /api/session/{sessionID}/context` | WP-05+WP-10 | SessionV2.context direct session_message DB query | `packages/chimera/src/server/routes/instance/httpapi/handlers/v2/session.ts:111; packages/chimera/src/v2/session.ts:340-370` |
| 3 | `v2.session.messages` | `GET /api/session/{sessionID}/message` | WP-05+WP-10 | SessionV2.messages direct session_message DB query | `packages/chimera/src/server/routes/instance/httpapi/handlers/v2/message.ts:32,42-57; packages/chimera/src/v2/session.ts:299-339` |
| 4 | `config.remoteCompaction.status` | `GET /config/remote-compaction/status` | WP-05+WP-10 | Session.remoteCompactionLock reads compaction message parts | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:70-82,131; packages/chimera/src/session/session.ts:1215-1235` |
| 5 | `experimental.session.list` | `GET /experimental/session` | WP-05+WP-10 | Session.listGlobal reads session rows | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:120-140,184` |
| 6 | `process.list` | `GET /process` | WP-05+WP-10 | Process registry joined with Session.get rows | `packages/chimera/src/server/routes/instance/httpapi/handlers/process.ts:8; packages/chimera/src/server/routes/instance/process-service.ts:43-59` |
| 7 | `session.list` | `GET /session` | WP-05+WP-10 | Session.list storage pagination | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:68-102,461` |
| 8 | `session.create` | `POST /session` | WP-05+WP-10 | SessionShare.create -> Session.create storage; optional auto-share fork | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:224-226,473; packages/chimera/src/share/session.ts:40-46` |
| 9 | `session.update` | `PATCH /session/{sessionID}` | WP-05+WP-10 | Session.setTitle/setPermission/setArchived storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:249-267,475` |
| 10 | `session.children` | `GET /session/{sessionID}/children` | WP-05+WP-10 | Session.children storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:120-122,464` |
| 11 | `session.diff` | `GET /session/{sessionID}/diff` | WP-05+WP-10 | SessionSummary.diff reads session_diff storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:167-172,470; packages/chimera/src/session/summary.ts:124-136` |
| 12 | `session.goal` | `GET /session/{sessionID}/goal` | WP-05+WP-10 | Goal.get storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:132-137,467` |
| 13 | `session.goalClear` | `DELETE /session/{sessionID}/goal` | WP-05+WP-10 | Goal.clear storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:162-165,469` |
| 14 | `session.messages` | `GET /session/{sessionID}/message` | WP-05+WP-10 | Session.messages / MessageV2.page storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:174-211,471` |
| 15 | `session.message` | `GET /session/{sessionID}/message/{messageID}` | WP-05+WP-10 | MessageV2.get storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:213-222,472` |
| 16 | `part.update` | `PATCH /session/{sessionID}/message/{messageID}/part/{partID}` | WP-05+WP-10 | Session.updatePart storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:443-458,492` |
| 17 | `part.delete` | `DELETE /session/{sessionID}/message/{messageID}/part/{partID}` | WP-05+WP-10 | Session.removePart storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:436-441,491` |
| 18 | `session.todo` | `GET /session/{sessionID}/todo` | WP-05+WP-10 | Todo.get storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:124-126,465` |
| 19 | `session.workBrief` | `GET /session/{sessionID}/work_brief` | WP-05+WP-10 | WorkBrief.get storage | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:128-130,466` |

注意：`session-storage` 不是“无依赖”。它依赖 session 表结构、消息/part 序列化、session_diff 文件、goal/todo/work_brief 存储。这些属于 WP-05 的权威矩阵；在数据面换权前，host 只读投影也只能作为代理后的第二读点。

## 6. 69 条 host-first（handler 层）

> touchPoint 带 `[L]` 的 30 条 = handler 无依赖但 layer 构造依赖 session（见 §2.1）。它们保留 handler 层 `host-first` 判定，但不进入首批；首批候选只有 39 条 construction-clean 条目。

| # | operationId | method path | cutoverOwner | touch point | evidence |
|---|---|---|---|---|---|
| 1 | `app.agents` | `GET /agent` | WP-07 | Agent service list; no Session/SessionPrompt import | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:76-78,101` |
| 2 | `auth.set` | `PUT /auth/{providerID}` | WP-10 | Auth service; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/control.ts:13-19,32` |
| 3 | `auth.remove` | `DELETE /auth/{providerID}` | WP-10 | Auth service; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/control.ts:21-24,32` |
| 4 | `command.list` | `GET /command` | WP-07 | Command service reads instance config state; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:72-74,100` |
| 5 | `config.get` | `GET /config` | WP-10 | Config service; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:18-20,127` |
| 6 | `config.update` | `PATCH /config` | WP-10 | Config update + instance disposal; no session execution；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:22-26,128` |
| 7 | `config.modelSelection.get` | `GET /config/model-selection` | WP-10 | ConfigModelSelection file read; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:108-110,134` |
| 8 | `config.modelSelection.update` | `PATCH /config/model-selection` | WP-10 | ConfigModelSelection file write + bus event; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:112-116,135` |
| 9 | `config.providers` | `GET /config/providers` | WP-10 | Provider service list; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:118-124,136` |
| 10 | `config.remoteCompaction.get` | `GET /config/remote-compaction` | WP-10 | Remote compaction policy read; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:84-86,132` |
| 11 | `config.remoteCompaction.update` | `PATCH /config/remote-compaction` | WP-10 | Remote compaction policy write; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:88-106,133` |
| 12 | `config.remoteCompaction.eligibility.list` | `GET /config/remote-compaction/eligibility` | WP-10 | Provider/config eligibility list; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:31-33,129` |
| 13 | `config.remoteCompaction.eligibility.update` | `PATCH /config/remote-compaction/eligibility` | WP-10 | Provider/config eligibility write; no session；[L] handler 无依赖但 layer 构造依赖 session（config group -> Session.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:35-68,130` |
| 14 | `experimental.capabilities.get` | `GET /experimental/capabilities` | WP-10 | Config delegation flags; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:162-168,186` |
| 15 | `experimental.console.get` | `GET /experimental/console` | WP-10 | Account/config console state; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:31-43,175` |
| 16 | `experimental.console.listOrgs` | `GET /experimental/console/orgs` | WP-10 | Account orgs; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:45-65,176` |
| 17 | `experimental.console.switchOrg` | `POST /experimental/console/switch` | WP-10 | Account active org; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:67-74,177` |
| 18 | `experimental.resource.list` | `GET /experimental/resource` | WP-10 | MCP resources; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:170-172,187` |
| 19 | `experimental.workspace.list` | `GET /experimental/workspace` | WP-10 | Workspace table read; no session；[L] handler 无依赖但 layer 构造依赖 session（workspace group -> Workspace.layer -> Session/SessionPrompt） | `packages/chimera/src/server/routes/instance/httpapi/handlers/workspace.ts:20-22,74` |
| 20 | `experimental.workspace.create` | `POST /experimental/workspace` | WP-10 | Workspace adapter/DB create + sync start; no session runtime；[L] handler 无依赖但 layer 构造依赖 session（workspace group -> Workspace.layer -> Session/SessionPrompt） | `packages/chimera/src/server/routes/instance/httpapi/handlers/workspace.ts:24-33,75` |
| 21 | `experimental.workspace.adapter.list` | `GET /experimental/workspace/adapter` | WP-10 | Workspace adapter list; no session；[L] handler 无依赖但 layer 构造依赖 session（workspace group -> Workspace.layer -> Session/SessionPrompt） | `packages/chimera/src/server/routes/instance/httpapi/handlers/workspace.ts:15-18,73` |
| 22 | `experimental.workspace.status` | `GET /experimental/workspace/status` | WP-10 | Workspace connection status; no session；[L] handler 无依赖但 layer 构造依赖 session（workspace group -> Workspace.layer -> Session/SessionPrompt） | `packages/chimera/src/server/routes/instance/httpapi/handlers/workspace.ts:35-38,76` |
| 23 | `worktree.list` | `GET /experimental/worktree` | WP-10 | Project sandboxes; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:93-96,180` |
| 24 | `worktree.create` | `POST /experimental/worktree` | WP-10 | Worktree git create; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:98-102,181` |
| 25 | `worktree.remove` | `DELETE /experimental/worktree` | WP-10 | Worktree git remove; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:104-111,182` |
| 26 | `worktree.reset` | `POST /experimental/worktree/reset` | WP-10 | Worktree git reset; no session；[L] handler 无依赖但 layer 构造依赖 session（experimental group -> BackgroundJob.Service） | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:113-118,183` |
| 27 | `file.list` | `GET /file` | WP-04 | File service list; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/file.ts:36-38,52` |
| 28 | `file.read` | `GET /file/content` | WP-04 | File service read; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/file.ts:40-42,53` |
| 29 | `file.status` | `GET /file/status` | WP-04 | File service status; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/file.ts:44-46,54` |
| 30 | `find.text` | `GET /find` | WP-04 | Ripgrep search; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/file.ts:15-19,49` |
| 31 | `find.files` | `GET /find/file` | WP-04 | File search; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/file.ts:21-30,50` |
| 32 | `find.symbols` | `GET /find/symbol` | WP-04 | LSP workspace symbols; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/file.ts:32-34,51` |
| 33 | `formatter.status` | `GET /formatter` | WP-07 | Format service status; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:88-90,104` |
| 34 | `global.browserArtifact` | `GET /global/browser-artifact/{projectHash}/{sessionHash}/{filename}` | WP-07 | Browser artifact bytes; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:209-226,238` |
| 35 | `global.config.get` | `GET /global/config` | WP-07 | Global config read; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:117-119,233` |
| 36 | `global.config.update` | `PATCH /global/config` | WP-07 | Global config write + instance disposal; no session execution | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:121-125,234` |
| 37 | `global.dispose` | `POST /global/dispose` | WP-07 | Dispose all instances; runtime lifecycle, no session semantics | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:127-130,235` |
| 38 | `global.health` | `GET /global/health` | WP-07 | Health/version; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:79-81,229` |
| 39 | `global.preferences.get` | `GET /global/preferences` | WP-07 | WebUI preferences read; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:87-89,231` |
| 40 | `global.preferences.update` | `PUT /global/preferences` | WP-07 | WebUI preferences write; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:91-115,232` |
| 41 | `global.presence` | `POST /global/presence` | WP-07 | Instance presence TTL; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:135-152,236` |
| 42 | `global.upgrade` | `POST /global/upgrade` | WP-07 | Installation upgrade; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/global.ts:186-203,237` |
| 43 | `graph.file.symbols` | `GET /graph/file/symbols` | WP-06 | Graph service read-only; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/graph.ts:13` |
| 44 | `graph.files` | `GET /graph/files` | WP-06 | Graph service read-only; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/graph.ts:14` |
| 45 | `graph.impact` | `GET /graph/impact` | WP-06 | Graph service read-only; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/graph.ts:15` |
| 46 | `graph.node` | `GET /graph/node/{nodeID}` | WP-06 | Graph service read-only; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/graph.ts:12` |
| 47 | `graph.search` | `GET /graph/search` | WP-06 | Graph service read-only; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/graph.ts:11` |
| 48 | `graph.status` | `GET /graph/status` | WP-06 | Graph service read-only; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/graph.ts:10` |
| 49 | `instance.dispose` | `POST /instance/dispose` | WP-07 | Instance disposal; runtime lifecycle, no session semantics | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:24-27,93` |
| 50 | `app.log` | `POST /log` | WP-10 | Log service; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/control.ts:26-30,32` |
| 51 | `memory.importLegacy` | `POST /memory/import` | WP-05 | MemoryManagement legacy import; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:17` |
| 52 | `memory.notes` | `GET /memory/notes` | WP-05 | MemoryManagement list; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:12` |
| 53 | `memory.remember` | `POST /memory/notes` | WP-05 | MemoryManagement create; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:13` |
| 54 | `memory.update` | `PATCH /memory/notes/{id}` | WP-05 | MemoryManagement update; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:14` |
| 55 | `memory.forget` | `DELETE /memory/notes/{id}` | WP-05 | MemoryManagement delete; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:15` |
| 56 | `memory.rebuild` | `POST /memory/rebuild` | WP-05 | MemoryManagement rebuild; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:18` |
| 57 | `memory.reset` | `POST /memory/reset` | WP-05 | MemoryManagement reset; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:16` |
| 58 | `memory.status` | `GET /memory/status` | WP-05 | MemoryManagement status; no session；[L] handler 无依赖但 layer 构造依赖 session（memory group -> Memory.layer -> Session/SessionStatus） | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:11` |
| 59 | `path.get` | `GET /path` | WP-07 | Instance paths; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:29-38,94` |
| 60 | `project.list` | `GET /project` | WP-04 | Project service list; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/project.ts:14-16,42` |
| 61 | `project.current` | `GET /project/current` | WP-04 | Instance project; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/project.ts:18-20,42` |
| 62 | `project.initGit` | `POST /project/git/init` | WP-04 | Project git init + instance reload; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/project.ts:22-33,42` |
| 63 | `project.update` | `PATCH /project/{projectID}` | WP-04 | Project update; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/project.ts:35-40,42` |
| 64 | `app.skills` | `GET /skill` | WP-07 | Skill service list; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:80-82,102` |
| 65 | `vcs.get` | `GET /vcs` | WP-04 | VCS branch info; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:40-43,95` |
| 66 | `vcs.apply` | `POST /vcs/apply` | WP-04 | VCS patch apply; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:57-70,99` |
| 67 | `vcs.diff` | `GET /vcs/diff` | WP-04 | VCS diff; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:49-51,97` |
| 68 | `vcs.diff.raw` | `GET /vcs/diff/raw` | WP-04 | VCS raw diff; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:53-55,98` |
| 69 | `vcs.status` | `GET /vcs/status` | WP-04 | VCS status; no session | `packages/chimera/src/server/routes/instance/httpapi/handlers/instance.ts:45-47,96` |

### 6.1 layer-blocked 清单（30 条，不进首批）

| group | operationIds | 构造层依赖 |
|---|---|---|
| config（9） | `config.get`、`config.update`、`config.modelSelection.get`、`config.modelSelection.update`、`config.providers`、`config.remoteCompaction.get`、`config.remoteCompaction.update`、`config.remoteCompaction.eligibility.list`、`config.remoteCompaction.eligibility.update` | group 构造取 `Session.Service`（`handlers/config.ts:29`） |
| experimental（9） | `experimental.capabilities.get`、`experimental.console.get`、`experimental.console.listOrgs`、`experimental.console.switchOrg`、`experimental.resource.list`、`worktree.list`、`worktree.create`、`worktree.remove`、`worktree.reset` | group 构造取 `BackgroundJob.Service`（`handlers/experimental.ts:29`）；`ToolRegistry`/`Worktree` 间接带 `Session` |
| workspace（4） | `experimental.workspace.list`、`experimental.workspace.create`、`experimental.workspace.adapter.list`、`experimental.workspace.status` | `Workspace.layer` 取 `Session.Service` + `SessionPrompt.Service`（`control-plane/workspace.ts:171-172,1085,1087`） |
| memory（8） | `memory.importLegacy`、`memory.notes`、`memory.remember`、`memory.update`、`memory.forget`、`memory.rebuild`、`memory.reset`、`memory.status` | `MemoryManagement` -> `Memory.layer` 取 `Session` + `SessionStatus`（`memory/management.ts:206-209,370`、`memory/memory.ts:420-425`） |

## 7. 对首批范围的建议

建议按“最小闭环 + 可独立验证”排序，而不是按 96 条整体推进：

1. **先接 construction-clean 的无状态/配置/项目面**：`global.health`、`global.config.*`、`global.preferences.*`、`project.*`、`path.get`、`file.*`、`find.*`、`vcs.*`、`app.agents`、`app.skills`、`command.list`、`formatter.status`、`auth.*`、`app.log`、`instance.dispose`。**不要**把 `config.*` 放进首批：它属于 layer-blocked（§6.1）。
2. **再接 graph**：graph 是独立数据面且 group 构造无 session 依赖，适合作为 WP-06 的 parity 试点。`memory.*` 虽然也是独立数据面，但 layer 构造依赖 session，先走代理。
3. **pty/tui/event 单独处理**：它们虽然是 host-first 或 special，但有 WebSocket/SSE/交互语义，不能混进普通 JSON 路由。
4. **session-storage 等数据面**：`session.list/get/update/children/messages/...` 在 WP-05 的权威矩阵和换权协议就绪后再接；`session.get` 因为 resume kick 归 execution，不在 storage 批次。
5. **session-execution 与 layer-blocked 继续代理**：8 条硬边界 + 30 条 layer-blocked 都不进入首批。

## 8. 建议与待拍板

### 8.1 建议

1. 接受 **39/30/27** 三分：39 条 construction-clean host-first 可进首批；30 条 layer-blocked 与 27 条 session-dependent 列入“代理保留”清单，而不是“待迁移”清单。
2. 对 19 条 session-storage 路由，先做只读投影/双读验证，不直接换写权。
3. 对 8 条 session-execution 路由，记录“Bun 代理 + 事件桥”的验收向量，等 W3 会话闭环后再评估。
4. 把 `session.get` 的 resume kick 作为显式已知差异写入 WP-10 的语义点映射，避免后续误判为纯读。
5. 30 条 layer-blocked 的解除条件写进 WP-10/WP-05 的依赖表：只有对应 group 的构造层不再需要 Session/SessionPrompt/BackgroundJob/SessionStatus，才重新评估首批资格。

### 8.2 待拍板

| 项 | 需要决定 | 默认建议 |
|---|---|---|
| D-WP04-1 | 是否接受 39/30/27 三分作为 W2 首批范围 | 接受；首批只从 39 条 construction-clean 中选 |
| D-WP04-2 | 19 条 session-storage 是否允许数据面迁移后先接 host | 允许只读投影；写路径等换权协议 |
| D-WP04-10 | 8 条 session-execution 的代理保留期 | 至少保留到 W3 首条闭环通过 |
| D-WP04-13 | 30 条 layer-blocked 是否列入代理保留 | 是；layer 依赖解除前不迁移 |

## 9. 证据索引

| 证据 | 位置 |
|---|---|
| 96 路由不抢跑 | `RUST_FULL_MIGRATION_PLAN.md:37,245` |
| 96 host-first 仅初步分类 | `RUST_FULL_MIGRATION_PLAN.md:25,151` |
| inventory 分组规则 | `packages/chimera/script/httpapi-inventory.ts:104-170` |
| inventory 首次分类声明 | `packages/chimera/script/httpapi-inventory.ts:16-17` |
| session.get resume kick | `packages/chimera/src/server/routes/instance/httpapi/handlers/session.ts:113-116` |
| Session.remove background cancel | `packages/chimera/src/session/session.ts:803-808` |
| Workspace.remove 级联 | `packages/chimera/src/control-plane/workspace.ts:959-972` |
| SessionStatus 进程内状态 | `packages/chimera/src/session/status.ts:62-74` |
| 96 行 fixture | `packages/chimera/test/oracle/http/triage-96.json` |
| config group 构造依赖 Session | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:28-29` |
| experimental group 构造依赖 BackgroundJob/ToolRegistry/Worktree | `packages/chimera/src/server/routes/instance/httpapi/handlers/experimental.ts:27,28,29; packages/chimera/src/tool/registry.ts:576,586; packages/chimera/src/worktree/index.ts:564; packages/chimera/src/project/instance-layer.ts:4-8; packages/chimera/src/project/bootstrap.ts:66` |
| Workspace.layer 构造依赖 Session/SessionPrompt | `packages/chimera/src/control-plane/workspace.ts:171-172,1085,1087` |
| memory group 构造依赖 Session/SessionStatus | `packages/chimera/src/server/routes/instance/httpapi/handlers/memory.ts:8; packages/chimera/src/memory/management.ts:206-209,370; packages/chimera/src/memory/memory.ts:420-425` |
| 构造层依赖机检清单 | `packages/chimera/test/oracle/http/triage-96.json` 的 `constructionLayerDeps` |