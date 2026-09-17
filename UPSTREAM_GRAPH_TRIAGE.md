# 上游 codegraph 同步分诊明细（方向③追踪文档）

制定：2026-09-08。方法：7 个并行只读分诊代理（5 reviewer 判断组 qwen3.8-max medium + 2 scout 筛选组 deepseek-v4-flash low）+ root 汇总对账。
范围：上游 `/Volumes/workspace/codegraph`（**严格只读、禁 fetch**；HEAD=`6a056ec5`，2026-08-26，CHANGELOG 1.6.0）功能级同步点 `a5a8942`（#1318，2026-07-16）..HEAD = **197 commits（含 merge）/ 枚举口径 179 条（--no-merges）**。as-of 2026-08-26（禁 fetch，此为漂移上界）。
类型分布：fix 52 / docs 45 / feat 32 / test 21 / perf 19 / 其他 6 + 3 条 CG-xx 非规范前缀。安全关键词命中 1（WAL 无界泄漏 #1431/#1490）；行为关键词（crash/hang/loss/corrupt/race）命中 12（已全部组内消化定级）。
五分类口径沿用 F 线：①直接可移植 / ②需适配 / ③fork 已等价 / ④无关 / ⑤已同步。所有 ①②⑤ 判定均经 `git grep <关键内容> HEAD` 上游终态验证（F1 坑 #1 纪律），**零回退命中**；已知回退对：`d652c14`（伪 docs 实为 CG-30 -179 行回退）已被 `cd1ea27` 恢复，HEAD 终态在位。

## 1. 总览与对账

| 组 | 范围 | 条数 | ① | ② | ③ | ④ | ⑤ |
|---|---|---|---|---|---|---|---|
| R1 | kernel/resolution/union | 27 | 1 | 16 | 0 | 9 | 1 |
| R2 | explore/mcp/search/retrieval/synthesis+deprioritize | 26 | 2 | 23 | 0 | 1 | 0 |
| R3 | db/store/sync/scale+稳定性安全 | 11 | 0 | 9 | 0 | 2 | 0 |
| R4 | perf 全部 | 19 | 1 | 6 | 0 | 11 | 1 |
| R5 | extraction+语言面 | 13 | 4 | 8 | 0 | 1 | 0 |
| S1 | installer/cli/telemetry/chore | 17 | 0 | 3 | 0 | 14 | 0 |
| S2 | docs 45 + test 21 | 66 | 0 | 3 | 0 | 63 | 0 |
| **总计** | | **179** | **8** | **68** | **0** | **101** | **2** |

（③ 无整条命中：81e1f4a#1556≈cfe8410ee、238dbc5 camelCase 半侧≈fork search_text 拆词、7cc2366 keyset 半侧、c74e8b0 scoped sync 半侧等 ③ 级子项均折入所属 ② 条目。S1 的 2 个 [拍板] 项归一化：0d17dfd→②、49c11fc→④。）
（⑤ 2 条：6e52295 #1332 WAL containment→batch1+2 a0229e996 吸收；a2f3c31 #1320 defer checkpoints→同。残余 P2：fork synthesizeCallbackEdges 大批插入前无 backpressure 调用，可选 1-3 行加固。）

## 2. fork 结构性事实（决定 101 条 ④ 的根因，全部经实查）

