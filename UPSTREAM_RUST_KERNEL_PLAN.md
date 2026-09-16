# Rust 提取内核（codegraph-kernel）采纳计划

制定：2026-09-16。依据：双 reviewer 只读调研（上游侧 ses_f573518f / fork 侧 ses_f573487a，全部断言带 文件:行/commit 锚点）；用户拍板"Rust 核心改造优先"（推翻 UPSTREAM_GRAPH_TRIAGE.md 拍板 E 原建议）。
上游参照：`/Volumes/workspace/codegraph` @ `6a056ec`（2026-08-26，CHANGELOG 1.6.0，严格只读禁 fetch）。

## 1. 决策摘要

**采纳姿势：B 案绞杀者（strangler）**——kernel 作为可选提取路径整体平移上游机制（loader + contract_info 对账 + 逐文件 defer 回退 + CODEGRAPH_KERNEL kill switch + 逐语言路由白名单），从基建+工装做起，**逐语言过 fork 自建 parity gate 才开闸**，wasm 路径保留至终态可选删除。
**采纳动机（用户原话口径，2026-09-16）**：不是为加速——“这种东西用 Rust 实现起来更加方便些”。即提取层（AST 走树/文本处理/内存控制）属于 Rust 的舒适区：实现更直接、无 wasm 堆病理、类型系统兼得正确性；P0-1 实测墙钟收益仅 1.02-1.05× 不改变本计划优先级（§2.4）。

选 B 不选 A（全量换轨）的理由：
- 可逆性：kill switch 逐调用生效、按语言摘除路由即回滚；A 案语义对齐后回退需还原 TS 增强
- 语义换轨风险受控：kernel 的字节 parity 是对**上游** wasm 提取器建立的，不是对 fork——每路由一个语言 = 该语言图谱从 fork 语义切到上游 HEAD 语义，必须逐语言对账放行
- 与上游机制同构：上游 HEAD 本身就是 B 形态（DEFAULT_ROUTED 全 20 语言 + 逐文件 defer + 回退），平移而非发明

## 2. 关键事实（双调研对表结论）

### 2.1 kernel 范围与形态
- 只接管 parse worker 内的 **parse+extract 走树**，藏在既有 ExtractionResult 契约后；resolution/synthesis/frameworks/MCP/审计层全部不动（fork 侧验证：src/chimera 与 src/tool/chimera.ts 零处引用 extraction 内部）
- **同步调用设计**（上游明令禁止 Rust 侧重建池）→ fork 的 ParseWorkerPool 作为并行编排**保留**；wasm 病理对冲（recycle/crash budget/grammar watchdog）在 kernel 路径旁路
- napi8 cdylib，五表扁平 buffer ABI v2（meta 36B/node 96B/edge 44B/ref 40B/arena），`extraJson` 为任意 Node 属性的 JSON 逃生舱（decode 时 Object.assign 直通，零 ABI bump）
- **node id 公式与 fork generateNodeId 逐字节一致**（sha256(filePath:kind:name:line)[0..32] + kind 前缀；file 节点例外 `file:${path}`）——实查对账过
- 20 语言；不含 fork 独有 objc/pascal（永走 wasm 路由，天然共存）、不含 erlang/模板系（svelte/vue/liquid/mybatis/dfm 留 TS）

### 2.2 fork 自有提取语义 × kernel 对账表（核心风险面）

