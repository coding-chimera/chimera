# Chimera Rust 化改造规划（调研文档）

制定：2026-09-18。性质：**只读调研产出，不实施**（用户战略指令：上游同步与 WebUI 吞吐战役收口后规划 Rust 化改造；不一定全 Rust，可 Rust/TS 混合；主要目标=减少内存占用+尽可能快+高吞吐）。

证据基础：
- 现网实测 RSS/footprint（只读观测既有全局 `chimera web` 进程，归档 `/Volumes/workspace/cbench/rust-plan/rss-aggregate-20260918.md` + `rss-snapshot-20260918.txt`）。
- WebUI 吞吐战役 RSS 标定（`cbench/webui-perf/.runs/*/result.json` 全量提取，见归档 §2）。
- 8 路 scout 只读源码取证（实例生命周期/bus/后台任务引擎/审计层缓存/SSE 与 server/监视与图谱同步/会话运行时/运行时耦合面），全部断言带 file:line，关键锚点已抽样复核原文。
- 既有战役资产：`UPSTREAM_RUST_KERNEL_PLAN.md`（codegraph-kernel napi 先例全文）、`WEBUI_PERFORMANCE_PLAN.md`（W1 内存预算拍板）、`memory.md`（K-v2/G1/bench 条目）、`cbench/g1-wal/`、`packages/chimera/script/bench/burst.ts`。

纪律说明：本文档为本批唯一新增文件；未改任何现有文件、未 commit/push；未构建/执行任何新鲜可执行物；「14:34 后台任务注册表丢失」事故的 memory.md 记录已被清理（grep 无命中），本文按用户口述输入处理，并以源码级机制佐证（见 §1.4-B3）。

---

## ① 现状盘点：常驻进程面、内存与生命周期热点

### 1.1 实测：短跑标定 vs 长驻实运行差一个数量级

| 观测面 | 数据 | 来源 |
|---|---|---|
| server 底座空载 RSS | **410–460 MB** | webui-perf 6 个 p3 run 的 baseMB（归档 §2） |
| 稳态每项目实例增量 | **~10–30 MB** | p3-rss-staged timeline（431→547→563→572→606→637→647→636） |
| 8 路并发流式峰值 | **1002.4 MB**（=1024 预算的 98%） | p3-after-stream-presence peakMB |
| TTL 全驱逐后回落 | 132.8 MB（JSC 有整体归还能力） | p3-after-ttl-reclaim endMB |
| **现网同型进程 20h22m 实运行** | **RSS 3.29 GB / footprint 2090 MB**（PID 43877，全局安装 `chimera web`） | ps + footprint，归档 §1 |
| footprint 类别分解 | app-specific tag 1（Bun/JSC VM 堆）**1779 MB dirty + 1557 MB reclaimable**；WebKit malloc 117 MB；JS JIT 46 MB；SQLite page cache 44 MB（可回收） | footprint(1)，归档 §1 |
| 孤儿测试进程 | PID 18926 `bun run src/index.ts run …` 存活 **10 天 14h**、176 MB | ps |

三个直接推论：
1. **增长发生在长时间维度**。分钟级 harness 8 路峰值 ~1 GB 且能回落；同型进程 20h 涨到 3.3 GB，主体在 JSC VM 堆（tag 1）。这是「TS 运行时不适合超长运行」论断的本地定量实证，也说明 W1 的实例级驱逐预算（1024/2048MB，`WEBUI_PERFORMANCE_PLAN.md:49`）在长驻场景实际失守。
2. **底座 410–460 MB 是纯运行时税**：bun 单二进制 + Effect v4 beta 运行时 + 双 HTTP backend（Hono + effect-httpapi，`src/server/server.ts:107-145`）+ WebUI 嵌入资产。任何「减内存」路线必须先回答这 400+MB 怎么降。
3. **进程生命周期管理本身有缺口**：10 天孤儿 run 进程、14:34 注册表丢失事故（口述）都指向同一类问题——常驻态全在进程内存、无持久化、无监督回收。

### 1.2 常驻进程面分层（谁在长驻、常驻什么）

`chimera web` 单进程内含以下长驻层（全部有源码锚点）：