1. **fork 是 wasm-only 形态**：无 napi-rs native kernel（`codegraph-kernel/`）、无 store-worker/store-writer（SQLite store 主线程单写者是有意设计）、无 resolver-pool 家族（resolver-pool/resolver-worker/memory-budget；resolution 全主线程 + 自有流式 batch）。上游 kernel 战役（R1-R7 walker 系列）、pool 系 perf、bulk-index heal、store 线程面全部无宿主。
2. **fork 双消费面**：agent 面 `chimera_search/chimera_impact/chimera_file_symbols/chimera_context`（src/tool/chimera.ts→codegraph-adapter）+ MCP 面 `src/graph/mcp/tools.ts`（chimera graph serve --mcp）。上游 CG 预算分配史诗的输出质量改进**只落 MCP 面**（agent 面不回传整段源码、无字节信封分配问题）；retrieval/context 类修复同时落两面。
3. **fork resolution/context 面系统性落后上游 baseline**：name-matcher.ts 734 行（上游 HEAD 2660）、import-resolver.ts 1308（上游 2291）、callback-synthesizer ~1300（上游 3700+）；缺 #825 Container::member、#1292 instance inference、#754 supertype 走链、#810 methodMatchCache、#954 c-fnptr、#1109 receiver-inference、#708 Lua require、#720 projectNameTokens（fork 已删）。
4. **fork c-cpp.ts 严重落后**：163 行 vs 上游 baseline 时点已 841 行——pre-baseline macro blanking 基础（#1159/#1207）全缺；c/cpp 语法走 tree-sitter-wasms ^0.1.11 的 2023-era 构建。
5. **基线前缺口账本（横切发现，需单独立账）**：fork extraction/resolution 面缺失多个 **<a5a8942** 的上游机制——function-ref 捕获面（#807，2026-06-11）、matchGoFieldChainCall（#1276）、blankCppExportMacros 系（#1159/#1207）、`.metal`/`.cu` 扩展名映射、`?? dir/` embedded-repo 递归、c-fnptr-synthesizer（ba209d9 #932/#954）。说明 fork extraction 实际分叉点早于宣称基线或有有意裁剪——**这些不在 179 窗口内**，是 ② 类条目的隐形前置。
6. **休眠资产**：schema v9 `name_segment_vocab` 表、v11 `files.generated` 列均无读写方（cb2172ed0 只铺了 schema）；CLI 头注广告了 `chimera context <task>` 但命令未注册。

## 3. P 级清单（crash/hang/loss/corrupt/race/安全）

**P1（8 条）**：
| 条目 | 性质 | fork 暴露判定 |
|---|---|---|
| `340d4b0` Swift Vapor 路由 regex 灾难性回溯（#1547） | hang（内容触发，30 args=41.7s） | **同病逐字存在**（frameworks/swift.ts 歧义形 regex），1 行修复 |
| `474f051` tsconfig extends 路径别名（#1534） | loss（Nx 型 monorepo 跨包 import 静默丢边） | **同病**（path-aliases.ts 与上游修复前逐字节相同） |
| `02c0e2c` WAL 无界泄漏（#1431/#1490，安全横切唯一命中） | 磁盘 DoS（数十 GB 级残留） | 部分免疫（fork WAL defer+finally TRUNCATE），SIGKILL 残留与长驻 PASSIVE-only 增长两路仍暴露 |
| `8c1e821`+`ca88d3b#1` valve file-cap+barrier TRUNCATE+futility latch（#1334/#1335） | 磁盘 DoS（bulk 期 WAL 文件无界，上游实测 22GB/EXIT=137） | 同病（fork valve 停在 #1231 形态：PASSIVE-only 无 file-size 触发器）；**约束：按 HEAD barrier-only 终态，勿带 #1334 timer-truncate（race）与 #1339 动态 soft（清单外）** |
| `d8f2eea` unresolved-ref loop-append+salvage 可见（#1558/#1576） | crash（spread 超 V8 实参上限中断 resolution） | **同病更锐**（`rows.push(...chunkRows)` 原样 + 缺 #540 输入分块 + fork cfe8410ee merge sync 放大触发面） |
| `03893b0` CG-33 增量 sync 与全量重建收敛 | corrupt（silent 持久 edge drift，上游自测 4.3% 双向错边） | 同病（getNodesByName 无 ORDER BY / 无 definitionDelta）；**chimera_impact/audit 直接消费被污染边** |
| `f2a5df3` 漂移文件禁供错切符号体（#1474/#1492） | corrupt（isError:false 名义供应别的符号代码体） | 同病且更宽（cross-project projectPath 无 watcher 正是主发场景）；可独立于 CG 史诗先行 |
| `c74e8b0`（debounce 半侧）watcher quick-fire（#1397） | 产品体验（save→可查 2.5-6s→0.6s） | 同病（fork 固定 2s debounce；agent 会话 watcher 常开放大此项价值） |

