# ULTRACODE_PLAN — chimera 的编程式子代理编排能力

> 状态：全部落地 ✔ — Phase 0 地基验证｜ Phase 1 运行时 seam + 薄入口｜ Phase 2 绑定 + dispatch 扩展｜ Phase 3 orchestrate 工具上线｜ Phase 4 规模化三修 + prompt-budget 重录（orchestrate.txt +2450B 为本批故意增长，其余折叠并发会话）。打包构建验证（含 --orch-child 分流冒烟）留给用户/CI：OPENCODE_CHANNEL=latest bun run build --single --skip-install。
> 输入证据：deepseek-harness PTC 全面彻查（12 区）+ chimera 性能审计（14 区），侦察全文在 `~/.local/share/chimera/tool-output/`。

## 1. 目标与定位

给 chimera 增加 **ultracode 能力**：模型把任务**预先编程式编排成一大批子代理**（写一段程序声明扇出、并发、依赖与合成逻辑），然后**一次运行**；子代理的中间过程与结果默认**不进入父会话上下文**，只有程序 `return`/`log` 的精选内容回灌。

**主要服务对象是 ultra 模式**：ultra tier = 模型最高推理档 + 主动多代理编排（`<multi_agent_mode>` 块 + `src/session/prompt/ultra.txt`），根会话本就是编排者。ultracode 让这个角色从「逐个发 `task`/`chimera_swarm` 工具调用」升级为「一段程序声明全部编排再运行」。提示词集成落在 ultra 层与 multi-agent 指引；工具本身对所有 agent 可用（权限门禁），但只在 ultra 路径主动教授。

参照系是 deepseek-harness 的 `workflow-ptc`（`agent()/parallel()/pipeline()` 在 PTC 进程里编排子代理），**不是**完整 PTC 的注册表坍缩。理由：

- 用户目标是「编排大量 subagent」，不是「把工具调用全部程序化」；
- workflow-ptc 的 guest 绑定面极小（`begin/startChild/childResult/disposeChild/progress` 五个 JSON 绑定），不暴露任意 `tools.*`，安全面与实现面都小得多；
- 完整 PTC（注册表坍缩 + `tools.*` 绑定）作为可选扩展放到 Phase 5。

## 2. 与 dsh 的关键差异（chimera 可以更 lean）

| 面 | dsh 做法 | chimera 计划 |
|---|---|---|
| 子调用可观测性 | 新增 log-only 事件词汇 `tool/ptc-dispatch(-start)` + 配对不变量 + v2→v4 迁移 | **子代理即子会话**——chimera 的 subagent 本就有独立 session/UI/持久化，无需新事件词汇；编排进度用 `ToolPart.metadata` 承载（已持久化） |
| 注册表 | `run_code` 坍缩 + `collapses()` 执行面强制 | **不坍缩**：`orchestrate` 作为普通工具与现有工具并存；`llm.ts` repair、`tool_search` 不变量、wire 数组全不动 |
| 执行后端 | OS 沙箱（bwrap/landlock/seatbelt）+ fd 控制通道 | Phase 1：Bun 子进程 + env 清洗 + stdio JSON 行协议，**无 OS 沙箱**——并行子代理的文件踩踏由 edit-intent claim 协调层解决（见 §3.2），OS 沙箱不再是必需项 |
| 会话格式 | 事件 vocab 迁移 | 不动 `Part` union、不动 `message-v2` 投影 |

## 3. 关键设计决策（已定稿）