| fork 资产 | kernel 对应物 | 处置 |
|---|---|---|
| return_type 列（receiver 推断原料） | ⚠️ **实测修正（P0-2a smoke）**：layout 字段在位、go/python 产出，但 **tsjs walker 对 `async go(): Promise<string>` 不产出 returnType**（类型只在 signature 文本） | **tsjs returnType 进 P1 Rust 补丁清单**（与 params 同批）；其余语言 parity 对账 |
| **NODE_KINDS 表分歧（contract 门失败，路由硬前置）** | kernel=[…,import,export,route,component,union] vs fork=[…,statement,import,export,route,component]：**kernel 独有 union，fork 独有 statement**（fork 审计层 relation-clause/传播探针大量消费 stmt@ 节点） | 两条线：① union 链立项（拍板 B 已采纳，G4 残链提前）② **statement 存续策略调研中**（Rust 侧补发射 vs 替代方案）——对齐前 contract verify 恒失败，kernel 不可路由（P0 常态即此，降级链路已验证） |
| **params_json（0.5/0.5b 硬依赖）** | ❌ **无对应物**（python 仅拼进 signature 文本） | **Rust extraJson 补丁**（见 §3 P1）；TS 后处理不成立（post-pass 无树；二次 wasm parse 吃掉收益）；放弃=召回战役资产回退，不可接受 |
| TS 接口/type-alias 成员建节点 | ✅ 上游语义存在（tsjs/extractors.rs:847-855） | 对账 kind/qn 形态 + **flush 顺序语义**（fork 契约成员必须排同文件实现之后，first-match-by-name 消费方依赖；parity harness 含节点数组顺序断言） |
| 值位置引用 valueReferenceTypes | ✅ 上游语义存在（tsjs/mod.rs:416-514，`{"valueRef":true}`、VALUE_REF_LANGS=ts/tsx/js、20k 上限、CODEGRAPH_VALUE_REFS 开关） | 对账排除集细节（fork：≤2 字符/声明位/callee/import specifier/类型位/解构绑定排除 + per-file dedup + 对象字面量补收）；边 kind/metadata 形状映射 |
| signature/docstring/类型注解引用/instantiates | ✅ 均有对应面 | parity 对账（signature 文本形态漂移会使 MMS/MMB 分类假阳性——逐字节比对纳入 harness） |
| re-export 文件边 | 本就在 resolution 期（materializeFileLevelImportEdges） | 不受影响 |
| frameworks/* extract() 钩子（21 resolver，含 G0 刚修的 swift Vapor） | 上游留 TS 侧 merge pass | 保持 TS：kernel 出原始结果后 merge（fork 现架构本就是独立 merge 步）；唯一 extraction→resolution 耦合点，显式切割 |
| c/cpp preParse blanking | kernel 依赖 TS 侧 blanking 钩子先行 | **fork c-cpp.ts 缺 #1159/#1207 基础（163 行 vs 上游 841）**——c/cpp 路由的硬前置，排 P2 后 |

### 2.3 分发与构建（fork 约束全部有先例）
- .node 旁挂：grammar wasm 已随平台包 `bin/` 旁挂（execPath 相邻解析）；@parcel/watcher/node-pty 证明 bun compile 单二进制运行时 require napi .node 是既成模式（含 musl 变体先例）
- 缺口三项进展（P0-2a 实测）：① bun × napi-rs 3 五 Buffer smoke **PASS**（Buffer.isBuffer/ArrayBuffer backing/byteOffset=0 全验，TS/Python/Go 三语言 decode 正常，defer 探针正常）；② musl 交叉腿脚本映射已备（build-kernel.sh），实机验证待做；③ **.node 实测 33.6 MiB/平台**（超 10-30MB 估计 ~13%，分发矩阵按此规划）；host 构建 1m01s（rustc 1.98.1+clang 21）
- macOS 签名/inode 注意（build-kernel.sh:81-85：先 rm 再 cp 防签名缓存 SIGKILL）适用 darwin 平台包

### 2.4 性能预期（如实，不吹）
- 上游 headline（单 native 线程 4.4× 于整个 wasm 池）已被上游自测修正：dubbo-on-Mac 的墙是**单写者 SQLite ingest（94%）**；kernel 真实端到端收益在 CPU 受限信封 1.25-1.5×（2 核 CI：Linux kernel 树 26min→<12min 为 kernel+pool sizing 合并效果）
- fork 实测（P0-1 profile，2026-09-16，M2 8 核，3 次完整运行占比稳定）：**parse+extract 仅占墙钟 2-4%（~2.6s/110s），store ≈30%，resolution ≈51-56%**（store+resolution ≈81%，kernel 完全不触碰）→ **kernel 端到端预期 ≈1.02-1.05×**，受限核数信封在 fork 不会触发。单线程提取吞吐基线：411 文件/s、17.4k 节点/s（kernel parity harness 的对比基准）
- **kernel 对 fork 的价值排序因此改写**：① 鲁棒性（profile 附带实锤：wasm parse 池 recycle 期间歇挂死 3/8 次、冻结 >400s——kernel 路由消除该病理路径；已另派 TS 侧诊治批先行防护）② 上游对齐/可维护性 ③ function-ref 免费补齐 ④ #1581 SIGSEGV 栓守卫——**墙钟收益不在其中**。若未来要动 fork 端到端性能，目标是 store/resolution 的 SQLite 吞吐（上游 store-worker/direct-to-store 家族重新入选项评估范围，本计划不含）
- 战略收益（与性能无关）：提取层与上游 HEAD 对齐后，G4 grammar vendoring 动机消失、后续上游 kernel 演进按批同步、深嵌套栈守卫（#1581 SIGSEGV 级）等上游修复自动获得宿主

### 2.5 fork 缺 EXTRACTION_VERSION（必须同批新建）
- fork 无任何提取版本化失效机制（project_metadata 表休眠无调用方）；kernel 切换/升级/grammar 变更都会造成旧图谱静默陈旧
- P0 落地：提取版本键（挂 project_metadata，getMetadata/setMetadata 现成）+ 版本不符 needsReindex 报告（复用 GraphSchemaMigrationRequiredError 的 needsMigration 姿态）
- **已落地（P0-3，2026-09-16）**：`EXTRACTION_SEMANTICS_VERSION=1`（db/extraction-version.ts，独立于 schema version）；stamp 写入点 = **indexAll 成功收尾 ∪ 空库 sync**（实施中发现 chimera_init_graph/MCP 建库走 init+sync 而非 indexAll，只写 indexAll 会使工具面建的库永无 stamp；非空库 sync 永不写，防部分重提取谎报最新）；键缺失宽容不报警（存量库免假警报）；needsReindex 姿态接入 status/search/impact/file_symbols 四读面 + graph CLI status（text/json），chimera_status.txt 描述同步。kernel 路由/grammar/提取语义变更时按常量旁 bump 纪律抬版本

## 3. 阶段计划

### P0 基建与工装（先于任何路由，~1-1.5 周）
1. fork 侧 parse 段 profile（主仓 + 大仓样本；五桶计时），出收益上限报告
2. vendoring：crate 全量（MIT）+ build-kernel.sh + 上游 `src/extraction/kernel/*`（loader/layout/decode/contract-verify/defer memo）整体平移，适配 fork 路径与 `[CodeGraph]` 诊断纪律（禁 @opencode-ai/core）
3. **双路 parity harness**（本计划的护栏核心）：同仓 wasm 臂 vs kernel 臂逐字节 diff ExtractionResult（含节点数组顺序、signature/docstring/qn 文本、id 逐字节）；上游 kernel-parity.mjs 骨架 + dump-diff gate 移植；数据根 .chimera
4. EXTRACTION_VERSION 等价键 + needsReindex 报告
5. 构建分发：.node 进平台包 bin/ 旁挂（grammar wasm 模式）；build.ts 拷贝链 + postinstall 验证项（kernel 加载探测 + 降级姿态）；musl 交叉腿；bun×napi Buffer smoke
6. 验收：extraction.test 345 用例全绿（wasm 臂零回归）；parity harness 在"kernel 未路由"状态空转正确

### P1 首批开闸（~2 周，主力价值语言先行）
1. **tsjs params extraJson 补丁**（Rust 侧，ts/tsx/js/jsx 优先 = fork 99.4% 引用所在；~2-4 人日；其余 16 语言 params 延后按需）——TS 路由的硬前置
2. TS 语义对账三件：contract members（含 flush 顺序）、value refs（排除集/边形状映射）、returnType 截断规则
3. `DEFAULT_ROUTED` fork 首开 ts/tsx/js/jsx → parity diff 归零（主仓 + cbench fixture 仓 + 大 TS 仓样本）→ java/python/go 机械扩展
4. 验收：双路 diff 清零；resolution.test 130 基线全绿（receiver 推断吃 kernel 产出的 params/returnType 无回退）；cbench 17 任务 G 臂复跑 ≥12/12 基线；主仓重索引收益/回归实测
5. c/cpp 前置战役启动（#1159/#1207 blanking 移植，triage P2 转正）

### P2 切默认（+一个发布周期观察）
- kernel 默认 on（全路由语言），wasm 保留回退（erroring 文件 defer/深嵌套栈守卫/无 prebuild 平台/CODEGRAPH_KERNEL=0）
- postinstall/发布矩阵验证 kernel 加载；`--no-kernel` 变体是否需要 → 拍板点
- c/cpp 路由（blanking 前置完成后）；长尾语言（ruby/php/swift/kotlin/scala/dart/lua/r/csharp/rust）按 parity gate 逐族放行

### P3 终态（可选，独立拍板）
- 删 wasm 提取路径：parse-pool 的 wasm 病理对冲（recycle/crash budget/watchdog）、web-tree-sitter/tree-sitter-wasms 依赖、bin 旁挂 wasm；grammars.ts 收缩为语言探测；G4 wasm vendoring 项正式销账
- 保留条件：objc/pascal/erlang/模板系仍需要 wasm 或 TS 路径——**P3 实际是"收缩"而非"删除"**

## 4. 风险 TOP（合并双报告）

1. **语义换轨静默改图谱**（边被 retrieval/audit 直接消费；triage P1 03893b0 edge-drift 教训）→ parity harness 逐字节护栏 + 逐语言 gate，diff 不清零不开闸
2. **提取期确定性顺序丢失**（接口成员 flush 序、文件序提交）→ 结果入库顺序仍由 TS flushOrdered 钳制；harness 含数组顺序断言
3. **Rust 分叉 rebase 税**（上游 kernel 月均 3-8 commit）→ 补丁最小化（extraJson 加法、零 ABI bump）；每批同步走 triage 流程
4. **grammar 钉版纪律成永久维护面**（Cargo.toml 钉版 ↔ wasm 回退侧 revision-match，parity 测试断言 node-kind 表相等）→ fork 的 wasm 回退侧需同步升到与 kernel 钉版一致（G4 vendoring 转型为此项）
5. **分发矩阵放大**（musl/老 glibc/win32；加载失败=静默 wasm 慢路径）→ postinstall 验证 + 降级可观测（CODEGRAPH_KERNEL_DEBUG 姿态平移）

## 5. 对既有规划的影响

- **G 批次重排**：G4 wasm vendoring 动机消失（转型为 §4.4 grammar 对齐）；union NodeKind 链仍需要（NODE_KINDS 是 TS/kernel 共享契约，contract_info 对账机制接管验证）；G1/G2/G3/G6/G7/G8 不受 kernel 影响（db/watcher/检索/预算/CLI 层），按原优先级在 kernel 战役间隙穿插；G0 已落地（5 条中 4 条不受 kernel 影响，swift regex 属 frameworks 留 TS）
- **16 项分诊拍板**：E 由本计划取代；A（grammar vendoring）并入 P0/P1 grammar 对齐；B（union NodeKind）保留独立推进；F（function-ref 捕获面）**被 kernel 反而补齐**（wire code 200 上游已有）——从"独立战役"降级为"kernel 采纳的免费收益"；其余（C/D/G/H/I/J/K/L/M/N/O/P）不受影响，随 G 批次排期
- **长尾召回资产**：resolution 层（name-matcher 全部策略/veto/仲裁/消歧）kernel 不触碰，全量存续；提取侧 params/returnType/成员/值引用经 §2.2 处置存续

## 6. 待拍板点（随 P0 启动呈报）

| # | 拍板点 | 建议 |
|---|---|---|
| K1 | params extraJson 补丁范围：tsjs 四语言优先 vs 全 20 语言 | tsjs 优先（99.4% 引用所在；其余按需） |
| K2 | 首批开闸语言顺序：TS 主力先行 vs 非 TS 练手 | TS 先行（价值最大；parity harness 承担风险；上游 tsjs 是最成熟 walker） |
| K3 | P3 删 wasm 路径是否承诺排期 | 不承诺（观察期后独立拍板；objc/pascal/模板系使"全删"不成立） |
| K4 | `--no-kernel` 发布变体 | 不需要（回退是运行时机制非构建变体；平台包缺 .node 即自动 wasm） |
| K5 | kernel 战役期间 G1（WAL P1×4）是否先行 | 先行（P1 级 hang/corrupt 保护现网，与 kernel 零文件冲突） |