**P2 要目**：`278a8ed` object-literal 成员调用丢边；union 链 5 条（C/C++/Rust 图谱正确性）；`2d72891` C/C++ macro blanking（fork 暴露更重：连前置基础都缺）；`ca88d3b#4` parse 池 cpuset 超订/2 核欠配（**fork 双重落后**：os.cpus() + 无 floor）；`cf1b0e3` watcher scope 不随 .gitignore/codegraph.json 刷新；`81e1f4a` #1555 parse budget 无 cap（hang 窗口）/#1553 daemon PID 重用 race/#1557 failure marker 不持久（重复解析）；`57e0854`+`16e1749` generated 检测全盲（schema 休眠）；`c74e8b0` needsFullScan 半侧（目录删除滞留节点）；`d1b75a1` dart wasm unpinned github dep（供应链）；`7cc2366` per-batch COUNT O(N²)；bulk-index 窗口三件套。

## 4. 跨组配对与硬依赖（拆单即错）

1. **union 整链（5+1 条）**：基座 `6978acc`（R5）+ `85e9ac6`（R5，HEAD 形态已被 6978acc 重构，**合并取 HEAD 终态一次移植**）+ 增量 `8e3cde6`/`e922563`/`e219594`/`5b0c4b8`（R1）+ 测试 `11acc50`（S2）。涟漪面：NODE_KINDS→chimera_* 工具 schema 自动派生 + `chimera_*.txt` 描述硬编码 kind 列表须同改（fork AGENTS.md 规则）+ mcp CONTAINER_NODE_KINDS + CodePlan 审计规则同权问题[拍板-B]。
2. **generated-file 检测配对**：`16e1749`（CG-5 本体，R5）+ `57e0854`（Wrangler banner 增量，R2）必须同一工作项；激活休眠 v11 `files.generated` 列；重索引语义（needsMigration 姿态兼容）。
3. **valve/WAL 成套**：`02c0e2c`（journal_size_limit+healOversizedWal，独立）→ `8c1e821`+`ca88d3b#1`+`2adc7f6` 终态约束（一次 valve 移植）→ `7cc2366` db-scaled soft cap **必须与 ca88d3b#1 file cap 成套**（否则 2GB soft 下文件无界）。
4. **d8f2eea 与既定预留 sync ref-retry 合并实施**（同函数面 getRetryableFailedReferences 一次触碰）。
5. **CG-33 收敛三件**：`03893b0`+`02ee151`（测试，fork 无 CodeGraph.recreate 需等价物）+`2cf63fd`（drift diff 工具→移植前后测量验收器，数据根改 .chimera）。
6. **CG 预算分配史诗（16 条，R2-B 包）**：b37f191（诊断地基，env 门控可先行）/a3898cd/5f7f5f5/fa7fb8d/fca7d87/fc31b1e/ab38d1f/765c06a+cd1ea27（回退恢复对，取 HEAD）/089dcc2/f1fecb8/c54e008/7cbde95/9efae0f/eed1644/89c53dd + S2 测试 `1d9206d`/`bd86ad2`。**独立战役**（新模块 ~1430 行 + tools.ts 三方合并：上游 HEAD × fork skeleton/adaptive/TINY_REPO 改造 × 双消费面约束，~3500+ 行）；`f2a5df3` P1 守卫**可解耦先行**。边界不变量警报：上游 explore-diagnostics 用 logDebug，fork 必须换 defaultLogger/stderr（坑 #10 TLA 链）。
7. **watcher 面同文件**：`c74e8b0`（debounce+needsFullScan）与 `cf1b0e3`（scope 刷新）都动 sync/watcher.ts——同批或串行。
8. **238dbc5+ccb0295 合并**：取 HEAD 终态 query-paths.ts（287 行，已含 kebab 增量），不逐 commit 重放。
9. **C/C++ 面依赖梯**：`44561b6`（现代 grammar vendoring，地基）→ `d618d94`（含补 #1159/#1207 基线前宏分支）→ `2d72891`（需先补 c-cpp.ts pre-baseline 基础 ~700 行，backlog）→ `b9d0f57`（C deferral round2 战役，缓议）。
10. **9 条 wasm grammar vendoring（R1 拍板-A 包）**：c5eebe6(TS/TSX/JS)/03d54e4(Java)/c2503e2(Python+Go)/f1ca991(Rust)/1909931(Ruby)/a6c62d7(PHP)/09e301b(Swift)/45a53eb(Kotlin)/d1b75a1(Dart pin)——与 44561b6(c/cpp) 同机制（VENDORED_GRAMMAR_LANGUAGES + binary 拷贝），**建议与 G4 合并一次落地、一次 EXTRACTION_VERSION bump、一次重索引提示**。

