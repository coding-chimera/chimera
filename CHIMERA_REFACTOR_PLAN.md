# Chimera 大重构总体规划（调研与路线图）

制定：2026-10-10。性质：**调研完成、方向已定、待开工**。本文档是"Chimera 大重构"的总图，聚合 13 路并行调查（dsh webui / Agents-Anywhere web-next+desktop / newweb 现状 / onboarding 链路 / 内存实测 / newweb god file 解构 / chimera 核心传播分析 / 原生 GUI API 评估 / Rust 化盘点 / codex 设计语言 / 解环切割集 / 目标分层设计）的结论。所有关键断言均有 file:line 证据；原始报告在发起会话（ses_edc5a8876ffedncUXH4PQd6V0m）的 tool-output 中。

用户战略指令（2026-10-10 拍板）：
- **暂不开工**（"等我再看看"），本文档先行。
- WebUI 重构方向：god files 拆成"编排+组件库"模式；用图能力削减传播深度（除通用 util 外不允许长传播链）。
- GUI：拒绝 Tauri/Electron 重壳，**做原生 GUI，macOS Swift 先行**（Windows 暂缓，Linux/KDE Qt 随后）；原生为主、webui 并存。
- 潮酷：参照 codex；范围再研究（codex app 逆向为备选）。注意 codex app 自身也有 2-3GB 内存问题 → **内存纪律是 GUI 的一等设计约束**。
- Rust 路线：看诊断结果再定 → 诊断已出（见战线 B），结论：**选择性 Rust，全量重写当前 No-Go**。

---

## 0. 全局判断

Chimera 的问题不是"缺功能"，而是三件事同时发生：

1. **运行时依赖图结成了死团**：`packages/chimera/src` 834 个文件中 246 个处于同一个强连通分量（SCC），模块级 36 节点 283 条环边；跨层环 `effect→session→provider→effect` 实证存在。继续发展下去代码将不可维护。
2. **JS 堆在长驻中只涨不缩**：实测在役 `chimera web` 进程 RSS 1.5GB（peak footprint 4.1GB），大头是 JSC arena 棘轮（507MB 常驻 + 320MB swapped）。
3. **WebUI 的交互纪律没立起来**：骨架其实是对的（features 零交叉 import），但 barrel 枢纽造成 16 层传播链、11 个 god file（最大 1885 行）、权限双系统并存。

三条线都有低风险起步动作，且互相支撑：解环让 server 可维护 → 减重让 server 可长驻 → GUI/潮酷都建立在前两者之上。

---

## 战线 A：解环（packages/chimera/src）

### A.1 证据基线

- 文件级最大 SCC = **246 文件**；模块级 SCC = **36 目录 / 283 条环边**。复现脚本（import 正则抽取 + Tarjan）：`/var/folders/dt/wxzvy2252txfv2mrcbpxsh3h0000gn/T/chimera/{modgraph,scc,sim,sim3}.ts`（`sim3.ts` 支持删边模拟）。
- `graph`（179 文件 / 8.1 万行，占 39.4%）与 `util` 出边为 0，**不在团内**。
- 根因一：`session/schema.ts`（SessionID/MessageID/PartID）被 46 个外部文件、11 个模块引用，却是编排层叶子——类型归属错误。
- 根因二：`session/session.sql.ts` 的 Drizzle 表被 storage/project/share/memory/permission/chimera/v2 等约 10 个模块反向引用——表归属错误。
- 根因三：`effect/app-runtime.ts` 一个文件反向 import 14 个 session 模块（组合根倒置，66 条反向边）。
- 根因四：`server` fan-out 431（横跨 33 目录）、`tool` fan-out 208——上帝编排器。
- **单点最大杠杆**：`plugin/index.ts:130` 一条动态 `import("../server/server")` 把全部 86 个 server 文件钉进巨团；删边模拟实测文件 SCC **246→154**。
- 诚实约束：**纯搬迁不缩文件级 SCC，只有真删边才缩**；全仓 400 处 `import type` 剥离是最便宜的消边手段；112 处动态 import 不计入静态边，禁止把静态边偷改成动态 import 来"假解环"。

