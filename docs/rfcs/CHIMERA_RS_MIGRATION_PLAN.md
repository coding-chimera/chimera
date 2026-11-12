# Chimera-rs 硬分叉与能力迁移实施计划

> 状态：实施中，2026-11-12。
>
> 本文是实施计划与验收基线，不是完成报告。完成标志是全部迁移能力和质量门均落地，且实际 Chimera-rs 产品可正常使用。
>
> 目标：以当前 Codewhale 为执行底座硬分叉为 Chimera-rs，迁入 Chimera 的关键产品能力，以 swarm 单向替代 fleet，并形成可验证的单进程高并发、多项目运行能力。
>
> 实施硬约束：迁移实现全部使用 Rust，不保留或新增 TS 实现、TS browser driver 或 TS 会话/工具兼容执行体。所有功能切片必须带可运行的行为、边界、故障和隔离测试；新增 crate 和模块默认 `#![forbid(unsafe_code)]`，既有 unsafe 只能按明确必要性单独审查，不得扩散。

## 0. 结论

1. **fork Codewhale，不迁移 Chimera 的 TS 会话运行时。** `Engine::run_turn` 仍是唯一 turn loop，Runtime worker 仍是唯一持久执行基元，`agent` 仍是唯一模型侧子代理入口。
2. **swarm 不是恢复 Codewhale v0.8.5 前的旧实现，也不是把 `fleet.jsonl` 改名。** 目标是“Chimera swarm 的扇出与推送完成语义 + Codewhale 的持久 Runtime、租约、权限、远程执行和 receipts”。Fleet 的公共名词、配置、API 和存储在迁移完成后退出，不保留第二套长期别名。
3. **先修多项目隔离，再迁功能。** 当前 read denylist、终端宿主、retry 展示、prompt override 等仍有单前台 Engine 假设；app-server 也仍以单一 `state.workspace` 驱动多数路由。
4. **图工具退役的是拉取式模型/MCP 表面，不是图内核。** edit 的主动同步、依赖级联重索引、传播结果、predesign/audit 所需查询和 `Ref: node:<id>` 锚点必须保留。Codewhale `work_graph` 是任务证据台账，不能拿来替代 CodeGraph。
5. **渐进披露采用 Chimera phase-2 语义。** reveal 先进入追加式会话上下文并按名执行，在 compaction 边界再进入工具数组；搜索、权限和 wire 测量复用 Codewhale 现有实现。
6. **Provider 只迁增量，不另建 provider/event 抽象。** Codewhale 已有 OpenAI API Responses/OAuth 与官方 Model Studio 支持；Chimera 的 ChatGPT subscription Codex backend 是另一条 endpoint、凭证 scope 和 wire profile，不能因同名 Codex 就宣称已覆盖。Chimera 的 `alibailian` 也是独立于官方 Model Studio 的显式 relay profile。
7. **配置、提示词和身份都做一次性显式迁移。** 不引入第二套 JSONC 配置加载器或第二个 base prompt；旧数据经 importer 转换，未识别项报错，不静默忽略。
8. **硬分叉先切断上游服务依赖。** 未有自己的端点前，默认关闭遥测、自更新、cloud-facts 和 account/remote-control，避免数据发回上游或“更新回 Codewhale”。

## 1. 范围与非目标

### 1.1 范围

- fleet → swarm 的产品、运行时、配置、API、TUI、Workflow、Lane 和存储迁移。
- 单进程多项目、多会话、多 swarm 的隔离、限额、背压、恢复和观测。
- edit 推送式图传播，以及拉取式图工具向推送式上下文的完整切换。
- predesign 多会话编辑意图、冲突排队、唤醒与释放。
- browser 七工具及其生命周期、审批、安全和产物链路。
- 工具渐进式披露。
- Codex、Alibailian 及其他 provider 的显式特化 profile。
- Chimera 配置选项和提示词语义的映射、收口与登记。
- Chimera-rs 品牌、许可、CI、发布和上游同步边界。

### 1.2 非目标

- 不搬入 Chimera 的 TS `SessionPrompt.runLoop`、`chimera-host` 第二会话执行体或 Bun session worker。
- 不迁移可执行 `orchestrate` JS/consumer host；DAG 使用现有 Workflow IR，多轮常驻 consumer 如需支持另行评审。
- 不新增第二个 turn loop、工具 registry、provider 事件流、write-claim 权威或工具发现系统。
- 不把 predesign 做成 OT/CRDT 或自动内容合并；冲突解决仍是排队、重读和代理/用户判断。
- 不要求第一期一个 swarm 跨多个项目写操作；多项目目标是一个宿主内多个项目各自并发运行。
- 不迁移 Playwright/TS browser driver；浏览器仅复用系统 Chromium 及 Rust CDP 客户端，浏览器协议、会话、权限、快照和资源生命周期均由 Rust 拥有。
- 不迁移未接线的 `chimera_context`、browser scenario runner 产品化或 `DUAL_SYSTEM_PROMPT_PLAN.md` 的双风格实现。
- 不实现 Workrooms RFC；需要跨表面线程投影时另评，不与本次 Runtime 改造同时进行。
- 不在没有自有发布与账户服务时承诺 npm/crates.io/account 功能，不未经授权发布或改写历史。

## 2. 证据基线

### 2.1 仓库固定点

| 项 | 当前事实 |
| --- | --- |
| 目标仓库 | `/Volumes/workspace/chimera-rs`，实为 Codewhale，`main=f5a3dda`，工作树在调研前干净 |
| 目标 remote | `https://github.com/codewhale-hq/Codewhale.git` |
| 目标历史 | shallow/grafted，只有当前提交、无 tag；本机 `codewhale-upstream-main` 也同样 shallow，不能补历史 |
| Chimera 源 | `/Volumes/workspace/chimera`，`main=db93aa581`，相对 origin ahead 93 |
| Chimera 工作树 | 41 个已修改文件，2 个未跟踪文件；不能只按 commit 迁移 |
| Chimera diff 指纹 | `git diff --binary` SHA-256 `721eca687813792d63bf99c098612a276f7ed6670ccbfe9b3a40e44d15002642` |
| 未跟踪文件指纹 | `DUAL_SYSTEM_PROMPT_PLAN.md` = `90901cbbdb9dbb052e17891019e6a625f09c44a19ee821e30c8b1b256f430846`；`chimera.json` = `367e1f4ffe32c55d42b677b353b25ba7b9521401ae8140ea149065a703b54b3c` |

每个实施切片开工前都要重新记录源 commit、工作树 diff 和实际读取文件哈希。若源文件已变化，以新证据修订对应切片，不能机械套用本文行号。

### 2.2 旧文档不能当作现状

- Chimera `RUST_FULL_MIGRATION_PLAN.md` 的生产接线状态已滞后：`chimera web/serve` 已默认委派 `session.runtime`，原生 Rust swarm 已存在，但其 `production_verified` 仍未取得 24h/72h 证据。
- `chimera-host/src/session/subagent/{swarm,spawner,registry}.rs` 可参考 Rust 语义，但依赖 host 的 session facade 和 RPC，不能整个塞进 Codewhale。
- `crates/chimera-graph-core` 当前只有 wire/contract；store/db/query/traversal 等仍为空模块。生产图实现主体是 `codegraph-kernel` 与 `packages/chimera/src/graph/**`。
- `DUAL_SYSTEM_PROMPT_PLAN.md` 是未跟踪的纯设计稿，没有对应生产实现。
- Codewhale 文档明确旧 swarm 已在 v0.8.5 移除；现存的是 `agent`、`SubAgentManager`、Fleet、Workflow、Lane 与限流 governor。

### 2.3 可复用与不可混淆的现有资产

| 领域 | 直接复用 | 不应复用/误判 |
| --- | --- | --- |
| 执行 | `Engine::run_turn`、`RuntimeThreadManager`、`SubAgentManager`、headless `exec` | Chimera TS runLoop、Chimera host 第二 turn loop |
| 持久编排 | Fleet ledger 的 lease/heartbeat/幂等 append、local/SSH host、artifacts、receipts | `fleet/scheduler.rs` 的 test-support/dead-code 路径、Runtime 已忽略的 legacy 配置 |
| 多项目 | `RuntimeWorkspaceScopes`、workspace drive lease、每 thread Engine、session lease | 单值 `RuntimeApiState.workspace`、进程全局 read denylist |
| 工具 | 生产 `crates/engine/src/tools/{registry,spec}.rs` 与 `tool_catalog.rs` | 未接入 Engine 的 `crates/tools::ToolRegistry` 另一层 |
| 披露 | Codewhale 搜索、defer、权限、真实 provider-wire 测量 | 再复制一份静态工具描述目录 |
| Provider | `RouteResolver`、`ReadyRouteCandidate`、responses dialect、Codex OAuth、Model Studio、native search | 新引入 Chimera `LlmEvent` 平行事件体系或 substring 路由推断 |
| 图 | `codegraph-kernel` 的提取/store/resolver、TS 图查询与遍历语义、既有 fixtures | Codewhale `work_graph`；把 `chimera-graph-core` 骨架当完整实现 |
| 协作 | Codewhale `CoordinationLedger` 与 Chimera claim 算法 | 两个独立文件锁/claim 权威 |
| 浏览器 | Codewhale 审批、net guard、MCP desktop fence、图像 ToolResult | 无鉴权 artifact URL、无 SSRF 防护的原始 browser runtime |

## 3. 目标架构与不变量

### 3.1 架构

