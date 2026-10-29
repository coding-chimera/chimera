# Workflow 采用率提升计划（swarm 合并 + ultra 提示词）

> 计划文档（2026-10-28）。本文记录决策、方案与验收口径，不代表已实施。除标注 `newweb/` 外，路径均相对 `packages/chimera`；`file:line` 基于当日 checkout 取证，实施前应重新核对。关联快照：`specs/orchestrate-claude-workflow.md`。

## 背景与目标

### 现状

Chimera 目前有三套多代理执行面：

- `task`：单发子代理，可续跑（`task_id`），可后台。
- `chimera_swarm`：声明式、同构、证据驱动的批处理，可后台。
- `orchestrate`：模型编写的异步程序，程序内 fan-out / pipeline / 合成。

三者共享 `SubagentDispatch`，但模型面与执行面各自演化。ultra 提示词的默认派发对象是 `task` / `chimera_swarm`：`ultra.txt:5` 把编辑派给二者，`ultra.txt:22` 把 `orchestrate` 限定为“5+ subagents 或依赖/需要程序内合成”，并把简单同构 fan-out 推回 `chimera_swarm`。DeepSeek ultra 层的五条规则全部是 swarm（`deepseek-ultra.txt:3-25`）；最强的编排措辞藏在按需加载的 skill 里（`SKILL.md:21`）。`chimera.txt:23` 的多代理段落也只提 `task` / `chimera_swarm`。

结果是模型在三个入口之间做“哪个更轻”的成本比较，必然滑向 `task` 或 `swarm`。`orchestrate` 的程序内合成、上下文隔离、异构 worker、schema 输出等能力因此长期闲置。

### CC 对照动机

Claude Code 只有 Agent + Workflow 两件套（`specs/orchestrate-claude-workflow.md:15`）：Agent 负责单发，Workflow 负责可编程编排，且 Workflow 本身是后台任务（task ID + 完成通知 + 阶段树）。这是模型训练分布里熟悉的形状。

Chimera 的三件套对模型是分布外的：多一个入口就多一次成本比较，而工具描述又把默认推向最轻的入口。对齐 CC 不等于照搬：Chimera 的 `orchestrate` 有真实持久化子会话、进程级隔离、图/审计闭环，这些是优势；要补的是“单一默认入口 + 后台语义 + 审批预览”，不是 VM 沙箱、预算或 resume。

### 目标

1. 让 `orchestrate` 成为 ultra 根会话处理实质性任务的唯一默认入口，并可用会话工具调用记录度量采用率。
2. 在不丢能力的前提下收敛 `chimera_swarm` / `orchestrate` 重复的执行与通知机制，降低维护面。
3. 提示词改动可独立回退，测试锚点与预算基线齐全。
4. 把“改名 `chimera_workflow`”与“phase 一等概念”两个未拍板项显式挂起，并写清它们对本文文案的依赖。

### 非目标

- 不在本文实施 `chimera_workflow` 改名或 phase 一等概念（见第三部分）。
- 不改 `orchestrate` 的子进程协议、resume、worktree、脚本内预算。
- 不做 CC 式关键词触发（`ultracode` reminder）；本文把 ultra 变体本身当作 standing opt-in。
- 不为了“少一个工具名”而删除 `chimera_swarm`；是否最终删除由 telemetry 决定（见 1.4 / 1.6 P3）。

## 结论摘要

| # | 决策 | 理由（一句话） |
|---|---|---|
| 1 | `chimera_swarm` 不删除，降为声明式 facade（方案 B） | swarm 有 6 项 `orchestrate` 没有的能力，删除成本高于维护成本；真正重复的是执行/通知层，不是 schema。 |
| 2 | 抽出 `WorkerBatch` + `batch-source` / `batch-preset` 共享引擎 | 约 300 行 job/通知/池逻辑是唯一实质重复，复用应落在两者之下，而不是让编程编排依赖工具层。 |
| 3 | `orchestrate` P0 后台化：program 级 job + settled 逐 worker 注入 | 补上唯一硬缺口（后台 + 逐 worker 通知），同时为 P3 删除 swarm 留出零功能损失路径。 |
| 4 | 先修 `orchestrate` 权限旁路 | 无 `task` 权限的子代理当前仍可调 `orchestrate`（`subagent-permissions.ts:21` 只 deny task/swarm），后台化前必须堵住。 |
| 5 | ultra 的默认入口改为 `orchestrate`，`task` / `swarm` 降为例外 | 单一默认入口消除三选一的成本比较；例外用一句话硬边界约束。 |
| 6 | 删除“5+ 才用”门槛，改 2-4 / 5-9 / 10-30 档位 + 首次派发前一行计划 | 给档位不给门槛，把“要不要编排”变成“编排什么”，并让成本对用户可见。 |
| 7 | `deepseek-ultra.txt` 五条 swarm 规则重写为八条 orchestrate 纪律 | 当前该层是纯 swarm 引导，与新的默认入口直接冲突。 |
| 8 | `chimera.txt` 的多代理段落同批改 | 它是 ultra 根会话实际注入的 capability layer；不改会出现系统提示自相矛盾。 |
| 9 | swarm 相关文案采用情形 B（保留 swarm 的硬边界） | 与第一部分推荐 B 一致；边界 (a)（后台）在 P0 落地后应退役，仅保留 preset/from。 |
| 10 | 改名与 phase 不在本文实施，只在提示词中预留替换点 | 两项均未拍板；先落采用率改动，避免一次改动同时承担语义与命名风险。 |
| 11 | 测试预算基线重录，并新增防回退断言 | 当前工作树 `prompt-budget.test.ts` 已因 `110187 > 109718` 失败，基线本身已漂移。 |

---

## 第一部分：swarm 与 orchestrate 的关系判定与合并方案

### 1.1 能力矩阵（精简版）

| 维度 | `task` | `chimera_swarm` | `orchestrate` |
|---|---|---|---|
| 执行形态 | 单发，可续跑 | 声明式、同构批处理 | 程序化、异构编排 |
| `background` | 有（`task.ts:376-503`） | 有，每 worker 一个 job（`swarm.ts:803-1044`） | **无**，阻塞到程序结束，仅 `timeoutMs`（`orchestrate.ts:19-34,177-187`） |
| 逐 worker 完成通知 | 仅后台（`task.ts:335-375`） | 仅后台，`<swarm_worker_result>`（`swarm.ts:817-852,452-472`） | **无**，仅 ToolPart.metadata 进度（`orchestrate.ts:146-155`） |
| 证据源 `from` | 无 | 有，7 个 source，limit ≤100（`swarm.ts:374-393,27-35,496`） | 无，程序只暴露 `orche.agent`（`host-bindings.ts:305-308`） |
| `preset` | 无 | 有，4 个 preset + RETURN_CONTRACT（`swarm.ts:187-224,510`） | 无，靠 `orchestrate-authoring` skill（`orchestrate.txt:11`） |
| scope 冲突告警 | 无 | 有，advisory（`swarm.ts:279-302,645-649`） | 无 |
| 程序控制流 | 无 | 无（模板逐项渲染） | 有，任意 async JS（`child-main.ts:319-325`） |
| `pipeline` | 无 | 无 | 有（`child-main.ts:231-253`） |
| 程序内合成 `return` | 无 | 无，仅聚合 results JSON（`swarm.ts:1128-1163`） | 有（`child-main.ts:345-360`） |
| 结构化 `schema` | 无 | 无，文本标签解析（`swarm.ts:410-433`） | 有，`json_schema` + 2 次重试（`host-bindings.ts:251-259,123-129`） |
| 异构 worker | 有（每次独立 prepare） | 无（一次 prepare 共享 route，`swarm.ts:549-579`） | 有（每 agent 独立 prepare，`host-bindings.ts:226-233`） |
| 并发上限 | 前台 `DelegationLimiter` 128 / 后台池 16 | 自身 semaphore 16 / 后台池 16 / 前台 128 | 程序内 FIFO 16 + `maxTotalAgents` 64/256 + 每次 dispatch 128 |
| 审批 | `task` + `task_profile` / `task_model` | `task` 一次 + profile/model 一次 | `orchestrate` 一次 + 每 `orche.agent` 的 `task`；**缺 profile/model 校验** |
| 结果回父 | 内联 `<task_result>` / 后台合成 | JSON results + outputFile / 逐条通知 | 单个 tool output（`## Logs` + `## Result`） |

### 1.2 子集判定证据

**共享核心只有一个：`SubagentDispatch`。**

- 三者都走 `prepare`（`subagent-dispatch.ts:118`）→ `materialize`（`:244-308`，`sessions.create` 只在 `:270`）→ `runPrepared`（`:533-541`）或 `runPreparedBackground`（`:547-551`）。
- 入口：`task.ts:125,216`、`swarm.ts:479,549`、`orchestrate.ts:99` + `host-bindings.ts:317`。
- 深度上限、嵌套 deny、模型路由、子会话自有 job 的 park 都在这一层（`subagent-dispatch.ts:260-266,363-389`）。

**`chimera_swarm` 独有、`orchestrate` 无对应 surface 的 6 项：**