### A.2 目标分层

| 层 | 职责 | 目录 |
|---|---|---|
| L0 原语 | 无内部依赖 | `util` `id` `graph` |
| L1 契约 | 纯类型+端口接口 | `packages/schema`（已存在，`@opencode-ai/schema`）+ 新增 `src/contracts/*`、`src/storage/tables/*` |
| L2 基础设施 | 无业务语义服务 | `bus` `storage` `file` `git` `shell` `patch` `env` `installation` `auth` `ide` |
| L3 组件 | 单一职责 | `effect`(原语) `lsp` `mcp` `pty` `snapshot` `format` `skill` `image` `question` `command` `permission` `account` `worktree` `browser` `sync` `share` `config` `project` `control-plane` `memory` `plugin` |
| L4 领域服务 | 领域编排 | `provider` `session` `agent` `chimera` `tool` `v2` |
| L5 编排入口 | 传输与入口 | `server` `cli` `acp` |
| L6 组合根 | 装配，禁止被 import | 新增 `src/composition/*`、`index.ts` |

规则：只许上层 import 下层；同层协作只能经 L1 端口接口或 bus 事件；除 util/id/graph/contracts 外传播链 ≤2。

### A.3 迁移序列（每步独立可回退，SCC 阈值卡 CI）

| 步 | 动作 | 预期 SCC | 风险 | 验证 |
|---|---|---|---|---|
| A1 | `plugin/index.ts:130` 动态 import 改组合根注入 | 246→≈154 | 中 | typecheck + test/plugin + SCC 复算 |
| A2 | schema 下沉：`session/schema.ts` → `packages/schema`；`session.sql.ts` → `storage/tables/`；原文件留 re-export shim（调用点零改动） | 模块级显著收缩 | 低 | typecheck + test/session|memory|storage + drizzle migration 无漂移 + OpenAPI 字节不变 |
| A3 | `remote-compaction-codec.ts`（纯叶子）迁中立模块，消 provider→session/plugin→session | — | 低（机械） | typecheck |
| A4 | effect 组合根拆至 `src/composition/`，`effect/` 只留原语；环境上下文类型（Instance/WorkspaceContext）上移 | →≈139 | 中 | typecheck + test/effect + serve 冒烟 |
| A5 | tool 薄接口：新增 `src/contracts/{session,agent,audit}-port.ts`，tool 只依赖 contracts；剥离 type-only import | →≈95 | 中 | test/tool |
| A6 | server service 门面：handler 只调 Service 接口，不 import 领域实现 | 逐组下降 | 中 | test/server + OpenAPI 无漂移 |
| A7 | graph 独立成包（出边已为 0，纯工程收益，最后做） | — | 中 | 全量 |

配套模式规则：**跨模块"查询/命令需返回值" → 端口接口；"状态变更广播" → bus 事件**（bus 已有 65 个事件类型）。

### A.4 防回归（机械化）

- **立即**：~~oxlint `import/no-cycle`~~ **已证伪**（2026-10-10 实测：1.60.0 该规则是 stub，两文件互导探针 0 警告）。改为门禁前置：自研 `packages/chimera/script/check-layering.ts`（移植已验证的 scc.ts/modgraph.ts 解析+Tarjan），W1 即上闸。
- **门禁**：check-layering 断言文件级/目录级最大 SCC ≤ 阈值（起点 246/36，逐里程碑收紧），`bun run check:layering` 与 `bun typecheck` 并列进 CI（CI 接线在 W2）。
- **终态**：dependency-cruiser 分层规则（配置草案在分层设计报告 §3.2）。
- **反作弊**：每刀记录删的是值边还是类型边；SCC 不变的动作不算进展。

---

## 战线 B：减重（内存纪律）

### B.1 实测画像（2026-10-10，本机）