```text
chimera CLI / TUI / web / ACP / MCP / exec
                    │
                    ▼
        app-server：请求级 project 解析与鉴权
                    │
                    ▼
       Project registry / lifecycle（建议逻辑边界）
       canonical root · config generation · quotas
       graph service · coordination ledger · browser resources
                    │
                    ▼
          RuntimeThreadManager / Runtime worker
          一个 session 一个 Engine；一个 Engine 一个项目
                    │
                    ▼
             Engine::run_turn（唯一循环）
                    │
       ┌────────────┼──────────────┐
       ▼            ▼              ▼
   ToolSpec      SwarmService    Provider profile
   mutation →    agent 批量动作   RouteResolver → client
   graph push    Runtime worker   Chat / Responses / Anthropic
                    │
                    ▼
        lease · receipts · mailbox · event log
```

建议的逻辑边界不是要求再建一套框架：优先在现有 `app-server`、`runtime_threads`、`engine` 模块内增加明确类型和所有权；只有 codegraph、browser driver 等确有独立依赖的内容才新增 crate。

### 3.2 强制不变量

1. **单循环**：所有模型调用和工具执行继续经过 `Engine::run_turn`。
2. **单子代理入口**：模型通过 `agent` 的批量/swarm 动作扇出；不新增独立 `chimera_swarm` 模型工具。CLI/API/TUI 可使用 `swarm` 名词。
3. **单执行底座**：短期子代理、持久 swarm worker、Workflow 叶子都投影到同一 Runtime 生命周期、权限、终态和 receipts。
4. **项目隔离**：每个 Engine 固定 canonical workspace；跨项目不共享可变 session/config/graph/browser 状态。换项目创建新 Engine，不用 `SyncSession` 把运行中 Engine 改造成另一项目。
5. **会话单 turn**：同一 session 仍一次一个 turn；高并发来自多个 session/worker，不在一个 Engine 内引入并行 turn。
6. **权限只能收紧**：项目配置、子代理和跨项目请求都不能扩大用户/全局授权；身份解析不等于授权。
7. **模型可见即可重建**：所有图推送、工具 reveal、swarm 完成、claim 唤醒都写 session 记录；live UI 不拥有另一份真相。
8. **KV prefix 可解释**：system + tool catalog 只在声明的 initial/model/mode/goal/tool_surface/resume 边界变化；compaction 本身是 `reset:compaction` 的 history tail reset，若借该边界提升工具，提升另行记录 `change:tool_surface`。易变事实走追加历史。
9. **背压优先**：所有队列、事件、索引、浏览器和 worker 都有界；达到上限时排队或明确拒绝，不能无界 spawn。
10. **失败不伪装原子性**：文件写入、图同步、审计、浏览器产物分别记录状态；任何部分失败都明确可读，不能宣称跨资源事务成功。
11. **Tokio 不内联阻塞**：图 SQLite、解析和浏览器进程控制遵守现有 `spawn_blocking`/异步进程约定。
12. **功能与 registry 同切片**：新增/删除命令、feature flag、provider 或用户功能时，同步 `docs/features.toml`、`config.example.toml`、文档和相关 guard。

### 3.3 所有权和隔离键

| 资源 | 所有权/键 | 生命周期 |
| --- | --- | --- |
| 项目 | canonical workspace root | registry admit → pin/idle TTL/RSS 回收；活跃 turn/worker 禁止回收 |
| 会话 | `session_id`，且绑定项目 | Runtime thread；恢复后仍保持原项目 |
| turn | `turn_id + session_id` | FIFO admission；cancel/interrupt 保留终态 |
| swarm | `swarm_run_id + project + parent_session` | durable ledger；子 worker 记录 parent/attempt/lease |
| 图 | 每项目单 writer、读池、graph revision | 项目回收时 drain/close；跨进程锁保留 |
| claim | 项目 + file + session family | explicit/idle/remove/TTL 释放；wake 有界优先 |
| 浏览器 | project + mode 的 connection；session context；tab generation | session close、项目回收、全局配额与进程退出清理 |
| 配置 | 项目 generation + session snapshot | reload 影响新 session；运行中只接受显式、记录的变更 |
| Provider | route/provider scope 的限额与凭证 | 不随项目串用；secret 不进入项目日志 |

## 4. 实施波次

波次表示依赖，不要求所有工作串行。Provider、文档 fixture 和独立测试可并行；生产切换必须按门执行。

| 波次 | 工作包 | 主要出口 |
| --- | --- | --- |
| W0 | 分叉止血、源基线、行为 oracle | 自有构建可复现；上游端点不再误用；当前行为可比较 |
| W1 | 多项目 Runtime 与配置隔离 | 多项目零串扰；请求级 workspace；有界实例生命周期 |
| W2 | swarm 单向替代 fleet | agent 批量动作、后台推送、durable swarm；fleet 代码与表面退场 |
| W3 | 提示词、披露、Provider profile | reveal 缓存稳定；Codex/Alibailian 合同分项验收 |
| W4 | CodeGraph 与 predesign | 文件变更主动传播；推送结果可替代拉取工具；协作冲突可恢复 |
| W5 | browser 工具包 | 七工具、安全审批、资源回收、截图链路；真实浏览器 smoke |
| W6 | 配置/身份收口、压测与退役 | 配置 importer、旧路径/旧 fleet/旧图工具清理；并发与 soak 证据 |

任何一波不得把“代码存在”写成“生产验证完成”。每波提交信息记录实际运行的测试及 `N passed; M failed`，过滤测试必须确认 `N > 0`。

## 5. W0：硬分叉与行为基线

### 5.1 仓库和供应链

1. 在获得联网授权后，用完整 clone 或 `git fetch --unshallow` 恢复历史与 tags；配置独立 `upstream` 和新的 `origin`。当前两个本地 shallow 目录都不能承担历史合并。
2. 默认采用 **保留上游 remote、选择性 cherry-pick/merge 安全修复**；不重写共享 main，不自动 rebase 上游，不自动同步发布。
3. 保留 `LICENSE` 原版权行、`THIRD_PARTY_NOTICES.md`、Apache-2.0/NOTICE 和 `.mailmap`/作者信息；新增 Chimera-rs 归属，不删除历史贡献。
4. 第一期默认 **GitHub Releases-only**，暂停 npm/crates.io/homebrew/winget 发布。新 org/repo URL 是执行发布改名前的外部前置条件。
5. 在第一个可运行 fork 构建前处理以下默认值：
   - telemetry：无自有 sink 时默认关闭，而不是指向 `telemetry.codewhale.net`；
   - update：无自有 release 源时明确禁用，不允许回退到 Codewhale Releases；
   - cloud-facts/account/remote-control：无自有服务时移除或显式报告 unavailable，不能静默连接上游；
   - owner 限定的 CNB/GitCode/web/review workflow 和上游 secrets：删除或替换为自有配置。
6. 保留 provider 语义变量，如 `DEEPSEEK_API_KEY`；产品运行时变量才进入 `CODEWHALE_*` → `CHIMERA_*` 映射，禁止全局字符串替换。

### 5.2 行为 oracle

建立四类基线，fixture 放目标仓库并拥有明确版本，不通过 `../packages/chimera` 跨仓引用：

1. **请求/事件**：provider body、流事件、工具调用、终态、取消、session log、KV prefix hash。
2. **持久状态**：session/Runtime/Fleet ledger、graph schema v14、extraction v10、claim/waiter、配置导入结果。
3. **故障**：取消、超时、进程退出、部分写、重复/乱序事件、DB busy/替换、恢复与重放。
4. **统计**：延迟、吞吐、RSS、FD/进程数、DB lock、队列长度；记录环境，不能用单次结果当容量承诺。

旧 Chimera 的 26 并发和 30 分钟报告可作参考，不能直接证明 Codewhale 或图写路径；其大库报告是主库而非 `codegraph.db`，其 24h/72h 门尚未完成。

## 6. W1：高并发多项目 Runtime

### 6.1 先修进程级串扰

| 问题 | 证据与改动 |
| --- | --- |
| read denylist 后建 Engine 覆盖先建者 | 将 `crates/sandbox/src/read_guard.rs` 的全局 active 改为 Engine/ToolContext 捕获的不可变策略；增加两项目相反 denylist 的并发回归 |
| retry 状态单前台假设 | `crates/runtime/src/retry_status.rs` 拆分 provider 共享限流事实与 session/project 的展示状态；保留正确的 provider 级 pause |
| 终端宿主/chrome | `host_terminal` 只归拥有终端的 TUI；headless/Runtime worker 禁止 chrome，多前台不共享终端输出 |
| prompt override OnceLock | 当前仅从全局 config home 在启动时加载一次，二次 set 会失败而非覆盖；继续限制为进程启动级统一配置或删除，防止未来项目级 override 引入全局态。普通项目 constitution 走 session 固定快照 |
| first notice 全局去重 | 按产品进程或项目语义明确键控，不能由一个项目吞掉另一个项目的关键提示 |
| cwd 回退 | 清除 MCP、session、file、subagent 中对进程 cwd 的隐式相对路径回退；在 admit 时转成项目内绝对/受限路径 |

### 6.2 请求级项目路由与实例生命周期

