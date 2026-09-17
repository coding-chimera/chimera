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

- macOS 签名/inode 注意（build-kernel.sh:81-85：先 rm 再 cp 防签名缓存 SIGKILL）适用 darwin 平台包

**发布面落地（2026-09-17，kernel prebuild 交叉编译发布面批）**：
- **平台矩阵**：npm 发布 12 平台包（package-variant.ts npmPlatformTargets），kernel 产物轴 = (os, arch, libc)：baseline（avx2:false）包共享非 baseline 产物（crate 无 target-cpu 编译旗标）→ **12 包收敛 8 腿**：linux-{x64,arm64}{,-musl} + darwin-{arm64,x64} + win32-{x64,arm64}。目录命名 = kernelPrebuildPlatformDir（package-variant.ts 新助手，win32 拼写从 loader 的 process.platform，非包名的 windows）；与 build-kernel.sh platform_for 的漂移由 package-variant.test 守卫
- **汇聚点**：publish.yml build-cli 在单 ubuntu runner 上交叉编译全部 12 个 Bun 二进制 → kernel prebuild 必须先以 artifact 汇到该 runner。新增 kernel-prebuild job（8 腿矩阵：ubuntu+zigbuild×4 linux、macos-26×2 darwin、windows-2025×2 msvc）→ upload → build-cli download（merge-multiple → codegraph-kernel/prebuilds/）→ copyKernelPrebuild 按包拷贝。**kernel 永不闸发布**：job continue-on-error + download continue-on-error + build.ts 缺腿 warn-only（wasm 回退）。publish.ts 原样重打包 bin/，npm 平台包 files:["bin"] 自动含 bin/kernel/
- **选型实测**（本地 macOS/arm64，全部安全验证工具 file/objdump/otool/nm/shasum）：① **cargo-zigbuild = linux 全 4 腿正解**（本地+CI 同路线）：gnu 腿 `x86_64/aarch64-unknown-linux-gnu.2.28` 钉 glibc 地板（Node 18+/manylinux_2_28 世代；objdump -T 实测 GLIBC 符号上限 2.28、NEEDED libc.so.6），musl 腿见下；② **cross 淘汰**（docker daemon down，无 colima/podman）；③ **cargo-xwin 拒绝安装**（cargo install = 新落盘未签名可执行 + ~2GB SDK 下载，触端点安全红线模式）→ windows-msvc 腿 CI-only；④ **windows-gnu 本地探针被 napi-build 闸**：gnu 目标要求 libnode.dll 导入库（windows.rs:15 panic 实测复现）；**msvc 目标 napi-build 零额外输入**（源码核实 setup() 仅 gnu 分支有要求）→ CI windows 原生腿无此障碍
- **musl cdylib 硬坑（实测新发现）**：rustc 1.98 在 musl 默认 +crt-static 下拒绝 cdylib（crt_static_allows_dylibs，"cannot produce cdylib"）；解法 = napi/alpine 惯例 `-C target-feature=-crt-static`，且必须走 **CARGO_ENCODED_RUSTFLAGS**（cargo-zigbuild 自组 encoded flags，cargo 优先级会掩掉普通 RUSTFLAGS —— 两路线实测对比确认）。产物 = 动态链 musl libc（NEEDED libc.so，alpine 加载器解析），非全静态
- **darwin 地板钉版**：build-kernel.sh 钉 MACOSX_DEPLOYMENT_TARGET=11.0（否则产物 minos 随构建机漂移）；实测 darwin-x64 交叉腿（M2 arm 宿主 Apple 工具链，CI macos-26 同路线）minos 11.0 ✓；darwin-arm64 宿主重建与基线逐字节一致（sha 72c5e790…）✓
- **Windows 命名坑结论：无需 loader 改动**。cargo 产 codegraph_kernel.dll → build-kernel.sh 统一改名 codegraph-kernel.node（napi/node-gyp 惯例；Node/Bun 在 win 的 dlopen=LoadLibrary 不辨扩展名）；loader 两个候选都是固定 .node 名，postinstall.mjs 的 -musl/-baseline 后缀探测与 win32→windows 映射复核无误，零改动
- **本地产物证据**：6/8 腿已 staged+格式验证（ELF/Mach-O、GLIBC≤2.28、musl NEEDED、minos 11.0、napi_register_module_v1 全腿导出确认）；win32 两腿待 CI 首跑。端点安全：zigbuild 链接过程零拦截（红线⑧未再触发；zig 自托管子命令全家未碰）
- **端点安全事件（2026-09-17，本机纪律固化）**：npm 安装冒烟中执行 /tmp 新解包的 bin/chimera 被内网端点安全组件 SIGKILL 拦截（exit 137；内容与 dist 二进制 sha 逐字节一致 2b0da268…，实锤拦截的是“新落盘可执行物被执行”模式而非内容）→ **本机安装流验证一律静态化**：tar -tzf 清单 + tar -xzO 管道读取（零落盘）断言 os/cpu/libc/files/postinstall/optionalDependencies + .node sha 对账；二进制执行验证（安装冒烟、--version、graph 命令）一律 CI-only/待授权。AGENTS.md 的 npm install 全局验证流程在受管机器上不可执行
- **静态安装验证已过**（--single darwin-arm64 no-webui tarball）：平台包 bin/kernel/codegraph-kernel.node sha == staged 源（72c5e790…，打包链路字节无损）；os/cpu/files:[bin,LICENSE] 字段正确；主包 postinstall.mjs + scripts.postinstall + optionalDependencies 形状正确
- **6 腿 sha256 清单（staged，gitignored，待 CI 腿补齐 win32×2）**：darwin-arm64 72c5e790f706b0ea…（==基线）、darwin-x64 901881e6d85d39d5…、linux-x64 0ebd0f3595bd733d…、linux-arm64 af7aedbf542a6573…、linux-x64-musl a418925270a7d0a6…、linux-arm64-musl 6f1f492dc01f6611…
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
5. 构建分发：.node 进平台包 bin/ 旁挂（grammar wasm 模式）；build.ts 拷贝链 + postinstall 验证项（kernel 加载探测 + 降级姿态）；musl 交叉腿；bun×napi Buffer smoke（发布面 2026-09-17 落地：build.ts 矩阵感知拷贝 + build-kernel.sh 多腿 + publish.yml kernel-prebuild job，见 §2.3 增补；待 CI 首跑）
6. 验收：extraction.test 345 用例全绿（wasm 臂零回归）；parity harness 在"kernel 未路由"状态空转正确