## 5. 待产品拍板（16 项，集中一轮过；每项带建议）

| # | 拍板点 | 建议 |
|---|---|---|
| A | grammar pin 策略：9+2 条 wasm vendoring 打包替换 tree-sitter-wasms 2023-era 构建（改解析输出→EXTRACTION_VERSION bump+重索引；含 dart 供应链 pin） | **采纳**，与 G4 一次落地 |
| B | union 一等 NodeKind 整链立项（涟漪：chimera_* 工具 schema、CodePlan 是否给 union 与 struct 同权） | **采纳**；CodePlan 同权 |
| C | 278a8ed：简化钩子直移 vs 先补 #825/#1292 基础层 | 简化钩子先收益，基础层入 backlog |
| D | resolver-pool 并行合成家族（#1305/#1333 及 8 条挂在其上的 perf） | **暂不移植**；触发线：真实项目 >100k refs 索引常态 >60s 再整体评估 |
| E | rust kernel + store-worker 家族 | **不移植**（wasm-only/主线程单写者是既定架构分叉） |
| F | function-ref 捕获面（基线前 #807 系 + 38580e0 Python 扩展；回调注册点进 callers/impact，上游实测 +559 边） | **独立战役立项**（agent 代码理解高频盲区，值得） |
| G | C deferral 战役（2d72891 round1 + b9d0f57 round2 + c-cpp 基础补齐 ~700 行，XL） | **缓议**；仅先落 44561b6；待真实大 C 仓需求 |
| H | deprioritize 配置（1d9de88，与 includeIgnored 同文件同机制） | **采纳**；#720 projectNameTokens 另案勿捆绑 |
| I | 238dbc5 机制映射：上游 identifier-segments+vocab 激活 vs fork search_text 拆词认定为长期等价机制 | 后者——只移植路径钉住+变量种子；休眠 vocab 表继续休眠 |
| J | a5c2709 MCP workspace 根发现/单子项目收养 | 分两步：#1607 诊断出声先落（低风险），#1606 自动收养后议 |
| K | 自托管 telemetry（49c11fc，7.7k 行 Cloudflare D1+dashboard） | **不移植**（fork telemetry 姿态未定） |
| L | 非交互 bootstrap（0d17dfd：init --yes + install --init 链式） | 借鉴落地（CI/容器语义，~50 行） |
| M | erlang 语言面新增（41c1075 宿主） | 不立项（如未来要，按 HEAD 终态整体引入） |
| N | salvage 可见性 CLI 面（d8f2eea 后半：chimera graph index 输出警告+errors.log） | 照上游做用户可见警告 |
| O | env 命名姿态（CODEGRAPH_WAL_HEAL_MB 等沿用上游名 vs CHIMERA_ 别名） | 沿用上游名最小化 diff（fork 已有双轨先例），需要时后补别名 |
| P | explore CG 预算史诗（16 条，~1-2 周独立战役）是否立项与排期 | 立项但**排后**；f2a5df3（P1）+b37f191（诊断）解耦先行 |

## 6. 批次建议（拍板后执行；规模为含测试粗估）