- 在 `crates/app-server/src/runtime_api.rs` 增加统一 middleware：显式 workspace 参数/header → 已认证 session/swarm 所属项目 → 默认项目。禁止客户端仅凭路径越权进入未授权项目。
- 把 handler 对单值 `state.workspace` 的读取改成 resolved scope；不能让少数路由继续隐式使用启动目录。
- `RuntimeWorkspaceScopes` 增加 idle TTL、活跃计数、RSS/数量预算与有界等待。当前 64 是代码硬上限，8 是 active-thread 默认值，两者都只是基线而非容量承诺；调整 scope 上限需要显式修改常量/配置及对应测试。
- 移植 Chimera `InstanceStore` 的三类消费者信号：请求 lease、session pin、UI presence。presence 只续期、绝不引导启动；SSE 在整个流期间持 lease。
- 增加抖动治理：dispose 后立刻 reboot 的短期 pin、连续两次 dangling pin 才对账清除、内存压力驱逐和告警退避。具体 TTL 由压测确定，不能把源仓库 30 秒/2 分钟等数值当未验证的目标默认值。
- 保留一个项目一个 driving owner 的跨进程 lease；同一宿主内可有多 session/worker。竞争时返回明确持有者信息，不静默放宽为多个跨进程 writer。
- ACP/MCP stdio 仍可单项目启动；HTTP 多项目必须走同一解析与鉴权逻辑。
- swarm 子 worker 默认继承父项目；跨项目任务必须显式创建属于目标项目的 root session 并重新鉴权，不继承浏览器、凭证或可写路径。
- 不复制 Chimera 的全局单 SQLite 连接/全局 Promise 写队列。项目写者、Runtime store owner 和读池按现有存储权威拆分，避免一个项目的慢写阻塞所有项目。

### 6.3 配置和会话快照

- 项目加载得到不可变 `ConfigSnapshot + generation`；session 创建时固定 prompt/header 和项目资源所有权。
- 复用 Codewhale 现有的 fd-lock + CAS 配置写和 reload preflight：先验证所有 loaded thread 的新 route，失败则保留旧配置，不能像源 Chimera 一样读-改-写丢更新或直接 dispose 活跃实例。
- route、compaction、stream timeout、subagent 限额可按现有 per-engine op 在下一 turn/新任务生效，活动 turn 保持不变；graph/browser/project ownership 变化只影响新 session/worker。
- 权限收紧可立即经现有 `LivePosture`/authority 通道传播；model、mode、tool surface 等 header 变化必须产生声明的 re-pin 事件。
- provider 凭证不进入项目 snapshot 的可序列化日志；secret 仍由现有 secrets store 和 route-owned auth 解析。

### 6.4 持久 admission、幂等与恢复

高并发不是只增加 Engine 数量，还要防止跨进程重复 turn 和重复副作用。补入 Chimera host 已验证的以下语义，但接入 Codewhale 现有 Runtime store：

- 每 session 持久 turn lease：原子 acquire、owner boot id、续租、过期/死持有者接管和包含持有者信息的 busy 错误。源实现的 30 分钟 TTL/10 分钟续租作为初始对照值。
- prompt `request_key`：同 key 同 body 返回首次结果且不增加 provider round；同 key 不同 body 返回 `idempotency_conflict`。pending request 唯一，durable event 以 dedupe key 去重。
- 先收编现有 `llm_response_cache::ResponseCache::make_key` 的指纹/缓存部件：Runtime admission 是唯一的用户可见幂等权威，response cache 只能是其内部响应存储或只读优化，不能再叠加一套给出不同答案的去重语义，也不能以缓存命中为由重放工具副作用。
- terminal、idle、usage 和 event cursor 作为一个原子提交组；流式 delta 不当 durable terminal 重放。
- 启动 recovery 按证据收敛到 completed/cancelled/interrupted；无法证明副作用时明确 `side_effect_state=unknown`，不能自动再执行工具。
- 用真实 SIGKILL 子进程验证恢复，而不只跑合成 fault enum；覆盖等待工具、terminal 前后、pending republish 和重复启动 sweep。

### 6.5 W1 出口

- 两个项目使用相反 read denylist、不同 model/config、独立图和浏览器状态，并发运行无串扰。
- 同项目多 session 可运行；跨进程第二个 writer 被明确拒绝或 watch-only attach。
- scope/Engine 回收不会取消活跃 turn，也不会留下 MCP、shell、浏览器或索引任务。
- 同 key 重试不重复 provider/tool 副作用；kill -9 后 lease、terminal、pending 和事件均可恢复且二次 sweep 幂等。
- 所有事件能用 project/session/swarm/turn 定位，慢消费者有背压或显式 gap，不静默跨项目投递。

## 7. W2：以 swarm 单向替代 fleet

### 7.1 目标语义

**保留 Chimera swarm 的产品行为：**

- 三种合法输入：`items + prompt_template`、`items + preset`、`from`；`description` 必填，items/from 互斥，模板必须含 `{{item}}`，错误文案能让模型自修复。
- 保留 `audit-followup | audit-review | oracle-followup | file-review` 四类 preset 和结构化摘要字段；它们只提供 prompt 形状，不绕过目标完成 sentinel。
- `from` 支持 `pending/claimed/stale/active_obligations` 与 `failing/unknown/failing_or_unknown_oracles` 七源。W2 先实现只读 evidence-source port 和缺记录时的显式错误，W4 接齐 obligation/oracle writer；没有证据时按空工作输入报错，不能生成假 items。
- items 的 scope overlap 继续产生 advisory `scopeWarnings`，但真正防冲突由 Codewhale write scope 与 W4B claims 强制，警告不能冒充锁。
- model/profile/workload 只在 fan-out prepare 时解析一次，权限也只按目标合同询问一次，随后冻结并给所有 worker 复用；Runtime 不得在中途另选模型。`workload` 只能映射到预先声明的 swarm/Reasoning Router profile，不迁第二套 cost-aware 调度器；无法映射时 fail loud。
- `background` 省略时仍为 foreground，工具指引优先建议 background。启动 receipt 只含真实已启动 worker 和 queued 状态，后续完成逐项推送，父代理不 sleep/poll。
- 每个 worker 输出独立 artifact 和有界摘要；单 worker 失败进入该 item 结果，不把整个 fan-out 伪装成整体失败。UI 从真实 worker/session 状态读 live 状态，不把启动快照当活状态。
- run 内超出 concurrency 的 items 排队；共享 background pool 满时按源合同拒绝该 worker 并发送 error 通知，不能在全局池外再无界排队。
- 单 worker 取消、整 run 停止、parent/session remove 的所有权语义；后台 worker 不因普通父 turn abort 被误杀，family quiescence 必须包含 running 和 delivery-pending。
- 嵌套深度默认 3（含 root）作为 Chimera-rs 的有意安全默认值，operator 可进一步收紧、child 不得放宽；全局/项目/run 额度统一，等待自己孩子的父 worker 通过 permit 借用避免双占和死锁。同一切片修改 `DEFAULT_SPAWN_DEPTH=u32::MAX`、其 pinning 测试和 mailbox 中相互矛盾的默认值注释。
- 新 fan-out 的每个 item 都创建新 child，不暗中 resume 旧 worker；显式 follow-up 可复用 child session。durable attempt resume 由 ledger 决定，不能与隐式上下文复用混为一谈。

**保留 Codewhale Fleet/Runtime 的持久能力：**

- durable ledger、lease、heartbeat、restart/resume、幂等 append、事件 replay、artifacts 和 receipts。
- role/profile 路由冻结、ChildAuthority/ChildGrant、write claims、worktree、本地/SSH/placement。
- scorer/verifier、失败源分类、run usage ceiling 和类型化告警，不能因 Chimera swarm 本身没有这些能力而删除。
- Workflow 排序、Lane 运行实例、429 自适应 governor 和 CLI/API/TUI 控制面。

不恢复旧 Codewhale swarm，不引入 TS `WorkerBatch` 第二套执行生命周期。可参考 `chimera-host` Rust swarm 的 Semaphore/JobRegistry，但最终归属现有 Runtime/SubAgentManager。目标现有 `rx_subagent_completion` idle 唤醒可直接复用，但它没有持久 delivery 标记；必须补 generation + dedupe outbox，不能仅靠 mpsc 就声称重启后恰好一次。

### 7.2 模型、CLI 与 API 形状

- 模型侧扩展现有 `agent`，增加批量/swarm 动作和显式参数 schema；不注册第二个模型侧子代理工具。从 Chimera `delegation.background_subagents` 导入的新 `[swarm]` 键为 false 时，schema 不含 background/block_reason；该键是 Chimera-rs 新增配置，不是 Codewhale 现有键，且只在 session 创建或声明的 tool-surface 边界改变，不能在工具循环中悄悄改 header。
- 公共控制面使用 `chimera swarm …`、`/swarm`、`/v1/swarm/*` 和 `swarm.*` operation ids。
- `fleets/<name>.toml` 的“可复用角色/路由集合”迁为可选 swarm profile；匿名 `items` 不要求先建 profile。
- Workflow 的 fleet 绑定改绑 swarm profile；Lane 记录 swarm run/profile，Workflow 仍是 order，Runtime 仍是 where/how。
- `FleetRole` 等内部类型迁移为中性的 Agent/Swarm 角色类型；保留封闭角色集及权限映射，避免借改名扩大角色能力。
- 单个 fan-out 的 concurrency 初始默认且封顶 16，保持 Chimera 合同；多 run 可共享全局最高 128 的 Codewhale subagent 容量。只有压测通过才提高单 run 或全局默认值，不能把硬上限写成默认并发。

### 7.3 数据与旧表面退役