1. **background + 后台池**：每 worker 注册 job（前台 `metadata.background:false`，后台 `true`），占 `delegation.background_concurrent`，受 kill-switch；`swarm.ts:803-985`（后台）、`:987-1044`（前台）、`:1196-1204`（kill-switch）。`orchestrate` 未 import `BackgroundJob`。
2. **逐 worker 完成通知**：job settle → `wait` → `injectSynthetic` → `markDelivered`；`swarm.ts:817-852`，文本格式 `:452-472`。`orchestrate` 只有 `onEvent` 投影到 ToolPart.metadata（`orchestrate.ts:146-155`）。
3. **`from` 证据源物化**：`materializeSource` 读 obligation store / oracle jsonl；`swarm.ts:374-393`，source 定义 `:27-35`，limit `:496`。`orchestrate` 程序无受支持的 store 绑定（`host-bindings.ts:305-308`）。
4. **`preset` / `RETURN_CONTRACT`**：`DEFAULT_TEMPLATES` `swarm.ts:187-224`，来源/子代理推断 `:239-249`，渲染 `:298-302,509-512`。
5. **scope 冲突告警**：`itemScopeFiles` / `collectScopeWarnings` `swarm.ts:266-302`，metadata `:644-649`/`:965-969`；仅 advisory，不锁文件（`swarm.txt:56`）。
6. **summary / outputFile / per-worker cancel handle**：`extractSummary` `swarm.ts:410-433`，完整输出落 Truncate `:435-441,1081`；取消入口 `task-cancel.ts:50,60`，swarm 的 onInterrupt 取消子会话 `swarm.ts:905`（后台）/:1003（前台）。

**`orchestrate` 独有、`swarm` 不可能有的能力：**

- 任意控制流（`child-main.ts:319-325`）、`orche.pipeline`（`:231-253`）、程序内合成 `return`（`:345-360`）。
- 每 agent 的 `model` / `agent` / `label` / `schema`（`host-bindings.ts:226-259`）；`schema` 校验 2 次重试。
- `maxTotalAgents` 64/256（`orchestrate.ts:15-16`）、`timeoutMs`、独立 OS 子进程隔离。
- 子会话真实持久化、可单独取消；中间消息/工具输出永不进父上下文（`host-bindings.ts:4-8`）。

**结论：fan-out 形状是子集，能力面不是。** 今天把 `chimera_swarm` 做 `orchestrate` 的纯别名会丢后台审计 follow-up 工作流、证据源物化和 preset 便利，必须先把 6 项能力搬进 `orchestrate`，否则不能合并。

### 1.3 三选项对比

| 方案 | 做法 | 收益 | 成本 / 风险 | 结论 |
|---|---|---|---|---|
| **A 删除** | 删除 `chimera_swarm`，能力搬进 `orchestrate` | 对齐 CC 两件套，模型面最小 | 6 项能力搬迁 + 2642 行测试 + WebUI/TUI 重写 + registry/权限/telemetry 全面下线；声明式批处理被迫写成 JS，token 与失败率上升 | 成本最高，收益只是少一个工具名；仅在 P3 telemetry 支持时执行 |
| **B 薄 facade + 共享引擎** | 保留 swarm schema/from/preset/scope；把 background/job/通知/cancel/池抽成 `WorkerBatch`，swarm 与 `orche.batch` 共用 | 复用真正重复的约 300 行；不牺牲声明式 ergonomics；可分阶段、可回退 | 需要一次行为保持型重构；facade parity 测试成本 | **推荐** |
| **C 永久并存** | 维持现状，只改提示词 | 风险最低，改动最小 | 维护面不降，三选一认知负担持续；边界靠 prompt 维持，仍会误用 | 只作为过渡态，不作为终态 |

### 1.4 推荐结论

**推荐 B：保留 `chimera_swarm` 作为声明式 facade，执行/通知层抽共享引擎。**

- 复用度最高的是执行/通知层，不是 schema。把 `WorkerBatch` 抽到 `swarm` 与 `orchestrate` 之下，才能让“编程编排”不依赖工具 schema / UI。
- 不牺牲声明式入口：`items` / `from` / `preset` / `scope` 是最省 token 的批处理方式，删掉会迫使模型写更多 JS，反而降低可靠性。
- 终态是“两个执行原语 + 一个声明式预设库”：`task` 单发、`orchestrate` 编程；`chimera_swarm` 是 `orche.batch` 的声明式外壳。
- **方向修正**：不要把 `orchestrate` 的扇出接到 swarm 工具层；共享能力要抽到两者之下的引擎。
- **P3 可选删除**：若 P2 后 telemetry 显示直调 `chimera_swarm` <5%，且模型能稳定写三行 `orche.batch` 程序，再执行 A 删除外壳；此时是零功能损失收尾。

### 1.5 `orchestrate` 需新增的 surface 与接线点

| Surface | 现状 | 新增内容 | 接线点 | 备注 |
|---|---|---|---|---|
| `background` | 无，阻塞到程序结束 | program 级 job（type `orchestrate`）、启动回执、kill-switch 隐藏参数 | `src/tool/orchestrate.ts` + `src/agent/background-job.ts` | **program 级即可**；`onInterrupt` 取消 runtime fiber + 全部子会话，不必 per-agent job |
| 逐 worker 通知 | 无 | settled 回调 → `wait` → `injectSynthetic` → `markDelivered`；program 结束再注入汇总 | `src/orchestrate/host-bindings.ts`（onEvent 已有 sessionId/status）+ `src/session/prompt.ts` | 复用 task/swarm 的 settle→inject→markDelivered 模式；只有需要独立 promote/cancel 生命周期时才做 per-agent job |
| `from` | 无 | 7 个 source + limit 20/100 | 抽 `materializeSource` 到 `src/agent/batch-source.ts`；绑定 `orche.batch({from})` | 数据仍在 `.chimera/chimera/` |
| `preset` | 无 | 4 个 preset + RETURN_CONTRACT | 抽 `DEFAULT_TEMPLATES`/`RETURN_CONTRACT` 到 `src/agent/batch-preset.ts`；绑定 `orche.batch({preset})`；skill 同步 | preset 不改变权限/工具 |
| scope 告警 | 无 | `itemScopeFiles` / `collectScopeWarnings` | 抽到 batch 模块；`orche.batch({items})` 注入 prompt 前缀 + metadata | advisory 语义不变，不锁文件 |
| summary / outputFile | 无 | 复用 `extractSummary` + Truncate | batch 模块 | 保持 swarm 现有 UX |
| per-worker cancel | 无 | `orche.agent` 返回 `{sessionId,cancel}` 或 `orche.cancel` | `host-bindings.ts` | 与 program 级取消级联一起设计 |
| `block_reason` | 无 | schema 字段 + execute 校验 | `src/tool/orchestrate.ts` | swarm 目前只声明未校验（`swarm.ts:94-97`），facade 阶段补校验或删除参数 |
| 权限 | `orchestrate` 默认 ask，但子代理 deny 不覆盖 | 无 `task` 权限时同时 deny `orchestrate` | `src/agent/subagent-permissions.ts:21` | 后台化前先修，避免权限旁路 |
| `## Background Tasks` 可见性 | 无 orchestrate job | 纳入运行时上下文 | `src/session/prompt.ts:507-540` | `task_cancel` 实现已类型无关，文案扩到 orchestrate worker 即可 |

### 1.6 迁移步骤

**P0 补 `orchestrate` 后台（additive，不改现有行为）**

- `src/tool/orchestrate.ts`：加 `background` / `block_reason`、`serviceOption(BackgroundJob)`、program 级 job、receipt、kill-switch。
- `src/orchestrate/host-bindings.ts`：补 settled 回调与 `cancel(sessionId)`；补 `task_profile` / `task_model` ask（当前缺失，见 `orchestrate.ts:109-114` 与 `host-bindings.ts:220-222` 的对照）。
- `src/agent/subagent-permissions.ts:21`：无 `task` 权限时同时 deny `orchestrate`。
- `src/session/prompt.ts:507-540`：`## Background Tasks` 纳入 orchestrate job；`src/tool/task-cancel.ts/.txt` 文案扩到 orchestrate worker。
- 测试：`test/orchestrate/*` 增加 background / cancel / dispose 三腿。
- 退出标准：后台 orchestrate 可启动、可取消、可收尾；前台行为字节不变。

**P1 抽共享引擎**

- 新建 `src/agent/worker-batch.ts`：job 注册、池预检、settle→inject→markDelivered、receipt、cancel；从 `swarm.ts:803-1044` 迁移，swarm 改为调用。
- 新建 `src/agent/batch-source.ts`、`src/agent/batch-preset.ts`：迁移 `materializeSource`、`DEFAULT_TEMPLATES` / RETURN_CONTRACT、`itemScopeFiles` / `collectScopeWarnings`。
- `host-bindings.ts` 增 `orche.batch({items|from,preset,concurrency,scope})`，复用上述模块，不改现有 API。
- 退出标准：swarm 与 `orche.batch` 走同一套 job/通知代码；现有测试全绿。

**P2 swarm 变 facade**

- `src/tool/swarm.ts` 只留 schema/校验/渲染，内部调 `WorkerBatch`；metadata 契约 `childRuns` / `childSessions` / `background` 不变，UI 零改。
- `src/tool/chimera.ts:2096-2110` 的 swarmFollowup 指引改指向 `orche.batch`；`src/tool/registry.ts` 保留 id。
- 提示与文档统一三分法：`swarm.txt`、`orchestrate.txt`、`src/session/llm.ts:175`、`ultra.txt:5,11,22`、`deepseek-ultra.txt`、`chimera.txt:23`、`subagent-model-scheduling.ts:628`、`subagent_model_schedule.txt`、`SKILL.md:12`、`AGENTS.md:35,48,66`。
- WebUI/TUI 不动；`newweb/.../SwarmRenderer.test.tsx` 加 facade 契约用例。
- 退出标准：facade parity 测试全绿；直调 swarm 的 telemetry 与旧实现一致。

