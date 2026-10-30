# 116/54 覆盖差距逐项 owner

> 契约版本：`cr-2026-10-30-r1`。工作包：WP-04。基线：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
> 本文件回答 DoD 第 2 项：116/54 覆盖差距逐项有 owner。

## 1. 差距的出处

计划第 25 行给出结论：`170 ops、96 host-first（仅初步分类）、116 exercise/54 none`；第 151 行要求冻结 170 op inventory 并补运行时错误/鉴权/目录 workspace 代理/WS 矩阵。代码侧的出处是：

- `packages/chimera/script/httpapi-inventory.ts:16-17`：分类是“deliberate H0 first-pass freeze, not an approved implementation plan”。
- `packages/chimera/script/httpapi-inventory.ts:177-186`：`exerciseKeys()` 用正则扫描 `httpapi-exercise.ts` 中的 `.get/.post/...("path")`，得到 exercise 路径集合。
- `packages/chimera/script/httpapi-inventory.ts:242`：`parityCoverage = exercise.has("METHOD path") ? "exercise" : "none"`。
- `packages/chimera/script/httpapi-exercise.ts:1-20`：exerciser 的定位是 route-coverage/parity harness，不是完整 oracle；当前只覆盖 Effect/Hono 双臂与隔离 mutating 场景。
- `packages/chimera/script/httpapi-exercise.ts:68-69`：`Mode = "effect" | "parity" | "coverage"` 与 `Backend = "effect" | "legacy"`，说明双臂边界。

因此 116/54 的含义是：

| 值 | 含义 | 剩余差距 |
|---|---|---|
| `exercise`（116） | `httpapi-exercise.ts` 中存在该 method+path 的场景 | 场景可复用，但不是 TS/Rust 完成；缺 recorder/replay、SSE/DBtrace、错误/鉴权矩阵 |
| `none`（54） | exerciser 中没有该 method+path 的场景 | 需要新增 HTTP fixture/场景，按 domain 归 owner |

**重要**：`exercise` 不等于“已验收”。计划明确说 exerciser“可复用但不是 TS/Rust 完成；完整 SSE/DBtrace 需扩”。所以 116 行的 owner 仍要负责把场景升级为可比较的 oracle，而不是把现有场景当作完成证据。

## 2. 总览

| group | operations | exercise | none |
|---|---|---|---|
| config | 10 | 3 | 7 |
| control | 3 | 3 | 0 |
| event | 1 | 1 | 0 |
| experimental | 13 | 11 | 2 |
| file | 6 | 6 | 0 |
| global | 10 | 6 | 4 |
| graph | 6 | 0 | 6 |
| instance | 12 | 9 | 3 |
| mcp | 8 | 8 | 0 |
| memory | 8 | 0 | 8 |
| permission | 2 | 2 | 0 |
| process | 1 | 0 | 1 |
| project | 4 | 4 | 0 |
| provider | 5 | 4 | 1 |
| pty | 8 | 7 | 1 |
| question | 3 | 3 | 0 |
| session | 32 | 27 | 5 |
| sync | 4 | 3 | 1 |
| tui | 13 | 13 | 0 |
| v2 | 5 | 0 | 5 |
| v2 credentials | 2 | 0 | 2 |
| v2 integrations | 7 | 0 | 7 |
| v2 messages | 1 | 0 | 1 |
| workspace | 6 | 6 | 0 |
| **total** | **170** | **116** | **54** |

## 3. Owner 负载

| owner | operations |
|---|---|
| WP-04 | 15 |
| WP-05 | 8 |
| WP-06 | 6 |
| WP-07 | 27 |
| WP-08 | 14 |
| WP-09 | 8 |
| WP-10 | 92 |
| **total** | **170** |

分配规则：

- `contractOwner = WP-04` 对所有 170 行负责 HTTP 契约层（fixture 结构、生成链、SDK 漂移门）。
- `semanticOwner` 是该行缺失行为 fixture 的业务域 owner；每行恰好一个。
- 分组默认 owner：config/control/experimental/session/sync/tui/v2/v2 messages/workspace → WP-10；global/event/process/pty/instance → WP-07；mcp → WP-09；memory → WP-05；graph → WP-06；provider/v2 credentials/v2 integrations → WP-08；file/project → WP-04。
- 操作级覆盖：`vcs.get/apply/diff/diff.raw/status` 从 instance 组改归 WP-04（VCS 是项目/文件面，不是运行时面）。

## 4. 54 条 `none` 逐项 owner