1. 新 writer 上线前停止旧 Fleet writer，drain 在飞任务并记录 checkpoint。
2. 用一次性 importer 把 `.codewhale/fleet.jsonl` 和命名 roster 转为新 swarm ledger/profile；保留原文件备份，校验 run/task/attempt/receipt 计数和哈希后才切换。
3. 新存储采用单一 `schema="swarm"` 版本；不继续接受 exact/legacy 多形态。旧形态由 importer 处理，不进入新运行时分支。
4. 同一切片迁移 CLI、slash、HTTP、Engine ops、Workflow/Lane、work_graph owner、telemetry、skills、i18n、features registry 和文档。
5. 删除生产不再使用的 Fleet scheduler 死路径、legacy `FleetProfilePermissions`、旧 API/配置写路径和退役别名；不留下长期 fleet/swarm 双写或双控制面。
6. `fleet/acp.rs`、external-agent registry、host adapters 等仍被 Runtime 其他消费者使用的代码先迁到中性所有者和模块，再做目录删除；不能按 `fleet/` 目录一刀切误删外部 agent 能力。
7. 查询状态仍遵守“先 probe 再 open”，读空状态不能创建 ledger。

### 7.4 W2 出口

- foreground/background、部分失败、排队、单 worker/整 run 取消、session remove、restart/resume 均有真实终态。
- 每个 background worker 完成恰好推送一次；父 session 重启后能从未消费 outbox 恢复，不重复执行工具。
- 七类 evidence source 都有物化/空输入测试；路由和权限只解析一次，worker 失败隔离，background pool 满时无超额排队。
- 429 governor 能缩容/恢复，provider/project/run 限额不会相互绕过，排队有界且原因可观测。
- 旧 Fleet 的本地持久任务和必要的远程/placement 行为有等价验证；旧 CLI/API/config 不再可写。
- `single_turn_loop`、feature registry、Workflow/Lane、app-server 和 conformance 合同通过。

## 8. W3A：工具渐进式披露

### 8.1 采用的目标流程

```text
固定 system + 非 deferred 工具 + tool_search
        │ 模型搜索
        ▼
reveal：返回 ToolSpec 的真实描述/schema 摘要
        │ 不写工具数组
        ▼
追加 revealed-tools session 上下文 + 持久化 reveal(timestamp)
        │ 模型按名调用；权限再次检查
        ▼
现有 turn loop 的 deferred-call 执行路径
        │ compaction 触发；提升记 change:tool_surface
        ▼
需要常驻的工具进入工具数组，尾部对应条目失效
```

### 8.2 复用与改动

- 保留 `tool_catalog.rs` 的 defer、`always_load`、MCP defer、BM25/regex 搜索和 provider-wire 字节测量；不把 Chimera 静态 18 工具清单和重复描述表搬来。
- 把 reveal 集合和时间戳持久化到现有 session/state 存储，修复 Codewhale 当前重启丢失 activation 的缺口。
- reveal 本身不改变 pinned tool array；用现有 runtime/user history 通道追加签名和摘要。不得以“披露”为名每步重组 system。
- 按名执行进入 `Engine::run_turn` 已有 deferred/missing-tool 分支，权限、child grant、user toggle 在调用时重新执行；reveal 不授予权限。
- `tool_search` 网关始终可发现，但调用仍受权限约束；未知工具别名规范化不能形成“提示先搜索、搜索工具自己又不可达”的自锁。
- compaction 使用同一个 `revealTime <= compactionTime` 谓词决定提升和尾部移除，避免数组与上下文不一致。compaction 本身仍记 `reset:compaction`，提升工具数组另记 `change:tool_surface`；同一切片更新 `docs/CACHE.md`，不能把两者合并成一个未声明的 header 原因。
- 对目标仓库更大的 MCP 目录保留有界预算。off-array 条目超限时通过追加通知逐出；被逐出的调用返回明确 unavailable/reveal，不悄悄扩权。
- OpenAI Responses native `tool_search` 只在显式 provider profile 支持时启用，共用同一 reveal store；Chat、Codex OAuth 和其他 provider 保持函数工具路径。历史回放按各自 wire 合同测试，不能混用。

### 8.3 验收

- reveal 前后 system/tool header hash 不变，session log 可重建该 reveal 和后续调用。
- compaction 提升后 schema 与 ToolSpec 一致，尾部不重复；resume 后 reveal 不丢失。
- 两个 session 揭示同名不同权限工具不串状态；子代理不能 reveal 其 profile 禁止的工具。
- native/function 两种 wire 都能回放；provider 实测的 schema 字节下降有记录，而不是沿用 Chimera 的静态估算。

## 9. W3B：Provider 特化 profile

### 9.1 架构决定

继续使用 `ProviderKind`/descriptor → `RouteResolver` → 不可变 `ReadyRouteCandidate` → `prepare_outbound_request` → Chat/Responses/Anthropic。不得新增 Chimera `Provider::stream_turn`、`LlmEvent` 或第二套 retry 所有权。

特化尽量进数据 profile：descriptor、responses dialect、模型能力表和精确 route shaping。不得用模型名 substring 猜 provider，不得因 custom base_url 相似就继承官方能力或发送专属字段。

### 9.2 Codex 分包验收

先把两条路由分开：**Codewhale 现有 `OpenaiCodex` 是 `https://api.openai.com/v1` 的 OpenAI API Responses 路径；Chimera 订阅后端是 `https://chatgpt.com/backend-api/codex/responses`。** 目标代码目前明确拒绝后者，且两边 OAuth client/scope、headers、模型目录和 Responses 工具封装不同。因此“保留现有 Codex”不等于完成 Chimera Codex 后端迁移。

| Profile | 处理方式 |
| --- | --- |
| Chat/API-key | 保留现有 Chat 路径与工具回放测试 |
| OpenAI API Responses/API-key/OAuth | 保留现有 dialect、账号隔离、严格终态和加密 reasoning replay；不得擅自加 subscription 专用头 |
| ChatGPT subscription Responses HTTP | 作为新显式 profile 重新准入：仅允许审核过的 ChatGPT backend endpoint 和对应 grant，使用其 account/originator/session headers、`store:false`、加密 reasoning 和订阅配额语义 |
| ChatGPT subscription WS | 独立实现和验收，不从 HTTP 推断已支持；覆盖 `previous_response_id + input delta`、prewarm、turn state、连接/会话缓存和 HTTP 回退 |
| native tool_search | 与 W3A 共用 reveal 状态；验证 `tool_search_call/output` 和 deferred schema 回放，不把 subscription OAuth 序列化误当通用 native 路径 |
| remote compaction | 独立 profile 和协议测试；v2/legacy、加密输出、binding/lock、local fallback 不得因任一 Codex 路径可用而隐式宣称 |

新增 subscription profile 时必须逐项处理：

- 复用现有 OAuth 生命周期和 secret store，但 ChatGPT subscription 的 client/scope、account id、deviceauth 与 OpenAI API grant 不可互换。现有 device-flow 代码存在不代表其 scope 与 Chimera `/api/accounts/deviceauth/*` 相同，分别做离线合同和真实登录验证。
- 保留 endpoint 凭证 fence，不能为了支持新后端而允许官方 grant 发向任意 custom URL。redirect 继续拒绝。
- 现有 Codewhale dialect 使用自身工具命名空间、system→developer 和并行工具限制；Chimera subscription 使用 function call、hosted tool 和 turn-state 规则。两者是不同 Responses profile，不能只换 base URL。
- subscription 的产品 `ultra` 档映射到 wire 所允许的最高 effort（源实测为 `max`），不得向该后端直接发送 `ultra`；其他 API profile 是否调整须有各自证据。
- 用 Chimera 模型能力表补充现有 roster 的 effort/context metadata，但路由选择仍归 `RouteResolver`，不建立第二模型选择权威。
- WS 的 `x-codex-turn-state` 只在有 function call 的 turn 续传；连接和基线缓存按 endpoint + account + session 键控且有界。只有 replay-safe 时才允许 WS 重连/HTTP 回退。
- 若保留订阅配额 UI，`wham/usage` 作为该 profile 独立只读能力验收，不混用 API pricing。

任何路径在产生首个语义事件后不得自动重放推理请求；工具结果更不能因传输重试重复执行。

### 9.3 Alibailian 与官方 Model Studio 分离

- 官方 `Modelstudio*` provider 保持现有 endpoint、thinking、reasoning 和 native search 行为。
- `alibailian` 作为显式命名的 relay profile 处理，其 endpoint 由受控配置提供；公开仓库不写入内部基础设施地址或凭证。
- 需要迁移的 relay 增量：
  - Chat 下 native `json_schema` structured output：只在零工具请求挂 `response_format`；若本轮没有得到合法 structured output，按源合同再做一次无工具、显式携带 schema 指令的提取，失败写结构化错误，不能把初次调用就当必然成功；
  - 多工具且需要强制调用时以 `tool_choice=Named(StructuredOutput)` 替代 `Required` 的 backstop，避免 relay 的多工具 400；
  - Responses relay 的 hosted `web_search` 声明、事件和历史回放；
  - `alibailian → DeepSeek → Kimi` 的 websearch fallback，各自独立鉴权和错误可见；
  - model/provider 级 header 合并，包括显式配置的 DashScope session-cache 头；
  - force-reasoning 时的 sampling 参数修整和 Responses replay compensation。
- 这些 quirk 只能绑定显式 `alibailian` profile；不得因官方 Model Studio 也属于“百炼”而共用。`dashscope_enable_thinking` 等 provider-id 驱动行为与 `backend_semantics=alibailian` 也是两个独立判定，不得互相继承。

### 9.4 验证