### P1 首批开闸（~2 周，主力价值语言先行）
1. **tsjs params extraJson 补丁**（Rust 侧，ts/tsx/js/jsx 优先 = fork 99.4% 引用所在；~2-4 人日；其余 16 语言 params 延后按需）——TS 路由的硬前置
2. TS 语义对账三件：contract members（含 flush 顺序）、value refs（排除集/边形状映射）、returnType 截断规则
3. `DEFAULT_ROUTED` fork 首开 ts/tsx/js/jsx → parity diff 归零（主仓 + cbench fixture 仓 + 大 TS 仓样本）→ java/python/go 机械扩展
4. 验收：双路 diff 清零；resolution.test 130 基线全绿（receiver 推断吃 kernel 产出的 params/returnType 无回退）；cbench 17 任务 G 臂复跑 ≥12/12 基线；主仓重索引收益/回归实测
5. c/cpp 前置战役启动（#1159/#1207 blanking 移植，triage P2 转正）

### P1 前置实测修正（wave2 parity 基线，2026-09-16，harness=script/kernel-parity.ts，基线 JSON=/Volumes/workspace/cbench/kernel-parity/baseline-20260916.json）
- 全语言基线：575 文件 · 43 字节一致 · 489 diff · 43 defer（全部真 defer，0 kernel error）。**lua 22/22 字节级全一致**；kotlin 2/6；ts 仅 2/199（statement 级联主导）
- **grammar 钉版漂移是新发现的硬前置**：14/19 语言 native↔wasm grammar 修订不一致（js/jsx/c/rust abi 15↔14、csharp/swift 15↔13、kind/field 表内容差）——即 G4 转型批（fork wasm 侧重钉到 kernel 钉版修订），否则 parity diff 无法二分“语法版本噪声 vs 提取逻辑差异”。已对齐的 5 语言（kotlin/lua/luau/scala/dart）恰为字节一致/接近集——**首批路由波改为这 5 语言**（grammar-parity 测试已固化为门禁：对齐集严断言，漂移集显式 skip+名单在册，对齐一批勾销一批）
- **params 前提修正**：wasm 臂产 params、kernel 全缺（1432 处 drift）——extraJson 补丁硬前置地位实锤；**returnType 缺口比预估宽**：tsjs 666 处外，c(112)/python(139)/csharp(29)/go(4) 也缺，按语言逐项补
- **statement 级联量化**（tsjs 最大项）：wasm 侧 14673 个 stmt 节点 1:1 级联出 contains 边缺失(15628)+ref 重挂（calls missing 28802/from-drift 16041 大头是 wasm 挂 statement: 而 kernel 挂 function:）——Rust statement 发射批（阶段 a）落地后应归零，是 harness 的最大验证点
- **ref:order-mismatch 128 文件**（ts75/tsx35/js18）列入 P1 对账显式项：同一 ref 行两臂相对次序反转，first-match-by-name 消费方风险；node 级 order-mismatch=0（flush 序本身一致）
- 语料缺口：jsx/java/scala/dart/swift/ruby/r 无仓内真实样本（采纳前需补语料，上游 fixture 集候选）；edge metadata(valueRef) 形状 0 漂移（好消息）

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