**P3 可选删除（A 收尾，仅在 telemetry 支持时）**

- 删 `src/tool/swarm.ts/.txt`、registry 注册、agent allowlist/permission key、prompt 提及、`chimera.ts` 指引、TUI `index.tsx:1736,2298-2400`、`newweb/.../SwarmRenderer` + `ToolPartView.tsx:592`、`test/tool/swarm.test.ts`（引擎用例已迁）。
- 文档：`specs/orchestrate-claude-workflow.md:122`、`ULTRACODE_PLAN.md` / `UPSTREAM` 计划只加决策记录，不改历史。

### 1.7 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| ToolPart 终态后 `ctx.metadata` 失效 | 后台进度不可见 | 进度走 job 投影 / `session_status`（swarm TUI 已这么做），不能只靠 part metadata |
| program 级后台只产生单条完成通知 | 丢失逐 worker 增量合成 | 按 settled 回调逐 agent 注入，program 结束再注入汇总；不要先砍成单条 |
| cancel 级联不完整 | 孤儿 worker 继续跑 | 取消 program job 必须杀 runtime fiber 与全部子会话；补 dispose 矩阵 |
| 权限旁路 | 无 task 权限的 agent 仍可 orchestrate | P0 先修 `subagent-permissions.ts:21` |
| `block_reason` 只声明未校验 | 参数语义空洞 | facade 阶段补校验或删除参数 |
| 基线预算已红 | CI 持续失败，掩盖新增漂移 | 实施时重录 `TOOL_TOTAL_BUDGET` 等基线，并记录漂移来源 |
| facade parity 回归 | UI/通知行为变化 | 旧实现保留到 parity 测试全绿，失败即切回；无数据迁移 |
| 过度 fan-out / token 成本上升 | 单会话成本失控 | Session Goal 预算是唯一规模约束；`maxTotalAgents` 与并发窗口是护栏；监控每会话成本 |

**回退**：P0/P1 纯 additive，`swarm` 不动；P2 facade 保留旧实现直到 parity 全绿；P3 删除前保留一个 release 的旧工具注册开关。提示词改动可单文件回退（见第二部分）。

---

## 第二部分：ultra 提示词优化

### 2.0 诊断

现有提示词把“是否编排”留成三个入口之间的成本比较：

- `orchestrate.txt:15-16` 把准入线写成“5+ subagents，或依赖/需要程序内合成”，并把“simple homogeneous fan-out”明确推给 `chimera_swarm`。
- `ultra.txt:22` 只说“prefer”，且把简单 fan-out 推回 swarm。
- `deepseek-ultra.txt:3-25` 五条规则全是 swarm 派发纪律，连标题都是 `# swarm 派发纪律`。
- `SKILL.md:12,21` 把单任务/简单 fan-out 推给 `task`/`swarm`，Ultra tier 段仍以“5+ agents or per-item stages”为触发条件。
- `chimera.txt:23` 的多代理段落只提 `task` / `chimera_swarm`。

模型在三个入口之间选择时，最轻的路径总是 `task` 或 `swarm`；`orchestrate` 的程序内合成与上下文隔离优势因此没有被使用。

### 2.1 CC 机制对照表

| 机制 | Claude Code | Chimera 现状 | 本计划动作 |
|---|---|---|---|
| 执行原语数量 | Agent + Workflow 两件套 | `task` + `chimera_swarm` + `orchestrate` 三件套 | 提示词层收敛为单一默认入口；执行层按第一部分合并 |
| Workflow 默认形态 | 本身是后台任务（task ID + 通知 + 阶段树） | `orchestrate` 阻塞型调用，仅 metadata 进度 | P0 补 program 级后台 + settled 逐 worker 通知 |
| 准入条件 | 需要编排时调用 Workflow，无“5+ agents”门槛 | “5+ 或依赖/需要程序内合成” | 删除门槛，改 2-4 / 5-9 / 10-30 档位 |
| 审批预览 | workflow 启动是审批点，可先 review 动态 workflow | `orchestrate` 每次调用审批一次，但无阶段预览 | 首次派发前写一行计划（phases / agent 数 / 每阶段返回物）；phase 落地后升级为静态预览 |
| 子代理实体 | 专用 `workflow-subagent`，禁再委派 | 真实持久化子会话，可在深度内再委派 | 保持现状（Chimera 优势） |
| 编写参考 | workflow-authoring skill 在编写前加载 | `orchestrate-authoring` 按需加载，且文案把简单 fan-out 推走 | 首次程序 + 多阶段程序前必须加载 |
| 关键词触发 | `ultracode` reminder | 无对应机制 | 本文把 ultra 变体本身当作 standing opt-in；关键词触发不在范围 |
| 阶段模型 | 阶段树 + per-phase 状态 | metadata.agents 平铺 | 依赖第三部分 B（phase 一等概念） |

### 2.2 改写原则

1. **准入即默认**：ultra 变体已经是用户的显式 opt-in，注入层必须写成“每个实质性任务默认写程序”，而不是“可以考虑/优先”。
2. **单一默认入口**：多代理 fan-out 只保留 `orchestrate` 一个默认入口，其他工具用一句话硬边界约束，消除模型在三个入口之间做成本比较的空间。
3. **给档位、不给门槛**：用 2-4 / 5-9 / 10-30 的规模档位替代“5+ 才用”的准入线；`maxTotalAgents` 与 16 并发窗口是护栏，不是目标。
4. **状态行 + 审批预览**：首次派发前必须输出一行 `phases / 预计 agent 数 / 每阶段返回物`，把“要不要编排”变成“编排什么”，并让成本对用户可见。
5. **闭环唯一出口**：solo 只允许“不碰仓库的对话轮”和“琐碎机械编辑”；硬阻断只改变程序形状（pipeline / scope / 阶段），不改变是否编排；token 成本不是缩减理由，有 Session Goal 时预算才是唯一规模约束。

### 2.3 文件 1：`src/session/prompt/ultra.txt`（全文替换）

**Before（26 行）**

```text
You are running on the ultra tier: the model's highest supported reasoning effort plus proactive multi-agent delegation. Ultra is an orchestration tier, not an editing tier: spend the deep reasoning budget on decomposition, dispatch quality, and audit rather than on drafting edits in chain-of-thought.

# Orchestrator discipline

1. Do not write implementation code yourself. Feature work, bug fixes, refactors, and any multi-hunk edit are delegated to `task` or `chimera_swarm` workers. Your direct edits are limited to small fixes: a few lines in a single file to close out reviewed child work (imports, naming, an off-by-one, a missed case).
2. Own the loop: understand the request -> decompose into independent, non-overlapping, fully-contextualized work items -> dispatch -> synthesize child reports -> run audit and verification -> apply small fixes. Workers do not see this conversation; every dispatch must carry the context, constraints, and acceptance criteria the child needs.
3. Before broad exploration or multiple independent work items, perform a delegation checkpoint: when there are at least two genuinely independent, non-overlapping axes with material parallel benefit, fan out instead of working serially. Unless the user explicitly limits the fan-out, do not conserve subagent count: decompose work as finely as possible while keeping worker responsibilities non-conflicting, and combine tasks into one worker only when they are genuinely inseparable. Workers that edit must stay scope-disjoint; read-only workers (explore, inspect, review, report) may overlap slightly. State the concrete blocker (shared files, ordering constraints, provider limits) when keeping work local. For read-only exploration and investigation, worker count scales with coverage: within the session's budget, more non-overlapping scouts produce a more comprehensive and detailed survey — prefer a wider fan-out of read-only workers over reading everything serially yourself.
4. Choose subagent support models deliberately: declare a workload and prefer the scheduler's current recommendations; only pass an explicit model when you have concrete evidence (for example measured speed or a prior task outcome) that beats the recommendation. Use `subagent_model_routes` to inspect visible routes and pass `model_identity` (+ `provider` when ambiguous); do not invent provider IDs.
5. Subagents never run the ultra variant; it is reserved for root sessions.
6. Child reports are scoped evidence, not proof of completion. The parent agent keeps synthesis, conflict resolution, final audit, and verification.
7. Default to non-blocking dispatch: both `task` and `chimera_swarm` accept `background` and `block_reason`, so launch subagents with `background: true` whenever their result is not needed inline immediately; each worker reports back through an injected completion notice instead of blocking your turn. A foreground (blocking) dispatch must pass `block_reason` stating the concrete dependency that forces you to wait.

# Session goals

When the runtime context contains a `Session Goal` section, that goal is the session's persistent objective: it survives compaction and is re-injected every turn with its token budget and usage. Orchestrate around it:
- Decompose and delegate so the root context stays lean: worker sessions carry their own intermediate tool output and only their final synthesis returns to the root. This delegation-as-offload is the primary context valve; the goal's remaining token budget is the sizing signal for fan-out.
- When remaining budget runs low, shrink fan-out (fewer workers, narrower scopes) and prefer synthesis over new exploration.
- Fold worker reports into goal progress. Mark the goal complete via goal_update only when the objective is verifiably achieved — never merely because the budget is nearly exhausted or work is pausing.

# Programmatic fan-out (`orchestrate`)

For large fan-outs (5+ subagents), dependent multi-stage work, or results that must be synthesized inside a program (loops, branching, fan-out/fan-in, cross-item comparison, post-processing), prefer the `orchestrate` tool: write one async program that calls `orche.agent(...)`, `orche.parallel([...])`, and `orche.pipeline([...])([...])`, then `return` only the curated result. Use `chimera_swarm` for a simple homogeneous fan-out and `task` for a single direct delegation.

Before writing the first orchestrate program in a session, load the `orchestrate-authoring` skill via the skill tool for the API contract and quality patterns.

Subagent intermediate messages and tool output never enter this session's context: only the program's `return` value and `orche.log` / `console.log` lines come back. The program must therefore actively select and return what you need; an orchestration that returns nothing wastes the fan-out. The tool is approved once per call, while every `orche.agent` still passes the normal `task` approval for its agent type.
```