- 离线：请求体、分块变化、EOF/无 terminal、工具调用回放、OAuth 并发刷新、敏感信息扫描、Alibailian 各 quirk、search fallback。
- 真实凭证：Alibailian relay 的实际 chunk/错误体、OpenAI API OAuth、ChatGPT subscription 的 browser/device 登录与 HTTP/WS、Model Studio hosted search、thinking replay、真实 429/Retry-After。两类 Codex 收据必须分开，mock 通过不能替代这些收据。
- 更新 provider descriptors、route golden、capabilities、`docs/features.toml` 和 `docs/PROVIDERS.md`；能力缺失用 `Unknown`，不能提升成 `Supported`。

## 10. W4A：CodeGraph 与推送式传播

### 10.1 先建立可用的内部图核心

新增独立 codegraph 逻辑 crate，顺序如下：

1. 从 `codegraph-kernel` 抽出无 NAPI 的 rlib：提取、buffers、store、resolver ctx、resolver、栈守卫；`#[napi]` 只保留在可选适配层。
2. 将 schema 和 wire 定义纳入目标 crate，消除对 TS 仓库相对路径的 `include_str!`；冻结 node/edge kind 顺序和 UTF-16 范围合同。
3. 对齐 workspace 的 rusqlite/sha2/tree-sitter 版本和 `-Dwarnings`，保留语法版本与 fixtures 的对应关系。
4. 移植 TS 编排中实际被推送和 predesign 使用的部分：增量 sync、依赖级联、QueryBuilder/FTS、GraphTraverser、impact、ContextBuilder、只读池和生命周期。
5. watcher 使用 Rust 文件通知实现；目标 `crates/notify` 是声音通知，不能复用。每项目单 writer、读池、DB inode 替换重开、close/drain 和有界 busy 是基础合同。
6. WASM fallback 若保留，必须是显式、可观测的同语义后端；不能在 native 失败时静默换一套结果不同的解析语义。

图核心未通过这些门之前，不删除任何生产拉取式能力，也不宣称“Rust 化完成”。

### 10.2 统一 mutation 管线

在共享文件变更服务和 `RuntimeToolServices` 上接 `MutationTracker`，覆盖 edit/write/patch 等所有写工具，不依赖模型记得调用某个图工具：

```text
权限 + coordination gate
  → 读取 graph revision / 文件 hash
  → 现有原子文件写入与 per-path lock
  → syncFiles(变更文件)
  → 反向依赖文件重提取 + reference resolution
  → after revision + provenance/change facts
  → FileMutationRecorded / UI event
  → LSP diagnostics + bounded propagation result
  → 正常 ToolResult（进入 session log）
```

要求：

- 未启用图时零图工作，不创建图 DB；Chimera-rs 新增的 `graph.required` 开启后不可用则 fail loud。该键不是源 Chimera 已有配置，必须按新用户配置登记。
- 图同步失败不能 die 整个 Engine。若文件已写入，返回包含 `file_written=true`、`graph_status=failed/stale` 的可恢复工具错误，记录失败并允许幂等重试；不宣称文件与图原子提交。
- watcher 与工具路径用 mutation id/content hash 去重，不能继续只依赖 15 秒时间窗；外部变更仍生成 filesystem provenance。
- 传播探针使用与 edit 后图一致的坐标；不能用 post-edit 图配未校正的 pre-edit range。
- 保留 `Ref: node:<id>`、文件/符号、graph revision、影响面和 scope drift 的有界输出，供 ast edit、predesign 和后续模型步骤引用。
- 事件载荷包含 project/session/turn/tool/mutation/before/after revision；事件本身不替代 ToolResult 和持久记录。

### 10.3 把拉取式能力改为推送式上下文

核查确认，Chimera 目前**没有**通用的图上下文订阅、跨工具 token 预算或图事件到模型的推送子系统；现成只有 edit 探针、LSP/oracle 摘要、claim 唤醒和一次性图发现提示。下表是 Chimera-rs 需要新建的目标合同，不得写成源仓库已有能力。

| 触发 | 推送内容 | 通道 |
| --- | --- | --- |
| edit/write/patch 成功 | 变更符号、依赖、传播、scope drift、引用锚点 | 当前 ToolResult，天然持久化 |
| predesign | 声明范围、影响证据、claims/冲突、队列位置 | 当前 ToolResult |
| read/file_search/grep 等定位到文件或符号 | 有界定义、关系和必要上下文，不再只提示“去调用图工具” | 当前 ToolResult 的可选尾部 |
| watcher/外部进程改变图 | revision、变化文件和未消费影响摘要 | 下一消息准入边界的追加 `<context_update>` |
| 项目恢复/图 stale | 索引状态、pending、可重试错误 | 追加 session 状态，不改 frozen prefix |

按 `(session, project, mutation, graph_revision)` 去重；同一 edit 不在 ToolResult 和 `<context_update>` 重复推送。所有动态推送都有字节/条数预算和截断原因。

`chimera_search` 的概念发现、已知文件的 `chimera_file_symbols` 第一眼和 `chimera_status` 在源仓库都没有现成推送等价物，必须靠上述新触发补齐。oracle 全量回溯与 obligations 状态机也不是图查询工具，不能因为图套组退役而一并删除。

直接使用图查询回答任意符号问题仍有语义风险：模型必须先能通过用户/文件上下文获得种子，再由推送提供关系。用现有 graph evaluation 和真实 coding bench 比较拉式与推式的成功率、步骤、token 和错误率；**未达预设等价门，不得删除拉式表面。门未通过时改推送触发和排序，而不是保留两套长期产品。**

### 10.4 图工具最终退役清单

等价门通过后，同一切片执行：

- 删除模型侧 `chimera_init_graph/status/search/file_symbols` 的注册、handler、描述、权限示例和 discovery nudge；`chimera_context` 本就未注册，不迁。
- 删除 8 个 `codegraph_*` MCP 模型工具、installer/auto-allow 配置与代理 daemon 的模型查询职责；必要时将 daemon 保留为内部同步服务，但不暴露拉取模型目录。
- 改写 explore 子代理、`chimera.txt`、模型层和工具文案，禁止再教模型调用已删除工具。
- 保留内部 CodeGraph facade、FTS、traversal、impact、schema、索引和推送所需 read pool。
- 保留 predesign/audit/obligation 等协调能力的内部图依赖；它们不是“搜索工具”的同义词。
- 运维 CLI/只读诊断与 WebUI 图面板不属于模型工具目录，可保留为 operator 表面，但必须改用内部服务，不能成为绕权限的隐藏模型查询通道。
- 同步 feature registry、工具 golden、MCP 文档、配置和迁移说明。

### 10.5 audit、oracle 与 obligations 的最小承接

swarm 的 `from`、prompt closeout 和 claim 显式释放还依赖一组**非拉式图查询**的证据工具，不能只迁空壳：

- 建立版本化的项目 evidence store，承接 `obligations.json` 与 `oracle-results.jsonl` 的语义；迁移时转换到目标存储，不在运行时长期双写旧文件。
- obligations 保留 pending/claimed/stale/active 状态及 list/sync/claim/resolve/ignore 操作；oracle 保留 failing/unknown、完整输出引用和宽窗口查询。它们作为独立 deferred ToolSpec，不属于被删除的图搜索套组。
- 每次 mutation 自动记录 audit；常见失败/unknown 摘要有界内联，完整输出通过 evidence tool/artifact 获取。展示截断不能删除底层完整证据。
- `audit_recent` 提供显式 closeout 并驱动 edit-intent release；外部 patch 的显式 audit 仍可按 seed 执行，和自动推送并存。
- 七类 `from` 都读同一 evidence store；`limit` 默认 20、上限 100，长输出只截断展示并保留 `outputTruncatedForDisplay` 标记。缺 store 或没有匹配项按空工作输入处理，不能返回伪成功 fan-out。

## 11. W4B：predesign 多会话冲突解决

### 11.1 合并到现有协调权威

Codewhale 已有 `CoordinationLedger`、write claims 和 `agent action=claim/release`。它随 delegated-agent store（当前 `subagents.v3.json`）持久化，以 flock 保证跨进程单写者，已有单调 sequence、精确文件/root/contract scope 和 worktree 豁免。实施时升级这一 store 的 schema 并扩展该权威，**不得再建只服务 predesign 的 SQLite/JSON 锁库**。

需要补入的 Chimera 语义：

- predesign 声明：intent、files/symbols/refs、session、时间和证据。claims 不依赖图初始化；没有图时只写协调/predesign 记录，不能因此把图标为 ready。
- 文件级 active claim、FCFS waiter、queue position、10 分钟 wake-priority、2 小时 TTL 兜底。waiter 使用独立于 `COORDINATION_RECORD_LIMIT` 的有界容量；活跃 claim 仍不得被 retention 淘汰。
- 队列顺序直接复用 ledger 的持久单调 sequence，不以 claim id 字典序、rowid 或毫秒碰撞决定先后。
- 释放原因：explicit、session idle（family jobs quiescent 后）、session removed、yielded、TTL。优先使用 Codewhale store-owner 活性/心跳判定，TTL 只做崩溃兜底。
- 被唤醒者必须 re-read；编辑仍由现有文件 hash/hashline 和内容检查拒绝 stale write。没有自动合并。

**family 豁免必须限定 claim 类型：**现有 `WriteScopeClaim` 继续对所有父子 agent fail-closed，不因本次迁移放宽。新增 predesign edit-intent policy 才按 Chimera 规则对同一 session-family 豁免，lineage 不可读时按 foreign。若一次写入同时受两种规则约束，必须同时通过，不能用 family 豁免绕过原有 write scope；isolated worktree 豁免保持不变。

### 11.2 mutation gate 与唤醒