---

## K-v2：路线 a 对齐战役（2026-09-17 立项，用户拍板）

**决策**：路线 a=跟进上游 N（codegraph@ba3c21e50d，codeload 快照 /Volumes/workspace/codegraph-snapshot/）+取舍原则：**双实现比对实现水平取强者**（用户原话），纯 fork 增量（上游无对应物）保全。

**盘点权威**：`UPSTREAM_KERNEL_V2_INVENTORY.md`（入库版：blob 级基底考证/hunk 交叠实测/12 条比对判定表 D1-D12/五阶段切分）；38 份 patch 归档在 `/Volumes/workspace/codegraph-snapshot/inventory/`（不入仓，可由快照再生）。

### P0 判定会（parent，2026-09-17）

| 项 | 裁定 |
|---|---|
| D1 value-ref | **合并**：fork 实现为主干（覆盖面+17.7% references 实证更强）+吸收 N shadow-prune+收窄 VALUE_REF_LANGS 防 tsjs 双发 |
| D2 statement | 取 fork（上游无对应物） |
| D3 interface 成员 | 默认取 N #1638 实节点；fork 保序机制去留待 P0 深查结论（若动机仍成立=作为 N 节点上的增强保留） |
| D4 docstring | 取 N（fork 清洗器=对旧 oracle 的对齐件，随路线 a 作废） |
| D5 builtin 大写块 / D6 csharp returnField | 待 P0 深查；D6 默认保 fork 直至证实 N 有补偿路径 |
| D7 builtins / D8 伪边防御 / D9 接收者证据 | 合并（骨架/前后置互补，按盘点方案） |
| D10/D11 store 族+kotlin/scala/dart 语义 | 取 N（剥除回滚快速道） |
| D12 name-matcher | 保 fork 骨架（RESOLVER_RANK/veto 独有）+移植 N 20 hunk 机制（无文本合并路径，清单制） |