| 场景 | RSS | 方法 |
|---|---|---|
| 裸 bun | 12MB | time -l |
| `chimera --version` | 218MB 峰值 | time -l |
| `chimera serve` 空闲（空目录） | **127MB 稳定** | ps |
| `chimera graph index`（219 文件） | 571MB 峰值 | time -l |
| 活跃 agent run | 238-358MB | ps |
| **常驻 `chimera web`（在役 16h）** | **1.5GB / peak 4.1GB** | ps + vmmap |

归因：增长主体 = **JSC 堆棘轮**（507MB 常驻 + 320MB swapped）；SQLite page cache 常驻 <1MB、mmap 常驻低、wasm 空闲未加载——都不是主因。结构性来源：① 多项目图连接常驻不释放（在役进程握 3 个 codegraph.db，每个固定 64MB cache + 256MB mmap，`graph/db/index.ts:62-63`）；② 全局会话库 2.68GB（part 表 1.8GB / message 682MB）；③ 堆无上限（`cli/heap.ts:16` 仅 2GB 才 snapshot）；④ grammar 缓存生产环境从不卸载（`graph/extraction/grammars.ts:281-283,747`）。

归档对照（`cbench/rust-plan/*`，2026-09）：底座税 410-460MB → 本次实测 127MB，**底座已改善**；R3（图 store/resolution Rust 化）代码已落地待开闸。

### B.2 五刀（目标：常驻 <500MB）

| 刀 | 动作 | 锚点 |
|---|---|---|
| B1 | 图连接空闲淘汰：web server 对空闲项目 close codegraph 连接（或调已有 `CodeGraph.shrink()`） | `graph/index.ts:1435` |
| B2 | SQLite 默认值下调：mmap 256→32MB、cache 64→16MB；会话库同步 | `graph/db/index.ts:62-63`、`storage/db.ts:155` |
| B3 | 消息/部件历史驻留收敛：按需流式读取、限制保留窗口 | `session/message-v2.ts` |
| B4 | JS 堆上限 + 主动 GC：`OPENCODE_AUTO_HEAP_SNAPSHOT` 抓堆定位增长点；周期性 `Bun.gc(true)` 评估 | `cli/heap.ts:16` |
| B5 | grammar 缓存按语言卸载（`resetParser` 已有，生产未启用） | `grammars.ts:716` |

### B.3 Rust 路线结论

- **选择性 Rust**：R3 收口（parity 验证 + 默认路由开闸）是最大剩余内存杠杆（预期 -0.5~-0.9GB，直击索引墙钟 ~81%），代码已存在、成本低；之后 R5' sidecar（watcher 统一 + SQLite 池，可独立重启）。
- **全量 Rust：当前 No-Go**。12-24 人月；Effect v4 编排语义不可跨 FFI；20 个 provider SDK 重做；上游同步断裂。Go 条件（须同时成立）：五刀+R3 后稳态仍 >800MB、长跑棘轮 sidecar 也救不了、接受上游断裂、保留 JS 插件层。任一不成立维持混合架构。详见 `RUST_MIGRATION_PLAN.md` 与 `cbench/rust-plan/R3_PROPOSAL.md`。
- LSP（每语言 100-500MB 独立进程）与 Chromium（browser 工具）是系统级叠加项，单独评估是否纳入常驻预算。

---

## 战线 C：WebUI（packages/newweb）

### C.1 结构判断

骨架是对的：features 之间零交叉 import、`components/ui` 单向被消费——"编排+组件库"的地基已存在。要修的是：

1. **barrel 枢纽**（传播深度的主因，~70%）：`api/index.ts`(fan-in 56)、`hooks/index.ts`(40)、`store/index.ts`(29)、`contexts/index.ts`、`features/attachment/index.ts` 串联出 14-16 层链。动作：禁止 barrel→barrel；热点模块拆细 barrel；子组件 import 具体文件。
2. **11 个 god file**（解构蓝图已出，含分块/目标结构/拆分顺序）：DiffViewer(1885)→InputBox(1538)→SidePanel(1529)→FileExplorer(1469)→layoutStore(1406)→themeStore(1132)→useChatSession(1144)→MessageRenderer(1093)→Terminal(1076)→SessionList(1055)→ChatPane(1025)。批次：① 纯函数/类型（零风险）→ ② 叶子组件 → ③ feature hook 抽取 → ④ 重容器 → ⑤ store slice（fan-in 最高，最后动，保持 API 兼容）。
3. **权限双系统**（`PermissionDialog` 浮层 vs `InlinePermission` 内联 + `ToolPartView` 补丁缓存）统一成单一交互模型（参照 AA InteractionCard：审批+问答合一）。