- gate 接在共享 mutation 管线，先于文件写入和图 before snapshot；所有写工具走同一顺序：write-scope/edit-intent claim 检查在前，高风险变更的 fresh-predesign 检查在后。不要给每个低风险编辑增加强制 predesign 仪式。
- blocked 结果包含 blocker、queue `#N of M`、replay key 和非冲突工作建议；模型不能忙轮询或强写。
- replay key 指向 canonical session log 中被 blocked 的原始 tool call，以 session + call id 恢复原参数，不复制 Chimera 进程内 100 条 LRU stash。重启后记录不存在或内容校验失败就明确要求重新生成，不伪造恢复。
- 唤醒复用现有 Runtime mailbox/session admission 和 `UserInputProvenance::Runtime` 持久通道。busy session 在下一次准入 drain，idle session 由 Runtime 唤醒；不新建会话循环。
- 同进程用事件/outbox，跨进程在现有 flock/foreign-owner 重读点接 waiter 状态，不再增加一个全局三秒 DB poll。唤醒记录必须持久且恰好消费一次。
- 普通父 turn abort、session remove、swarm quiescence 与 claim 释放的关系要和 W2 一致，不能因子 worker 结束提前释放整个 family 的声明。

### 11.3 有意的失败语义调整

Chimera 当前 claim 存储故障多采取 degrade-open。Chimera-rs 在 **claims 已启用且项目已有协调状态** 时改为可恢复的失败关闭：返回明确 coordination unavailable，不继续无保护写入，并保留重试入口。功能显式关闭且项目无历史协调状态时，不创建新记录、不阻塞普通编辑；图未初始化本身不禁用 claims。

这是有意的目标行为变化，必须有单独测试和文档；不能用“兼容”名义静默丢失冲突保护。

### 11.4 验收

- 两会话/两进程竞争同一文件，FCFS、family 豁免、队列位置和 wake-priority 可重放。
- 多 holder 全释放后才 wake；并发 take 只有一个成功；busy/idle/remove/TTL/host death 都不丢唤醒。
- replay 必须重读并校验内容；claim 存储故障按新失败关闭合同处理。
- 图未初始化时 claims 仍可工作，后续 graph init 只迁图 schema、不改协调 store；只读操作不会创建协调记录。
- 原 WriteScopeClaim 的父子争用仍 fail-closed，只有 edit-intent policy 享 family 豁免；两种规则同时命中时不可绕过较严者。
- swarm family 与普通跨项目 session 不互串 claims；取消、重启和恢复不重复执行原编辑。

## 12. W5：browser 工具包

### 12.1 承载方式

- 为 `browser_open/snapshot/click/type/screenshot/close/evaluate` 实现生产 `ToolSpec`，全部 `defer_loading`，复用现有 tool_search、审批、cancel、turn deadline 和 ToolResult 图像通道。
- 使用 Rust CDP driver：通过 Chromium DevTools Protocol 管理 target/context/page、输入、脚本、可访问性快照和截图，协议客户端、生命周期与权限全部由 Rust 实现；不得保留 Node/Playwright sidecar。
- 不下载或捆绑 Chromium；继续使用系统浏览器发现或显式 executable/CDP。缺依赖时仅该 browser 调用返回可操作错误。
- 现有 desktop-browser MCP 和 computer-use 通道保留各自宿主边界，统一走相同网络/权限原则；不再新增第三套 browser 权限系统。

### 12.2 并发和资源模型

- connection 按 project + local/remote + headless mode 隔离；BrowserContext 按 session；tab 和 refs 按 session/tab/generation。
- 不在一个 session 改 headless 时重启并关闭其他 session 的 tabs。模式不匹配时新建受配额约束的连接或明确拒绝。
- 全局/项目浏览器进程、context、tab、内存和 artifact 配额有界；超限明确拒绝或排队。
- session close、项目回收、driver 断连和宿主 shutdown 都清理 context/tab/进程注册；修复源实现仅主动 `browser_close` 才释放 context 的泄漏。
- 远程 CDP 必须显式信任，不默认共享用户已认证 profile；无 pid 的远程连接也要有生命周期 owner。

### 12.3 安全前置门

以下未完成前 browser 不得稳定启用：

1. **SSRF**：每次 open、导航和 redirect 都复用 `crates/net` 的 destination/DNS guard；仅检查初始 URL scheme 不够。源工具没有 upload/download，本期继续不支持，不能借 `BrowserUseConfig` 的未接线字段暗中开放。
2. **审批**：origin 级 approval scope；redirect 后按新 origin 重审。`browser_evaluate` 每次审批、禁止持久 always，输入文本和敏感值不进审批日志。
3. **不可信内容**：snapshot/evaluate 继续带 UNTRUSTED 标记，脱敏 URL 凭据、敏感 query 和节点值，限制输出。
4. **artifact**：路由要求 Runtime 鉴权并校验 project/session ownership；保留 traversal 防护、图片类型白名单和 nosniff。增加 TTL、容量和删除策略。
5. **子代理边界**：遵守现有 desktop/machine-control child 禁令；swarm 不因继承父会话而获得浏览器或已认证页面。
6. **截图**：通过现有图像 ToolResult/attachment 路径进入模型并写 session；不能依赖无鉴权公开 URL。

### 12.4 验收

- fake driver 覆盖连接复用、session context、ref 失效、死 tab、headless 冲突、清理、配额和取消。
- 安全测试覆盖私网/metadata/redirect、artifact 鉴权、敏感信息、子代理拒绝和 TTL。
- 用真实系统 Chrome/Chromium 做一次 open → snapshot → click/type → screenshot → evaluate → close 的 UI smoke，保留截图和实际输出；CI 不下载浏览器。
- 多项目、多 session 同时运行时无 context、cookie、tab、artifact 或审批串用。

## 13. W6A：配置迁移与运行时语义

### 13.1 单一配置体系

- 新权威仍是 **TOML + serde + profile + env + managed + requirements**，不引入 Chimera 的十层 JSONC loader。
- 建议新主文件为 `chimera.toml`，项目文件为 `.chimera/config.toml`，并增加显式 `schema_version=1`；最终文件名与品牌切片一起落地。
- 项目 overlay 延续 Codewhale 白名单和“只能收紧”规则。Chimera 项目文件可自由配置 provider/agent/凭证的习惯不能照搬。
- well-known/account 远程配置不进入默认加载链；只有自有、显式配置的 managed 来源才可启用，失败按 managed 合同 fail loud，不能仅记日志后静默使用半套配置。
- 新 schema 对未知键 fail loud，包含完整来源和字段路径。现有 `extras`/serde 忽略行为不能用于新 Chimera 配置。
- importer 读取 Chimera JSON/JSONC 和旧 Codewhale TOML，输出新 TOML；未知或未支持字段列出并失败，不静默丢弃。导入是显式命令，不让生产 loader永久承担所有历史形态。

建议优先级：defaults → global file → selected profile → env/CLI → restrictive project overlay → managed → requirements/validation → session 内进一步收窄。数组和 instructions 等字段在 importer 中计算成最终值，避免再引入一套特殊 merge 语言。

### 13.2 选项映射

| Chimera 域 | Chimera-rs 落点 |
| --- | --- |
| `delegation.*` | `[swarm]` + `[subagents]`；统一深度、全局/后台/项目/run 限额、profiles、scheduling |
| `fleet`、命名 fleets | 一次性转为 swarm profiles；新运行时只读新形态 |
| `provider`、`model_capabilities`、`wire_api`、`backend_semantics` | descriptors、`[providers.<id>]`、model/route profile；未知 capability 不继承 |
| agent sampling/prompt/steps | `[agents.<name>]` 或 role profile；静态 prompt 在 session 创建时固定 |
| permission/tools | 现有 `permissions.toml` 和 ToolSurfacePolicy；旧 tools 布尔翻译只在 importer |
| MCP | 现有 `mcp.json` 与 MCP timeout/trust；不复制第二解析器 |
| browser headless/CDP/artifact | `[browser]` + driver 配置；凭证不写入项目文件 |
| `codegraph.json` 的 `includeIgnored` | 映射为 `[graph].include_ignored` 与项目数据根；`required`/预算不是源配置键，若作为 Chimera-rs 新键引入，必须单独登记 schema/example/registry，不能由 importer 读取 |
| diagnostics、tool_output、compaction、memory | 对应现有 diagnostics/tool/compaction/memory 配置，重复键取一个权威 |
| experimental flags | 逐项转为 `[features]` 或删除；不保留无消费者的解析键 |
| prompt style 设计稿 | 不导入，因当前无生产实现 |

每个新用户键必须同步 config example、schema 校验、文档和 feature registry（若属于新用户功能）。

### 13.3 reload 与并发

- 两仓目前都没有通用配置文件 watcher。首期以显式 reload/update 触发项目 generation；若以后加 watch，也只发“可重载”信号，不能直接改变运行中的 header。
- 复用现有 fd-lock + CAS 写回和全 loaded-thread route preflight：任一项目/线程新 route 不可解析就拒绝整次 reload 并保留旧配置，不能部分 swap。
- prompt/header 继续由 session 固定；route、compaction、timeout、subagent 限额通过现有 per-engine op 在下一 turn/新任务生效，活动 turn 不变；graph/browser/project ownership 只影响新 session/worker。
- 权限收紧立即生效；model/mode/tool surface 变更通过显式操作记录，不能由文件 watch 静默改 header。
- 每次变更记录 source、write target、generation、preflight/reload receipt 和脱敏字段差异；两仓目前都缺完整配置变更审计，不能只靠可变文件推断历史。
- 多项目 reload 不共享临时可变 map；一个项目配置错误必须定位到该项目，不被另一个项目配置掩盖。全局 memo 失效必须跨进程可见，不能只失效发起进程。
- secrets 仍使用现有 secret store/environment 绑定；导入报告不得回显密钥，项目配置不得写入全局凭证。

