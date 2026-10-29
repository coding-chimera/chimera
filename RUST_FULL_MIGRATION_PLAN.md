# Chimera 全量 Rust 化计划（承诺终点 · 加速绞杀）

制定：2026-10-29
修订：2026-10-29（24 轴静态核查 + 3 组跨轴 review 结论回写）
性质：执行计划草案。立项与长尾取舍仍待拍板（§13）；文中建议不等于用户已拍板。

文档关系：
- 取代 `RUST_HOST_MIGRATION_PLAN.md`（2026-10-21）的 H3「Bun session worker 化」路线——该路线整体删除；
- `RUST_MIGRATION_PLAN.md`（R0–R6 / A·B·C 方案）保留为历史调研证据，不再按原顺序执行；
- 证据基线 = 2026-10-28 并发调查（10 份探查报告 + 主线程采样 + dbstat 实测）+ 同日 W-E Effect 解剖战役（16 worker 两阶段，343 语义点全清单）+ 2026-10-29 24 轴静态核查；索引见 `memory.md` 当日条目与附录 B。

---

## 1. 审查结论（本轮修订依据）

原计划方向成立（全量 Rust 为终点、加速绞杀、oracle 先行），但存在以下疏漏，逐条订正；保留 file:line 便于复核，不重做全仓调查。

| 轴 | 核查结论 | 对计划的修订 |
|---|---|---|
| H1 定位 | H1 是协议/控制存储基础，不是生产 Rust runtime：`chimera-host/Cargo.toml:15-23` 仅 rusqlite；TS Drizzle 是唯一 migrator；`src/store.rs:16-19,341-368` 同步 conn 只拥有 6 张控制表；`bin/chimera-host.rs:194-207,315` 为 Unrouted；`:180-181` 默认 host/host.db 未接 canonical 主库。 | 新增 runtime foundation / router / boot-path-capability-launcher 工作包（WP-07）；W1/W2 不假设 H1 可直接承载生产面。 |
| H2 状态 | Step0 已实现：`host_driver.rs:1139-1180` serve_available 已带预算与 Idle。 | 从“未实现”改为“保留并复验”，不重复立项。 |
| W3 缺 LLM | Codex Responses/OAuth 在会话侧（`session/llm.ts:455-483`），`:489-521` 有 TS native-llm 试点；`packages/llm` 的协议/fixture 可复用，但不是 Rust 资产。 | W3 前需可用且通过 oracle 的 provider 通路；优先验证 genai 0.7.2 薄适配器，不以自建全量 SDK 为前置。特殊通路显式保留 provider-only 兼容执行体；详见 §15。 |
| W3 缺 hook | 插件影响 config/bootstrap、tool.definition、chat.params/headers、tool.before/after、auth refresh（`plugin/codex.ts:501-560`）；只有 hook spec 不足以让 W3 跑通。 | 插件 hook IPC 契约 + 最小真实 sidecar 提前；W5 保留生态硬化。不新建“把整套 TS session 塞进去”的 worker。 |
| 数据权威 | 缺库/表级权威矩阵。audit/process/claims 与 graph 同库（`src/chimera/store.ts:630-631` → `graph/db/index.ts:628-629`），并非审计已分库。多文件 WAL 无跨文件 crash 原子性（SQLite `lang_attach` 文档），但不能泛称所有 SQLite 跨库不原子。 | 先保持 schema 与权威兼容，再拆可重建投影；语言迁移/分库/换权不同时做；Rust 迁移权接棒不拖到 W6。 |
| W0 oracle | 四序列不足：缺 tool result/LINE#ID、关键 prompt 分段/锚点、tool visibility/history/native tool_search、hook/permission/question/job family/delivery generation、MCP 协议与进程资源。 | W0 扩为“确定性字节/规范化 schema + 请求/因果行为 + fault matrix + 统计性能”分层 oracle；禁止用全局排序吞顺序 bug。 |
| HTTP 契约 | inventory fixture 为 170 ops、96 host-first（仅初步分类，`inventory.ts:16-17`）、116 exercise/54 none；`httpapi-exercise.ts:68-69` 仅 Effect/Hono 双臂且隔离 mutating 场景，可复用但不是 TS/Rust 完成；完整 SSE/DBtrace 需扩。 | 冻结 live `Server.openapi()` 完整规范化 spec；补运行时错误/鉴权/目录 workspace 代理/WS 矩阵与正式 SDK 重生成漂移门；不把旧 `packages/sdk/openapi.json` 当实时权威，也不断言当前 SDK diff 是手改（无证据）。 |
| SSE 恢复 | `EventApi` 无恢复头输入，`event.ts:33-38` id 为 undefined。Last-Event-ID/replay/retention_floor/reset 是新增能力。 | 明确标注为新增能力，不能冒充旧行为 parity。 |
| graph 拆分 | kernel 是 cdylib（`kernel Cargo.toml:9-14`），不应直接吸收入 host；同版本 Cargo 可统一依赖，不能断言合并必重复 SQLite 符号。pattern/search/framework-WASM fallback 与 Rust 字节/TS UTF16 范围需明确（`graph/pattern/index.ts:15-37`）。 | 先抽纯 Rust core rlib + NAPI 薄适配；existing parity 逐面列映射，不以 extraction 模板证明 graph 全域覆盖。 |
| 控制面 WBS | config/bootstrap/skills/instructions/workbrief/goal/prompt assembly/tool_search/remote compaction；mutation 权限→filewrite→format/LSP→sync/provenance/audit/claims 完整链；MCP client 三 transport + graph daemon/server + OAuth callback。session 广义可能包含这些，但 WBS/oracle/owner 未明确。 | 新增显式控制面 WBS；MCP 有 transport/OAuth（`MCP/src/index.ts:4-7,25-26`），graph MCP daemon 也写图，必须在图 writer 切换前变薄代理或改归属。 |
| 并发/生命周期 | InstanceState 不止 DashMap+OnceCell：`instance-state.ts:38-54` 有 ScopedCache+disposer、在飞 init 去重/失效/清理；DelegationLimiter 有 permit 借贷/cancel 安全；BackgroundJob/SessionActivity 有 generation+pending delivery/family quiescence。 | 生命周期细节进 oracle；retain 30d 与 telemetry DB 移除已拍板，WBS 补自动触发/活跃 family/未完成 job/保留 floor 与旧 telemetry 只读兼容，本轮不删数据。 |
| 宿主/UI | CLI/TUI UI 可暂不迁，但其承载 server/session 必须迁出：`tui/thread.ts:167` new Worker，`worker.ts:85,97-99` 内嵌 Server；run/web/serve 亦自宿主。orchestrate 用独立 Bun 脚本 sandbox（`orchestrate/runtime.ts:127-150,407-418`），“删除 session worker”不等于删此工具。 | 补 Rust 启动/发现/连接/信号/退出/恢复契约；UI 为薄客户端；JS 兼容范围（plugin + tail provider + orchestrate sandbox）列为待拍板，单/双 sidecar 条件选用不冒充已拍板。 |
| 发布/CI | 发布必须前置到首次用户可启用 host 能力前，不只 W6：`publish.yml:173-190` host optional continue-on-error、不进 npm、Unix-only；`:262-265` build-cli 无 host 依赖。现有 host Rust CI 已存在（`test.yml:163-204` cargo test + bench compile）。 | 补 core/host cargo fmt/clippy/tests/parity、host 必需时 CI hard gate、Windows 传输/兜底决定、with-webui GPL / no-webui MIT 两变体资产与 npm install 验收。 |
| 性能裁判 | 脚本已 tracked（HEAD a3232406c）：`packages/chimera/script/bench/concurrency-probe.ts`（Glob 曾漏检，非不存在）。450 行中合成 step 真实 storage page50 + 直接 INSERT + 2 store reads（:258-272），不是完整 session/真实 LLM；指标 :280-309 无 RSS/write/step 延迟。 | 复用并扩充真实 session fixture、host+全部 sidecar 整体 RSS、API/heartbeat/turn/writer 延迟、吞吐/公平性/队列/磁盘、重复运行同环境基线与阈值；阈值开工签定，不任编不可达标准。W-E343 清单确有 summary，固化版本化“语义点→owner→fixture”映射，不称 343 项已逐点测试。 |