追加裁定：②navigates **纳入** FILE_PROJECTION_EDGE_KINDS+may-impact（保守纳入，成本≈0）；③N index.ts #1728/preload=P2 批内与 fork watcher 层比对等价后 cherry-pick，等价则记证据跳过；④tb3/tb4-v2v3 bench 格=P5 后 re-baseline 立项（不退役）；⑤10 语言 wasm blob 扩容=**暂不**（采 N 代码不采 blob，hasTreeSitterGrammar 运行期降级；发布体积可选项报用户，不阻塞）；⑥铁律：P4 完成前，非 tsjs 臂残留 flush_value_refs 的语言禁开 kernel 路由（lua/luau 由 P0 深查重点确认）。

### 批次序与状态

P0 深查（5 项，在途）→ P1 契约 append（navigates 五处+子集门测试，新旧 kernel 均兼容可先行合入）→ P2 wasm 升级（L）∥ P3 kernel re-vendor（L，含 8 腿 prebuild 重建 CI-only 纪律）→ P4 parity 重对账（N 自带 13 套件先跑绿+fork harness 期望重写，v4 的 21/21 基线作废重建）→ P5 semantics **v5**+resolution 合并（D7/D8/D9+新 callee 形态消费端配套）+重索引+bench 重验（G 臂 12 格+tb5-v2/tb6-b 重放+主仓冒烟 delta 归因）。KERNEL_ABI_VERSION 不动（append-only，N 未 bump）。

主力窗口：P2/P3 待当前并行 builder（F2/claims/L4 小件/WebUI P1P2/workbrief 改造）收口后排上；P0/P1 小件可插队先行。

### P0 深查落锤（2026-09-17，证据归档 UPSTREAM_KERNEL_V2_P0_FINDINGS.md，162 行三方 file:line 交叉证据）