## 14. W6B：Chimera 提示词迁移

### 14.1 保留一个 base，分层解决特化

- `crates/engine/src/prompts/text.rs::BASE_PROMPT` 仍是唯一 base 和指令优先级权威。以目标现有优先级为准，不搬 Chimera 与其冲突的层级定义。
- Chimera 的工程语义按“保留、合并、删除”迁入现有常量/fragment，不复制 `default.txt + workflow.txt` 作为第二 base。
- Provider/model 特化若确有行为价值，使用**静态、编译期、精确 route 选择的附加 profile**，在 session 创建时固定；它不是第二 base，且 `/model` 通过 `change:model` 记录 re-pin。现有 `every_mode_shares_one_prompt_per_host`/model-fact-free 守卫若不允许该附加层，必须在同一切片把守卫改成“一个 BASE + 显式静态 profile”的新合同并更新 golden，不能绕过测试。
- Browser、图、predesign 的详细调用规则放 ToolSpec 描述和推送结果，不随每步工具 reveal 改 system。
- 不实施未接线双风格计划；其“提示词只声称真实能力”的 gate-facts 思想可用于 profile 校验，但不新增运行时风格框架。

### 14.2 语义处置

| Chimera 语义 | 处理 |
| --- | --- |
| 图优先、图工具调用协议 | 改为消费推送图证据与 typed refs；删除 `chimera_search/file_symbols` 指引 |
| predesign、edit-intent、scope drift | 保留并由真实 mutation gate/claims 支撑，不靠散文假装有门禁 |
| workbrief、goal、obligation/oracle closeout | 与现有 goal、work_graph、verification 语义合并，避免两个状态权威 |
| task/swarm/orchestrate 三分法 | 改为 `agent` 批量动作、Workflow/Runtime 的真实选择规则 |
| background swarm 完成通知 | 保留“不轮询、逐项结果、独立 output file、父级最终复核” |
| DeepSeek/Codex/Claude/Kimi 等特化 | 只保留当前模型仍需要且可验证的规则，按 route profile 选择；删除时间敏感模型代际断言。源项目曾有 DeepSeek 层零改动约束，但图工具退役和目标工具名变化使原文无法直接成立，必须单独审查语义 diff，不能声称 byte-identical |
| 子代理结构化报告 | 保留摘要字段，兼容目标完成 sentinel 和父侧解析器，不另造完成协议 |
| 响应合同、证据、验证 | 合并进 BASE/OUTPUT 现有位置，删除重复和互相矛盾条款 |
| opencode 身份、旧工具名、旧 fleet 名称 | 删除或改写，不进入 Chimera-rs prompt |

### 14.3 动态上下文与缓存

- 易变 workbrief/goal/graph/background/reveal/claims 信息进入追加式 `<context_update>` 或现有 runtime user message，不进入 frozen prefix。
- 项目/工作区漂移在新用户 turn 前合并成一条有界 delta；swarm 完成和 claim 唤醒可在现有消息准入边界追加，不能重写 system。
- 每个 section 有 hash/dedupe、字节预算和截断原因；turn-owner 判定排除 synthetic context，防止把系统注入当最新真实用户请求。
- 沿用目标 prefix stability、`UserInputProvenance::Runtime` 和 session log，不迁 Chimera host 的 ephemeral 无记录分支。
- prompt stats 思路并入现有 `/context`、prefix receipts 和 source map，不新建每步平行事件总线。

### 14.4 验证

- 更新结构性 prompt/conformance fixtures以反映有意变化，不新增逐字散文偏好测试。
- 跑 BASE 结构、byte-stable、model-fact-free、prefix privacy、prefix drift、model-visible logged、tools golden 和 `single_turn_loop`。
- 记录静态 prompt + eager tool 的真实 wire 字节；预算测试必须解释增长原因，不能只提高上限。

## 15. W6C：品牌、存储与发布收口

建议默认值，执行前记录在分叉 ADR：

| 项 | 默认决定 |
| --- | --- |
| 产品/仓库名 | Chimera-rs / `chimera-rs`；新 org URL 由所有者提供 |
| 用户二进制 | `chimera`；不在第一期保留 `codewhale`/`codew` 可执行别名 |
| 状态 | `CHIMERA_HOME`，默认 `~/.chimera`；旧状态经显式 importer 迁移 |
| 项目目录 | `.chimera`；读取旧 `.codewhale` 只发生在 importer，不由新 writer 双写 |
| 产品 env | `CHIMERA_*`；provider 自有 env（如 DeepSeek、OpenAI、DashScope）不变 |
| crate | 功能迁移期暂留 `codewhale-*` 以降低冲突；最终用独立机械改名切片转为 `chimera-*`，不在上游 npm/crates 名称下发布 |
| 发布 | 先 GitHub Releases；自有签名、checksum、update 源和安装文档准备好后才启用自更新 |
| 上游服务 | 无自有实现即删除或明确 unavailable；不默认回连 |
| 历史文档 | CHANGELOG、历史 PR/作者和旧品牌原样保留；当前文档使用新名，不改写历史 |

机械改名与行为变更分开，方便审查。旧 session/ledger/config 的读取兼容集中在 importer；运行时不保留长期 shim。必须保留的旧 transcript 解析标识在数据迁移 RFC 中单独列出，不能靠全局重命名决定。

## 16. 总体验证与容量门

### 16.1 每个切片的最小验证

| 切片 | 必跑证据 |
| --- | --- |
| W0 | 许可/notice、版本一致性、无上游端点默认值的静态检查、可复现构建 |
| W1 | app-server project routing、read guard 两项目隔离、scope/Engine 回收、lease/cancel/event 测试 |
| W2 | subagent/governor、swarm foreground/background、ledger replay、Workflow/Lane、HTTP/TUI 控制面 |
| W3A | tool_search、reveal/resume/compaction、prefix hash、权限、native/function replay、feature registry |
| W3B | config route/golden、Chat/Responses/Auth 离线 fixture、Alibailian quirk；真实 provider 另列收据 |
| W4A | codegraph wire/contract、incremental=full、watcher/DB replace、mutation failure、推送等价 bench |
| W4B | claim FCFS/wake/family/TTL/host death、mutation replay、session remove、故障关闭 |
| W5 | fake driver 全套、安全负例、真实浏览器 smoke、artifact auth/TTL、跨项目隔离 |
| W6 | config importer、unknown key、feature registry、config example、prompt/conformance、单 turn loop guard |

优先运行现有聚焦测试和 `scripts/dev-test.sh <area|path> [filter]` 映射的最快命令。只有跨切面收口才跑 workspace；不得重复跑已经通过的相同套件。

### 16.2 建议容量矩阵

以下是**测试 workload，不是当前性能声明**：

1. 单项目：1 个 root session，多个 swarm，合计 128 worker 硬上限内排队执行。
2. 多项目：8 项目 × 16 活跃 session，总 128 worker，混合同/异 provider profile。
3. 超订阅：32 项目 × 16 session，全局 128 worker，验证有界排队、公平性和取消。
4. 图叠加：上述负载下并发 edit、watcher、索引和依赖传播，记录单 writer 排队与 stale 结果。
5. 浏览器叠加：受资源配额约束的多项目 context/tab，验证拒绝和清理，不为了人数无界启动 Chromium。
6. 故障：kill worker、kill host、DB busy/替换、慢事件消费者、provider 429、取消和恢复。

采集：

- turn admission、worker 排队、事件投递、图同步的 p50/p95/p99；
- 吞吐、公平性、429 缩容/恢复、重复/丢失事件数；
- host + sidecar + Chromium 的 RSS、FD、线程/进程数；
- SQLite lock/busy、WAL、队列长度、artifact 与磁盘增长；
- 取消后残留 worker/process/claim/context 数。

正确性门：零跨项目泄漏、零重复工具执行、零无解释终态、零未记录模型可见输入。性能门在 W0 同环境基线上冻结；不能用任意编的毫秒值阻塞或放行。发布候选需要 30 分钟开发门和 24h/72h soak；旧 Chimera 尚未提供的证据不能豁免本 fork。

### 16.3 验证报告纪律

- 每个报告列命令、commit、环境、实际测试数量和原始结果。
- 区分离线 fixture、真实二进制、真实浏览器、真实 provider、CI 和发布状态。
- 新回归测试应证明能捕获缺陷；不能只用“未崩溃”“非空”“数量增加”充当行为验证。
- 不用代码行数、agent 数量或测试文件数代替产品正确性和容量证据。

### 16.4 全 Rust、unsafe 与测试纪律

- 新增生产实现只能是 Rust。CI 检查迁移路径没有新增 `.ts/.tsx` 实现、Node helper、Playwright 依赖或 TS sidecar 启动点；文档、历史 fixture 和第三方既有资产不受此限制。
- 新 crate 在 root 使用 `#![forbid(unsafe_code)]`，在既有 crate 新增的独立模块同样默认禁止 unsafe。确需 unsafe 时必须给出无可替代的安全边界、审查记录和靶向测试，不能用性能或移植方便作为泛化理由。
- 每个功能至少覆盖正常行为、输入/容量边界、错误、取消/超时、恢复和跨项目隔离；涉及持久化的功能还需 kill/restart 与重复消费测试，涉及 provider/browser 的功能还需真实表面 smoke。
- 优先证明新增回归测试在无修复时失败。禁止只断言源码存在、mock 自回显、非空、长度增长或不崩溃；必须断言消费者可观察的合同。
- 每个切片同时运行相关既有测试，记录真实 `test result: N passed; M failed` 且覆盖测试 `N > 0`。CI 负责全量回归，本地收口运行受变更影响的完整套件。
- 最终验收必须启动实际 `chimera` 二进制，完成多项目会话、swarm、图推送、predesign、provider 离线和 browser 真实 Chromium 路径；不能用库测试替代产品可用性。