### C.2 潮酷纪律（参照 codex，范围待研究）

codex 的"潮"= 纪律而非重设计，可迁移的四条：
1. 语义 design token：单一 accent + 语义状态色 + 对比度校验（CIE76 Lab）+ 能力分级降级。newweb 已有 CSS 变量主题系统（`themeStore` + `themes/index.ts`），在其上立纪律即可。
2. 克制微动效：流式 shimmer、状态庆祝动画、全部带 reduced-motion 降级。
3. 流式增量渲染 + 危险动作仪式化：流式 markdown（newweb 已有 marked+morphdom 管线）、diff 行号/gutter/语法高亮、审批语义符号。
4. 视觉快照测试守门（codex 193 个 TUI 快照测试的对应物）。

待定：codex app 逆向调研作为备选输入（注意其自身 2-3GB 内存问题，取其视觉纪律、不取其运行时）。

### C.3 快赢：onboarding（独立于大重构可先落地）

"必须先 TUI 配置才能用 WebUI"的根因不在后端：server API（provider/auth/oauth/config）与 SDK 全部就绪，newweb 已有 `ProviderSettings.tsx`。缺的只是首启状态机：检测零 connected provider → 自动打开 Provider 设置（TUI 参照 `cli/cmd/tui/app.tsx:445-454`）→ 连接成功 → 引导选模型。`server-workflow-closure.json:449` 标注 `ui: deferred`。风险点：无目录 scope 下 provider 路由行为需实测。

---

## 战线 D：原生 GUI（macOS Swift 先行）

### D.1 可行性结论

**基本可行，无硬缺口**。codex 桌面 app 即"原生 GUI 连本地 server"（app-server JSON-RPC）的同构先例。我们的面：

- REST：~170 个 operation 全部在 OpenAPI（Effect HttpApi 契约生成），可喂 swift-openapi-generator；生成链复刻 `packages/sdk/js/script/build.ts` 的"取 spec → 喂生成器"两步。
- 事件：BusEvent 是干净的一级判别 union（Swift enum 友好）；SyncEvent 二级判别（`type:"sync"`+`name`）需手写分派。
- 鉴权/绑定：默认 127.0.0.1 + 可选 Basic auth，原生端比浏览器更简单。

### D.2 硬缺口（开工前必补）

1. **启动握手**（server 侧新增）：原生壳 spawn `chimera serve` 时需要 AA 式"loopback + 随机 token + 机器可读端口回读"（当前只有 stdout 文本，`serve.ts:20`；port=0 时端口非确定）。
2. **SSE 客户端**（Swift 自写）：帧格式 `data: <GlobalEvent JSON>`（无 event/id 字段），心跳 10s、event-gap 需 resync——参照 `newweb/src/api/events.ts`+`sse.ts` 重写。
3. **PTY WS 客户端**（Swift 自写）：ticket 单次消费 60s TTL、原始字节帧、resize 走 REST 而非 WS——参照 `newweb/src/api/pty.ts`+`Terminal.tsx` 重写。

### D.3 设计约束