由此产生的结构性修订：

1. **波次是能力域，不是全局串行顺序**：设计与 fixture 可并行；实际切换依赖 oracle 与 DAG；W0 硬门不可绕过。
2. **首批不抢 W2 的 96 路由**：其中大量路由依赖 TS session 语义，先完成 runtime foundation 与第一条 Rust 主控会话闭环；provider 执行体按 §15 的 profile 准入。
3. **权威换权与语言迁移解耦**：先兼容 schema/权威，再拆可重建投影，最后才做 writer 翻转。
4. **发布门禁前移**：在首个用户可启用的 host 能力前建立 npm 两变体验收与 CI hard gate。
5. **编排纪律入计划**：work manifest、独立 review、focused verify、canary-first、显式 checkpoint。

---

## 2. 决策摘要

1. **全量 Rust 化是承诺终点**，不再是「H6 再评估」的可选项。终态 = Rust host 承载 HTTP/存储/图/事件/会话运行时/主力 provider；Bun 仅保留为插件生态与必要长尾的兼容 sidecar（范围待 §13 拍板），不再是运行时主进程。
2. **形态 = 加速绞杀，不是大爆炸**。沿用 kernel 战役验证过的纪律：波次推进、每波 parity 门、kill switch、旧实现保留一个发布周期、parent 独立复验。
3. **删除 Bun session Worker 过渡形态**（不新增线程或进程 session worker）。TS 侧调用接口异步化（Promise/RPC），执行体直接落在 Rust host；不新建“把整套 TS session 塞进去”的 worker 来顶 W3。现存 TUI 的 server 托管须迁出；orchestrate 脚本 sandbox 是独立兼容能力，归属按 §13 决定。
4. **oracle 不立不动工**：W0 的分层 oracle 是所有后续切换的前置。
5. **性能问题不单独立项**：止血包已随 `0.0.7-beta8-patch2` 落地；其余（codex 式数据面、写后置、异步化）并入对应波次，随 Rust 化推进解决。
6. **数据权威与语言迁移分离**：先保持 schema 与权威兼容，再拆可重建投影；单写者换权、fencing、ACK 与回退流程须先有矩阵与 oracle。
7. **JS 兼容终态范围待拍板**：plugin、长尾 provider、orchestrate sandbox 是三个不同性质的 JS 面，不能默认合并或默认全删。

---

## 3. 证据基线（为什么旧判定被推翻）

旧判定（方案 C 暂缓）的三个前提，2026-10-28 起全部有了新事实：

| 旧前提 | 新事实 |
|---|---|
| Effect 编排语义不可跨 FFI（未知恐惧） | W-E 解剖：343 个非平凡语义点 = mechanical 120 / di 74 / structured-concurrency 68 / coordination 45 / streaming 31 / **hard 仅 5**，且 4 个 hard 在本就留 JS 的插件/包管理边界（ALS 双轨桥 ×2、npm 动态 import），1 个是可设计的 catchDefect 控制流。编排层本体零 hard。 |
| 无渐进回退（断点迁移） | kernel 战役与 10-28 止血包战役证明「波次 fan-out + parity 门 + parent 复验」的绞杀机器可行；本仓库已有 535 测试文件 / ~2 万断言的行为测试底盘。 |
| 成本 6-12 人月 | 成本结构变化：写不再是瓶颈，验证与契约才是——两者都可建制化（W0 工装 + 编排扇出起草）。 |

支撑证据：

- **并发调查**：单 Bun 进程单事件循环跑 26 会话；主线程 ~76% 采样在 `sqlite3_step` 同步 pread（大行溢出链、非 mmap）；每 step 固定税（~10 次同步库往返 / 全量历史重读 / git status 全扫描 / 44 工具 schema 重建）；主库 3.66GB、图库 3.67GB（审计证据 3.4GB）。
- **codex 对照**（fork 版 codex-rs）：历史常驻内存 `Arc<Vec>` 每 step O(1) 快照；JSONL 权威 + SQLite 可重建投影（7 库降锁竞争、sqlx 异步池、每库 5 连接）；每会话后台 writer task + mpsc；元数据 5s 去抖；无进程注册表/编辑意图/图谱同步/审计写库；多线程 tokio runtime。
- **已有 Rust 资产**：`codegraph-kernel`（30 文件 / 40,273 行 / 52 napi 函数，extraction+store+resolution 默认 ON）；`chimera-host`（10,723 行，H1 的协议/控制存储基础已落地，生产 runtime 未落地）；`packages/chimera/specs/rust-host/`（3,063 行规格：ipc-v0 / recovery-matrix / h2-data-plane）。
- **orchestrate 实测边界**：16 并发 / 64 默认总派发 / 256 上限；子代理上下文隔离只回传结果；edit-intent 同 family 豁免（战役内文件冲突需靠文件分区纪律，不能靠 claims）；schema 结构化输出在 flash 路线上对大 schema 不稳定（用文本 JSON + 程序内解析）。可做：侦察、模块翻译起草、独立验证。不可做：共享编译循环、跨模块语义收敛、契约单点决策。