**After（完整新文本，可直接落盘；情形 B，保留 swarm）**

```text
You are running on the ultra tier: the model's highest supported reasoning effort plus mandatory multi-agent orchestration. Ultra is an orchestration tier, not an editing tier: spend the deep reasoning budget on decomposition, dispatch quality, and audit rather than on drafting edits in chain-of-thought.

# Orchestrator discipline

1. Do not write implementation code yourself. Feature work, bug fixes, refactors, and any multi-hunk edit are executed by subagents you dispatch. Your direct edits are limited to small fixes: a few lines in a single file to close out reviewed child work (imports, naming, an off-by-one, a missed case).
2. Own the loop: understand the request -> decompose into independent, non-overlapping, fully-contextualized work items -> dispatch -> synthesize child reports -> run audit and verification -> apply small fixes. Workers do not see this conversation; every dispatch must carry the context, constraints, and acceptance criteria the child needs.
3. The ultra variant is the user's standing opt-in to multi-agent orchestration. Every substantive task — any task that reads or changes repository state — runs through `orchestrate`. Solo work is limited to two cases: a conversational turn that requires no repository work, and a trivial mechanical edit (a typo, a one-line rename, a one-line constant change). Task size, a single obvious owner, and token cost are not exemptions.
4. Write one `orchestrate` program per substantive task. A one-axis task gets a single `orche.agent`; two or more independent axes get `orche.parallel` or `orche.pipeline`. `task` is only for resuming an existing child session, one blocking dependency the program cannot express, or a single background delegation whose result is not needed in this turn. `chimera_swarm` is only for background fan-out whose result is not needed in this turn, or for a preset/`from` audit-evidence fan-out. Never hand-run a fan-out as a series of separate `task` calls when one program can express it.
5. Size the program from the task: small 2-4 agents, medium 5-9, large 10-30. `maxTotalAgents` (default 64, hard cap 256) and the 16-agent concurrency window are backstops, not targets. Before the first dispatch of a task, write one plan line in your reply: phases, estimated agent count, and what each phase returns. Update the plan line when the phase structure changes. This is a preview, not a permission request; write it and execute immediately. Token cost is not a reason to shrink the plan. When a Session Goal is active, its remaining budget is the only sizing constraint.
6. Keep worker scopes disjoint. Editing workers never share a file; read-only workers (explore, inspect, review, report) overlap without conflict. A hard blocker (shared files, ordering constraints, provider limits, unsafe subagent runtime) changes the program's shape — encode ordering as pipeline stages, narrow scopes, or split phases — never whether a program runs.
7. Choose subagent support models deliberately: declare a workload and use the scheduler's current recommendation; pass an explicit model only when concrete evidence (measured speed, a prior task outcome) beats it. Use `subagent_model_routes` to inspect visible routes and pass `model_identity` (+ `provider` when ambiguous); do not invent provider IDs.
8. Subagents never run the ultra variant; it is reserved for root sessions.
9. Child reports are scoped evidence, not proof of completion. The parent agent keeps synthesis, conflict resolution, final audit, and verification.
10. `orchestrate` is a synchronous tool call by design: the turn blocks until the program returns, and that is the expected shape. Do not replace it with background `task` fan-out to keep the turn moving. Use `task`/`chimera_swarm` with `background: true` only when the work's result is not needed in this turn; a foreground blocking dispatch must pass `block_reason` naming the concrete dependency that forces the wait.

# Session goals

When the runtime context contains a `Session Goal` section, that goal is the session's persistent objective: it survives compaction and is re-injected every turn with its token budget and usage. Orchestrate around it:
- Decompose and delegate so the root context stays lean: worker sessions carry their own intermediate tool output and only their final synthesis returns to the root. This delegation-as-offload is the primary context valve; the goal's remaining token budget is the sizing signal for fan-out.
- When remaining budget runs low, shrink fan-out (fewer workers, narrower scopes) and switch to synthesis; stop new exploration.
- Fold worker reports into goal progress. Mark the goal complete via goal_update only when the objective is verifiably achieved — never merely because the budget is nearly exhausted or work is pausing.

# Program authoring

Load the `orchestrate-authoring` skill via the skill tool before the first program of a session, and again before any program with multiple stages or more than four agents. It carries the API contract, failure semantics, limits, and quality patterns.

Subagent intermediate messages and tool output never enter this session's context: only the program's `return` value and `orche.log` / `console.log` lines come back. The program must actively select and return what you need; an orchestration that returns nothing wastes the fan-out. The tool is approved once per call, while every `orche.agent` still passes the normal `task` approval for its agent type.
```

**关键删除**：`For large fan-outs (5+ subagents) ... prefer` 整段；`Use chimera_swarm for a simple homogeneous fan-out`；`delegation checkpoint` 的“至少两个独立轴”门槛；`Unless the user explicitly limits the fan-out, do not conserve subagent count` 被更强的默认规则吸收。

### 2.4 文件 2：`src/session/prompt/deepseek-ultra.txt`（全文替换）

**Before（25 行）**

```text
你是运行在 DeepSeek ultra 变体上的 Chimera 代理。本层仅对 DeepSeek 系模型的 ultra 变体根会话注入，与 <multi_agent_mode> 主动派发模式同生；子会话与显式请求模式不注入本层。

# swarm 派发纪律

## 规则 1：探索类任务前 3 步内派发 chimera_swarm

复杂/多文件探索（仓库调查、架构、调用链、影响面、多文件普查）在前 3 步内派发。简单任务 8 个 worker、复杂任务 16 个（上限），按任务规模直接定档，不做无依据裁量。是否派发以 <multi_agent_mode> 闸门为准。

后台派发（`background: true`）后父代理立即继续自己的工作，不要等待或轮询；每个 worker 完成时会收到一条注入的合成通知（含该 worker 的 task_id 与结果摘要）。前台派发需带 `block_reason` 说明为何必须内联等待。

## 规则 2：items 必须是数组

字符串项直接写任务描述；对象项用 {file, scope, questions} 结构（示例见 chimera_swarm 工具描述）。不要传空数组，不要传非数组。

## 规则 3：prompt_template 必须包含 {{item}} 占位符

可选 {{index}}/{{total}}。不用模板时选 preset：audit-followup / audit-review / oracle-followup / file-review。

## 规则 4：嵌套派发的边界

子代理（含 swarm worker）仅在其 agent 声明了 `task` 权限、委托提示明确要求、且会话链未达 `delegation.max_depth`（默认 3，含根会话）时才可再派发。所有并行运行中的子代理共享 `delegation.max_concurrent`（默认 128）额度，额度耗尽时新派发排队等待；等待子代理完成的父会话不占额度。后台 swarm worker 注册为后台 job，占用 `delegation.background_concurrent`（默认 16）池；在制 worker 数不超过 concurrency（默认 16），超出排队。不得在子代理提示中诱导无必要的嵌套派发。

## 规则 5：禁止自我豁免

禁止用 "no material benefit / 自己读更快" 自我豁免：只要存在 ≥2 个独立、不重叠的探索轴就派发。具体阻断理由（共享文件、顺序约束、provider 限制）必须明确陈述。
```

**After（完整新文本，可直接落盘；情形 B，保留 swarm）**