- **D3 落锤**：采 N interface 实节点（#1638）+**保留 fork 保序为增强**（extract() 末尾对 interface 成员稳定重排）。保序动机实证仍成立：fork resolver first-match 顺序依赖链（db/queries.ts:866 无 ORDER BY → name-matcher.ts:388 matches[0]，出处 a84c65722 修 426 条 failed refs）。P4 保留 node:order-mismatch 已知项；P5 resolver 侧加固后再评估移除重排。
- **D5 落锤**：fork 大写块修复**保留但改写为 tsjs 作用域**——N 的 TYPE_ANNOTATION_LANGUAGES 含 scala/php（N tree-sitter.ts:6240-6242），整块删会误伤 Scala；N 无补偿路径。P2 wasm 重放为语言作用域（大写块仅 ts/tsx/js/jsx 失效）；P3 kernel 只在 tsjs/mod.rs 重放；P4 复测 ServerConnection.Any 场景+Scala 抽验。
- **D6 落锤**：**撤销'上游休眠 bug'说**——N 已双路补偿（extractCsharpReturnType 读 'returns' + extractCsharpTypeRefs 'type'??'returns'）；fork 的 returnField delta 保留但重新定性=服务 fork 独有 RAW returnTypeText。P2 采 N csharp.ts 整体+重放 1 行 returnField:'returns'（对 N 特性零影响）。
- **⑥ 修正（重要）**：残留=**9 个非 tsjs 文件**（报告原计 11 多算了 tsjs 两件有意重 track），全部未路由、无活雷；lua/luau 三查干净。**但 P2 会对已路由 kotlin/scala/dart 新开 valueRef 差**（N wasm 发、F kernel P3 前不发）——**P2/P3 必须原子落地或 P3 紧随，窗口期 parity 白名单 valueRef 差**；P4 前 9 残留语言维持禁开（现状合规）。
- **③ watcher 缺口坐实**：F buildDefaultIgnore 缺 .git/info/exclude+core.excludesFile+嵌套 .gitignore 目录剪枝（N #1728）——P2 批 cherry-pick N 两个自包含函数进 buildDefaultIgnore（watcher 自动受益）；preloadLanguagesForFiles 为性能项 P2 尾部可选。
- **P1 范围修正**：①②⑤执行；③④（FILE_PROJECTION_EDGE_KINDS/may-impact 消费）**推迟**——N 提取层 navigates 零发射（发射方全在 fork 已判跳过的 resolution router synthesizer 族），fork 语料 navigates 边恒 0，纯契约预留。
- **口径修正三条入库**：残留 11→9 文件；'P2 自动闭合'→P2+P3 联合闭合；fork harness '改三处'→两处代码（knownExpectations 剥除族 :757-777、statement/params 断言 :763-769）+一处基线重生成（docstring 期望无独立代码位）。
- **P1 已落地（parent 直做，小件）**：types.ts EdgeKind ∪ layout.ts EDGE_KINDS append 'navigates'（append-only 12→13，KERNEL_ABI_VERSION 不动，新旧 kernel 均过子集门）；kernel-loader.test 反转表断言改推导式（防未来表增长破防）；typecheck 绿+聚焦测试全绿。
- **P3 已落地（builder 子代理，2026-09-17，4 commits 未 push）**：vendored kernel re-vendor 到上游 N（ba3c21e50d）终态。快速道 9 文件整体采 N（kotlin/scala/dart/lua/python/ccpp/java/rustlang/tsjs-fnref = 剥除回滚 + N 17 条新机制随入：#693×6 语言/#1495/#1638/#1727+FLAG_IS_ABSTRACT/lua 赋值式/rust unit-struct+self-owner/generator/jsx-object fnref 等）；textutil = N regex 回归 + push_json_string 保全。慢道 tsjs/{mod,extractors}.rs = N 基底 + fork 五件套重放：statement 全套（15 kind 表+嵌套重叠+多重归属+240 截断）、value-ref retrack（D1：三表+dedup+collectObjectValueReferences 保全，upstream capture/flush 移除防双发，**shadow-prune 已吸收**=compute_shadowed_value_names 前扫，公式 decl_counts>file_scope_counts 默认 1，P2 wasm 须同式实现）、params_json+RAW returnType（200 截断，extra_json/return_type 线字段）、D5 大写块剔除仅 tsjs 作用域；D3 kernel 按 N 源码序 inline 发射（PendingInterface 延迟 flush 从 kernel 移除，保序归 P2 wasm 末尾重排承载）；D4 docstring 采 N（_tsjs 清洗器随路线 a 作废）。buffers 双 append 终态：NODE_KINDS 24（N 23+尾 statement）+ EDGE_KINDS 13（尾 navigates），除 statement 尾外与 N index 级全等；kernel-decode.test 领先集断言归零（['navigates']→[]，P1 预留消费）+#808 断言随 N 分类改 property。langs.rs/lib.rs/Cargo.toml/build.rs/grammars 三方一致零动作确认。**.node：darwin-arm64 宿主腿重建 sha256=6e32fc67e48e0b84cc4d97365cbc71c7ef076dd6721b64ac65b82bf390607eac**（staged prebuilds/ + 全局平台包 bin/kernel/ rm-then-cp 覆盖，替 5e00fd19；**其余 7 腿仍为 wave3 旧 kernel，8 腿 sha 现不一致——parent 波次收口 CI-only 统一重编，发布前必须补**）。验证：cargo build release 干净（仅 3 条 N 上游自带 unused_mut 警告）；kernel 测试族 58/58（子集门全等+statement/params/returnType 冒烟绿）；typecheck 绿；窗口期 parity 快照（P2 在途未收口，wasm 臂=旧 oracle）：243 files/30 identical/213 diff/**0 defer/0 kernelErrors**；四类 fork 资产断言保全——statementMissingInKernel=0（6555 wasm stmt 全发射）、params drift 11 条全为 #1638 interface 成员 kernel 侧富化方向（非丢失）、nodeOrderMismatch=44=D3 设计内窗口态（P4 known 项）、value-ref 冒烟（bare-arg/shorthand/pair-value 三族+shadow-prune 实证剪枝）通过；白名单差=kotlin/scala/dart N 语义 vs 旧 quirk oracle、ts #693 归属/chain 重编码/import-binding refs 回归、lua 赋值式函数——归档 cbench/kernel-parity/ksd-parity-p3-window-20260917.json。P2 协同四项：VALUE_REF_LANGS 收窄（wasm 侧）、shadow-prune 同式、wasm extractFunction/extractMethod 的 params/returnType 重放点与 kernel Extra 对齐、import-binding refs 回归后与 resolution 层 re-export 物化的双发核对（P5）。EXTRACTION_SEMANTICS_VERSION 未动（v5=P5 统一）。
- **P3 followup 已落地（builder，2026-09-18，P2 收口后钉桩修复，同波待推）**：① object-literal valueRef 双发修（extract_variable 的 pre-walk collect 让位 #693 行走 generic hook，单发 constant 归属；collect_object_value_references 退役），② D3 decode 侧重排（kernel/index.ts POST_PASSES：reorderInterfaceMembersToTail，typescript/tsx，镜像 wasm extract() 稳定分割；raw wire 保 N 源码序），③ interface function-typed property 促升 method（extract_property 镜像 P2 wasm replay，保 resolveMethodOnType 0.5/0.5b 绑定）。**.node 终态 sha256=51f20349eab67702af0f627da5efba701951c7b17dab2ffefc646ae7912dcd7c（双落点一致，取代上条 6e32fc67）**。终验：两红钉桩转绿、P2 钉桩面 451/451、kernel 电池 58/58、**parity typescript 199/199 exit 0 clean（全计数器归零：order 44→0、refMissing/Extra→0、params expect0=0、stmtWasm 6713 全发射；快照 cbench/kernel-parity/ksd-parity-p3-followup-ts-20260918.json）**、typecheck 绿。P4 注：kotlin/scala/dart/lua 窗口白名单差待 P2 收口后复跑归对；wasm 侧 collectObjectValueReferences 已成无调用点 vestige，P4 可清。
- **P4 已落地（builder=P3 同 session resume，2026-09-18，3 commits 未 push）**：parity 重对账收口——① cargo test 21/21（N Rust 测试面 21=21 零缺失实证；N 根 13 vitest 套件需 N npm workspace，端点安全内不可跑，fork harness 全语言扫代位双臂自洽证明）② takeDeferredPreParse 接线回补（P2 挂账；kernel adapter 全 N defer-memo 形 + wasm fallback sourceIsPreParsed 消费；已路由语言恒等，P5 c/cpp 路由前置）③ collectObjectValueReferences vestige 终裁=删（两臂无调用点，覆盖⊆#693 hook+store 臂）④ scala return_type wire=fork RAW returnTypeText 镜像（全语言扫描唯一残差 1/430：N kernel 用 #750 bare 形 vs fork wasm RAW；parity 裁判=wasm 臂；D5 类偏差注释，上游反馈候选）⑤ harness knownExpectations 终态重写（全计数器=归零守卫，剥除族预算退役；params“11 终态”与“order P4 保留 known”两个预设均被实测 0 取代）⑥ kotlin/scala/dart value_ref 双臂**字节一致**（挂账实测项）。**新基线：9 路由语言 429/430 byte-parity / 0 diff / 1 合法 defer / 0 kernelErrors / exit 0，归档 cbench/kernel-parity/ksd-parity-p4-baseline-20260918.json（v4 21/21 基线正式作废）**。.node sha=189f7f82…（scala 修复重建，双落点，取代 51f20349；7 腿仍待 CI）。主仓默认路由强制重索引 92s（bun 源码 CLI+守卫 env 双阀路径）：128,799/336,220/266,188/66,733 vs P2 +8/+14/+19/+8（<0.01%，归因=本批 3 个 TS 文件自身语料演进，kernel-vs-wasm≈0）；4 errors=nix 已知缺 blob。验证：kernel 电池 58/58、P2 钉桩面 451/451、typecheck 绿。P5 待办不变（开路由决策/chain-form resolver 配套/import-binding 双发卫生/semantics v5/fn-ref 翻牌）。