## 17. 主要风险与阻断关系

| 风险 | 处理 |
| --- | --- |
| Chimera 工作树持续变化 | 每切片重新固定 diff/hash；优先搬 Rust 语义和 fixtures，不盲合旧分支 |
| Fleet 功能远多于一次性 fan-out | 保留 durable/remote/profile 能力，先映射再退役；不能只换名词导致数据丢失 |
| 图主体仍有大量 TS 编排 | 内部核心和推送等价门先于工具删除；禁止以 kernel 存在宣称图迁移完成 |
| 推送不能覆盖任意图查询 | 用同一 evaluation/bench 决定等价；未过门不退役，继续改触发而非长期双系统 |
| 双锁权威 | predesign 必须并入现有 CoordinationLedger/write claims |
| 配置自由度冲突破权限 | 保留项目白名单和 secret 边界；未知项导入失败 |
| Provider 名称混淆 | Alibailian relay 与官方 Model Studio 分 profile；能力逐项验收 |
| Browser 安全与资源泄漏 | SSRF、artifact auth、session cleanup、全局配额是稳定启用硬门 |
| 多项目全局态 | W1 未通过前不并行铺功能，避免把串扰扩散到 swarm/graph/browser |
| 上游服务误用 | W0 未切断 telemetry/update/account 前不构建对外 fork 包 |
| 范围过大形成永久双轨 | 每波都有删除清单和最终消费者；功能 flag 仅用于开发/回滚，不作为长期双产品 |

## 18. 明确已知限制

- 本计划没有证明目标仓库当前已达到高并发；它列的是必须完成的工作和验证。
- 图 Rust core、真实大图写吞吐、24h/72h、部分远程 host 和真实 provider 行为目前均缺少可直接承接的生产证据。
- 第一期 predesign 不做内容自动合并，单 swarm 不跨项目写；browser 只依赖系统 Chromium 和 Rust CDP，不允许外部 Node/Playwright/TS 依赖。
- 图推送若不能通过既定等价门，图工具退役就是阻断项，不能用文档宣布完成。
- 新仓库 URL、自有发布签名/更新源、自有账户服务和真实 provider 凭证属于外部前置条件；未具备时对应功能保持关闭，但不妨碍本地离线实施。

## 19. 第一批可执行工作包

1. **FORK-0**：完整历史、remote/许可/CI/上游端点止血、ADR 与源基线 manifest。
2. **ORACLE-0**：session/provider/Fleet/图/claim 的 fixture 和故障矩阵骨架，冻结性能测量方法。
3. **PROJ-1**：read guard 与终端/retry/prompt 全局态隔离，附两项目回归。
4. **PROJ-2**：app-server 请求级 workspace、实例 pin/TTL/预算、项目配置 generation。
5. **SWARM-1**：在现有 `agent` + SubAgentManager + Runtime worker 上实现 background 批量扇出和恰好一次完成推送。
6. **SWARM-2**：合并 durable ledger/profile/Workflow/Lane/API，执行 Fleet importer 和最终删除。
7. **DISCLOSE-1**：reveal 持久化、追加式签名、compaction promotion 和权限回归。
8. **GRAPH-0**：无 NAPI kernel rlib、schema/fixture 落库、六面 parity 与大图基准。
9. **MUTATE-1**：统一 mutation tracker，先接 provenance/failure，再接图同步和推送。
10. **COORD-1**：现有 CoordinationLedger 与 Chimera claim 语义的合并设计及最小并发闭环。

这些工作包可并行调研和准备 fixture，但生产合入顺序必须满足 `FORK/ORACLE → PROJ → SWARM/DISCLOSE → GRAPH/COORD → BROWSER → 收口` 的依赖。

## 20. 关键证据索引

本计划来自 36 个并行只读切面和后续窄补核。以下行号对应 §2.1 的工作树，用于实施时复核，不是测试运行收据。

| 主题 | Chimera 源证据 | Codewhale 目标证据 |
| --- | --- | --- |
| 单循环与 prompt | `packages/chimera/src/session/prompt.ts:3119-3595`；`packages/chimera/src/session/llm.ts:235-258` | `crates/engine/src/core/engine/turn_loop.rs:1536`；`crates/engine/src/prompts/text.rs:43-104` |
| host 当前状态 | `packages/chimera/src/host/capabilities.ts:41-58`；`chimera-host/src/session/subagent/swarm.rs:1-70` | `docs/ARCHITECTURE.md:35-38` 明确旧 swarm 已删除 |
| 多项目 | `packages/chimera/src/project/instance-store.ts:570-619`（lease/pin/presence）、`:478-535`（抖动治理）；`packages/chimera/src/session/turn-lease.ts:96-215` | `crates/app-server/src/runtime_api.rs:208,319-478`；`crates/sandbox/src/read_guard.rs:396-418` |
| 配置写与 reload | `packages/chimera/src/config/config.ts:987-1045` 的读-改-写 | `crates/config/src/config_document.rs:250-385` 的 fd-lock+CAS；`crates/engine/src/runtime_threads/manager.rs:4067-4197` 的 preflight/reload |
| Fleet | — | `crates/engine/src/fleet/manager.rs:418-1055`；`ledger.rs:340`；`host.rs:165-209`；`docs/FLEET.md:14-37` |
| swarm | `packages/chimera/src/tool/swarm.ts:20-137`（schema）、`:485-565`（后台）；`packages/chimera/src/agent/worker-batch.ts:241-383`；`packages/chimera/src/agent/batch-source.ts:9-17` | `crates/engine/src/tools/subagent/governor.rs:1-46`；`core/engine.rs:3700-3760` 的 idle 唤醒 |
| edit 图传播 | `packages/chimera/src/chimera/provenance.ts:1153-1278`；`packages/chimera/src/graph/index.ts:2119-2260`；`packages/chimera/src/chimera/propagation-probe.ts:431-502` | `crates/engine/src/tools/file.rs:2504-2579`；`core/engine/lsp_hooks.rs:51-117` |
| 图内核 | `codegraph-kernel/src/store.rs:1404-1476`；`codegraph-kernel/src/resolver.rs`；`packages/chimera/src/graph/db/schema.sql:1-225` | 当前无 CodeGraph；`crates/engine/src/work_graph/` 是另一领域 |
| 图 core 骨架 | `crates/chimera-graph-core/src/lib.rs:29-63` 的 feature-gated 空模块 | — |
| 图工具表面 | `packages/chimera/src/tool/chimera.ts:2562-2968`；`packages/chimera/src/graph/mcp/tools.ts:441-618`；`packages/chimera/src/tool/registry.ts:330-344` | 生产工具落点是 `crates/engine/src/tools/{registry,spec}.rs`，不是未接线的 `crates/tools::ToolRegistry` |
| predesign/claims | `packages/chimera/src/chimera/edit-intent.ts:111-144,261-350`；`packages/chimera/src/chimera/store.ts:2024-2057`；`packages/chimera/src/tool/edit.ts:281-323` | `crates/engine/src/tools/subagent/coord/ledger.rs:392-810`；`core/engine.rs:385-470` 的写权限缝 |
| 渐进披露 | `packages/chimera/src/session/tool-search.ts:36-47,191-220`；`packages/chimera/src/session/prompt.ts:247-254,534-566,1351-1430` | `crates/engine/src/core/engine/tool_catalog.rs:129-236`；`core/session.rs:18-298` |
| Codex 订阅后端 | `packages/chimera/src/plugin/codex.ts:15-18,115-241`；`packages/chimera/src/session/codex-responses.ts:228-248,497-651` | `crates/engine/src/client.rs:1690-1706` 当前拒绝 ChatGPT backend；`crates/config/assets/responses_dialects.json` |
| Alibailian | `packages/chimera/src/session/llm.ts:48-127`；`packages/chimera/src/tool/websearch.ts:96-133,404-490` | `crates/config/assets/provider_descriptors.json` 的 Model Studio 行；`crates/engine/src/client/chat.rs:398-586` |
| browser | `packages/chimera/src/browser/runtime.ts:143-177,207-632`；`packages/chimera/src/browser/artifact.ts:51-177`；`packages/chimera/src/tool/browser_evaluate.ts:65-83` | `crates/net/src/guard.rs:25-217`；`crates/engine/src/mcp.rs:7641-7705`；`crates/engine/src/profile_constitution.rs:83-108` |
| prompt 分层 | `packages/chimera/src/session/system.ts:58-199`；`packages/chimera/src/session/prompt/default.txt`、`packages/chimera/src/session/prompt/workflow.txt`、`packages/chimera/src/session/prompt/chimera.txt` | `docs/CACHE.md:10-63,119-126`；`crates/engine/src/prompts.rs:1071-1457` |
| feature/config 守卫 | `packages/chimera/src/config/parse.ts:48-88` 的未知顶层键拒绝 | `docs/features.toml:1-35`；`crates/tui/tests/feature_registry.rs`；`crates/core/tests/single_turn_loop.rs` |
| 分叉供应链 | — | `crates/config/src/telemetry.rs:18`；`crates/release/src/lib.rs:27-60`；`crates/cloud-facts/src/lib.rs:32`；`LICENSE`、`THIRD_PARTY_NOTICES.md` |