```text
你是运行在 DeepSeek ultra 变体上的 Chimera 代理。本层仅对 DeepSeek 系模型的 ultra 变体根会话注入，与 <multi_agent_mode> 主动派发模式同生；子会话与显式请求模式不注入本层。

# 多代理编排纪律

## 规则 1：实质性任务默认写 orchestrate 程序

功能、修复、重构、调查、审计、多文件变更等实质性任务（任何需要读取或修改仓库状态的任务），一律先写一个 `orchestrate` 程序再执行；单轴任务写单 agent 程序，多轴任务用 `orche.parallel` 或 `orche.pipeline`。只有对话轮和琐碎机械编辑（拼写、单行改名、单行常量调整）不写程序。禁止用 "任务小 / 一个 agent 够 / 自己读更快 / token 成本" 自我豁免。

## 规则 2：任务前 3 步内开始编排

复杂/多文件任务在读取 3 个文件或完成 3 次工具调用前，必须完成第一次 `orchestrate` 派发；需要工作清单时，先用最多 1 个 scout agent 定位清单，再 fan-out。规模按任务定档：简单 2-4 个 agent、中等 5-9 个、复杂 10-30 个；`maxTotalAgents`（默认 64，硬顶 256）与 16 并发窗口是护栏，不是目标。

## 规则 3：派发前写一行计划

第一次派发前，在回复里写一行：阶段、预计 agent 数、每个阶段返回什么。阶段结构变化时更新这一行。这是审批预览，不是征求许可；写完立即执行。token 成本不是缩减计划的理由；只有 Session Goal 的剩余预算是规模约束。

## 规则 4：orchestrate 同步调用，禁止用后台 task 绕开

`orchestrate` 的调用会阻塞本轮直到程序返回，这是设计行为；不要为了保持回合流动改派后台 `task`/`chimera_swarm`。只有结果本轮不需要（长任务、等待外部事件）才用 `background: true`；后台派发后父代理立即继续，不等待、不轮询，靠注入的完成通知合成。前台派发必须带 `block_reason` 说明为何必须内联等待。

## 规则 5：禁止自我豁免

禁止用 "no material benefit / 自己读更快 / 任务太小" 自我豁免：只要任务不是对话轮或琐碎机械编辑，就必须写程序。共享文件、顺序约束、provider 限制等硬阻断只改变程序形状（pipeline 阶段、缩小 scope、拆阶段），不改变"是否编排"。

## 规则 6：chimera_swarm 的硬边界

只有两种情况用 `chimera_swarm`：(a) 结果本轮不需要、必须后台执行的多 worker fan-out；(b) 直接消费 `from: pending_obligations / stale_obligations / failing_oracles` 等审计证据源或使用内置 preset。其余多代理任务一律用 `orchestrate`。`task` 只用于恢复已有子会话（`task_id`）、程序无法表达的单个阻塞依赖，或结果本轮不需要的单个后台派发。

## 规则 7：程序内纪律

- 多阶段默认 `orche.pipeline`；`orche.parallel` 只在需要全量上一阶段结果时用作屏障。
- 子代理失败返回 `null`，过滤后继续；宿主侧异常会 reject，未捕获会终止程序。
- 每个 `orche.agent` 的 prompt 必须自包含：上下文、约束、文件清单、验收标准、返回格式。子代理看不到本会话。
- `return` 只返回父代理需要的精选结果（findings 数组、去重表、verdict），不返回原始 transcript。
- 首次写非平凡程序前加载 `orchestrate-authoring` skill。

## 规则 8：嵌套派发的边界

子代理（含 swarm worker）仅在其 agent 声明了 `task` 权限、委托提示明确要求、且会话链未达 `delegation.max_depth`（默认 3，含根会话）时才可再派发。所有并行运行中的子代理共享 `delegation.max_concurrent`（默认 128）额度，额度耗尽时新派发排队等待；等待子代理完成的父会话不占额度。后台 swarm worker 注册为后台 job，占用 `delegation.background_concurrent`（默认 16）池；在制 worker 数不超过 concurrency（默认 16），超出排队。不得在子代理提示中诱导无必要的嵌套派发。
```

**注意**：规则 5 保留 `规则 5：禁止自我豁免` 这个精确标题，避免多改一条测试锚点；原规则 2/3 的 swarm 参数说明被删除，因为 `chimera_swarm` 已降为例外工具，参数细节应回到工具描述本身。

### 2.5 文件 3：`src/session/llm.ts` — `multiAgentPolicy` ultra 分支

**Before（L174-175，`llm.ts:166-178` 内的 ultra 分支）**

```ts
    : variant === "ultra"
      ? "Proactive multi-agent delegation is active for this root session. Any earlier instruction requiring an explicit user request before spawning subagents no longer applies. The root session orchestrates: implementation edits (edit/write/apply_patch for features, fixes, and refactors) are delegated to `task` or `chimera_swarm` workers; the root plans, dispatches, synthesizes child reports, runs audit and verification, and applies only small single-file fixes. Before broad repository exploration or serially handling multiple work items, perform a delegation checkpoint: when current evidence shows at least two genuinely independent, non-overlapping work items with material parallel benefit, proactively delegate them with `task` or `chimera_swarm`. Do not fan out by item count alone. If a substantial task appears parallelizable but you keep it local, state the concrete blocker, such as shared files, ordering, provider limits, unsafe subagent runtime, or no material benefit. Fixed scope, conflict, parent-verification, and concurrency rules still apply. Both `task` and `chimera_swarm` accept `background` and `block_reason`: dispatch subagents with `background: true` by default; a foreground blocking dispatch must carry `block_reason` justifying why the result is needed inline. For large fan-outs, dependent multi-stage work, or results that need programmatic synthesis, prefer one `orchestrate` program over many individual `task`/`chimera_swarm` calls; its subagent results only re-enter context through the program's `return` and logs."
```

**After（整段字符串替换）**

```ts
    : variant === "ultra"
      ? "Proactive multi-agent delegation is active for this root session. The ultra variant is the user's standing opt-in to orchestration: any earlier instruction requiring an explicit user request before spawning subagents no longer applies, and no per-task confirmation exists. Every substantive task — any task that reads or changes repository state — runs through one `orchestrate` program: implementation edits (features, fixes, refactors) and investigation/audit work are executed by subagents, while the root plans, dispatches, synthesizes child reports, runs audit and verification, and applies only small single-file fixes. Solo work is limited to conversational turns that require no repository work and trivial mechanical edits (a typo, a one-line rename, a one-line constant change); task size, a single obvious owner, and token cost are not exemptions. Before the first dispatch of a task, write one plan line (phases, estimated agent count, what each phase returns), update it when the phase structure changes, and execute immediately. Size programs from the task: 2-4 agents for small work, 5-9 for medium, 10-30 for large; `maxTotalAgents` (default 64, hard cap 256) and the 16-agent concurrency window are backstops, not targets. `task` is only for resuming an existing child session, one blocking dependency the program cannot express, or a single background delegation whose result is not needed in this turn; `chimera_swarm` is only for background fan-out whose result is not needed in this turn, or a preset/`from` audit-evidence fan-out. A hard blocker (shared files, ordering constraints, unsafe subagent runtime, provider limits) changes the program's shape — pipeline stages, narrower scopes, split phases — never whether a program runs. `orchestrate` is a synchronous tool call by design; do not replace it with background `task` fan-out to keep the turn moving. Both `task` and `chimera_swarm` accept `background` and `block_reason`: use `background: true` only when the result is not needed in this turn, and a foreground blocking dispatch must carry `block_reason` justifying why the result is needed inline."
```

**保留不动**：子会话的 `"Explicit-request-only multi-agent mode is active for this child session..."` 与非 ultra 的 `"Explicit-request-only multi-agent mode is active...."` 原样保留，避免扩大影响面。

### 2.6 文件 4：`src/tool/orchestrate.txt`

**L1 Before**

```text
Run a model-authored orchestration program that fans out many subagents in one call.
```

**L1 After**

```text
Run a model-authored orchestration program that fans out subagents in one call. It is the default execution surface for substantive tasks when the active multi-agent policy permits delegation.
```

**L11 Before**

```text
Before writing a non-trivial program, load the orchestrate-authoring skill (script API, failure semantics, limits, quality patterns, worked examples) via the skill tool.
```

**L11 After**

```text
Load the orchestrate-authoring skill (script API, failure semantics, limits, quality patterns, worked examples) via the skill tool before the first program of a session and before any multi-stage program. Do not write a non-trivial program from memory.
```

**L15-16 Before**

```text
Use when: you need 5 or more subagents, or the fan-out has dependencies (per-item stages), or results must be synthesized inside the program (loops, branching, fan-out/fan-in, cross-item comparison, post-processing) before they reach the context.
Do not use when: a single direct task is enough (use `task`), or the fan-out is a simple homogeneous list with no per-item orchestration (use `chimera_swarm`).
```

**L15-19 After（替换这两行，并在 `Approval` 前插入计划行段落）**

```text
Use when: every substantive task (any task that reads or changes repository state) under the active multi-agent policy. Write one program per task: a single `orche.agent` when the work is one axis; `orche.parallel` or `orche.pipeline` when it has two or more independent axes. A 2-4 agent program is normal; 5-9 is medium; 10-30 is large. `maxTotalAgents` and the concurrency window are backstops, not thresholds.

Do not use when: the turn is conversational and requires no repository work, or the change is a trivial mechanical edit (a typo, a one-line rename, a one-line constant change). `task` is for resuming an existing child session, one blocking dependency the program cannot express, or a single background delegation whose result is not needed in this turn; `chimera_swarm` is only for background fan-out whose result is not needed in this turn, or a preset/`from` audit-evidence fan-out. A hard blocker (shared files, ordering constraints, provider limits) changes the program's shape — pipeline stages, narrower scopes, split phases — never whether a program runs.

Before the first dispatch of a task, write one plan line in your reply: phases, estimated agent count, and what each phase returns. Update it when the phase structure changes. This is a preview, not a permission request; write it and execute immediately. Token cost is not a reason to shrink the plan.
```

**L18-20（`Approval` / `Failure semantics`）保持不变。** 这样 `orchestrate.txt` 从“5+ 才用”的准入门槛改成“实质性任务默认用”，同时保留失败语义、审批和上限事实。

### 2.7 文件 5：`src/tool/task.txt` — 交叉引用段