1. **词汇定稿**：`orchestrate`（工具名）/ `agent()`、`parallel()`、`pipeline()`、`log()`（程序内 API）。dsh 教训：命名与持久化词汇尽早定稿，不做 alias。
2. **文件沙箱 = 已由 predesign 的 edit-intent claim 设计解决**（用户确认并核实）：`chimera_predesign` 声明的文件注册 advisory claim（`src/tool/chimera.ts:3102-3161` → `src/chimera/edit-intent.ts:98-120`）；mutation gate 在 `src/chimera/provenance.ts:1309` 拦截其它 session family 对被认领文件的 edit/write；被挡方 FIFO 排队、释放自动唤醒；父子 subagent 同属一个 family 互不阻塞。因此编排程序无需 OS 文件沙箱，Phase 1 威胁模型 = Bun 子进程 + env 清洗 + `orchestrate` 审批门禁。**已知边界**：claim 只管 chimera 工具化编辑；程序内原生 `node:fs` 写与 bash 命令写不走该 gate（与现有 bash 工具同级信任，用户接受）。
3. **不坍缩注册表**（回答「做不做的区别」后定稿为不做）：坍缩 = wire 上只剩 `run_code`、直呼其它工具被拒绝，收益是把**工具级**中间结果也挤出上下文；成本是要动 `llm.ts` 未知工具分支、`tool_search` 不变量、wire 坍缩视图、`tools.*` 绑定桥与权限身份链（实现面约 3-5 倍），且 ultra 根会话失去直呼能力（小编辑也得写程序）。关键事实：子代理结果不进父上下文的收益**不做坍缩也完整保留**（子会话天然隔离），坍缩的边际收益只剩工具级程序化——那是 Phase 5 的可选项。
4. **规模化的最小伴随修复（确认顺手修）**：以下三项性能缺陷在几十个子代理并发时会立即成为瓶颈，**作为 ultracode 工作项的一部分修掉**（不属于推后的全面清洗）：
   - `src/tool/swarm.ts:610-627` 元数据 O(N²) 全量发布 → 增量/终态发布；
   - `src/agent/background-job.ts:440-447` `jobs.list()` 全表扫 → live map 短路；
   - `src/session/activity.ts:53-108` 50ms family 轮询 → 事件驱动 + 低频兜底。

## 4. 阶段计划

### Phase 0 — 地基验证与 spike（只读 + 最小实验）

- 核实耦合点现状（审计报告已给 file:line，落实为接口清单）：
  - `SubagentDispatch` 的 `prepare/materialize` API（`src/agent/subagent-dispatch.ts`）能否被非 tool 调用方复用；
  - `Tool.Context` 合成所需的全部字段来源（sessionID/agent/abort/callID/metadata/ask）；
  - `processor`/`session` 对子代理生命周期的现有事件面。
- ~~spike~~ **取消临时编译 spike**（遵守「不编译并立即执行新二进制」约束；且本地环境会直接 SIGKILL 临时目录里的新鲜二进制，spike 路径本身不可行）。机制假设改由仓内先例覆盖：`src/graph/mcp/index.ts:165-205`（execPath 重入起 daemon）与 `src/graph/extraction/wasm-runtime-flags.ts:95-117`（execPath 自重启）证明 `process.execPath` + 自定义 argv/env 可用；`--eval` 形态不采用（编译产物不解释 `--eval`），改为薄入口 flag/env 分流（见 Phase 1）。
- Phase 0 结论（3 份 scout，全文在 tool-output）：`SubagentDispatch` 是工厂 Effect（`yield* SubagentDispatch`，非 Service）；`prepare` 要求父消息是 assistant 且**不做审批**（编排工具须自己 `ask`）；`runPreparedCore` 私有，只能走 `runPrepared`；`materialize` 非幂等；深度封顶只 deny `task`/`chimera_swarm`——Phase 2/3 必须补 `orchestrate`；structured output 需给 dispatch 增加 `format` 透传；入口分流必须新建薄 `src/entry.ts`（在 index.ts 内加分支无效，静态 import 会先加载 AppRuntime）；测试一律源码模式子进程（`process.execPath` + TS worker），不碰编译产物。
- DoD：接口清单已回收 ✔；打包产物的真实验证并入 Phase 3 的官方构建命令（`bun run build --single --skip-install`），由用户或 CI 执行。

### Phase 1 — 执行运行时（内部 seam）

新增 `packages/chimera/src/orchestrate/`（名字随 §3.1 定稿）：

- `runtime.ts`：`resolve(request)`（校验/补全 cwd、timeout、budget）/ `run(spec)` 两阶段契约；**程序失败作为结果字段 `error` 返回，不 reject**（误用才 reject）；结果 `{ value?, logs: string[], error? }`。
- 子进程协议：stdio JSON 行（参考 dsh 的 fd 独立通道，chimera 用独立 pipe 即可），宿主把子进程当敌意对端逐帧校验：严格递增 `id`、绑定白名单自有属性、参数/返回必须无损 JSON、pending 上限。
- 子进程侧：`console` shim → logs 缓冲；绑定命名空间为 null-prototype 对象；程序体包成 async function（支持顶层 `await`/`return`）。
- 预算：墙钟 timeout、输出字节上限、pending 上限、优雅终止（SIGTERM→grace→SIGKILL）。
- DoD：`bun typecheck` + 新增 `test/orchestrate/runtime` 单测（真实子进程：握手、并发绑定、错误回传、超时、abort、输出截断），从 `packages/chimera` 跑 `bun test --timeout 30000` 通过。