- **G0 立即小修批（~1 天，无拍板依赖）**：`340d4b0`(1 行 P1) + `cc9ce09`(2 行) + `9219967`(15 行, django 实测 49.9ms→0.17ms) + `b8833fe`(1 行) + `474f051`(P1, ~160 行+182 行测试) + ⑤残余可选加固（synth 边插入前 backpressure，1-3 行）
- **G1 WAL+收敛稳定性战役（~3-5 天，P1×4）**：02c0e2c → 8c1e821+ca88d3b#1（含 2adc7f6 约束）→ ca88d3b#4 → d8f2eea（合并 ref-retry 预留，含拍板 N）→ 03893b0+02ee151+2cf63fd（先跑 drift 基线）
- **G2 watcher 面（~1-2 天）**：c74e8b0 双侧（debounce P1 + needsFullScan）+ cf1b0e3 + 81e1f4a 三小组分（#1555/#1553/#1557，fork DaemonHello 字段已同构）
- **G3 检索/上下文质量轻量批（~2-3 天）**：f6ac7b3 + 1de7e8f（双消费面受益）+ 238dbc5/ccb0295（拍板 I 后）+ 2962e7e（语言声明，数字按 fork 实际 grammar 面）+ 082ea65（prefilter/memo 三项，fork 永远 sequential 收益全额）+ a5c2709 第一步
- **G4 语法与语言精度批（~2-3 天，拍板 A/B 后）**：44561b6 → d618d94 → 12f7a59 → 7963672 → union 合并项（6 条）→ 9 条 wasm vendoring 打包（一次 EXTRACTION_VERSION bump）→ 26045b3 适用两段（salvage warning + zero-node 自愈，排除名单对齐 fork isFileLevelOnlyLanguage）
- **G5 generated 检测（~1-2 天）**：16e1749+57e0854 配对（激活 v11 列；消费面三处对齐）
- **G6 explore CG 史诗（独立战役 ~1-2 周，拍板 P）**：b37f191+f2a5df3 先行件 → 16 条包取 HEAD 终态三方合并 → 1d9206d/bd86ad2 测试
- **G7 perf 批（~2-3 天，G1 后）**：bulk-windows 三合一（567b4ad+f6d8e8f+ce0ae30，DDL 源换 loadInitialSchema、fresh gate 用 before 计数、finally 重建在 synthesize 之前）+ 7cc2366（changes guard + db-scaled valve，与 G1 成套校验）
- **G8 CLI/installer 小件（~1 天）**：c382225（context 命令注册，消灭广告-实现差异）+ 0682137（claude.cmd Windows）+ 0d17dfd（拍板 L）
- **Backlog（不排期，立账）**：基线前缺口账本（§2.5 全部：function-ref #807 系[拍板 F 战役]/matchGoFieldChainCall #1276/blankCppExportMacros #1159/#1207（并入 G4 d618d94 部分覆盖）/.metal/.cu 映射（并入 G4 44561b6）/?? dir/ embedded 递归/c-fnptr ba209d9/#825/#1292/#720）；resolver-pool 触发线（拍板 D）；C deferral 战役（拍板 G）；erlang（拍板 M）；a5c2709 第二步收养（拍板 J）；CG 史诗后排（拍板 P）

依赖序：G0 随时 → G1 → G7（valve 成套）；G2 独立；G3 独立；G4（拍板 A/B）→ 部分前置 G 项；G5 独立；G6 最后（最大）；G8 独立。

## 7. 排除证据（④ 101 条组级归纳，hash 全清单见各组报告）

- **kernel 家族**（R1×9 + R4 关联 + R5 kernel hunk）：fork wasm-only，无 napi-rs/kernel buffers/walker/parity 面。838006c 栈溢出 guard 的上游 P1 在 fork 不暴露（wasm 路径 per-file try/catch 已同等保护）。
- **resolver-pool/store-worker 家族**（R4×8 主体）：基础 #1305/#1333 未移植，皮之不存；机制洞察（readers pin WAL）由 G1 valve 移植对冲。
- **Copilot installer 4 条 + codex project-local + toml trailing**（S1）：fork installer 目标集无 copilot（既定命名规范清理）、codex 语义刻意相反、toml 场景不触发。
- **docs 45**（S2）：fork 不搬上游文档面；其中 **18 条 [证据]** 保留引用（explore CG 系行为契约 A/B 记录、union 语义、WAL 边界、R7a port-checklist——G6/G4/G1 实施时的对照源，逐条 hash+关联主提交见 S2 报告）。
- **test 中的 agent-eval 基建 18 条**（S2）：上游 explore 评测 harness（CG-7/8/9/11/13/15 测量系），fork 无对应评测面；若未来自建以自己基建为准。
- **chore/release/ci/measure/changelog 6 条**：上游版本与 CI 面独立。
- **41c1075 erlang**：语言面在 fork 不存在（拍板 M）。