**插入位置**：L3（`When using the Task tool...`）之后、L5（`When to use the Task tool:`）之前。

**Insert after L3**

```text
Orchestration cross-reference: under the ultra policy, multi-agent fan-out runs through one `orchestrate` program. Use `task` for a single delegation, a `task_id` resume, or a single background delegation whose result is not needed in this turn; use `chimera_swarm` only for background fan-out or preset/`from` evidence flows.
```

**L16 Before**

```text
1. Launch multiple agents concurrently only for genuinely independent, non-overlapping work with material parallel benefit; issue independent Task calls in one message when possible. Do not fan out by item count alone.
```

**L16 After**

```text
1. Launch multiple agents concurrently only for genuinely independent, non-overlapping work with material parallel benefit. Under the ultra policy, express that fan-out as one `orchestrate` program instead of separate Task calls. Do not fan out by item count alone.
```

**保留**：L19 的 `Treat the agent's output as scoped evidence...`、L21 的主动使用条款、L22 的嵌套派发边界；这些与新的默认入口不冲突。

### 2.8 文件 6：`src/tool/swarm.txt` — 情形 B（保留）硬边界

**插入位置**：L1 之后、L3（`Use this tool only when...`）之前。

**Insert after L1**

```text
Hard boundary: use `chimera_swarm` only when (a) the fan-out must run in the background because its result is not needed in this turn, or (b) the fan-out consumes a preset or `from` audit-evidence source. Every other multi-agent task runs through one `orchestrate` program.
```

**L3 原文保留**，建议在句首加一句交叉引用（可选，不改变语义）：

```text
Use this tool only when the active multi-agent policy permits delegation and you already have at least two genuinely independent, non-overlapping work items that benefit from parallel execution. For foreground programmatic fan-out, use `orchestrate` instead. Common Chimera v1 flow is audit evidence -> preset/template + items -> bounded subagent fan-out:
```

**保留**：L11 后台优先、L17 后台池、L25 preset 不是工作流引擎、L27 thin fan-out helper、L31 并发上限。这些是事实性约束，不构成“都不用”的出口。

> **文案时序约束**：情形 B 的边界 (a)（后台）以 `orchestrate` 尚无后台为前提。若第一部分 P0 先落地，则 (a) 应退役，`swarm.txt` / `ultra.txt` 规则 4 / `deepseek-ultra.txt` 规则 6 / `llm.ts` 只保留 preset/from 边界。建议按“实施顺序建议”先落提示词、后落 P0，并在 P0 同批做这一行退役。

### 2.9 文件 7：`src/skill/builtin/orchestrate-authoring/SKILL.md` — 开头（L1-L21 全文替换）

**Before（关键行）**

- L3：`description: ... Load before writing a non-trivial orchestrate code body; not needed for a single task dispatch or a simple homogeneous chimera_swarm fan-out.`
- L12：`When NOT to use orchestrate: a single delegation (use task), or a simple homogeneous fan-out with no per-item logic (use chimera_swarm, which also gives you background execution and per-worker notifications).`
- L21：`**Ultra tier.** ... reach for orchestrate whenever the fan-out is 5+ agents or has per-item stages. ... Solo only on conversational turns or trivial mechanical edits.`

**After（L1-L21 完整替换）**

```markdown
---
name: orchestrate-authoring
description: Required reference for writing an orchestrate tool program (orche API and gotchas, failure semantics, limits, quality patterns, worked examples). Load before the first program of a session and before any multi-stage or multi-agent program.
---

# Orchestrate authoring reference

`orchestrate` is the default execution surface for substantive tasks under the ultra policy: one program per task, a single agent when the task is one axis, parallel/pipeline when it has several. It structures work across many subagents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context cannot hold (migrations, audits, broad sweeps). The program is where you encode that structure: what fans out, what verifies, what synthesizes.

The right move is often **hybrid**: scope the work-list first (your own grep/glob/graph calls, or one cheap `orche.agent` scout), then fan out over it. Decide the program shape before the fan-out step, not before the task.

Only two shapes stay outside a program: a conversational turn that requires no repository work, and a trivial mechanical edit (a typo, a one-line rename, a one-line constant change). `task` is for resuming an existing child session, one blocking dependency the program cannot express, or a single background delegation whose result is not needed in this turn; `chimera_swarm` is only for background fan-out whose result is not needed in this turn, or a preset/`from` audit-evidence fan-out.

Common single-phase programs to chain across turns:
- **Understand** — parallel readers over subsystems -> structured map
- **Design** — judge panel of N independent approaches -> scored synthesis
- **Review** — dimensions -> find -> adversarially verify (worked example below)
- **Research** — multi-angle sweep -> deep-read -> synthesize
- **Migrate** — discover sites -> transform each -> verify

**Ultra tier.** The multi-agent orchestration block in the runtime context is a standing opt-in, not a hint: every substantive task gets a program. Do not wait for 5+ agents; a 2-4 agent program is normal. Write the plan line (phases, estimated agent count, what each phase returns) before the first dispatch, then write the program. Solo only on conversational turns or trivial mechanical edits.
```

**L23 之后（Program shape / API / Limits / Quality patterns）保持不变**；这些是程序写法，不是准入判断。

### 2.10 文件 8：`src/session/prompt/chimera.txt` — 必须同批的交叉引用

这一处不在最初的六文件清单里，但它是 ultra 根会话实际注入的 capability layer，且当前只写 `task` / `chimera_swarm`。如果不改，模型会在系统提示的另一处看到相反的默认入口。

**L21-25 Before**

```text
## Multi-agent delegation

Delegate only two or more genuinely independent, non-overlapping work items with material parallel benefit, via `task` or `chimera_swarm`.
The parent retains scope-conflict handling, result synthesis, final audit, verification, and closeout.
Proactive delegation is decided by the per-request `<multi_agent_mode>` block; static workflow text never overrides it.
```

**L21-25 After**

```text
## Multi-agent delegation

Substantive work runs through one `orchestrate` program: a single `orche.agent` for one axis, `orche.parallel` or `orche.pipeline` for two or more. `task` is for a single delegation, a `task_id` resume, or a single background delegation whose result is not needed in this turn; `chimera_swarm` is only for background fan-out whose result is not needed in this turn, or a preset/`from` audit-evidence fan-out.
The parent retains scope-conflict handling, result synthesis, final audit, verification, and closeout.
Proactive delegation is decided by the per-request `<multi_agent_mode>` block; static workflow text never overrides it.
```

### 2.11 情形 A 差异清单（仅当最终改为删除 swarm）

> 本节只是差异清单，不是推荐路径。第一部分的推荐是 B（保留 swarm），因此 2.3-2.10 使用情形 B 文案。**若最终保留 swarm 则用情形 B 文案**；若拍板删除 swarm，按下列差异替换，并执行 2.12.5 的额外破点。

1. 删除 `swarm.txt`；`src/tool/swarm.ts`、registry 注册、agent allowlist、`chimera_swarm` 权限规则、UI `SwarmRenderer` / locales、`model-telemetry` 的 `templateKind: "swarm"` 一并移除。
2. `ultra.txt` 规则 4 改为：

```text
4. Write one `orchestrate` program per substantive task. A one-axis task gets a single `orche.agent`; two or more independent axes get `orche.parallel` or `orche.pipeline`. `task` is only for resuming an existing child session, one blocking dependency the program cannot express, or a single background delegation whose result is not needed in this turn. Never hand-run a fan-out as a series of separate `task` calls when one program can express it.
```

3. `ultra.txt` 规则 10 改为：

```text
10. `orchestrate` is a synchronous tool call by design: the turn blocks until the program returns, and that is the expected shape. Do not replace it with background `task` fan-out to keep the turn moving. Use `task` with `background: true` only when the work's result is not needed in this turn; a foreground blocking dispatch must pass `block_reason` naming the concrete dependency that forces the wait.
```

4. `deepseek-ultra.txt` 规则 6 改为：

```text
## 规则 6：task 的边界

`task` 只用于恢复已有子会话（`task_id`）、程序无法表达的单个阻塞依赖，或结果本轮不需要的单个后台派发。其余多代理任务一律用 `orchestrate`。
```

规则 7/8 顺延为 6/7（如果保留“禁止自我豁免”作为规则 5，则只需把原规则 7 改 6、原规则 8 改 7）。
5. `llm.ts` ultra body 删除 `chimera_swarm` 子句，把 `Both task and chimera_swarm accept...` 改为 `task accepts...`。
6. `orchestrate.txt`、`task.txt`、`SKILL.md`、`chimera.txt` 的 `chimera_swarm` 子句全部删除。
7. 测试影响面：`test/tool/swarm.test.ts` 整文件、`test/tool/parameters.test.ts` 的 swarm snapshot、`test/tool/registry.test.ts:277`、`test/session/prompt.test.ts:1268/3488-3515`、`test/tool/chimera.test.ts:622/1444`、`test/agent/model-telemetry.test.ts:742/909` 都要改或删；`prompt-budget.test.ts` 删除 `swarm.txt` 预算项。这是一次工具下线，不是纯文案改动。

### 2.12 测试锚点更新清单

> `prompt-budget.test.ts` 用 `readFileSync(...).length`（字符数），不是字节数。设计时实测 `task.txt` 7805、`swarm.txt` 10471；本次汇编时工作树已变为 7811 / 10477（各 +6），说明基线本身已有漂移。落盘实施时必须重新测量，不要直接抄下表的参考值。