- **内存纪律是一等约束**（codex app 几个会话 2-3GB 是反面教材）：Swift 原生 + 系统 WebView 最小化使用；目标单体常驻远低于 Electron 方案。
- 架构照 AA 模式：GUI 壳 + 内嵌/旁挂 server 进程 + 能力探测桥；**直接消费 server API，不做第二份 UI 拷贝**。
- macOS Swift(SwiftUI/AppKit 待定）→ Linux/KDE Qt 随后 → Windows 暂缓。

### D.4 IM 模式验证（2026-10-10 实测，用户直觉"这本质是 IM"的数据验证）

**负载参数**（全局库 2.69GB / 2,297 会话 / 480k parts 实测）：

| 维度 | 实测 |
|---|---|
| 列表页全量 | ~200KB（2,297 会话，行均 87B） |
| 会话首屏 | p90 ~100-330KB，尾部尖峰 10MB |
| 全量载入 p99 会话 | 6.6MB JSON ≈ 内存 15-20MB |
| 首屏+分页 | <1.5MB（与全量载入差 10-20×） |
| part 落盘速率 | 0.2-0.8/s，fan-out 峰值 4.8/s |
| SSE delta | 推断 30-100 events/s/活跃流（库不存 delta，需服务端埋点实测） |
| 父子会话树 | 191 父 / 1,607 子，单父 max 229 子 |
| 单 part | p99 32.6KB / max 9.9MB；单 message max 1MB（内嵌 diff，须单独驱逐） |

**结论**：IM 纪律（服务端权威+客户端缓存视图、只挂当前会话流、分页+虚拟化、seq 游标补齐）在本负载下完全可行——codex/Claude 的 2-3GB 是违反这些纪律（Electron+全量驻留）的结果，不是问题固有难度。

**Server 侧 IM 化补全清单**（按价值排序，均为小改动）：① SSE 信封加单调 seq + `after=`/Last-Event-ID 增量续拉（含 transient 事件；现有 `/sync/history` 只覆盖 durable）② SSE 服务端 sessionID 过滤（列表页 1 条流+详情页复用；实例流无上限且每连接持 lease 需收敛）③ 列表摘要三件套 lastMessagePreview/unreadCount/busy（`Session.Info.summary` 现为 diff 统计而非消息摘要）④ `GET /session/:id/tree` 聚合（现状 N+1 次 children）⑤ part 分页 + 修 `limit=0` 返回全量的危险默认（`handlers/session.ts:170-172`）⑥ 修跨项目列表游标（`handlers/experimental.ts:137` 裸时间戳同毫秒会漏/重）。

### D.5 IM 纪律规格（Telegram-iOS × Synapse 调研结论，2026-10-10，11 路专项）

**定位声明**：IM 是参照模型不是目标架构（用户拍板）——chimera 保持 server 内嵌 agent 循环，以下是把成熟 IM 的纪律"贴"到现有架构上的规格。agent-as-client 改造面已测绘（边界在 SessionProcessor/LLM/Snapshot/Permission/SessionRunState 一圈，SessionTurnLease 可复用为会话租约），仅作档案，不在路线图内。

**协议侧规格（server）：**

1. **seq 游标**：全局单调 seq，做成不透明可版本化 token（`v1:<n>`，将来可扩多域）；服务端权威下发，客户端从不自增；连续性判定用精确等式（`新游标−步进==当前游标`，`>` 即缺口非成功）；每 session 独立游标（TG channel 模式），缺口互不阻塞。
2. **after= 增量恢复**：幂等拉取 + 分页 slice + after 太旧时明确降级"全量 reset"信号；响应三件套 `next_seq`/`limited`/`gap_from`；transient 事件（part.delta）与 durable 都要覆盖；token 容错三件套=非法报错/超前钳制/无新事件响应不缓存（防热循环）。
3. **缺口处理**：发现 gap → 暂存后续事件 + 短窗口补拉，补齐前不推进消费游标（TG）；gap 可作一等公民持久化（Synapse timeline_gaps 表）；compaction/中断产生的历史空洞不应静默显示为连续。
4. **分页**:keyset 分页 + `(session_id, seq)` 复合索引，禁 OFFSET；游标不对称语义写死（from inclusive/to exclusive，下一页游标指向边界外）。
5. **服务端过滤**：正负列表+通配符谓词，订阅时编译成 predicate，序列化前过滤+全屏蔽短路；内联参数+编译结果缓存，不做持久 filter 表（同机单客户端不需要）。
6. **未读模型**：事件写入时预计算标记（完成/待批/出错），非查询时现算；每会话一个单调已读游标（防回退）+ 增量计数器 + 对账逃生阀（计数与游标对不上→全量重算）；三档分离=未读/待办角标（需人介入）/高亮（出错），角标只由待办驱动；通知按"会话+已读位置"精确清除。
7. **列表摘要**：持久化轻量排序索引（session→{last_event_index,pin/folder}），列表页只读索引窗口 O(window)；消息到达产生 operation 增量 patch，禁止整表重排；忙碌等高频瞬态走独立通道不进索引。
8. **内存纪律**（Synapse 反面教材）：缓存一律字节预算+内存压力主动驱逐（Synapse 按条目数+默认关驱逐=吃内存主因）；冷数据留 DB，内存只放热工作集；SQLite 单写者纪律，sidecar 只能只读连接+变更流订阅（Synapse 多 writer 靠 Postgres，学不得）。

**客户端侧规格（原生 GUI）：**

1. **稀疏缓存+hole 模型**（Postbox）：本地只存已拉窗口+显式空洞，空洞决定下次向 server 要什么；默认不全量驻留（实测全量 p99 会话=内存 15-20MB vs 首屏分页 <1.5MB）。
2. **单串行写队列+事务合批**（Postbox）：事务闭包内只改内存、commit 一次落盘、prepared statement 复用；读走同队列异步回推 UI，UI 线程零 DB 开销；SQLite 配 WAL + synchronous=NORMAL + mmap 保守（Postbox 显式 mmap_size=0）。
3. **缓存故意简单**（Postbox）：表级无界字典+显式全量清空+版本失效（内存警告/外部写入时一次性丢弃）；缓存是可丢弃加速层，正确性由持久层保证，不过度设计 LRU。
4. **消息列表**（TG）：44 条/页、可见区距边界 5 条内触发翻页、跳到未读/最新/恢复滚动位置为内建能力。
5. **渲染纪律**（TG）：测量与提交分离（后台测量+主线程提交）；布局按输入指纹缓存（指纹不变零重算）；stableId 最小 diff+串行事务单飞+stationary 锚点（流式更新只动变化的行，不整表重建）；离屏 20pt 整棵子树释放，visibility 门控懒加载（不可见不拉取不动画）。
6. **流式 reveal**（TG TextRevealController）：按到达速率 EWMA 预测+匀速揭示，只在尺寸变化时重排——消除 token 到达抖动的跳变感，对 agent 流式直接可用。

---

## 验证基线（预期测试点）

每项改动的 DoD 除代码外必须包含本节对应测试点的实测结果；审计时逐项核对，**缺测 = 未完成**。基线数字取自 2026-10-10 实测（见 B.1 / D.4）。

### A 线（解环）

通用门禁（每刀必过，缺一不可）：
- `bun typecheck`（packages/chimera）全绿
- A.3 表所列 focused `bun test --timeout 30000` 全绿
- SCC 复算（`sim3.ts` 删边模拟脚本）达到该刀预期值；**不降 = 该刀无效**，按 A.4 反作弊条款不计进展
- `chimera serve` 冒烟：启动 + 列 session + 建立一条 SSE 连接

各刀专项：

| 刀 | 专项测试点 |
|---|---|
| A1 | test/plugin；真实插件加载冒烟（验证组合根注入路径） |
| A2 | `bun run db` 迁移生成零 diff；OpenAPI spec 改前改后字节对比一致；test/session + memory + storage |
| A3 | typecheck（纯机械搬迁，无行为面） |
| A4 | test/effect；`chimera run` 一次真实任务冒烟（组合根装配错误只在启动/运行时暴露） |
| A5 | test/tool；一次真实工具调用链路冒烟 |
| A6 | test/server；OpenAPI spec 字节对比一致；每组落地后 SCC 复算，不动则停手复盘（防审计化妆品） |
| A7 | 全量测试 + `bun run build --single --skip-install` 打包验证包边界 |

### B 线（减重）

测量纪律：peak 用 `time -l`，稳态 RSS 用 `ps`，堆用 `OPENCODE_AUTO_HEAP_SNAPSHOT`；每刀前后同机同场景各测一次，数字写进提交说明。

| 刀 | 测试点 | 预期 |
|---|---|---|
| B1 | `chimera web` 开 ≥2 项目空闲后 RSS 复测；test/graph 图查询正确性 | 空闲项目连接释放，RSS 回落 |
| B2 | test/graph + test/storage；219 文件索引场景 peak 复测 | 功能不变，peak 低于基线 571MB |
| B3 | p99 会话（6.6MB JSON）打开冒烟；test/session | 首屏驻留 <1.5MB，分页行为正确 |
| B4 | 长跑 agent run 压测 + 堆 snapshot 对比 | 无单调增长点 |
| B5 | 多语言 `chimera graph index` 后 RSS 复测 | grammar 释放，RSS 回落 |
| 总验收 | 常驻 `chimera web` 连续 16h | RSS <500MB（基线 1.5GB / peak 4.1GB） |

### C 线（WebUI）

- 所有改动过 newweb 自身测试（遵其 AGENTS.md：localStorage polyfill / store mocks / drift-guard 基线）+ `dist/` build 成功
- barrel 拆除：传播链深度复测（14-16 层 → ≤2，除通用 util）；typecheck
- god file 每批次：对应页面渲染冒烟（DiffViewer / InputBox / SidePanel / FileExplorer / Terminal / SessionList / ChatPane）
- 权限统一：手工场景清单——允许 / 拒绝 / 始终允许 / 问答 / 超时，合并后单入口各过一遍
- onboarding：零 provider 冷启动实测（全新配置目录），含无目录 scope 下 provider 路由行为（风险点，须实测记录）
- 潮酷样式：视觉快照基线建立后才允许动样式；之后每次样式改动过快照 diff

### D 线（原生 GUI）

server 补全 6 项各配 API 契约测试：

| 项 | 测试点 |
|---|---|
| seq + `after=` | seq 全局单调；断连后 `after=` 补拉不丢不重；after 太旧返回明确 reset 信号 |
| SSE sessionID 过滤 | 过滤连接只收目标会话事件；列表流 + 详情流并存不互相放大 |
| 摘要三件套 | lastMessagePreview / unreadCount / busy 存在且与会话真实状态一致 |
| `/session/:id/tree` | 一次请求返回完整父子树（用单父 229 子的最大会话实测） |
| part 分页 | `limit=0` 不再返回全量（拒绝或显式语义）；分页边界正确 |
| 列表游标 | 同毫秒时间戳跨项目翻页不丢不重 |

客户端：
- 启动握手：spawn `chimera serve` → 机器可读端口/token 回读 → REST 调用 200
- SSE 客户端：fault injection 断线重连，`after=` 补拉不丢不重
- PTY：ticket 单次消费、60s TTL 过期拒绝、resize 走 REST
- GUI 内存基线：常驻 RSS 首测写入验收记录（对照 codex app 2-3GB 反面教材，目标量级 <500MB）

---

## 路线图（开工后）

```
W1 止血（1-2 周）  : A1 解环第一刀 + A2 schema 下沉 | B1-B5 五刀 | check-layering 门禁上闸（oxlint 证伪后前置）
W2 立规（2-3 周）  : A4 组合根 L6 | SCC 门禁脚本进 CI | C.3 onboarding + C.1 barrel 拆除
W3 收口（3-4 周）  : A5 tool 端口 + A6 server 门面 | R3 开闸验证 | god file 批次 ①-③
W4 开路（并行）    : D.2 启动握手 + Swift MVP（SSE/WS 客户端）
```

依赖关系：战线 A/B 是地基（GUI 也连这个 server）；C 可并行；D 在握手就绪后启动。每个 W 的 DoD 含「验证基线」节对应测试点，缺测不计完成。

## 变更面跟踪（计划落笔后的新变更）

计划定稿（2026-10-10 15:15 +08:00，commit e6c901b4d）后两个仓的新增变更，及对各战线的影响：

| 时间 | 变更 | 对计划的影响 |
|---|---|---|
| 10-10 15:14 | newweb `35512534` SessionStatusPanel 进程面板 + `67f28825` 工具参数流式预览（配 server 端 `8e396af01`） | **部分推进 C.2 潮酷纪律第 3 条**（流式增量渲染已在 message 链路落地，TG TextReveal 式平滑仍未做）；DefaultRenderer(+92)/messageStore(+47)/ToolPartView 体积增长，C.1 god file 解构蓝图的行数基线以开工时实测为准；流式渲染客户端纪律与 D.5 客户端侧规格第 5/6 条同向，webui 可作为 GUI 的参照实现 |
| 10-10 15:29 / 16:02 | `4b545f733` + `1db73d775`：内建 `/goal` slash 命令（command/index.ts + session/prompt.ts 命令分发 + goal.test.ts） | session/prompt.ts（L4 编排）与 command（L3）新增边，**A 线开工前须重测 SCC 基线**；`/command` 列表新增项对 D 线 GUI 客户端可见（斜杠命令自动完成面） |
| 10-10 12:35 | `b86962078` progressive tool disclosure phase 2（tool-search 揭示不再动 wire 数组，走 runtime-context 尾段） | 计划写作期间落笔；session/llm 运行时面变更，同样计入 SCC 基线复测范围 |
| 10-10 16:30 | **W1 开工**：基线复测 file-SCC 246 / module-SCC 36 / 283 环边，与上午基线一致（`/goal` 两笔未漂移基线）；A1 删边模拟 246→154 再确认。oxlint `import/no-cycle` 证伪（stub 规则），A.4 门禁改为自研 check-layering.ts 前置到 W1 | 执行中 |

**基线复测条款**：A.1 的 SCC 数字（246/36/283）与 B.1 的内存数字（1.5GB/4.1GB）均为 2026-10-10 上午实测；每线开工当天用同一脚本/同一测量法复测一遍，以新基线验收。

---

## 开放问题

- 起步战线顺序（用户："等我再看看"）。
- 潮酷改造范围：渐进纪律化 vs 全面重设计 vs 留给原生 GUI（研究中，codex app 逆向为备选）。
- Windows GUI 策略（暂缓）。
- graph 独立成包的时点（建议 A 线收口后）。
- LSP/Chromium 是否纳入常驻内存预算。

## 附录：调查溯源

| 报告 | task_id（可 resume） |
|---|---|
| dsh webui | ses_edc58c30fffem3RIhlgZv8lDE3 |
| AA web-next | ses_edc58c2f8ffeuo16JU3F01pd8f |
| newweb 现状 | ses_edc58a1f6ffeglMh1JOfPwA5Mi |
| AA desktop GUI | ses_edc55a8c4ffe89tFxXNi53FWUf |
| onboarding 链路 | ses_edc556f26ffe3vEIgId2pKyUIQ |
| newweb god file 解构蓝图 | ses_edc35c88fffehiaHmXiySugup9 |
| chimera 核心传播分析 | ses_edc359b7effeigZ4F79znH4hDe |
| 原生 GUI API 评估 | ses_edc3561aaffeliY1jP6C3lbV32 |
| Rust 化盘点 | ses_edc352791ffe1Cpt0KN4YaMGvK |
| 内存实测 | ses_edc360454ffeYK7sTHqqLg5q1F |
| codex 设计语言 | ses_edc22bd67ffesSzQNG1NJ4KPMb |
| 解环切割集 | ses_edc1d56a6ffeJFnZ6KRI0zdQyg |
| 目标分层设计 | ses_edc1d0320ffeph81twzLdNS0aY |

既有相关文档：`RUST_MIGRATION_PLAN.md`、`UPSTREAM_RUST_KERNEL_PLAN.md`、`WEBUI_CHIMERA_ADAPTATION_PLAN.md`、`packages/chimera/specs/effect/server-package.md`、`cbench/rust-plan/R3_PROPOSAL.md`。