---

## 4. 终态架构

```text
┌────────────────────── chimera-host (Rust, 唯一长驻主进程) ──────────────────────┐
│ HTTP/HTTPS front door · auth · OpenAPI 契约（serde + utoipa，字节级 parity 门）   │
│ runtime foundation · router · boot/path/capability/launcher                      │
│ SQLite/WAL（sqlx 异步池，多库分面，单写者 + 读池，权威矩阵见 §6/W1）              │
│ session runtime（内存历史 + 每会话 writer task + turn 状态机）                     │
│ graph core rlib（extraction/store/resolution，NAPI 薄适配保留给 TS 旧调用）        │
│ watcher · SSE/WS fan-out（有界队列 + gap 恢复） · 进程监督                         │
│ provider transport（主力家原生 Rust；长尾经兼容边）                                │
│ control plane（config/bootstrap/skills/instructions/goal/prompt assembly/         │
│                tool_search/compaction/权限与 mutation 链）                        │
└───────────────┬──────────────────────────────────────────────────┬─────────────┘
                │ versioned framed IPC                              │ npm/ESM
   ┌────────────┴───────────┐                          ┌────────────┴───────────┐
   │ Bun 兼容 sidecar（可选） │                          │ JS 插件宿主（Bun）       │
   │ 长尾 provider 适配       │                          │ plugin SDK / hooks       │
   │ orchestrate sandbox（待定）│                        │ 最小真实 sidecar 先行    │
   └─────────────────────────┘                          └─────────────────────────┘
```

原则：**host 可以重启，提交过的事实不能丢**；任何面失败只降级该面，不拖垮宿主。CLI/TUI 是薄客户端，其承载的 server/session 必须由 host 提供，不自宿主。

---

## 5. 范围与非目标

**迁移**：storage 访问层、graph 全面、watcher、SSE/事件 fan-out、HTTP 路由、session/job durable state、session 运行时（历史/工具执行/LLM 流）、主力 provider transport（实际在用的 3–4 家）、遥测替代（内存态）。

**显式控制面 WBS（原计划缺失，本轮补登记）**：
- config/bootstrap/skills/instructions/workbrief/goal；
- prompt assembly 分段/锚点、tool_search 可见性/历史/native tool_search、remote compaction；
- mutation 权限→filewrite→format/LSP→sync/provenance/audit/claims 完整链；
- MCP client 三 transport + graph daemon/server + OAuth callback（图 writer 切换前改薄代理或改归属）；
- 生命周期：InstanceState ScopedCache/disposer/在飞 init 去重、DelegationLimiter permit 借贷、BackgroundJob/SessionActivity generation/pending delivery/family quiescence、租约孤儿恢复/取消 cascade/显式 close 顺序。