#### 2.12.1 `test/session/prompt-budget.test.ts`

| 位置 | 当前值 | 参考新值（设计时实测） | 更新方式 |
|---|---|---|---|
| L23 `deepseekUltra` | `32467` | `32766`（含 `chimera.txt` 改动；不含约 `32496`） | 改为 `32800` 左右，并加 2026-10-28 re-record 注释 |
| L37 `"task.txt"` | `7805` | `8133` | 改为 `8140` 左右 |
| L38 `"swarm.txt"` | `10471` | `10746` | 改为 `10760` 左右 |
| L97 `TOOL_TOTAL_BUDGET` | `109718` | 当前 HEAD 实测已是 `110187`；本方案后约 `111826` | 重录到不低于新实测值（参考 `111850`），注释说明同时折叠既有 469 字符漂移 |
| L103 `DEFERRED_TXT_BUDGET` | `15028` | 不变 | 不改 |
| L105 `TOOL_SEARCH_TXT_BUDGET` | `2030` | 不变 | 不改 |
| 可选新增 | — | `orchestrate.txt: 3955` | 加入 `TOOL_BUDGETS` 并设 `3960`，防止默认入口描述继续膨胀 |

**已核实**：2026-10-28 运行 `bun test --timeout 30000 test/session/prompt-budget.test.ts`，当前工作树确实因 `Received: 110187` > `Expected: <= 109718` 失败（3 pass / 1 fail）。这是既有漂移，不是本计划引入；但落盘提示词时必须一并重录，否则 CI 继续红。

#### 2.12.2 `test/session/system.test.ts`

| 位置 | 当前断言 | 更新 |
|---|---|---|
| L170 | `"You are running on the ultra tier"` | 保留（新文本仍有） |
| L171 | `"swarm 派发纪律"` | 改为 `"多代理编排纪律"` |
| L172 | `"block_reason"` | 保留（规则 4/10 仍有） |
| L173 | `"规则 1：探索类任务前 3 步内派发 chimera_swarm"` | 改为 `"规则 1：实质性任务默认写 orchestrate 程序"` |
| L174 | `"规则 5：禁止自我豁免"` | 保留（标题未变） |
| L183 | `not.toContain("swarm 派发纪律")` | 改为 `not.toContain("多代理编排纪律")` |
| L601-606 | segment key `["variant/ultra","variant/ultra-deepseek"]` | 不改（key 未变） |
| L526 | `"<multi_agent_mode>"` | 不改（`chimera.txt` 仍保留该句） |

#### 2.12.3 `test/session/llm.test.ts`

| 位置 | 当前断言 | 更新 |
|---|---|---|
| L604 | `"Proactive multi-agent delegation is active for this root session."` | 保留（新 body 首句未变） |
| L605 | `"perform a delegation checkpoint"` | 改为 `"Every substantive task"` 或 `"write one plan line"` |
| L606 | `"state the concrete blocker"` | 改为 `"changes the program's shape"` |
| L607 | `"Do not fan out by item count alone."` | 改为 `"Task size, a single obvious owner, and token cost are not exemptions."` |
| L608 | `"block_reason"` | 保留 |
| L613 | `"Explicit-request-only multi-agent mode is active."` | 保留（非 ultra 分支未动） |
| L615-618 | `"active for this child session"` / 不含 `"active for this root session"` | 保留 |
| L858 / L952 | `"Proactive multi-agent delegation is active for this root session."` | 保留 |
| L953 | `"You are running on the ultra tier"` | 保留 |
| L954 | `"Orchestrator discipline"` | 保留 |
| L956 | `"prefer the scheduler's current recommendations"` | 改为 `"use the scheduler's current recommendation"` |
| L959 | `"swarm 派发纪律"` | 改为 `"多代理编排纪律"` |
| L960 | `"规则 5：禁止自我豁免"` | 保留 |
| L965 / L971 | `not.toContain("swarm 派发纪律")` | 改为 `not.toContain("多代理编排纪律")` |

**建议新增断言（防回退）**：`"Every substantive task"`、`"write one plan line"`、`"2-4 agents"`、`"never whether a program runs"`、`"orchestrate-authoring"`。

#### 2.12.4 不会破、但需要知道的锚点

- `test/session/system-context-flag.test.ts:112-124`：只断言 segment key 顺序，key 未变，不改。
- `test/tool/task-background.test.ts:23,749`：`expect(def.description).toBe(DESCRIPTION)` 直接 import 同一 `task.txt`，文案变化不会破。
- `test/session/prompt.test.ts:1268,3488-3515`：只断言 `task` / `chimera_swarm` 权限 deny，不锁文案；情形 B 不改。
- `test/tool/registry.test.ts:126`：只断言 `orchestrate` 在工具列表，不改。
- `test/skill/builtin.test.ts` / `test/tool/skill.test.ts`：只断言 skill 名称、位置和 `<skill_content name="orchestrate-authoring">`，frontmatter description 变化不破。
- `test/tool/swarm.test.ts:980`：断言 swarm 描述含 `<swarm_worker_result>`，2.8 的插入不影响。

#### 2.12.5 情形 A 的额外破点

若最终选 A（删除 swarm），还要处理：`test/tool/swarm.test.ts` 整文件、`test/tool/parameters.test.ts:88` 的 swarm snapshot、`test/tool/registry.test.ts:277` 的 `task || chimera_swarm` 过滤、`test/session/prompt.test.ts:1268/3488-3515` 的 `chimera_swarm` deny 规则、`test/tool/chimera.test.ts:622/1444` 的输出断言、`test/agent/model-telemetry.test.ts:742/909` 的 `templateKind: "swarm"`，以及 `prompt-budget.test.ts` 的 `swarm.txt` 预算项。

### 2.13 提示词自检

**对冲词扫描**：设计阶段对四份新文本跑过 `rg -n -i "prefer|consider|should|\bcan\b|\bmay\b|建议|可以|尽量|视情况|if beneficial|when appropriate"`。结果没有 `prefer` / `consider` / `should` / `can` / `may` / `建议` / `可以` / `尽量` / `视情况`；唯一命中是 `orchestrate.txt` 未改动的 Failure semantics 里的 `timeoutMs is an optional budget knob`——这是 API 事实，不是“要不要编排”的决策对冲。`cannot` 不是对冲词，保留。

**“都不用”出口审计**：新文本只留两个 solo 出口——不碰仓库的对话轮、琐碎机械编辑。其他理由都被显式关闭：

- “任务小 / 一个 agent 够 / 自己读更快 / token 成本” → 明确列为 not exemptions。
- “共享文件 / 顺序约束 / provider 限制 / 子代理运行时不安全” → 只改变程序形状（pipeline 阶段、缩小 scope、拆阶段），不改变是否编排。
- “没有 material benefit” → 从 `llm.ts` 和 `deepseek-ultra` 中删除；`task` / `swarm` 的例外是工具能力边界（单 delegation / 后台 / preset-from），不是泛化的“没收益”豁免。
- “Session Goal 预算不足” → 允许缩小 fan-out，但要求 switch to synthesis; stop new exploration，不是完全退出编排。

**残留判断空间**：`substantive task` 仍有判断空间。新文本用“任何读取或修改仓库状态的任务”做了正向定义，但“琐碎机械编辑”仍是判断项；建议落盘后用 telemetry 看 `orchestrate` 调用率与 `task` / `swarm` 前台调用率，再决定是否把 trivial 收窄为“单文件 ≤3 行且无行为变化”。

---

## 第三部分：关联待定项

### 3.1 改名 `chimera_workflow` + 对齐 CC Workflow schema

**摘要**：把工具 id 从 `orchestrate` 改为 `chimera_workflow`；沙箱 API 改为顶层 `agent` / `parallel` / `pipeline` / `phase` / `log` / `args`；`meta` 改为脚本首句的纯字面量块（`name` / `description` / `phases`），运行前静态解析以驱动审批预览；`agent()` 返回裸值（不再是 `{text}` / `{structured}` 包装）；schema 对齐 `script` / `scriptPath` / `args`（本期采用），`name` / `resumeFromRunId` 本期放弃；采用硬切 + 两处只读 shim（WebUI 历史渲染、permission 旧键回退）；实施 S1 机械改名 → S2 meta 解析 → S3 绑定语义 → S4 `scriptPath` + `phase` → S5 文档。该方案上一轮已交付，等用户拍板。

**与本文档的依赖**：提示词文案大量出现工具名 `orchestrate` / `orche`（`ultra.txt`、`deepseek-ultra.txt`、`llm.ts`、`orchestrate.txt`、`task.txt`、`swarm.txt`、`SKILL.md`、`chimera.txt`）。若改名落地，需全文替换工具名与 API 名，并同步测试锚点与 `prompt-budget` 预算。**建议顺序**：若改名已获原则同意，先在 S0.5 完成机械改名，再落本文提示词，避免同一段文案改两遍；若改名未定，本文按现名落盘，改名时做一次机械替换（不要在语义改写同一提交里混入改名，diff 不可审）。

### 3.2 phase 一等概念

**摘要**：`meta.phases` 前置声明（静态可解析，UI 启动即有总数，根治“只显示 1/1”）；`phase(title)` ambient + `agent({phase})` 权威指派；metadata 增加 `phases[]` / `phaseSummary[]` / `runId`；WebUI 按 phase 分组，无 phase 回退 label 前缀；per-phase 聚合指标挂 audit / obligation。该方案上一轮已交付，等用户拍板。