## 8. 来源与已知局限

- 7 份组报告全文（会话 tool-output）：R1=tool_0842db4a2003SjEg1mCItqRmjk / R2=tool_0842bb0c2001ggq5vwmGWO3qoC / R3=tool_0842f323b001z74e3QEsmsatWw / R4=tool_0842d5719001C361R8ffQlE8fs / R5=tool_08426574b001JMdyHkbHR36UvQ / S1=tool_08417449c001KCah8PFMzwaCN8 / S2=tool_0841c6e82001iWo99mvOWOo0je；组清单文件 /tmp/graph-group-{R1..R5,S1,S2}.txt（临时，划分规则=类型优先+scope 正则+7 条人工纠偏）。
- 已知局限：① 禁 fetch——as-of 2026-08-26 后的上游演进不可见，下次开工前若上游仓可更新应重跑漂移核查命令（directions.md）；② fork name-matcher/tree-sitter 分叉程度按锚点抽查，②类实际移植冲突面可能大于估计（R5 剩余风险）；③ tree-sitter-wasms 0.1.11 内 c/cpp 语法版本未开箱验证（依据上游 commit 正文自证）；④ 基线前缺口账本未逐条量化（只立账）。
- 批次执行时沿用 F 线工作流 B：拆阶段以文件交集≈零为界（watcher.ts/tools.ts/queries.ts/extraction-index 是已知热点）、builder spec 带本文档对应节+组报告路径、每批 typecheck+test/graph 套件+对账、沉淀回写本文档勾选状态。

## 13. G1 WAL/并发稳定性扩容批完成记录（2026-09-17）

- **状态：✅ 完成**（8 commit f502c355d→1e54a46a0，每条带上游 sha；未 push 时点记录，随收口波次推送）。范围=原 G1 节（02c0e2c WAL 无界泄漏/8c1e821+ca88d3b#1 valve file-cap+barrier TRUNCATE/ca88d3b#4 parse 池 floor/d8f2eea loop-append）+漂移期扩容 5 条（9b8bb4aba fail-closed/58c07e874 edge 原子重绑（fork 形态：storeExtractionResult 单事务化）/1e4612375 legacy 锁两缺口/7440d2c47 第二写者 fail-fast（新 writer-lock.ts））。
- **不适用项（四层证据在 builder 报告③）**：72c1ff13c orphan-sweep（fork resolver 零 edges 表读+无内存队列，结构性安全）；1e4612375 registry/manager/probe 面（fork 无宿主）；9b8bb4aba sync 接线半侧（fork sync 不 defer autocheckpoint）；d8f2eea salvage 半侧（无 #1575 基建）；ca88d3b#2/#3（resolver-pool 家族无宿主）。
- **缓行项→独立批排期**：CG-33 收敛三件套（03893b0 ORDER BY+02ee151 definitionDelta+2cf63fd drift 测量工具）——文档自带“先跑 drift 基线”门槛且 ORDER BY 改变同名多定义选边与本批产物中立约束冲突；落地后 58c07e874/72c1ff13c 上游原生形态获宿主可复核归并。**G7 依赖序就绪**（7cc2366 db-scaled valve 与本批 file cap 成套）。
- **验证**：双进程并发 22/22（cbench/g1-wal/：双 CLI 同 index 仲裁/index+sync 共存/pinned-reader fail-closed WAL 峰值有界 2.15MB<4MB cap/对照组无误杀）；产物 parity 三场景 9600/21600 逐字节一致；聚焦 104/0+typecheck×5 绿；全量 5304 pass/25 fail==基线零新增；主仓重索引冒烟 integrity=ok（counts +21/+36=会话内容漂移，产物中立性双重钉住）。
- **行为变更入 release note**：WAL valve fail-closed（外部进程长期钉住 WAL 且超 cap 时 index 中止而非带病膨胀，错误文案含自救路径）；CHIMERA_INSTANCE_MEMORY_BUDGET_MB/CODEGRAPH_WAL_HEAL_MB/CODEGRAPH_WAL_VALVE_DEBUG 新 env。