### Phase 2 — `agent()` 绑定接 SubagentDispatch

- `agent({ prompt, agent?, model?, schema?, label? })` → 经现有 `SubagentDispatch` 起子会话 → 返回 `{ text }` 或 `{ structured }`；子代理失败返回 `null`，基础设施故障升级为程序致命错误（dsh 的 `AGENT_RESULT` 语义）。
- `parallel(tasks)`：逐项容错（普通失败 → `null`，致命 → 整程序失败）；`pipeline(steps)`：按 item 串行、失败项跳过剩余 stage。
- 限额：`maxTotalAgents`（防 runaway loop 硬上限）、并发槽 FIFO（默认沿用 swarm 的 16）；全部 JSON-only 跨线。
- 取消语义：外层 abort → 立即终止子进程并 dispose 已发布子代理；stray child 收割（settle 前 await/dispose）。
- DoD：单测覆盖并发槽、上限、取消、致命/普通失败分层；与 swarm 既有用例不冲突。

### Phase 3 — `orchestrate` 工具上线

- `src/tool/orchestrate.ts` + `orchestrate.txt`（描述遵循 AGENTS.md 风格：description-heavy、schema 精简；明确「何时用」= 需要 5+ 子代理/有依赖编排/结果需程序内合成时；「何时不用」= 单一直接任务用 `task`，同构扇出用 `chimera_swarm`）。
- 工具 schema：`code`（async 函数体）+ `description`（UI 标签）+ `maxTotalAgents?` + `timeoutMs?`。
- 执行桥：构建合成 `Tool.Context` 调 runtime；结果渲染 = logs + curated `return`；编排进度（child 列表/状态）写 `ToolPart.metadata`（复用 swarm 的 `publishMetadata` 通路，但按 §3.4 改增量发布）。
- 权限：`orchestrate` 进 permission 体系（默认 ask）；`explore` 等 allowlist agent 不可见（`"*": "deny"` 默认即拒，无需动作；如要放行再显式加 allowlist）。
- 模型可见性引导：主集成点是 ultra 层（`src/session/prompt/ultra.txt`）与 `<multi_agent_mode>` 指引——教根会话「大扇出用 `orchestrate` 编程编排，小扇出用 `chimera_swarm`，单任务用 `task`」；非 ultra 会话不主动教授。
- DoD：端到端测试（真实子进程 + 真实 SubagentDispatch，mock 仅 LLM 层）：模型调 `orchestrate` → 程序扇出 N 个子代理 → 只有 curated return 进父上下文；`bun typecheck` 全绿。

### Phase 4 — 规模化伴随修复（仅 §3.4 三项）

各自独立 PR 粒度提交；每项附前后对比（构造 16 worker swarm 的场景验证 DB 写入次数/轮询消失）。DoD：现有测试不回归 + 针对性新测试。

### Phase 5 — 加固与可选扩展（后续单独立项）

- ~~OS 沙箱对齐~~ **取消**：文件安全由 edit-intent claim 层覆盖（§3.2）；若未来引入程序内任意 `tools.*`/shell 绑定再重估；
- 程序内 `tools.*` 绑定（完整 PTC 面：工具注册表枚举 + log-only 子调用记录，届时才评估是否动 `Part` union）；
- 呈现模式坍缩（`both`/`ptc` mode）——仅在真实 token 数据支撑时做；
- WebUI 编排视图（子代理树实时状态）、snapshot/replay 测试层。

## 5. 验证与纪律

- 每个 Phase：`bun typecheck`（tsgo）+ 聚焦 `bun test --timeout 30000`，均在 `packages/chimera` 下运行；不从根目录跑测试。
- 涉及共享契约（工具注册、权限、Part metadata、SubagentDispatch）的编辑先 `chimera_predesign`，编辑后看内联传播摘要。
- 不新增依赖；不手改生成物；遵循 AGENTS.md 风格（早返回、const、不解构、`any` 禁令等）。
- 每个 Phase 完成更新本文件状态行。

## 6. 明确不做（本轮）

- 性能全面清洗（P0–P2 清单已交付，推后；仅 §3.4 三条随 Phase 4 顺手修）；
- `message-v2`/`Part` union/会话格式迁移；
- 注册表坍缩与 `tool_search` 语义变更；
- OS 文件沙箱（已由 edit-intent claim 层覆盖，见 §3.2）；
- Python 后端。