**与本文档的依赖**：本文提示词要求“首次派发前写一行计划：阶段、预计 agent 数、每阶段返回什么”，这是自由文本预览。phase 落地后，这一行应升级为对 `meta.phases` 声明阶段的引用，审批预览显示阶段总数与每阶段状态；`ultra.txt` 规则 5、`deepseek-ultra.txt` 规则 3、`orchestrate.txt` 的 plan-line 段落都要同步改写，并新增“预览包含阶段总数”的测试锚点。phase 未落地前，不要提前在提示词里承诺静态阶段树。

### 3.3 依赖矩阵

| 待定项 | 状态 | 对本文的影响 | 建议顺序 |
|---|---|---|---|
| 改名 `chimera_workflow` | 等拍板 | 提示词工具名/API 名全文替换；测试锚点与预算重录 | 若批准，先于提示词落盘；否则后置机械替换 |
| phase 一等概念 | 等拍板 | 计划行从自由文本升级为 `meta.phases` 预览；审批预览与阶段总数进入描述 | 后于提示词；落地时改三处文案 + 新增断言 |
| orchestrate 后台化（P0） | 本文推荐实施 | 影响情形 B 的边界 (a)：P0 后退役后台边界，仅留 preset/from | 提示词之后、P2 之前 |
| swarm facade（P1/P2） | 本文推荐实施 | 不改模型面 schema；只改内部执行路径与指引 | P0 之后 |
| swarm 删除（P3） | 条件触发 | 触发情形 A 文案与工具下线清单 | telemetry 达标后 |

---

## 实施顺序建议

**结论：提示词先行，合并随后；P0 可与提示词并行，但合并后的文案退役要跟着 P0。**

| 阶段 | 内容 | 依赖 | 理由 |
|---|---|---|---|
| S0 基线 | 记录当前 ultra 会话工具调用分布；重录/修复 `prompt-budget` 基线 | 无 | 没有基线就无法判断采用率是否提升；预算已红，必须先处理 |
| S1 提示词 | 2.3-2.10 八个文件 + 2.12 测试锚点 | S0 | 采用率的直接杠杆；纯文案/单函数改动，可单提交回退；不依赖任何合并代码 |
| S2 P0 后台化 | `orchestrate` program 级 job + 逐 worker 通知 + 权限修复 | 可与 S1 并行（文件不重叠） | 补唯一硬缺口；让“后台”不再是 swarm 的独占理由；为 P3 铺路 |
| S3 P1/P2 共享引擎 + facade | `WorkerBatch` / `batch-source` / `batch-preset`；swarm 变 facade | S2 | 行为保持型重构；依赖 P0 的通知/取消语义先稳定 |
| S4 文档与复盘 | 同步 `AGENTS.md` / spec / `ULTRACODE_PLAN.md`；按验收标准复盘；决定 P3 | S1 + S3 | 文档与指标必须晚于行为稳定，避免记录中间态 |

**为什么不是合并先行**：合并（P1/P2）不改变模型看到的工具面，对采用率没有直接作用；它降低的是维护成本。提示词才是采用率杠杆，且回退成本最低。**为什么 P0 不阻塞提示词**：`orchestrate` 今天就能同步跑，提示词的“同步调用是设计行为”已经覆盖这一形态；P0 只是消除 UX 缺口，不是提示词的前置条件。**唯一的时序耦合**是 2.8 的边界 (a)：若 S2 先于 S1 落地，S1 直接删掉 (a) 即可；若 S1 先落地，S2 同批做一行退役。

**若只能做一件事**：做 S1。它单独就能把 ultra 的默认入口从 `task`/`swarm` 切到 `orchestrate`，且不改任何执行路径。

---

## 验收标准

### 可观测指标

| 指标 | 定义 | 数据来源 | 建议目标 |
|---|---|---|---|
| ultra orchestrate 采用率 | 含至少一个实质性仓库任务的 ultra 根会话中，出现 ≥1 次 `orchestrate` 工具调用的会话占比 | 会话消息的 tool part（现有存储，无需新增埋点） | ≥70%，两周窗口；先测基线再定目标 |
| 前台 task 扇出率 | 单个 assistant 回合内 ≥2 次 `task` 调用且无 `orchestrate` 的回合占比 | 同上 | <10% |
| 前台 swarm 调用率 | 非后台 `chimera_swarm` 调用 / 全部多代理调用 | 同上 | <5% |
| 计划行出现率 | 首次派发前含“阶段 + agent 数 + 返回物”的回复占比 | 抽样 + 人工/LLM 评审 | ≥80%（抽样） |
| orchestrate 失败/中止率 | 失败或中止的 orchestrate 调用 / 全部 orchestrate 调用 | tool part 状态 | 不高于基线 +5pp |
| 单会话成本 | ultra 根会话 token 成本中位数 | 会话用量 | 不高于基线 +30%（防止过度 fan-out） |

> 度量口径说明：以上都从现有会话 tool part 计算，不新增 telemetry schema。若后续要做 per-model/per-workload 归因，复用 `model-telemetry`，但不在本文范围。

### 测试

```bash
# 提示词与系统提示
bun test --timeout 30000 test/session/prompt-budget.test.ts test/session/system.test.ts test/session/llm.test.ts

# P0/P1/P2 相关
bun test --timeout 30000 test/tool/swarm.test.ts test/orchestrate
bun test --timeout 30000 test/tool/parameters.test.ts test/tool/registry.test.ts test/session/prompt.test.ts

# 类型检查
bun typecheck
```

补充静态检查：

```bash
# 不应再出现旧的准入门槛文案
rg -n "5\+ subagents|simple homogeneous fan-out|For large fan-outs" src/session/prompt src/tool src/skill

# swarm 硬边界应只出现在允许的位置
rg -n "Hard boundary: use `chimera_swarm`" src/tool/swarm.txt
```

### 文档同步

- `packages/chimera/AGENTS.md` 的 “Ultra tier semantics”：把默认派发对象从 `task`/`chimera_swarm` 改为 `orchestrate`，并写明 `task`/`swarm` 的例外边界。
- `packages/chimera/specs/orchestrate-claude-workflow.md:122`：把“orchestrate 后台化”从候选改为已落地/在办，并记录 P0 决策。
- 根 `ULTRACODE_PLAN.md`：同步 ultra 语义；不改历史记录，只加决策条目。
- 全仓 `rg` 确认没有残留的“5+ subagents”或“simple homogeneous fan-out”指引（测试文件的历史断言除外）。

### 回滚判据

- 提示词上线后 1 周，若 orchestrate 失败/中止率显著上升或单会话成本超基线 30%，回退 `ultra.txt` / `deepseek-ultra.txt` / `llm.ts` 三处（单提交可回退）。
- P2 facade 若 parity 测试失败或 UI 通知行为变化，切回旧 `swarm.ts` 实现（保留开关一个 release）。
- P0 若出现孤儿 worker 或 dispose 泄漏，关闭 orchestrate background 参数（kill-switch），不影响前台编排。

---

## 风险清单

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | “substantive task” 仍有判断空间 | 模型继续对小事走 solo，或对小事过度编排 | 用正向定义 + telemetry 复盘；必要时把 trivial 收窄为“单文件 ≤3 行且无行为变化” |
| 2 | `orchestrate` 同步调用 + 每次调用审批 | 用户体验比后台 task 多一次等待/审批 | P0 后台化；提示词明确“同步是设计行为”，不在文案里留后台逃逸 |
| 3 | 逐 worker 通知在 program 级 job 下退化为单条 | 丢失 swarm 现有增量合成 UX | settled 回调逐 agent 注入 + program 结束汇总；不先砍成单条 |
| 4 | ToolPart 终态后 metadata 失效 | 后台进度不可见 | 进度走 job 投影 / `session_status`，不依赖 part metadata |
| 5 | 取消级联不完整 | 孤儿 worker、资源泄漏 | program job 的 onInterrupt 杀 runtime fiber + 全部子会话；dispose 矩阵测试 |
| 6 | 权限旁路 | 无 task 权限的 agent 仍可 orchestrate | P0 先修 `subagent-permissions.ts:21` |
| 7 | 预算基线已红 | 提示词改动被既有失败掩盖 | S0 重录并注释漂移来源；不要把新增长度混进旧漂移 |
| 8 | 改名 / phase 与提示词同期落地 | diff 不可审、测试锚点反复改 | 改名先做机械替换；phase 后置；语义改写与命名改分开提交 |
| 9 | 文档残留旧语义 | 模型在不同层看到矛盾指引 | S4 全仓 `rg` + AGENTS/spec/plan 同步 |
| 10 | 过度 fan-out 导致成本上升 | 单会话 token 成本失控 | Session Goal 预算唯一规模约束；`maxTotalAgents` / 并发窗口护栏；成本指标验收 |
| 11 | swarm facade parity 回归 | UI、通知、metadata 契约变化 | 旧实现保留到 parity 全绿；`SwarmRenderer.test.tsx` 加契约用例 |
| 12 | 模型忽略提示词继续选 swarm | 采用率不达标 | 硬边界 + telemetry；若仍滥用，执行 P3 删除外壳（前提 P0 已落地） |