| 层 | 进程级常驻结构 | 上限/驱逐 | 锚点 |
|---|---|---|---|
| HTTP server（双 backend） | Hono `Bun.serve` 或 node adapter；effect-httpapi NodeHttpServer | 关闭路径幂等 | `src/server/adapter.bun.ts:9-11`、`adapter.node.ts:36-58`、`httpapi-server.node.ts:1-24`、`server.ts:191-336` |
| 全局事件中枢 | `GlobalBus` = Node EventEmitter 单例；**全仓 0 处 setMaxListeners**（默认 10 告警线） | 无 | `src/bus/global.ts:11-22` |
| SSE 扇出 | 每连接 1 个 GlobalBus listener + 1024 容量 drop-oldest 队列 + delta 合并 pending Map（40ms 窗口） | 队列有界，**连接数无上限** | `src/server/global-event-stream.ts:71-78,114,130`、`util/queue.ts:20-31` |
| 实例注册表 | `InstanceStore.cache: Map<目录,Entry>` + lastDisposedAt/pinnedUntil/suspectedPinMismatch 三辅助 Map | idle TTL 10min + 60s sweep + RSS 压力驱逐（默认 1024MB、水位 0.8）；`disposeEntry` 在 active>0 时**静默返回 false** | `src/project/instance-store.ts:150-158,66-79,228-247,339-362,239` |
| 实例内状态基座 | `InstanceState` = **ScopedCache capacity=POSITIVE_INFINITY**，键=目录；全仓 **32 处 `InstanceState.make`** → 每打开一个目录常驻 ~31 份服务状态 | 仅 invalidate/实例 dispose | `src/effect/instance-state.ts:42-48`、`instance-registry.ts:20,38,54,89-91` |
| 每目录 bus | wildcard = **PubSub.unbounded（无界缓冲）**；typed Map 按事件类型惰性创建**只增不删** | 仅实例 dispose finalizer shutdown | `src/bus/index.ts:27-30,54-55,76-85,66-68` |
| 后台任务引擎 | `jobs: SynchronizedRef<Map<jobID,Active>>`，**非持久化、无 TTL、settled/cancelled 条目永不 delete**；per-directory 分池（InstanceState），无进程级 ceiling | 仅实例释放级联 | `src/agent/background-job.ts:51,143-150,206,441`；上限只约束 running 数（`:269-271`，默认 16，`src/config/delegation.ts:10`） |
| 会话 runner 注册表 | `runners: Map<SessionID,Runner>` + 每 runner leases 数组 | onIdle delete + finalizer 全清（有界） | `src/session/run-state.ts:38,79-96,39-47` |
| Chimera 审计层 | `graphStates/graphRootsByDirectory/directoriesByGraphRoot/recentToolFiles` 四个模块级 Map；非 readOnly 释放只 `shrink()` 不 `close()`（连接+watcher 常驻） | graphStates **无容量上限**；recentToolFiles 15s 窗口清理 | `src/chimera/provenance.ts:212-215,399-423,647-703,1027-1033` |
| 存储 | 全局唯一同步 SQLite 连接（WAL、cache_size=-64000）；chimera store `withDb` **每调用 open/close，无池**（29 调用点） | 单连接 | `src/storage/db.ts:109-146,150-196`、`src/chimera/store.ts:735-749` |
| WebUI 静态资产 | `assets: Map` 64MiB 预算 FIFO + gzip 追加计费 | 有界（预算驱逐） | `src/server/shared/newweb-ui.ts:26,41,88-95,117-128` |
| 图谱引擎（每项目） | ReferenceResolver 8×LRUCache（默认 5000）+ `knownNames/knownFiles` 全量字符串 Set（129k nodes 的 JS 堆投影）+ QueryBuilder nodeCache(1000)/**stmts 预编译语句无 dispose** | LRU 有界；knownNames 随库规模线性 | `src/graph/resolution/index.ts:159-168,244-272`、`db/queries.ts:341-345,677-691` |
| 文件监视（**双套并存**） | 运行时 parcel watcher（每实例 ≤2 subscription）+ 图谱 chokidar FSWatcher（每项目 1）+ provenance 再启 graph.watch | 实例 finalizer unsubscribe；chokidar `stop()` **不清 readyWaiters** | `src/file/watcher.ts:33,92,110-117,125-139`、`src/graph/sync/watcher.ts:211-265,290,421-438`、`src/chimera/provenance.ts:548` |
| MCP 工具面 | `ToolHandler.projectCache: Map<string,CodeGraph>` **无上限、仅 closeAll 全清**；daemon 空闲 300s 退出 | 无逐项驱逐 | `src/graph/mcp/tools.ts:589,598,815`、`daemon.ts:60,192,246` |
| PTY | 每会话 buffer 上限 2MB + subscribers Map | finalizer teardown（有界） | `src/pty/index.ts:17,36-42,135-152` |

### 1.3 CPU/吞吐热点（长驻进程内）

1. **doom-loop 每 tool-call 全量 SELECT parts**：`src/session/processor.ts:476` 每次 tool-call 事件调 `MessageV2.parts()`（`src/session/message-v2.ts:1202-1213` 无条件全量查询、无缓存）→ 单 assistant 消息 O(N²)；工具爆发 bench 实证 exec 膨胀 ~6×（glob p50 69ms→428ms@n=50，memory.md 2026-09-14 条目）。
2. **每调用 ~7 次同步 SQLite tx**（burst bench 归因）+ `withDb` 每调用 open/close 连接抖动（`store.ts:735-749`）+ 同步单连接阻塞事件循环（`db.ts:150-196`）。
3. **compaction 估算反复全量 JSON.stringify**：`src/session/compaction.ts:250-256,270-283`（concurrency:1 串行多次全量序列化）。
4. **SystemPrompt 每 step 全量重装配、无缓存**：`src/session/prompt.ts:2470-2477`、`llm.ts:101-124`、`system.ts:157-170`（纯函数层，重复计算）。
5. **大 body 同步 gzipSync**：`src/server/routes/instance/httpapi/middleware/compression.ts:57`（阻塞事件循环；注意 `server/compression.ts` 不存在，W5 计划书所指即此两处 gzip 面）。
6. **图谱索引墙钟构成**（kernel P0-1 profile，`UPSTREAM_RUST_KERNEL_PLAN.md` §2.4）：parse+extract 仅 2–4%，**store ≈30%、resolution ≈51–56%**——吞吐大头在 SQLite 写入与解析层，二者均为零/低 Effect 纯计算面。

### 1.4 TS 侧泄漏高危面清单（源码证据定位，不臆测）

**A 类：无界常驻（明确增长面）**
- A1 `InstanceState` ScopedCache capacity=Infinity（`src/effect/instance-state.ts:43`）——实例数即乘数，32 服务/目录。
- A2 bus typed Map 只增不删 + wildcard 无界 PubSub（`src/bus/index.ts:54-55,76-85`）。
- A3 background-job 注册表 settled 条目永不 delete、非持久化单副本（`src/agent/background-job.ts:51,143-150,206,441`）——**14:34 注册表丢失事故的机制佐证**：注释自认「process restart or owner-scope closure loses status」，崩溃/重启即全失，恢复靠 phase 2 从子会话重建。
- A4 `graphStates` 无容量上限、非 readOnly 只 shrink 不 close（`src/chimera/provenance.ts:212,1032`）——多 root 长会话累积连接+watcher。
- A5 MCP `projectCache`/`worktreeMismatchCache` 无上限（`src/graph/mcp/tools.ts:589,598`）。
- A6 `trimmedSessions` Set 进程级只增（`src/session/message-v2.ts:47`，每会话一项，风险低但无界）。
- A7 `deadHostBootIDs` Set 未见删除路径（`src/chimera/edit-intent.ts:37,426,437`）。
- A8 snapshot layer 级 `locks: Map<gitdir,Semaphore>` 无驱逐（`src/snapshot/index.ts:73`）。
- A9 `providerHealth` Map 无驱逐（`src/session/remote-compaction-registry.ts:105,130`，provider 数有限，低风险）。
- A10 QueryBuilder `stmts` 预编译语句缓存无 clear/dispose（`src/graph/db/queries.ts:345,691`）。

**B 类：释放路径缺口/竞态**
- B1 `disposeEntry` 在 active>0 时静默 false（`src/project/instance-store.ts:239`）；pin 校正两连击可能误降活跃 pin（`:299-334`）。
- B2 SSE 流若创建后不迭代/不 close，GlobalBus listener 永久泄漏；实例 `/event` 的 `stop()` 缺失会同时泄漏 lease+Bus 订阅（`src/server/global-event-stream.ts:114,126-133`、`routes/instance/event.ts:46-53,77-85`）。
- B3 **tui/worker.ts:44 `GlobalBus.on("event",…)` 全文件无 off**（唯一明确未配对点，scout 2 全仓核对；其余 4 个调用方 event.ts/llm.ts/lsp client/mcp.ts 均已配对）。
- B4 `file/index.ts:410` 每次 ensure 重建 `Effect.cached(scan())` memoization fiber（可疑累积点，旧 fiber 生命周期取决于调用 scope）。**批注（2026-09-20，R1 收口复核）：伪报**——`Effect.cached` 单槽语义：每次 ensure 返回同一缓存 Effect 的引用，重建仅发生在缓存失效后且旧 fiber 随调用 scope 释放，无跨调用累积；R1 未改此处，结论=无需修。
- B5 chokidar `FileWatcher.stop()` 不清 `readyWaiters`（`src/graph/sync/watcher.ts:421-438`）。
- B6 `refreshPromise` 失败分支未见显式清空（`src/chimera/provenance.ts:474-479` 起，scout 标注未逐行验证）。**批注（2026-09-20，R1 收口复核）：伪报**——逐行复核确认 `refreshPromise` 由 `finally` 兜底，成功/失败双分支均清空，无滞留路径；R1 未改此处，结论=无需修。

**C 类：结构性放大器（非泄漏但推高常驻）**
- C1 每 SSE 连接 = 1 listener + 1024 队列 + pending Map，连接数无上限（`global-event-stream.ts:71-76,114`）。
- C2 双 HTTP backend 并存（Hono + effect-httpapi）= 双份路由/中间件常驻（`server.ts:107-145`）。
- C3 双文件监视面并存（parcel + chokidar + provenance graph.watch 第三路）——同项目最多 3 条监视路径。
- C4 knownNames/knownFiles 全量字符串 Set = 图谱规模在 JS 堆的线性投影（`resolution/index.ts:244-247`）。

---

## ② Rust 化候选面评估矩阵

打分口径：收益/风险/成本各 1–5（收益=内存+吞吐改善潜力；风险=契约破坏与语义漂移概率；成本=人日级粗估，1=低 5=极高）。**净优先度 = 收益 − 风险 − 成本×0.5**（粗排用，非精算）。

| # | 候选面 | 收益 | 风险 | 成本（人日） | 净优先 | 关键依据 |
|---|---|---|---|---|---|---|
| 1 | **storage 访问层**（SQLite 连接/withDb/tx 批量化；rusqlite napi 或 sidecar 池） | 4（burst bench：每调用 7 tx=exec 膨胀 6×；store 占索引墙钟 30%；同步单连接阻塞事件循环） | 2（`SqliteDatabase` 已双后端抽象 `graph/db/sqlite-adapter.ts:195-328`；drizzle 类型面可保留在 TS 侧） | 2（~10-20 人日：桥 5 导出契约 `db.ts:109-196` + withDb 29 调用点不动签名） | **+3.0** | 契约面最小、双后端先例、直接命中吞吐热点 |
| 2 | **graph resolution/store 引擎**（67k 行中零 Effect 的纯计算域；kernel 邻接扩展） | 5（resolution 占墙钟 51-56%；knownNames JS 堆投影消失；129k nodes/302k edges 全量进 Rust 内存管理） | 3（契约面大：ReferenceResolver 数十方法；但 **graph/chimera 目录 Effect 密度≈1**（scout 8 rg 统计），且 kernel parity harness/kill switch/defer 回退纪律现成） | 5（~60-120 人日，可沿语言/子系统分批绞杀） | **+2.5** | 唯一同时命中「内存+吞吐」两大目标的大面；kernel 战役已证明该域 Rust 化工程可行 |
| 3 | **server 纯逻辑面**（静态资产缓存+压缩+SSE 队列/delta 合并；`global-event-stream.ts`/`queue.ts`/`newweb-ui.ts` 近零 Effect） | 3（gzipSync 阻塞消除；64MiB 资产缓存移出 JSC 堆；SSE 扇出吞吐） | 2（契约=1 middleware + 6 导出 + drop-oldest/gap 语义逐字复刻；**双 backend 并存是前置统一项**） | 2（~10-15 人日） | **+2.0** | scout 5 结论：纯逻辑层已接近零 Effect 依赖，适合优先 |
| 4 | **watcher 统一**（parcel+chokidar+graph.watch 三路面 → notify crate 单 sidecar） | 3（消除双/三监视面；内核 watch 数与 pendingEvents 契约保留） | 3（chokidar ignored 预过滤 #276/ready 基线/pendingEvents staleness 契约需复刻；parcel 回调过 `Instance.bind` ALS） | 3（~15-25 人日） | **+0.5** | graph/sync 零 Effect 是利好；ALS 回调桥是障碍 |
| 5 | **background-job/run-state 引擎** | 2（内存面小；真正收益=注册表持久化可靠性，但这用 TS+SQLite 也能拿到） | 4（Deferred/Fiber/Scope/park-quiescence 语义深绑 Effect；generation 幂等 `background-job.ts:331-345` 必须保留） | 3 | **−1.5** | **建议先在 TS 侧做持久化+settled 驱逐**（成本低一个数量级），Rust 化不划算 |
| 6 | **session runtime**（processor/prompt/compaction 编排层） | 2（热点 O(N²)/estimate 可 TS 局部修：parts 增量缓存、估算增量化） | 5（Effect 重灾区：Layer 依赖图 13-20 服务、Stream/Fiber/Deferred 全面；plugin trigger ~18 处穿插） | 5 | **−3.5** | **不迁**。热点用 TS 修（§④ R1），编排层保留 |
| 7 | **bus** | 2（无界 PubSub 加上限即可，TS 一行级修复） | 5（runSync 同步订阅假设 `bus/index.ts:183-184`、65 事件 Schema、100 发布点、GlobalBus↔SSE 合流跨语言无法共享 EventEmitter） | 4 | **−4.0** | **不迁**。TS 侧加界+背压 |
| 8 | **tool 层**（42 文件） | 1 | 5（Effect 95 处引用、plugin SDK tool() 工厂面、39 工具描述契约） | 5 | −4.5 | 不迁 |
| 9 | **pty** | 1 | 5（原生句柄+EffectBridge native callback+WebSocket 流，scout 1 判「最难面」） | 4 | −4.5 | 不迁（保持 #pty 双 variant） |
| 10 | **provider/config/cli** | 1（网络/子进程密集，非内存热点） | 4（远程 fetch、npm flock、models 快照契约） | 4 | −4.0 | 不迁 |

**矩阵 Top3 结论：① storage 访问层 → ② graph resolution/store 引擎 → ③ server 纯逻辑面。** 三者共同特征：零/低 Effect 密度、契约面可枚举、有 kernel 或双后端先例、直接命中实测热点（tx 膨胀/墙钟 81%/gzipSync 阻塞）。session/bus/tool/pty/provider 五个 Effect 重灾区**明确不迁**——其泄漏面用 TS 修复（§④ R1）成本低一个数量级。

---

## ③ 混合架构方案对比

### 方案 A：napi 桥扩展（沿 codegraph-kernel 先例逐层吞并）

```
┌─────────────────────── chimera (bun 单二进制, TS) ───────────────────────┐
│ Effect 运行时 / session / bus / tool / plugin / server 路由 (保留 TS)     │
│   │ 同步调用, 扁平 Buffer ABI, contract_info 对账, kill switch, defer 回退 │
│   ▼                                                                      │
│ *.node (napi8 cdylib): codegraph-kernel(已存在) + sqlite-bridge           │
│                        + resolution-engine + sse-static(新增 crate)       │
└──────────────────────────────────────────────────────────────────────────┘
```
- **契约面**：每 crate 一组 `#[napi]` 同步函数 + 扁平 buffer/JSON 逃生舱（kernel 先例：`extract_file`/`contract_info`/`grammar_info`，`codegraph-kernel/src/lib.rs:95-233`；五表 ABI v2 + extraJson；TS 侧 seam 仅 1074 行 = loader/layout/decode/index，`src/graph/extraction/kernel/*.ts`）。
- **工程纪律直接复用**：parity harness 字节级双臂对账、CODEGRAPH_KERNEL 式 kill switch、逐子系统路由白名单、加载失败静默回退 TS 路径（`loader.ts:1-24` 注释即设计文档）、8 腿 prebuild CI + wasm 回退永不闸发布。
- **适用面**：纯计算/存储面（矩阵 #1#2#3）——napi 同步调用设计（上游明令禁止 Rust 侧重建池）恰好匹配。
- **不适用面**：长驻状态+Effect Scope/Fiber 语义面（instance-store/bus/background-job）——napi 无法持有 Effect 生命周期，强行桥接=把 A 变成 C。
- **回退路径**：每层独立 kill switch + TS 原路径保留至终态（kernel 先例：wasm 臂保留 2 个战役周期后才议删除）。
- **增量成本**：.node 每平台 33.6 MiB（kernel 实测）；新 crate 可并入同一 .node（单 cdylib 多模块）避免分发腿×N。

### 方案 B：sidecar 进程（IPC）

```
┌── chimera (TS, 瘦身) ──┐   unix socket / 命名管道    ┌── chimera-daemon (Rust) ──┐
│ session/bus/tool/plugin │ ←── JSON/bincode 帧协议 ──→ │ watcher 统一(notify)       │
│ server 路由(薄)         │     请求/响应 + 事件推送      │ SSE 扇出+静态资产           │
└─────────────────────────┘                             │ SQLite 池(多连接读写分离)   │
        监督: 崩溃重启 + 版本握手 + 降级回 TS 路径         │ MCP graph daemon(已有先例) │
                                                          └────────────────────────────┘
```
- **契约面**：帧协议（请求/响应/事件三类）+ 版本握手 + 能力协商；事件语义需复刻 drop-oldest/gap 补发（`util/queue.ts:20-31`、`global-event-stream.ts:142-146`）。
- **独有能力**：真正的多连接 SQLite 读写分离（突破 bun 同步单连接）；watcher/图谱索引移出主进程（主进程 RSS 直接卸掉 knownNames 投影+parse 池峰值）；daemon 可跨 CLI/web/MCP 复用（`graph/mcp/daemon.ts` 空闲 300s 退出+writer-lock 单写者已是现成先例，`engine.ts:214-224`）。
- **代价**：IPC 序列化延迟（逐 token delta 路径过进程边界=吞吐风险，需共享内存或批量帧对冲）；生命周期管理新增一整类故障（崩溃重启/半开连接/版本偏斜）；分发矩阵新增独立二进制（8 腿 × 签名 × 端点安全「新落盘可执行物」红线——本机已两次触雷，sidecar 二进制的本地验证成本显著高于 .node）。
- **回退路径**：协议握手失败即整体回退 TS 内路径（同 A 的 kill switch 语义，但粒度=整个 daemon）。

### 方案 C：新 Rust 宿主 + TS 插件层反转

```
┌── chimera-host (Rust): HTTP/SQLite/调度/事件/进程监督 ──┐
│   嵌入式 JS 引擎 (quickjs/deno_core/v8) 运行:            │
│   - plugin SDK 插件 (18 hooks, PluginInput)              │
│   - 39 工具的 execute 沙箱                               │
│   - 用户配置面 JS 片段                                    │
└──────────────────────────────────────────────────────────┘
```
- **收益上限最高**：底座 410–460MB → Rust 宿主预计 <100MB；JSC 堆病理（tag 1 的 1.7GB dirty）整体消失；长驻稳定性由 Rust 监督层兜底。
- **成本/风险极端**：Effect v4 运行时语义（Layer 图/Scope/Fiber/Stream/PubSub/ScopedCache，session 136 处并发原语）需在 JS 沙箱内保留或在 Rust 重建——前者=没省下 JSC，后者=重写全部编排层（session 14k 行 + server 15k 行 + tool 12k 行）；plugin SDK 契约含 `Bun.$` BunShell（`packages/plugin/src/index.ts:58-68`）需另供 shell；SDK/OpenAPI v2 gen、WebUI 嵌入链、发布矩阵全重做。**估 6-12 人月起步，且与上游 opencode 同步面彻底断裂**（F 线/L 线同步成本转为纯 fork 自维护）。
- **回退路径**：无渐进回退——宿主切换是断点式迁移，这是与 A/B 的本质差别。

### 对比结论

| 维度 | A napi 桥 | B sidecar | C Rust 宿主反转 |
|---|---|---|---|
| 内存收益 | 中（计算面堆移出 JSC，底座仍在） | 中高（daemon 卸掉图谱/watcher 常驻） | 高（底座重写） |
| 吞吐收益 | 高（SQLite/resolution 直击 81% 墙钟） | 高（多连接池+进程外并行） | 高 |
| 风险 | **低**（先例全套纪律可复用） | 中（IPC+生命周期新故障类） | 极高（无渐进回退） |
| 成本 | 低-中（分层分批） | 中（协议+分发+签名） | 极高（6-12 人月+） |
| 上游同步兼容 | **好**（TS 面不动） | 中 | 断裂 |
| 端点安全适配 | **好**（.node 非「新可执行物」模式，kernel 已有静态验证流程） | 差（独立二进制本地不可执行验证） | 差 |

**推荐：A 为主、B 为补的混合路线**——纯计算/存储面走 A（sqlite-bridge、resolution-engine、sse-static 并入 kernel 同 cdylib 或平行 crate），需要「进程外常驻+多连接+跨入口复用」的面（统一 watcher、SQLite 读写分离池、MCP graph daemon 合并）走 B；C 仅在 A+B 完成后、若底座 400+MB 仍是硬伤时作为远景独立立项（决策点放 §④ R6）。依据：真实热点（store 30%+resolution 51-56%+tx 膨胀 6×）全部落在 A/B 适配面内；Effect 重灾区不迁则 C 的收益前提（重写编排层）不成立；kernel 战役已把 A 的工程风险降到有实证下界。

---

## ④ 分阶段路线图（规划，不实施）

总原则（kernel 战役验证过的纪律全套沿用）：**每层绞杀、kill switch、TS 原路径保留至 parity 门通过、字节级/行为级双臂对账、bench 门槛挂钩既有基线体系、树常绿可回退**。

### R0：调研收口 + 基线固化（本文档即产出；~2-3 人日）
- 出口判据：本文档评审通过；RSS 归档数据入 `cbench/rust-plan/`；基线三件套确认（webui-perf 8 路峰值 1002.4MB / 底座 410-460MB / 现网 20h 3.29GB）。
- 可回退性：无变更，天然可回退。

### R1：TS 侧泄漏与热点修复批（**不写 Rust，先摘低垂果实**；~5-10 人日）
- 内容：§1.4 A/B 类清单逐项修复——settled job 驱逐+注册表 SQLite 持久化（同时消解 14:34 类事故根因）、bus typed Map 上限+wildcard 有界化、GlobalBus setMaxListeners、tui/worker.ts:44 补 off、deadHostBootIDs TTL、projectCache/graphStates 容量上限、snapshot locks 驱逐、readyWaiters 清理、processor.ts:476 parts 增量缓存、compaction 估算增量化、gzipSync→异步。
- **新增长稳观测 harness**：24h soak（复用 webui-perf harness 加长时间轴 + 定期 heap snapshot/footprint 采样），归档 `cbench/rust-plan/soak-*`——这是 R2+ 每阶段的内存裁判。
- 出口判据：全量测试基线 25 fail 不新增；webui-perf 8 路峰值 ≤1002MB 不回退；**24h soak RSS 增长曲线斜率显著下降**（目标：24h 终值 ≤1.5×底座，对照现网 20h→3.3GB）；burst bench exec 膨胀收敛（glob p50 @n=50 < 200ms）。
- 可回退性：逐提交 revert；每项独立。
- 意义：若 R1 后 soak 曲线已平，则「Rust 化」的内存论据减弱、吞吐论据（81% 墙钟）仍在——**R1 数据是 R2 立项的输入而非形式步骤**。

### R2：storage 访问层桥（方案 A 首层；~10-20 人日）
- 内容：rusqlate napi crate（或并入 kernel cdylib）：连接持有+prepared stmt 缓存+tx 批量提交+读写分离只读连接；`db.ts` 5 导出契约（Client/use/effect/transaction/close）与 `withDb` 29 调用点签名不动；`#db` 双 variant 保留为回退路径。
- 出口判据：g1-wal bench-insert 全套场景吞吐 ≥ 基线且 integrity=ok；burst bench write 场景 ≥161/s 不回退、只读 exec 膨胀消除；SQL 行为 parity（drizzle 生成 SQL 逐条对账，仿 kernel parity harness 建 sql-parity 快照）；kill switch 关=字节不变；全量测试基线不新增。
- 可回退性：`CHIMERA_SQLITE_BRIDGE=0` 回 `#db` 原路径。

### R3：graph resolution/store 引擎 Rust 化（方案 A 主体，分子批绞杀；~60-120 人日）
- 内容：按 kernel 战役同款姿势分批——先 store（SQLite ingest，墙钟 30%），再 resolution 子域（name-matcher→reference-resolver→chain-form，墙钟 51-56%）；每批过 parity 门（同库双臂逐节点/逐边字节对账，复用 `cbench/kernel-parity/` 快照体系）才开路由；EXTRACTION_SEMANTICS_VERSION 同款语义版本键防静默陈旧。
- 出口判据（每子批）：召回矩阵 matrix-d/f 12 格满分不回退；G 臂 12 格 + tb5-v2/tb6 重放零回归；主仓重索引墙钟 ≥1.3× 改善（对应 store/resolution 占比）；knownNames JS 堆投影消除（soak 中图谱相关 RSS 增量 → ~0）；needsReindex 用户面姿态正确。
- 可回退性：逐子域路由白名单摘除即回 wasm/TS 臂（kernel 先例语义）。

### R4：server 纯逻辑面（方案 A；~10-15 人日；可与 R3 并行）
- 内容：静态资产缓存+压缩+SSE 队列/delta 合并下沉 Rust（先决项：双 backend 统一或至少 SSE 面单实现）；drop-oldest/gap/40ms 合并语义逐字复刻并建行为 parity 测试。
- 出口判据：webui-perf harness gaps=0/disposed=0 保持；8 路流式峰值 RSS ≤ 基线−10%；SSE 端到端延迟 p99 不回退；`/global/event` 事件计数逐类相等（harness counts 对账）。
- 可回退性：feature flag 回 TS 实现。

### R5：watcher 统一 + daemon 化评估（方案 B 唯一批；~15-25 人日）
- 内容：notify crate sidecar 收编三路监视面；同期评估 SQLite 池/MCP graph daemon 是否并入同一 daemon（R2/R3 数据决定：若 napi 已够则 B 案缩为仅 watcher）。
- 出口判据：pendingEvents staleness 契约保持（MCP tools 消费面测试）；#276 内核 watch 数不回升；双监视面消除（soak 中 per-project fd/线程数下降）；daemon 崩溃重启+降级回 TS watcher 演练通过。
- 可回退性：daemon 不启动/握手失败即回 TS 双 watcher 原路径。

### R6：长稳复评 + 方案 C 决策点（~3-5 人日）
- 出口判据：72h soak 报告（R1 harness）；对照三目标（内存/速度/吞吐）逐项结账；若底座 410-460MB 仍是硬伤且 A+B 收益已封顶 → C 案独立立项调研（另出文档）；否则宣告混合架构终态、TS 面冻结为「编排+插件+契约层」。
- bench 门槛体系总挂钩：webui-perf（RSS/事件）、g1-wal（SQLite）、burst（工具吞吐）、matrix-d/f + G 臂 + tb 系列（质量召回）、kernel parity 快照法（行为对账）、全量测试 25 fail 基线（回归）、24h/72h soak（长稳，R1 新建）。

---

## ⑤ 风险登记册

| # | 风险 | 等级 | 证据/机制 | 缓解 |
|---|---|---|---|---|
| 1 | **Effect v4.0.0-beta.83 绑定**：beta 漂移（beta.57→83 曾断 MaxBodySize.asEffect，memory.md 2026-09-01 条目）；runSync 同步订阅假设（`bus/index.ts:183-184`）；ScopedCache/Layer/Fiber 语义无法跨 FFI | 高 | 桥契约一律 plain data（kernel 先例：扁平 buffer+JSON 逃生舱）；Rust 侧零 Effect 类型；不迁 Effect 重灾区（矩阵 #5-#10） |
| 2 | **bun/node 双 variant**：#db/#pty/#hono/#httpapi-server 7 文件 222 行 seam；bun compile 单二进制下 .node 加载 | 中 | kernel 已实证：.node 旁挂 bin/ + execPath 相邻解析 + require 在 bun compile 下工作（含 musl 变体）；每新桥保留双 variant 回退 |
| 3 | **Bun.* 无等价 API**：`Bun.$`（plugin 契约一部分，`packages/plugin/src/index.ts:58-68`）、`Bun.hash.xxHash32`（`tool/hashline.ts:59`）、`Bun.serve` | 中 | 均不在 A/B 迁移面内（plugin/tool/server adapter 保留 TS）；若 C 案立项需另供 shell |
| 4 | **WebUI 嵌入资产链**：64MiB 缓存+manifest+gzip 计费（`newweb-ui.ts:26,41,88-128`）；newweb 嵌套独立 git 仓 dist 嵌入 | 中 | R4 整体搬静态服务进 Rust（scout 5 判「最自然切法」）；嵌入链不动，只换读取/缓存侧 |
| 5 | **plugin SDK 面**：18 hooks、~18 处 prompt.ts trigger、tool() 工厂、动态 ESM import（`plugin/loader.ts:121-124`）、@opentui peers | 高（仅对 C 案） | A/B 路线 plugin 面零触碰；C 案立项前必须先出插件沙箱专项调研 |
| 6 | **发布矩阵放大**：12 包→8 腿 kernel prebuild × 2 variant（no-webui/with-webui）已是现矩阵；每个新 Rust 组件潜在 ×N；win-msvc CI-only、musl crt-static 需 CARGO_ENCODED_RUSTFLAGS、zig 子命令全家禁用 | 高 | 新 crate 并入既有 cdylib（单 .node 多模块）避免腿数放大；kernel「永不闸发布」（continue-on-error + wasm 回退）纪律沿用 |
| 7 | **端点安全红线**：本机禁执行新落盘可执行物（两次触雷实录，memory.md 2026-09-17）；sidecar 独立二进制本地验证成本 >> .node | 高（对 B 案） | A 案优先的实证理由之一；B 案二进制执行验证一律 CI-only；静态验证流程（tar -tzf/shasum/otool/nm）沿用 |
| 8 | **SDK/OpenAPI 契约**：server 面变更需重生成 sdk v2 gen（`packages/sdk/js/script/build.ts`）；newweb api:inventory:update 联动 | 中 | R4 契约面（SSE 事件形状）逐字复刻+counts 对账，理论上 OpenAPI 零漂移；有漂移即重生成入同批 |
| 9 | **上游同步面断裂**：F 线/L 线仍在滚动（TRIAGE/计划书体系）；Rust 化层与 upstream opencode 对应物脱钩 | 高（对 C）中（对 A/B） | A/B 保留 TS 编排面=上游同步主战场不动；R3 起 graph 域本就 fork 自维护（kernel 战役先例）；每阶段收口时更新 TRIAGE 映射 |
| 10 | **SQLite 单写者约束**：WAL 单写者+同步事务语义（`db.ts:182-196`）；sidecar 多进程写锁 | 中 | writer-lock 单写者先例（`graph/mcp/engine.ts:214-224`）；R2 读写分离只动读连接；写路径保持单写者 |
| 11 | **测量噪声**：索引计时类实测与重型 I/O 并发曾产出 25min 假回归（memory.md 2026-09-16） | 中 | soak/bench 一律安静环境单独跑；R1 harness 内建噪声标注 |
| 12 | **14:34 类事故根因未明**：注册表丢失记录已从 memory.md 清理、未复发；Rust 化不自动解决逻辑性丢失 | 中 | R1 先做持久化+监督（TS 侧即可）；soak harness 加注册表一致性断言；若复发按新证据重开根因批 |
| 13 | **JSC 堆归还行为依赖**：TTL 驱逐后 endMB 132.8 < base（整体 dispose 才归还）——A/B 路线减少的是「进 JSC 的量」，不改变 JSC 归还策略 | 中 | 收益评估以 soak 曲线为准而非单点；底座 410MB 的 JSC 固有占用留给 R6/C 案决策 |
| 14 | **人日估算不确定性**：R3 的 60-120 人日基于 LOC（graph 67k 行）与 kernel 战役实速外推，resolution 契约面（数十方法）未逐方法盘点 | 中 | R3 立项前先出子域级契约盘点（仿 K-v2 P0 三方盘点姿势） |

---

## 附：调研盲区（Remaining risk）

1. 现网 3.29GB 的**归因未定位**——footprint 只给类别分布（JSC 堆 1779MB dirty），未做 heap snapshot 对象级归因；R1 soak harness 是补此盲区的前置。
2. 14:34 事故原始记录缺失（memory.md 已清理），仅口述+机制佐证。
3. 每 InstanceState 服务的单实例内存占比未实测（WEBUI 计划书开放问题 1 的遗留标定项「实测每项目实例 RSS 占用」未完成）。
4. scout 标注的未逐行验证项：`webSocketSessions` 清理点、`refreshPromise` 失败滞留、newweb assets 驱逐算法细节。
5. 无任何新 microbench：Rust 方案性能数字全部为既有 bench 外推（端点安全禁执行新鲜可执行物），R2/R3 立项时需 CI 侧补实测。
6. g1-wal 吞吐数字未逐场景提取（s*.out 部分为空，数据在 .sql.json/.err 面）。

## 附：2026-09-24 重估与 T0 批执行（增补）

重估总报告=`cbench/rust-plan/RUST_EVAL_20260923.md`（6 路侦察+合成），本文档口径以其 §9 为准。要点：

- **T0 纯 TS 批已落地**（5 commits）：WASM grammar kernel 感知化（消 96.4MB 高水位）/主库 WAL 治理+withDb 池化+prepare 缓存/SSE 全局流序列化一次化+连接上限 64/snapshot 每 step spawn ~10-14→4。tool-call tx 合并经评估**否决**（WAL 单写者+崩溃重放语义）。
- **T0-5 native profile 翻案**：~1GB 堆外真身=**JSC arena 棘轮**（vmmap tag 240 占 footprint 84-90%，索引爆发冲 1477MB 峰值后滞留 +246MB）；SQLite 页缓存 dirty ≈0.016MB 排除、系统 malloc 滞留排除。**R2 内存论据删除**，只剩吞吐；§1.4 相应失效。
- **R3 确认唯一内存杠杆**（WASM+棘轮+LRU 85MB 全在 JSC，预期削生产 RSS −0.5~−0.9GB）；立项书=`cbench/rust-plan/R3_PROPOSAL.md`（三刀 R3a/b/c，契约盘点已补齐盲区 #7）；R5' 设计上修=`cbench/rust-plan/R5_SIDECAR_DESIGN.md`（MCP daemon 骨架泛化，watcher 统一第一住户；graph 常驻缓存归 R3 napi）。
- server 面（原候选 3）论据失效移出名单：gzipSync 已异步、双 backend 非运行时、SSE 自有结构有界。
- R2' 新优先项：db.bun.ts 侧 prepare 缓存 shim（免补丁，量化后再定 napi 桥范围）。

## 附：证据档案索引

- 实测 RSS 归档：`/Volumes/workspace/cbench/rust-plan/rss-aggregate-20260918.md`、`rss-snapshot-20260918.txt`
- webui-perf 原始 run：`/Volumes/workspace/cbench/webui-perf/.runs/`（28 run）
- kernel 先例全文：`UPSTREAM_RUST_KERNEL_PLAN.md`（B 案绞杀者姿势、8 腿发布链、parity 纪律、§2.4 墙钟构成）
- W1 内存预算拍板：`WEBUI_PERFORMANCE_PLAN.md:49,136`
- 8 路 scout 报告（会话级存储，task_id 见收口报告）：实例生命周期/bus/后台任务/审计缓存/SSE-server/监视-图谱/会话运行时/运行时耦合面