| # | operationId | method path | semanticOwner | gapAction | gapDetail |
|---|---|---|---|---|---|
| 1 | `v2.credential.update` | `PATCH /api/credential/{credentialID}` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 credential update |
| 2 | `v2.credential.remove` | `DELETE /api/credential/{credentialID}` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 credential removal |
| 3 | `v2.integration.list` | `GET /api/integration` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 integration discovery |
| 4 | `v2.integration.attempt.status` | `GET /api/integration/attempt/{attemptID}` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 OAuth attempt status |
| 5 | `v2.integration.attempt.cancel` | `DELETE /api/integration/attempt/{attemptID}` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 OAuth attempt cancel |
| 6 | `v2.integration.attempt.complete` | `POST /api/integration/attempt/{attemptID}/complete` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 OAuth attempt complete |
| 7 | `v2.integration.get` | `GET /api/integration/{integrationID}` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 integration detail |
| 8 | `v2.integration.connect.key` | `POST /api/integration/{integrationID}/connect/key` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 key connect |
| 9 | `v2.integration.connect.oauth` | `POST /api/integration/{integrationID}/connect/oauth` | WP-08 | `add-auth-fixture` | missing HTTP scenario: v2 OAuth connect |
| 10 | `v2.session.list` | `GET /api/session` | WP-10 | `add-v2-session-fixture` | missing HTTP scenario: v2 session list |
| 11 | `v2.session.compact` | `POST /api/session/{sessionID}/compact` | WP-10 | `add-v2-session-fixture` | missing HTTP scenario: v2 compact |
| 12 | `v2.session.context` | `GET /api/session/{sessionID}/context` | WP-10 | `add-v2-session-fixture` | missing HTTP scenario: v2 context |
| 13 | `v2.session.messages` | `GET /api/session/{sessionID}/message` | WP-10 | `add-v2-session-fixture` | missing HTTP scenario: v2 messages |
| 14 | `v2.session.prompt` | `POST /api/session/{sessionID}/prompt` | WP-10 | `add-v2-session-fixture` | missing HTTP scenario: v2 prompt |
| 15 | `v2.session.wait` | `POST /api/session/{sessionID}/wait` | WP-10 | `add-v2-session-fixture` | missing HTTP scenario: v2 wait |
| 16 | `config.modelSelection.get` | `GET /config/model-selection` | WP-10 | `add-config-fixture` | missing HTTP scenario: model selection read |
| 17 | `config.modelSelection.update` | `PATCH /config/model-selection` | WP-10 | `add-config-fixture` | missing HTTP scenario: model selection write |
| 18 | `config.remoteCompaction.get` | `GET /config/remote-compaction` | WP-10 | `add-config-fixture` | missing HTTP scenario: remote compaction policy read |
| 19 | `config.remoteCompaction.update` | `PATCH /config/remote-compaction` | WP-10 | `add-config-fixture` | missing HTTP scenario: remote compaction policy write |
| 20 | `config.remoteCompaction.eligibility.list` | `GET /config/remote-compaction/eligibility` | WP-10 | `add-config-fixture` | missing HTTP scenario: remote compaction eligibility list |
| 21 | `config.remoteCompaction.eligibility.update` | `PATCH /config/remote-compaction/eligibility` | WP-10 | `add-config-fixture` | missing HTTP scenario: remote compaction eligibility write |
| 22 | `config.remoteCompaction.status` | `GET /config/remote-compaction/status` | WP-10 | `add-config-fixture` | missing HTTP scenario: remote compaction status |
| 23 | `experimental.capabilities.get` | `GET /experimental/capabilities` | WP-10 | `add-runtime-capability-fixture` | missing HTTP scenario: runtime capability probe |
| 24 | `experimental.session.background` | `POST /experimental/session/{sessionID}/background` | WP-10 | `add-job-family-fixture` | missing HTTP scenario: background job promotion |
| 25 | `global.browserArtifact` | `GET /global/browser-artifact/{projectHash}/{sessionHash}/{filename}` | WP-07 | `add-global-runtime-fixture` | missing HTTP scenario: browser artifact bytes |
| 26 | `global.preferences.get` | `GET /global/preferences` | WP-07 | `add-global-runtime-fixture` | missing HTTP scenario: WebUI preferences read |
| 27 | `global.preferences.update` | `PUT /global/preferences` | WP-07 | `add-global-runtime-fixture` | missing HTTP scenario: WebUI preferences write |
| 28 | `global.presence` | `POST /global/presence` | WP-07 | `add-global-runtime-fixture` | missing HTTP scenario: presence heartbeat |
| 29 | `graph.file.symbols` | `GET /graph/file/symbols` | WP-06 | `add-graph-fixture` | missing HTTP scenario: graph file symbols |
| 30 | `graph.files` | `GET /graph/files` | WP-06 | `add-graph-fixture` | missing HTTP scenario: graph files |
| 31 | `graph.impact` | `GET /graph/impact` | WP-06 | `add-graph-fixture` | missing HTTP scenario: graph impact |
| 32 | `graph.node` | `GET /graph/node/{nodeID}` | WP-06 | `add-graph-fixture` | missing HTTP scenario: graph node |
| 33 | `graph.search` | `GET /graph/search` | WP-06 | `add-graph-fixture` | missing HTTP scenario: graph search |
| 34 | `graph.status` | `GET /graph/status` | WP-06 | `add-graph-fixture` | missing HTTP scenario: graph status |
| 35 | `memory.importLegacy` | `POST /memory/import` | WP-05 | `add-memory-fixture` | missing HTTP scenario: legacy memory import |
| 36 | `memory.notes` | `GET /memory/notes` | WP-05 | `add-memory-fixture` | missing HTTP scenario: memory notes list |
| 37 | `memory.remember` | `POST /memory/notes` | WP-05 | `add-memory-fixture` | missing HTTP scenario: memory note create |
| 38 | `memory.update` | `PATCH /memory/notes/{id}` | WP-05 | `add-memory-fixture` | missing HTTP scenario: memory note update |
| 39 | `memory.forget` | `DELETE /memory/notes/{id}` | WP-05 | `add-memory-fixture` | missing HTTP scenario: memory note delete |
| 40 | `memory.rebuild` | `POST /memory/rebuild` | WP-05 | `add-memory-fixture` | missing HTTP scenario: memory rebuild |
| 41 | `memory.reset` | `POST /memory/reset` | WP-05 | `add-memory-fixture` | missing HTTP scenario: memory reset |
| 42 | `memory.status` | `GET /memory/status` | WP-05 | `add-memory-fixture` | missing HTTP scenario: memory status |
| 43 | `process.list` | `GET /process` | WP-07 | `add-process-registry-fixture` | missing HTTP scenario: session process registry list |
| 44 | `provider.balance` | `GET /provider/{providerID}/balance` | WP-08 | `add-provider-auth-fixture` | missing HTTP scenario: provider balance |
| 45 | `pty.connectToken` | `POST /pty/{ptyID}/connect-token` | WP-07 | `add-pty-ticket-fixture` | missing HTTP scenario: PTY websocket ticket |
| 46 | `session.backgroundQuiescence` | `GET /session/{sessionID}/background/quiescence` | WP-10 | `add-session-fixture` | missing HTTP scenario: background quiescence |
| 47 | `session.goal` | `GET /session/{sessionID}/goal` | WP-10 | `add-session-fixture` | missing HTTP scenario: session goal read |
| 48 | `session.goalSet` | `PUT /session/{sessionID}/goal` | WP-10 | `add-session-fixture` | missing HTTP scenario: session goal set |
| 49 | `session.goalClear` | `DELETE /session/{sessionID}/goal` | WP-10 | `add-session-fixture` | missing HTTP scenario: session goal clear |
| 50 | `session.workBrief` | `GET /session/{sessionID}/work_brief` | WP-10 | `add-session-fixture` | missing HTTP scenario: session work brief |
| 51 | `sync.steal` | `POST /sync/steal` | WP-10 | `add-sync-fixture` | missing HTTP scenario: session steal |
| 52 | `vcs.apply` | `POST /vcs/apply` | WP-04 | `add-vcs-fixture` | missing HTTP scenario: VCS patch apply |
| 53 | `vcs.diff.raw` | `GET /vcs/diff/raw` | WP-04 | `add-vcs-fixture` | missing HTTP scenario: raw VCS diff |
| 54 | `vcs.status` | `GET /vcs/status` | WP-04 | `add-vcs-fixture` | missing HTTP scenario: VCS status |