**不迁 / 最后迁**：
- plugin loader 与 plugin SDK（动态 ESM + npm 运行时安装，`provider.ts:2248-2405` 的 resolveSDK 证实）——长期 Bun sidecar，定义窄 IPC 能力面；
- provider 长尾（20 个 @ai-sdk/* 中未主力的部分）——Bun 兼容边，逐个收编；
- PTY / LSP / browser 的外部执行程序不移植；迁移其启动、控制、资源登记与关闭边界。CLI / TUI 的呈现层可暂不迁，但 run/web/serve/tui 内嵌的 server/session 必须迁出，改连 Rust host；不能因“UI 不迁”继续保留 TS 会话执行体。
- WebUI 嵌入链与 SDK 生成链——OpenAPI 为唯一事实源，生成产物必须字节不漂移。

---

## 6. 波次路线（W0–W6，能力域而非全局串行）

**读法**：W0–W6 是能力域编号，不是“必须一波做完才开下一波”。设计、契约、fixture 可跨域并行；代码切换按 §7 DAG 与 oracle 就绪度推进。W0 是硬门，任何迁移写入前必须过。

### W0：oracle 工装（硬门，不开写任何迁移）

说明：故障注入与待建 W0 原计划已列，本轮不把“工装未建”当漏项，只是不得跳门。

交付：
1. **分层 oracle**：
   - 确定性层：规范化 schema/字节对账（请求体、DB 行、SSE 帧、tool result/LINE#ID、prompt 分段与锚点）；
   - 因果层：请求/因果行为序列（tool-call 顺序、hook/permission/question/job family/delivery generation、tool visibility/history/native tool_search、MCP 协议与进程资源）；
   - fault matrix：崩溃/断电/超时/取消/重放/部分写；
   - 统计层：延迟/吞吐/RSS/磁盘，允许噪声带，但不吞顺序 bug。
2. 库/表与状态所有权矩阵：session/job/permission/question/process/event，以及 audit/provenance/oracle/obligation/predesign/edit-intent、config/auth/MCP 状态逐项标明权威、migrator、读写者、可重建性、恢复/保留策略、读回退与写换权协议；明确哪些记录必须同事务提交。
3. 170 op inventory 冻结：96 host-first 仅初步分类（`inventory.ts:16-17`）、116 exercise/54 none；补运行时错误/鉴权/目录 workspace 代理/WS 矩阵。
4. live `Server.openapi()` 完整规范化 spec + 正式 SDK 重生成漂移门；旧 `packages/sdk/openapi.json` 不作实时权威。
5. 压测 harness 复用 `script/bench/concurrency-probe.ts` 并扩充（真实 session fixture、host+全部 sidecar RSS、API/heartbeat/turn/writer 延迟、吞吐/公平性/队列/磁盘、同环境重复基线；阈值开工签定）。
6. W-E343 版本化“语义点→owner→fixture”映射（清单已有 summary，不等于 343 项已逐点测试）。

出口：TS 双臂自 parity 零 diff；故障注入全被抓；顺序/因果 bug 不被排序掩盖；spec 与 inventory 入库。**不达标则整个计划停在 W0。**

### W1：数据面与权威矩阵

范围：graph database/read/query/traversal → watcher + change stream → SQLite/WAL 与 durable state → static asset cache → SSE fan-out + event log → process registry。

前置：库/表级权威矩阵——migrator、reader/writer、单写者换权、fencing/幂等、ACK 确认与耐久故障范围（进程崩溃 vs 断电）、outbox/projection、恢复与读/写回退。当前 audit/process/claims 与 graph 同库，不假设已分库；多文件 WAL 无跨文件 crash 原子性，不能泛称所有 SQLite 跨库不原子。

纪律：先保持 schema 与权威兼容，再拆可重建投影；不同时做语言迁移/分库/换权；旧已应用 migration 不改，Rust 迁移权接棒在 W1–W2 内完成，不拖到 W6；writer 翻转后不能 toggle 就宣称无损回 TS，需 drain/checkpoint/兼容验证/明确回退流程。

oracle：按现有测试实际范围映射 extraction/store/resolution/query/traversal/pattern，复用帧字节与规范化节点/关系/结果行对账，不能以 extraction 模板证明 graph 全域覆盖；storage 对账事务效果与结果行，不强求 SQL 优化前后文本相同；SSE 对账事件计数、因果顺序、gap/drop 与单独定义的恢复行为。

退出：每面独立 capability + kill switch + TS fallback；压测数字不劣于 patch2 基线。

### W2：front door（受控扩面，不抢跑）

范围：runtime foundation/router 就绪后，先接不依赖 TS session 语义的 host-first 路由；再逐步接入依赖会话的路由。SSE 建连/恢复、auth。

oracle：`httpapi-exercise` 双臂 parity（现成模板，但仅 Effect/Hono 且隔离 mutating 场景，需扩完整 SSE/DBtrace）+ 170-op inventory 零漂移 + SSE framing 对账。Last-Event-ID/replay/retention_floor/reset 是新增能力，单独标注，不作旧行为 parity。

### W3：会话运行时（第一条 Rust 主控闭环）

前置（本轮核查新增，必须在 W3 前完成）：
- 至少一条可用且经 oracle 验收的 provider 通路：优先 genai 0.7.2 Rust 薄适配器；标准 Chat/API-key Responses 分 profile 准入。尚未覆盖的特殊协议可明确走 provider-only TS 兼容服务，不把整个 TS session 塞进 worker，也不要求先自建全量 provider SDK；
- 插件 hook IPC 契约 + 最小真实 sidecar（覆盖 config/bootstrap、tool.definition、chat.params/headers、tool.before/after、auth refresh）；
- W0 因果层 oracle 与 fault matrix 就绪。

蓝本 = codex 架构，不是逐行翻译 TS：
- 历史常驻内存（每会话 `Arc<Vec>`，全量读仅 resume 一次）；
- 每会话 writer task + mpsc，写后置批量落盘；提交过的事件先落盘再确认；
- 多库分面 + sqlx 异步池（主库/图库/审计库分离，按 W1 权威矩阵执行）；
- 元数据写去抖（事实变化或 ≥5s）；
- 工具执行：文件/graph/storage 相关工具先入 Rust；shell/子进程由 Rust 拥有 spawn/stream/kill；
- 中断语义：`uninterruptibleMask` 三区结构改写为「关键区无 await 取消点 + shield 任务」；取消路径必须保留落账（failToolCall 终态写入），不能只丢 JoinHandle。

**第一条闭环验收**：Rust host 拥有 HTTP/session → LLM 调用 → 本地 tool → commit → SSE → cancel/resume 的会话状态与执行循环；默认候选 provider 为 genai，兼容分支按 profile 单列。TS monolith 只作对照与未切面 caller；provider-only 服务不得承载 session/agent loop。

退出：golden transcript + 崩溃注入/恢复对账 + 26/50/100 路 lag/step 门；同会话 24h/72h soak 无丢失、无单调增长；中断/恢复与 TS 逐条对账。

### W4：provider 扩面

在 W3 已闭环的一家之外，扩到实际在用的 3–4 家（ali-inc / kimi / openai-codex / deepseek，按实际用量定名单）：复用协议与 cassette，冻结 header/body/error/retry/auth 的规范化契约。稳定字段做字节对账；流式按解析事件、内容、工具参数与终态保序对账，并用不同分块方式重放检验 parser，不能要求真实网络 chunk 边界逐字节相同。长尾暂经兼容边，范围按 §13 决定。

### W5：plugin 生态硬化

最小 sidecar 已在 W3 前落地；本波做生态扩面与硬化：hook 调用轨迹对账、权限/错误边界、版本兼容、崩溃隔离、npm 安装与缓存单一 owner。插件宿主保留 Bun 兼容形态；长尾 provider、MCP 适配及 orchestrate sandbox 的长期归属按 §13 明确，不能未经决定称插件为唯一 JS 混血面。

### W6：收口

TS 编排层降级为可选兼容层或退役；发布矩阵收口；上游同步策略重议。JS 兼容终态（plugin + 长尾 provider + orchestrate sandbox）按 §13 拍板执行。

---

## 7. 实际开工 DAG

```text
A0 修订范围 + 最少决策
        │
        ▼
G0 W0 契约 + 行为 oracle 硬门（不可绕过）
        │
        ▼
T1 runtime/core/layout/launcher/IPC 安全基础
        │
        ├────────────┬────────────┬────────────┬────────────┐
        ▼            ▼            ▼            ▼            ▼
   数据/图/审计    主力 provider   JS hook 兼容   HTTP/UI 薄客户端  控制面 primitive
        │            │            │            │            │
        └────────────┴─────┬──────┴────────────┴────────────┘
                           ▼
              第一条 Rust 主控闭环（HTTP/session→LLM→本地 tool→commit→SSE→cancel/resume）
                           │
                           ▼
              按契约依赖逐能力切片扩面 + 受控换权（W1–W5 能力域）
                           │
                           ▼
              故障注入 / 26/50/100 压测 / 24h+72h soak / 平台 npm 两变体门
                           │
                           ▼
                        W6 退役
```

要点：
- A0 只做范围与最少决策，不写迁移源码；契约/fixture 可并行准备。
- G0 是硬门；W0 未过不得写生产迁移代码，但可写契约、fixture、harness。
- T1 的 runtime foundation 是 W2/W3 的共同底座，优先于任何路由抢跑。
- 并行 track 之间不共享 owned files；跨 track 收敛与集成设 barrier；箭头表示默认扩面/换权顺序，不禁止同波内设计、fixture、oracle 并行。
- 首条闭环先窄后宽，不先接 96 个含 TS session 依赖的路由。

---

## 8. 首批工作包（8–10 个，contract/oracle 优先）

业务域各自 owned paths；下列产物路径为建议，本轮不创建。parent 负责共享 contract/manifest 签定；库拓扑、共享 contracts、codegen、migrator 各设单一 owner；CI 集成 owner 独占 Cargo/lock/mod.rs/registry/schema/SDK-gen/CI。

| ID | 范围 | owner | 依赖 | 产物（建议） | DoD |
|---|---|---|---|---|---|
| WP-01 | 范围/base 指纹、共享契约约定与 work manifest | parent | A0 | `specs/rust-host/` 内的 manifest 与分区表 | contract_rev/owner/具体 owned files 可追溯；派发前排除文件交集 |
| WP-02 | W0 recorder/harness（tool result、DB、SSE、prompt 分段） | oracle owner | WP-01 | `test/oracle/transcript/` | 同输入 TS 双臂零 diff；两臂隔离目录/DB，完整记录可重放 |
| WP-03 | W0 比较器、故障分类与统计门定义 | oracle owner | WP-02 | `test/oracle/faults/`、基线描述 | 注入丢失/乱序/重复/中断/部分写能被辨别；归一化不吞因果差异 |
| WP-04 | live OpenAPI/inventory 冻结与 SDK 漂移验证 | HTTP contract owner | WP-01 | 完整 spec、170-op 清单与漂移用例 | 正式生成链可复验；116/54 覆盖差距逐项有归属；96 候选按真实依赖重新分诊 |
| WP-05 | 库/表权威、schema/migrator、ACK/回退/保留契约 | storage owner | WP-01 | `specs/rust-host/` 内的权威矩阵 | 每表 owner/事务/恢复/换权明确；已应用迁移不改；跨库投影可恢复 |
| WP-06 | graph 资产清点、core/NAPI 拆层设计与 parity fixture | graph owner | WP-01 | graph 契约与 fixture 分区 | kernel 复用边界、pattern/search/框架 fallback、UTF-8/UTF-16、daemon writer 归属明确；此包不实现生产 core |
| WP-07 | runtime/router/boot-path-capability/launcher 与平台契约 | runtime owner | WP-01 | runtime/IPC/启动故障矩阵 | H1/H2 已有能力与未实现接线分开；关闭/重启、IPC trust、Windows、两变体安装都有验收向量；此包不实现生产 runtime |
| WP-08 | 首个 provider profile 的协议/请求/流/auth fixture 与 genai 准入规格 | provider owner | WP-01、WP-02 | provider-host fixture 分区 | 明确 genai 可接管与需兼容的 profile；含 hosted tools/native tool_search、重试与刷新归属；对账保序；此包不实现生产 transport |
| WP-09 | hook IPC/JS 兼容拓扑与调用轨迹 fixture | plugin owner | WP-01、WP-02 | plugin-host 契约与 fixture 分区 | config/bootstrap/tool.definition/chat/tool before-after/auth 的可变性、顺序、取消和失败策略明确；npm 单一 owner；此包不实现生产 sidecar |
| WP-10 | 控制面、mutation/MCP/job-family/retention 行为 fixture | control-plane owner | WP-02 | `test/oracle/control/` | 343 语义点映射到 owner/已有或待补 oracle；新增能力与已知差异单列，不冒充旧行为 parity |

**依赖闭合**：以上是 W0 契约/fixture/harness 工作，不依赖“W0 已过”或其自身实现阶段。WP-02–WP-10 的适用出口与差异清单汇合为 G0。G0 通过后才开 T1 生产 runtime/core/launcher 实现；再拆 graph/data、provider、最小 hook sidecar、HTTP/UI、control-plane 实现包。W3 必须等数据/运行时、至少一条经 oracle 验收的 provider 通路、最小真实 hook sidecar 全部可用，不能仅凭契约完成进入闭环。Provider 采用 genai 与特殊兼容通路的边界见 §15。

包纪律：每个包有独立 owned files、独立 build/test 命令、独立结果/checkpoint；不得共享编译输出或临时 DB；集成编译在单一 build root 由 CI owner 单写。

---

## 9. 固定编排与 work manifest

**work manifest 字段**：`work_id / scope / owned_files / base 与文件 hash / contract_rev / dependencies / role / model+variant / oracle_commands / status / attempt / result_refs / approved_delta`。

**状态机**：`queued → building → reviewed → verified → integrated`；异常显式标 `blocked / error`，不得静默跳过。

**pipeline**：discover/design → scoped build → 独立 review → focused verify。只有跨项收敛/集成设 barrier；shared files 串行。

**调度事实与纪律**：
- orchestrate 真实 API 只有 `prompt/agent/model/label/schema`（`host-bindings.ts:66,226-232`）；`workload/variant` 尚未暴露。开工前补选择器透传，或改用已有 task/swarm 保证调度纪律；不编造这些已支持。
- 16 并发 / 64 默认总派发 / 256 总上限 / 128 pending-call 预算；256 不等于可一次 `parallel` 256 个绑定调用，程序须分块或限制在飞请求。runtime 全局池与后台项目池另有作用域。累计派发可过百，但按文件分区、多批滚动，不擅自提高 caps。
- 大规模 family 还须验证活跃性/取消/交付边界：当前 `packages/chimera/src/session/activity.ts:49-70` 的 family 遍历最多 256 成员。WP-10 记录该边界，规模扩展的 oracle 必须检验超边界 family 的 quiescence/取消/claim 释放，不能把每次调用的总派发上限当作产品级可扩展性证明。
- 长战役不随手给任意总 deadline；`timeoutMs` 省略才无限，0/负数会变 1ms。单子失败返回 null，infra 错误 reject；worker/program 没有 durable resume。
- 本轮记录：0-agent 与 1-agent canary 均成功；首轮显式 `1800000ms` 总期限触发超时且无聚合（耗时来源未定），随后分组 24 轴报告全收齐。不据此说工具不可用，也不声称默认 30min 上限。
- canary-first 必须含真实模型权限；日志不是持久 checkpoint。
- 每个包外置结果/checkpoint；orchestrate JS 无 fs，agent 可通过专用工具写自己 owned 文件，不把全部详细报告压进最后 return。
- 失败按 `work_id + attempt` 重跑；编排重启不盲目重复不可幂等副作用。
- ownership 表不是自动锁：same-family claims 豁免，派前必须检测文件交集；不同包不共享编译输出/临时 DB；同一 build root 集成 compile 单写者。

---

## 10. 统一门禁（每波缺一不算完成）

- 该波分层 oracle 零 diff；若刻意修复旧行为或新增能力，须有事先认可的 `approved_delta`（原因、期望行为、受影响契约与对应测试），禁止仅以“差异来自本批改动”放行。规范化不得排序掉因果错误或过滤丢失事件。
- 全量测试不新增失败（对照既有失败基线）+ `bun typecheck` + `check:layering` + `check:service-wiring` 全绿。
- 只读/无状态能力可用 kill switch 回 TS；写路径必须先 drain、确认 durable checkpoint、执行 writer fencing/换权并验证旧版完整读写兼容，才允许受控回退。不能把写回退称作单纯 toggle；旧实现至少保留一个发布周期。
- parent 独立复验，不接受 builder 自报。
- 压测 harness（lag / step 延迟 / 吞吐 / RSS / 磁盘）不回退；阈值按同环境重复基线签定。
- ali-internal-audit 扫描净。
- **发布门禁前移**：host 能力首次对用户可启用前，必须完成 core/host cargo fmt/clippy/tests/parity、host 必需时 CI hard gate、Windows 传输/兜底决定、with-webui GPL 与 no-webui MIT 两变体资产 + npm install 验收。

---

## 11. Rust 宿主最小运行时契约（W-E 产出 + 本轮补充）

- tokio task + 层级 CancellationToken（实例/会话/请求三级）+ JoinSet 监督。
- oneshot / Notify / watch（Deferred、sliding(1) 唤醒邮箱）。
- Drop guard / 显式 async close 协议（无 async Drop 的纪律）；close 顺序需 oracle（尤其 BackgroundJob/SessionActivity）。
- broadcast + mpsc：按 topic 的实际保证区分可靠数据流、可合并唤醒与可重放事件；Effect PubSub 的 sliding 也可丢旧，不能笼统称全部 PubSub 不丢。tokio broadcast 的 lag 需显式处理；不可丢的交付/结算用 mpsc 或可证明的恢复协议。
- timeout / select! / interval（`Schedule.spaced` 完成间隔 ≠ `interval` 固定速率，逐点核对）。
- per-directory 注册表：InstanceState 等价物需覆盖 ScopedCache/disposer、在飞 init 去重、失效/清理，而非仅 DashMap+OnceCell。
- Mutex / Semaphore（DelegationLimiter permit 借用/出借 + cancel 安全 + panic 安全释放，逐行保真）。
- fs2/fd-lock 跨进程文件锁（EffectFlock 等价物）。
- serde + utoipa（OpenAPI 字节 parity 是 server 面硬门禁）。
- 显式 ctx 传参替代 AsyncLocalStorage（EffectBridge/InstanceState.bind 双轨桥迁完即删，净简化）。
- 租约/孤儿恢复：租约到期、取消 cascade、family quiescence、pending delivery 的 generation 语义须逐项 oracle。

完整语义清单（343 点、file:line 级）：`~/.local/share/chimera/tool-output/tool_1817c7215001Jj52Lh6h4U02cg`；版本化语义映射由 WP-10 汇总，WP-02/WP-03 提供记录与比较框架。

---

## 12. 风险登记册

| 风险 | 表现 | 应对 |
|---|---|---|
| 语义漂移不可见 | uninterruptibleMask / 四闩链 / PubSub 不丢语义错位 | W0 分层 oracle 不立不动工；W-E 清单逐点核对 |
| 权威翻转丢事实 | 多库/多文件 WAL 无跨文件 crash 原子性；toggle 即回退的误判 | W1 权威矩阵 + fencing/ACK + drain/checkpoint/回退流程 |
| 验证吞吐 | 全量测试串行 28min，每波回归成本高 | 测试分片 + 聚焦套件；CI 承载全量 |
| OpenAPI 漂移 | SDK/WebUI 契约破损 | live spec 规范化 + 字节级对账 + SDK 重生成门 |
| 战役内文件冲突 | edit-intent 同 family 豁免，兄弟 worker 互踩 | 文件分区 + 单写者纪律；派前交集检测 |
| 子代理能力 | flash 路线大 schema 结构化输出不稳；扇出不自动提升质量 | 文本 JSON 回传；翻译起草用扇出、语义收敛靠 parent |
| host 自身无界增长 | JSC 棘轮换成 Rust cache 无界 | 所有 cache/队列/连接字节或条目上限；soak 门禁 |
| provider 行为漂移 | 重试/流式/错误体差异 | 先一家闭环再扩大；长尾保留兼容边 |
| 发布滞后 | host 不可安装/CI 不 gate，用户无法启用 | 发布门禁前移；两变体 npm 验收 |
| 编排不可恢复 | 无 durable resume；重启重复副作用 | 外置 checkpoint；按 work_id+attempt 重跑；幂等边界显式 |
| 上游同步断裂 | fork 长期分叉 | 迁移批次小而可回退；分界面对上游 TS 层透明 |

停止条件（任一触发即回最近双臂稳定点）：host+sidecar 内存不优于单 Bun 基线；durable state/事件恢复在 soak 中丢已确认事实；IPC 批量化后仍为主要成本；发布矩阵超出可验证面。

---

## 13. 拍板事项

**待拍板（原立项/长尾取舍，保留）**：
1. **本计划立项**：全量 Rust 从「暂缓」升级为「承诺终点」。
2. **provider 长尾取舍**：接受「主力 Rust + 长尾 Bun 兼容边」的长期混血，最后 5% 不承诺全 Rust。

**本轮新增最少关键决策建议（建议，未拍板）**：
- D1 首个 provider profile 与 genai PoC 准入（建议从实际使用的 OpenAI-compatible Chat/API-key 模型开始；Responses/OAuth/WS 分开验收，不按 provider 名字推断全部能力）。
- D2 JS 兼容终态范围：plugin + 长尾 provider + orchestrate sandbox 是单 sidecar 还是双 sidecar；orchestrate 是否保留独立 Bun sandbox。
- D3 Windows：host 传输与兜底策略（随包发布 / 延迟 / 不支持）在首个 host 能力发布前定。
- D4 图 writer 切换时点与 graph MCP daemon 的归属（薄代理 vs 直接改 Rust）。
- D5 发布门禁时点：首个用户可启用 host 能力的版本即启用 npm 两变体 + CI hard gate。
- D6 性能阈值由开工时同环境重复基线签定，不预先写死。
- D7 共享 contract/CI 集成 owner 与业务域 owner 的边界（parent 签定）。

**已拍板（2026-10-28/29 会话，记录在此）**：
- session 与图审计证据保留期均 30 天；
- 遥测 DB 持久化移除；调度速度信号改进程内存态（用户 input 时或每 50 轮滚动平均 tps）；
- 异步接口先行、执行体可换（本计划落实为「执行体直接 Rust host，取消 Bun Worker 中间态」）；
- 止血包内容（pragma/vacuum/prune/读路径纯化/每步税/sync 门控/schema 缓存/桥修复/压测 harness）已随 `0.0.7-beta8-patch2` 落地。

---

## 14. 与既有文档/批次的对应关系

| 旧项 | 新位置 |
|---|---|
| RUST_MIGRATION_PLAN R0–R6 / 方案 A·B·C | 历史证据；方案 A 的 napi 纪律保留给 kernel；B 的 sidecar 仅剩 plugin 宿主（+待定长尾/orchestrate）；C 以加速绞杀形态成为主线 |
| RUST_HOST_MIGRATION_PLAN H0–H2 | H0 观测并入 W0 工装；H1 仅协议/控制存储基础，并入 WP-07 与 W1/W2；H2 即 W1（Step0 已实现，保留复验） |
| RUST_HOST H3（Bun session worker 化） | **删除**，由 W3（Rust 会话运行时）取代 |
| RUST_HOST H4–H6 | 并入 W4–W6 |
| 并发调查「阶段 2」（codex 式数据面 TS 版） | 取消 TS 版落地，四原则在 W3 的 Rust 会话运行时原生实现 |
| patch2 止血包（2026-10-29 已构建安装） | 已落地；其压测 harness 为基线之一，需按 §1 扩充后才作全计划裁判 |

---

## 15. Provider 选型追补：genai 0.7.2（2026-10-29 研究，候选未上线）

**建议**：优先采用 genai + Chimera 薄 provider adapter；agent/tool 执行循环仍由 Rust host 自有。不先重写全量 `ai-provider-rs`，也不把保留 TS provider 等同于保留 Bun session worker。若有通用扩展价值，待 adapter 的真实使用边界与 oracle 稳定后再评估独立公开库；本轮未建库或发布。

### 15.1 固定版本与职责

- 核查版本为 `genai 0.7.2`（docs.rs 标 2026-10-28 发布，MIT OR Apache-2.0）。PoC 建议锁 `=0.7.2`；Context7 索引曾标 0.5.2，API 必须按发布源核对：`Client::new()`/`build()` 返回 Result。
- `Client::exec_chat` / `exec_chat_stream` 只执行一个 provider 回合，不执行本地工具、不自动继续 agent loop；Tool/ToolCall/ToolResponse/ChatRequest 提供声明与回放数据。
- genai 负责已支持协议的 HTTP/SSE、请求构造与响应解析。Chimera adapter 负责自有请求/LLMEvent 映射、usage、工具参数模式、显式路由与错误/取消衔接。
- agent loop、工具执行/权限、plugin、历史/提交/审计、子代理调度、OAuth 凭据与刷新生命周期、retry/replaySafe 策略由 Chimera 拥有。异步 resolver 可向 genai 供应动态 token，不能因无内置 OAuth 登录流程就断言 HTTP token 接入不可行。

### 15.2 能力分诊（源码支持不等于已实测）

| profile / 能力 | 0.7.2 证据与处理 |
|---|---|
| 标准 API-key Chat、Anthropic/Gemini 等内置协议 | 适合作首批候选；自定义网关用显式 ModelSpec/ServiceTarget 与逐请求 headers/options，避免依赖名字嗅探或修改进程 env。每个实际路由仍需 fixture 准入。 |
| API-key OpenAI Responses | 已有专用 adapter：instructions、store/previous_response_id、response_id、工具、reasoning/usage；与 Chat 独立对账。加密 reasoning 已有捕获/回放支持，但 metadata/终态/续接 fidelity 必须验收。 |
| 函数工具与流式 tool-call | 支持多调用入队；capture_tool_calls=true 时 OpenAI chunk 是累计快照，不可再当 delta 拼接。ToolResponse.content 为 String，JSON 结果需规范化序列化，媒体/复合工具结果须单列适配或兼容。 |
| Codex OAuth HTTP | endpoint/token/headers 可由 caller 配置；账号头、刷新并发、body、历史和加密数据等价性未验证，不能由 API-key Responses 成功推断。 |
| Codex WebSocket、native tool_search、remote compaction、其他 hosted tool 事件 | 尚无完整原生契约覆盖；保留专用 route/transport 或经 oracle 验收的 TS provider-only 兼容执行体。按能力分流，不把失败半回合盲目重跑成另一后端。 |
| raw_frame_sink | 能观测规范化层之外的帧，但不是可插拔完整协议实现。同步 sink 不可阻塞；CollectorSink 无界、ChannelSink 满队列可丢帧，均不能直接作为可靠执行/恢复通道；终端 hook 也不是 cleanup 保证。 |

### 15.3 Adapter 的硬约束

1. 先保持 Chimera 自有 request/event/工具结果/usage 契约；不要将 SDK 的类型或模型名字推断当产品权威。Client 可复用，endpoint/auth/header/extra_body 按 profile 和请求隔离；验证尾斜杠、大小写同名 header 与最终覆盖顺序。
2. 显式定义 capture 模式与参数组装：多调用以稳定 call_id 关联；同一 assistant 回合只回放一次调用集合，再回放各 tool results。非法/截断 JSON 必须按 registry schema 报错或进入可审计恢复，不能把 SDK 的 String 容错当已验证工具输入。
3. 没有明确正常终态的 EOF/取消/超时不能补成成功或执行半截 tool-call；保留片段用于诊断/落账，清理由 host 显式负责。新增能力/已知差异用 approved_delta 与测试标注。
4. 仅捕获必要内容；raw frame 聚合必须按 stream_id 分流并有内存上限。OpenAI capture 源码会重新构造并 clone 累计参数，存在大参数复制热点，性能须实测；不预设 Rust SDK 必然优于 TS。

### 15.4 可验收 PoC 工作包（先契约/fixture，W0 门后才接生产实现）

| 包 | 依赖 / owned scope | 出口 |
|---|---|---|
| GP-0 profile 与 oracle | WP-08；provider fixture/能力表 | 固定版本、实际路由/model/auth/options、受支持与兼容清单；复用 packages/llm 的 recorded-golden/recorded-scenarios，不以真实重复副作用测 parity。 |
| GP-1 隔离 SDK adapter/harness | GP-0 + 测试契约；独立 provider 评估目录，不依赖 T1、不接生产 host | 单请求→流式工具调用→由测试 caller 执行工具→结果回放→下一轮响应；SDK 不自行循环。正常终态与 tool call_id 对齐；可作为 W0 选型验证工装先做。 |
| GP-2 协议与故障对账 | GP-1；provider replay 测试 | 多工具同帧、碎片/累计参数、reasoning/text 混合、usage 尾帧、invalid JSON、EOF/取消/超时/429、结构化与媒体输出；无误执行、无重复终态。Responses 与 signed/encrypted replay 独立验收。 |
| GP-3 并发与资源 | GP-1；独立 provider bench | 1/26/50/100 并发，同 cassette 发帧节奏；小/大 prompt 与大工具参数、不同 chunk 大小、慢消费者/drop。比较 TS provider 与 Rust genai adapter 的准备/首帧/交付延迟、CPU、峰值/回落 RSS、fd/连接、队列与错误率；阈值由同环境基线签定。 |
| GP-4 特殊通路、生产准入与分发 | GP-2/GP-3；生产注入另依赖 G0 + T1，Codex 专用实现与平台 CI 独立分区 | WS/native tool_search/remote compaction/OAuth 矩阵；未通过项保留明确兼容分支。SDK 可在隔离 harness 先评估，生产 host 不绕 W0 门。检查 reqwest/TLS/system-proxy/crypto features、实际 MSRV 与原平台构建矩阵，不以 edition 或库名称代替验证。 |

本轮仅完成 4 轴静态研究与关键发布源码复核，未编译、未跑上述 PoC/性能测试、未调用真实 provider；采用与 fork/公开库立项仍须依据准入结果决定。

### 15.5 固定版本证据

- [Client：单回合调用与显式 ServiceTarget](https://docs.rs/genai/0.7.2/genai/struct.Client.html)
- [OpenAI streamer：累计参数、多调用入队、终态](https://docs.rs/genai/0.7.2/src/genai/adapter/adapters/openai/streamer.rs.html)（106–137、174–193、214–275、349–351）；0.7.2 已遍历全部 tool_calls，旧片段“只取第一个”的疑点不成立。
- [Responses 输出规范化范围](https://docs.rs/genai/0.7.2/src/genai/adapter/adapters/openai_resp/resp_types/resp_output_helper.rs.html)（105–122）
- [Raw frame sink 的顺序、终端与队列契约](https://docs.rs/genai/0.7.2/src/genai/chat/frame_sink.rs.html)（150–179、216–294）
- 本仓 oracle：`packages/llm/test/recorded-golden.ts:58-93`、`recorded-scenarios.ts:91-121,206-213,275-284`。

---

## 附录 A：W-E 语义解剖要点摘录

- 分档：mechanical 120 / di 74 / structured-concurrency 68 / coordination 45 / streaming 31 / hard 5。
- hard 五处：`instance-state.ts:16-26` 与 `effect/bridge.ts` 的 ALS 双轨上下文重放（迁完即删）；`chimera.ts:802` 等 catchDefect 控制流（panic/Result 分层须保留通道）；`provider.ts:1641,2025` 插件 auth 重入桥与 `provider.ts:2248-2405` 动态 npm import（留 Bun sidecar）。
- DI：87 服务 / 84 构造器 / 76 条 provide 链全构造期静态装配；仅 3 个设计点（4 个 Context.Reference 请求注入、InstanceState per-directory 单例、10 处 Layer.suspend 断环全在 session 服务簇）。
- 生命周期硬点：无 async Drop（显式 close 纪律）、uninterruptibleMask 无对应物（改代码形态）、background-job 四闩链状态机（worker 回收正确性依赖）。
- 流式两契约：按 PubSub 配置区分可靠投递与 sliding 可丢旧/合并；Stream.scoped 惰性获取（流不跑不持租约）。
- 模块友好度：config-storage / session-infra（turn-lease、part-reconcile 可当 W1 首批）/ provider(transform) / session-stream 最友好；session-prompt（34 依赖构造器）/ agent/background-job / tool-shell 最重。

## 附录 B：证据索引

- 主线程采样 ×2 + lsof + pragma 实测：`/var/folders/dt/wxzvy2252txfv2mrcbpxsh3h0000gn/T/chimera/perf-2026-10-28/`；
- 探查报告 10 份 + 二轮 3 份 + W-E 1 份：`~/.local/share/chimera/tool-output/`（索引见 `memory.md` 2026-10-28/29 条目）；
- 体积 dbstat 实测、读写三桶清单、codex 对照表：同上报各件；
- 压测基线：`/Volumes/workspace/cbench/concurrency/concurrency-smoke-20261028-180545.json`（patch2 前：1 路 lag p50 0.72ms → 100 路 90ms；单路吞吐 695.7 → 9.4 steps/s）；
- 本轮 24 轴核查与 3 组跨轴 review：parent 会话记录（未落盘为独立文档）。