## 5. 116 条 `exercise` 按 owner 归组

| semanticOwner | count | operations |
|---|---|---|
| WP-04 | 12 | `file.list`, `file.read`, `file.status`, `find.text`, `find.files`, `find.symbols`, `project.list`, `project.current`, `project.initGit`, `project.update`, `vcs.get`, `vcs.diff` |
| WP-07 | 21 | `app.agents`, `command.list`, `event.subscribe`, `formatter.status`, `global.config.get`, `global.config.update`, `global.dispose`, `global.event`, `global.health`, `global.upgrade`, `instance.dispose`, `lsp.status`, `path.get`, `pty.list`, `pty.create`, `pty.shells`, `pty.get`, `pty.update`, `pty.remove`, `pty.connect`, `app.skills` |
| WP-08 | 4 | `provider.list`, `provider.auth`, `provider.oauth.authorize`, `provider.oauth.callback` |
| WP-09 | 8 | `mcp.status`, `mcp.add`, `mcp.auth.start`, `mcp.auth.remove`, `mcp.auth.authenticate`, `mcp.auth.callback`, `mcp.connect`, `mcp.disconnect` |
| WP-10 | 71 | `auth.set`, `auth.remove`, `config.get`, `config.update`, `config.providers`, `experimental.console.get`, `experimental.console.listOrgs`, `experimental.console.switchOrg`, `experimental.resource.list`, `experimental.session.list`, `tool.list`, `tool.ids`, `experimental.workspace.list`, `experimental.workspace.create`, `experimental.workspace.adapter.list`, `experimental.workspace.status`, `experimental.workspace.warp`, `experimental.workspace.remove`, `worktree.list`, `worktree.create`, `worktree.remove`, `worktree.reset`, `app.log`, `permission.list`, `permission.reply`, `question.list`, `question.reject`, `question.reply`, `session.list`, `session.create`, `session.status`, `session.get`, `session.update`, `session.delete`, `session.abort`, `session.children`, `session.command`, `session.diff`, `session.fork`, `session.init`, `session.messages`, `session.prompt`, `session.message`, `session.deleteMessage`, `part.update`, `part.delete`, `permission.respond`, `session.prompt_async`, `session.revert`, `session.share`, `session.unshare`, `session.shell`, `session.summarize`, `session.todo`, `session.unrevert`, `sync.history.list`, `sync.replay`, `sync.start`, `tui.appendPrompt`, `tui.clearPrompt`, `tui.control.next`, `tui.control.response`, `tui.executeCommand`, `tui.openHelp`, `tui.openModels`, `tui.openSessions`, `tui.openThemes`, `tui.publish`, `tui.selectSession`, `tui.showToast`, `tui.submitPrompt` |

说明：`exercise` 行的 `gapAction` 统一为 `extend-exercise`；`gapDetail` 统一为“recorder/replay + SSE/DBtrace (WP-02/WP-03)”。WP-04 负责把 HTTP 场景升级为可比较的 oracle 输入，WP-02/WP-03 提供 recorder/comparator。

## 6. 建议与待拍板

### 6.1 建议

1. 54 条 none 按 domain owner 进入各自包的 fixture backlog；WP-04 不代写 domain fixture，只提供 HTTP 契约壳。
2. 116 条 exercise 不重复造场景；先由 WP-02 把现有 exerciser 记录为可重放轨迹，再由 WP-03 接入比较器。
3. 运行时错误/鉴权/目录 workspace 代理/WS 矩阵作为跨组的横向补充，优先覆盖 54 条 none 中的 v2、graph、memory、global 四组。
4. 每个 owner 在进入 building 时把 `oracle_commands` 从空数组改为包内可独立运行的 focused 命令（manifest 当前按 WP-01 约定为空）。

### 6.2 待拍板

| 项 | 需要决定 | 默认建议 |
|---|---|---|
| D-WP04-7 | 116 条 exercise 的 owner 是“场景 owner”还是“验收 owner” | 场景 owner 归 WP-04；验收 owner 归各 domain WP |
| D-WP04-8 | 54 条 none 是否全部进 G0 出口，还是允许按组延后 | 全部进 G0 出口；不允许空 owner |
| D-WP04-9 | 运行时错误/鉴权/WS 矩阵是否单列一个横向工作包 | 先由 WP-04 在 HTTP 契约层记录，domain 包按需扩展 |

## 7. 证据索引

| 证据 | 位置 |
|---|---|
| 116/54 结论 | `RUST_FULL_MIGRATION_PLAN.md:25` |
| 170 op 冻结要求 | `RUST_FULL_MIGRATION_PLAN.md:151` |
| 首次分类声明 | `packages/chimera/script/httpapi-inventory.ts:16-17` |
| exerciseKeys 正则 | `packages/chimera/script/httpapi-inventory.ts:177-186` |
| parityCoverage 赋值 | `packages/chimera/script/httpapi-inventory.ts:242` |
| exerciser 双臂/隔离 | `packages/chimera/script/httpapi-exercise.ts:1-20,68-69` |
| 170 行 fixture | `packages/chimera/test/oracle/http/coverage-170.json` |