# Temporary Memory

This file is a temporary cross-session memory pad for this checkout.

Use it for short-lived notes that should survive context resets or handoffs while active work is still in progress. Prefer permanent documentation, issue trackers, or code comments for durable project knowledge.

Guidelines:

- Record only concise decisions, pending local context, and handoff notes.
- Remove stale entries once they are resolved or no longer useful.
- Do not store secrets, credentials, tokens, private keys, or long transcripts.

## Notes

### Chimera 大重构 W1 执行中（2026-10-10 开工，调研 13 路已完成见 CHIMERA_REFACTOR_PLAN.md）

- **W1 断点（2026-10-10 17:00 暂停，待重启后接手）**：已提交=门禁 `db69e4f4c`、B2 `f2c33b984`（SQLite 16/32MB，-16.2MB/连接实测）、plan/memory 文档若干；全部未 push。工作区未提交改动归属：A1（已验证 SCC 246→154、typecheck 绿、test/plugin 131 过）=`src/plugin/index.ts`+`src/server/server.ts`+`test/plugin/server-port.test.ts`（新测试，builder 刚补，待评审）；A2（schema 下沉，测试中）=`src/session/schema.ts`+`src/session/session.sql.ts`+`src/contracts/session-ids.ts`+`src/storage/tables/session.sql.ts`；B5（grammar 卸载，测试中）=`src/graph/extraction/grammars.ts`。进行中未落盘：B1（ses_edafe2f63ffe，图连接空闲淘汰，还在探测）、B4（ses_edafde812ffe，堆软上限+GC，还在探测）、B3 未放。接手顺序：① 跑 `bun run --cwd packages/chimera check:layering`+typecheck 看树是否自洽 ② 逐个 git diff 评审 A1/A2/B5 文件并补验证（A2 必查 OpenAPI 字节一致+drizzle 零漂移）③ 分别提交 ④ 静止树 SCC 复算+门禁阈值钉到实测值 ⑤ 再放 B3。builder task_id：A1=ses_edb156fdbffeNQTABGUZeLDAd3、A2=ses_edb1465c5ffeNzpn1xA92GNzpk、B5=ses_edb140249ffe1pVdokUjW99LLN（可 resume）；用户暂停原因：/goal 有 bug 待修

- **四条战线**：① 解环（运行时 246 文件巨团 SCC）② 减重（serve 常驻 1.5GB→目标 <500MB）③ newweb 解构+潮酷化 ④ 原生 GUI（mac Swift/Linux Qt，原生为主 webui 并存）
- **解环**：模块级 36 节点 283 环边；**单点最大杠杆=plugin/index.ts:130 一条动态 import server/server，切掉文件 SCC 246→154**；session/schema.ts 是纯叶子可直迁（packages/schema 已存在可作 L1 容器）；session/session.sql.ts 下沉 storage/tables 需连带表列类型；迁移序=schema→组合根(L6 composition/)→tool 端口(contracts/)→server service 门面→graph 独立成包（graph 出边=0 不在团内）。防回归=自研 check-layering.ts 门禁（oxlint import/no-cycle 已证伪为 1.60.0 stub 规则；切割集分析脚本在 /var/folders/.../T/chimera/{modgraph,scc,sim,sim3}.ts）。注意：纯搬迁不缩文件级 SCC，只有真删边才缩；400 处 import type 剥离是低成本消边
- **减重实测**：用户 web 进程 PID 实测 1.5GB/peak 4.1GB，大头=JSC 堆棘轮（507MB 常驻+320MB swapped）；serve 空闲稳定态仅 127MB；裸 bun 12MB、--version 218MB、graph index 219 文件 571MB。五刀：图连接空闲淘汰（3 项目 db 常驻）/SQLite mmap 256→32 cache 64→16/消息驻留收敛（全局 chimera.db 2.68GB，part 表 1.8GB）/heap cap+主动 GC/grammar 缓存卸载。R3 收口（图 store/resolution Rust 桥已落地待开闸）预期再 -0.5~-0.9GB
- **Rust 结论**：全量重写 12-24 人月当前 No-Go（Effect 编排语义不可跨 FFI、20 provider SDK、上游同步断裂）；选择性 Rust=R3 收口+R5' sidecar；归档 RUST_MIGRATION_PLAN.md 同判
- **原生 GUI**：API 面基本可行（~170 REST operation 全在 OpenAPI）；硬缺口=SSE 客户端+PTY WS 客户端（原生自写）+启动握手（loopback+随机 token，server 侧需新增）；codex 仓库无 GUI 源码（桌面 app 闭源经 app-server JSON-RPC 接入=同架构先例）；codex-rs=157 crate Rust workspace
- **潮酷（参照 codex TUI）**：语义色纪律（单 accent+对比度 Lab 校验+能力降级）+克制微动效（shimmer/庆祝动画+reduced-motion）+流式增量渲染/危险动作仪式化+重快照测试——潮=纪律非重设计
- **onboarding 快赢**：server/SDK API 全就绪，newweb 已有 ProviderSettings.tsx，缺的只是首启状态机（零 provider→自动弹配置）；TUI 参照 app.tsx:445-454；closure json:449 标 ui:deferred
- **newweb 结构其实是对的**（features 零交叉 import）；传播深 70% 来自 barrel 串联+attachment/contexts 枢纽（8 个 god file 下游共享同一条 16 层链）；11 个 god file 解构蓝图已出（含分块行数/拆分顺序/难点）
- **IM 参照调研完成（2026-10-10，TG-iOS×5+Synapse×5+agent-as-client×1，规格已入 CHIMERA_REFACTOR_PLAN.md D.5）**：用户拍板 IM 是参照模型非目标架构（不拆 agent 成独立进程）；核心结论=seq 游标精确等式判连续+服务端权威下发、after= 幂等恢复三件套 next_seq/limited/gap_from、keyset 分页禁 OFFSET、服务端过滤用编译 predicate+序列化前过滤、未读=写入时预计算+单游标+增量计数+对账逃生阀、列表=持久化轻量排序索引+operation 增量 patch、GUI 客户端=Postbox 稀疏缓存 hole 模型+串行写队列+离屏 20pt 释放+TextReveal 速率平滑；Synapse 反面教材=缓存按条目数非字节+驱逐默认关+SQLite 单写者纪律；agent-as-client 边界已测绘仅作档案（SessionProcessor/LLM/Snapshot/Permission/SessionRunState 一圈，SessionTurnLease 可复用）

### FrontierSWE v2 多模型对照实验（2026-10-09 设计完成，待 Phase 0 开工）

- **目标**：测 Chimera 多模型编排能力（非 k3 水平），产出改良方案。基准=/Volumes/workspace/frontier-swe-v2（34 Harbor 任务，官方 verifier 不改一字节）
- **对照**：A组=kimi-k3 max + deny task/chimera_swarm（单模型基线）；B组=kimi-k3 ultra + 调度器自由路由。k3 的 ultra≡max 推理档（transform.ts 映射 top effort），差异精确=编排层
- **任务集=6**：原生 4=qubit-routing(纯py)/crash-proof-flash(zig@0.14)/spice(rust+brew ngspice)/QE-rust(stretch,需编pw.x+烘焙参考)；Apple Container 2=git-to-zig/flight-sim（linux/amd64 镜像，需先装 Rosetta：sudo softwareupdate --install-rosetta）。本机已装 container CLI 1.3.0
- **执行**：无 Harbor。workspace 复制到本地工作目录→chimera run --variant <max|ultra> --dangerously-skip-permissions --format json →原生/容器内跑 tests/test.sh(verify.py)。20h/任务不截断，并发 2-3
- **verifier shim（不改 verifier 字节）**：symlink /app /logs/verifier /root/tests（需一次 sudo）+ PATH 前置 runuser/setpriv 透传 shim + brew coreutils(timeout)
- **关键坑**：①漏 --variant ultra 则 multi_agent_mode 静默不注入（llm.ts:97-106）②子代理禁 ultra 变体（subagent-execution.ts 硬拒）③前台 task 无超时→外层硬杀④遥测在 chimera.db（message 表 model/variant/token/cost + model_telemetry_*），stdout JSONL 只有 task part metadata⑤模型走内网 relay 11.161.198.115:3000，Modal 云不可达故弃用
- **配置注入**：容器内用 CHIMERA_CONFIG_CONTENT 注入 provider.ali-inc+delegation 配置（源=~/.config/chimera/chimera.jsonc），auth 用 env 或 auth.json
- **状态（2026-10-10 13:35）**：Phase 1 Wave 1 在跑——qubit A=r2 / qubit B=r3 / git-to-zig B=r2(容器)。完成监听 watch_and_verify.sh(pid 27709) 会在每个 run 退出后自动串行跑 verifier → runs/wave1-results.md。`scripts/status.sh` 随时看全景。Wave 2（剩 9 个运行）等用户看过 Wave 1 结果再放；Wave 2 起 arm-b.jsonc 已加 kimi-k3 excludeModels（k3 太慢不适合做 sub）
- **里程碑**：观测性补丁=快照 swe-experiment 分支 010400ca（delegation_started/progress/finished，8 测试+typecheck+实弹委派全绿）；容器链路全通（二进制 Rosetta 启动✓、relay 401=可达✓）；60min 诊断=805s 静默是 relay 缓冲 ultra thinking 非挂死；委派实弹：调度器给 general/builder 选 qwen3.8-flash@medium 符合设计
- **改良清单**：#1 delegation JSONL 事件✅已落地 / #2 stream stall 看门狗（>900s+工具在飞感知）待立项 / #3 委派期间 root JSONL 静默（#1 已修）/ #4 Config.ensureGitignore 不容忍 EROFS 只读挂载（容器标准模式必崩，agent_container_run.sh 已去 :ro 绕过，正式修复待主仓）/ #5 parent-model fallback 绕过 excludeModels 与调度器（git-to-zig r2 实测：kimi-k3@high 子代理），待立项
- **坑**：隔离 XDG 下原生 session 库=chimera-local.db、linux 二进制容器内=chimera.db；container 名无 arm 段（审计小坑）；容器 config 挂载不能 :ro（#4）

### K-v2 P5-2：9 残留语言 parity 验证+wave-4 开路由 + semantics v5 + 重索引（2026-09-18，builder=P5-1 同 session，1 commit 未 push）

- **parity 门（先验证后开路由）**：首扫 9 残留语言发现**唯一残差类=kernel returnType wire 为 N BARE 形 vs fork RAW returnTypeText oracle**（in-repo：go 4/python 216/rust 448/csharp 29 处 drift；java/ruby/swift in-repo 零语料→**自建 fixture 语料**（cbench/k-v2-p5-2/corpus，6 语言+Lombok 件）实证 java 7/php 3/swift 2 同类 drift，ruby 双臂天然无 returnType、go/csharp 干净）。处置=P4 scala 判例：**7 模块 kernel wire 改 RAW 镜像**（go 'result'/java 'type'/python 'return_type'/rust 'return_type'/csharp 'returns'/php 'return_type'/swift 'return_type'；trim+colon-strip+200 UTF-16 cap+empty→None）；bare-shape 规约移到 resolution `lookupCalleeReturnType`→`chainReceiverTypeName` 归一化（指针/引用/生命周期/const、非嵌套泛型、swift `?`、尾段、**Self/static→'self' 标记保留**=#608/#1861 链语义不丢）；java `normalize_java_type` 仅留 Lombok 合成路径（wasm java.ts 生成器同源=双臂一致，fixture 实证）。**终态：residual-9 exit 0 全计数器归零**（c 38 identical+13 defer/cpp 25+10 defer/python 58/rust 25/csharp 1/go 1/php 1；快照 ksd-parity-p52-residual9-final + post-routing 双份）；fixture 6 语言全 identical；**routed-9 回归 exit 0**（429/430 基线保持）
- **c/cpp defer 归类（takeDeferredPreParse 首次实弹）**：23 defer 100%=`parse tree contains errors — wasm recovery is canonical` 策略阀（0 stack-guard/0 接线故障/0 kernel error）；wasm 臂对同文件 0 errors 完整提取=kernel 侧宏 preParse 能力差，上游文档化 10–40% 政策带内；生产路径 E2E 实证（fixture 目录默认路由索引，defer→wasm 回退+RAW returnType 全通）
- **wave-4 路由**：DEFAULT_ROUTED +go/java/python/rust/c/cpp/php/ruby/csharp/swift=**19/20 语言**（仅 `r` 暂缓：无语料无法过门，selector 测试 iron-rule 改用 r 承载"支持但未路由"语义）；kernel-selector.test 重协商（iron-rule python→r、新增 wave-4 用例、fake contract languages 参数化、293 行 ruby kernelSupports 门用例原样保留）
- **semantics v5**：EXTRACTION_SEMANTICS_VERSION 4→5（route-change 条款+P5-1 resolution 面双触发，注释入库）；version 测试全相对断言零改动即绿；**needsReindex 用户面实录**：`graph status` → `Semantics: v4 — does not match v5`（黄字警示行）
- **.node**：sha256=**ff65c3ce7a56c007d281f8a89371183849b4b67558ebdca2bc3414f8604d5d7f**（cargo release 干净仅 3 条 N 自带警告+cargo test 21/21；staged prebuilds+全局平台包 rm-then-cp 双落点一致，取代 189f7f82→中间态 bab5e40c→终态；**其余 7 腿仍待 parent CI，wave-4 kernel 改动随 8 腿矩阵同步**）
- **重索引（84s 无卡死，安静环境单独计时）**：nodes 129,318 / edges 302,325 / unresolved 305,887 / stmt 67,162 / stamp v5 / fnRef 边 543。归因 vs P5-1 账面（129,313/302,312/305,966/67,155）：Δ=+5/+13/−79/+7 **全部=本批自身 ~10 文件语料演进**；**arm-switch 零漂移自证=rust 25 文件 node 数逐文件全等**（pre 快照已含本批 kernel 编辑：wasm 臂 sync 态 vs post kernel 臂全量态）
- **事故记录（已清）**：pre 快照发现 158 条 kind='function_ref' 脏边+~1.9k 伪 resolution（resolvedBy=exact-match 落 import 节点=pre-P5-1 语义）——归因=P5-1 批编辑窗口期（20:52 flip 后~21:33）某**混码长驻进程**（flip 后 emission × pre-P5-1 resolution 模块混合装载）对主仓增量 sync 所致；全量重索引清灭，当前代码 full+incremental 双路径复验 0 脏边（edges kind 词表外计数=0）。可选加固（storage 层 insertEdges kind 词表门）记 pending-parent
- **验证**：parity 三扫（residual-9 修复前后+routed-9 回归+post-routing 复跑）全 exit 0；kernel 电池 58/58；钉桩面 451/451；resolution-p51 19/19；test/graph 全量 1503=1484 pass/15 fail（逐名比对=既有环境基线 daemon7/roots3/init2/Node26×2/sqlite1，零新增）；typecheck 绿；召回矩阵/G 臂仍 CI-only（全局二进制依赖）
- **P5 余项（parent）**：r 语言语料建设后过门开路由；8 腿 CI 重编；召回矩阵+G 臂 12 格+tb5-v2/tb6-b 重放+tb3/tb4-v2v3 re-baseline；storage 层 kind 词表门加固与否

### K-v2 P5-1：resolution 层机制移植（清单制）（2026-09-18，builder 子代理，已推送 origin/main=82a38cd73）

- **交付**（D7/D8/D9/FN_REF/卫生批五件，fork 骨架/RESOLVER_RANK/veto 原位不动）：① **D7** 新模块 `resolution/js-builtins.ts`（N 骨架，name-matcher+index 双消费）——集合差机械比对**零冲突**：五族+REACT_HOOKS+GO_STDLIB+PASCAL_PREFIXES 双侧字节同（共同血统），JS_BUILT_INS 差={WeakMap,WeakSet}（N 多，取并），TS_PRIMITIVE_TYPES=N 独有 12 项（整体采纳）② **D8** N 规则做候选前置过滤（#915 import-kind 排除、#1719 sealed-module 源文本检测、#1714 裸调用非 method、local-binding shadow）+ rank 后校验（matchByExactName winner 过 isCrossFileReachable、matchFuzzy 唯一幸存者四重守卫、resolveOne 管线后 isVisibleAcrossFiles 终拒）——**N 拒绝=最终 unresolved 不晋升次名**；语言可见性全套（C static 源文件/TU、Go 大小写包域、Rust 非 pub 模块子树+trait-impl 豁免、7 语言 private 文件域）③ **D9** 形态消费端：`this.field.m`(#1496 类声明行字段类型+typeof 值形态)、rust `self.m`(#1861 owner 唯一性)/`self.field.m`(#1585 auto-deref 类型规约)、`inner().m`(#1683 store-accessor-only 排他，TS/JS/py)、#645/#608 dotted/scoped 链（lookupCalleeReturnType+fork resolveMethodOnType 验证）、#1573 对象字面量命名空间、cpp auto-init(#645)、isUnresolvedJsMemberCall 守卫、builtin/primitive 接收者否决(#1566/#1840)进 d2 ④ **FN_REF 双臂翻牌**：wasm FN_REF_EMISSION_ENABLED=true + types.ts `ReferenceKind = EdgeKind | 'function_ref'`（wire 契约零变更，200 码位 P1 已预留）+ matchFunctionRef/resolveThisMemberFnRef + createEdges function_ref→references+{fnRef:true} + kernel decode 200 映射（P2 丢 200 挂账清）；**.node 未动**（零 Rust 改动，sha 仍 189f7f82）⑤ **卫生批**：符号级 imports 边按 (source,target) 去重、(line,col) 最低者留——落在两臂共享 resolution 层=createEdges（发射端不动→parity 中性）；职责划分维持（binding ref 管本地使用/re-export ref 管 barrel 依赖）；fs/os 型 moduleName×binding 双发随 #915 排除自然消灭
- **范围收窄（pending-parent 清单）**：#1108 inferLocalReceiverType 未移植（Go 2-hop 链 #1276/PHP this->prop=排他 decline，语义等同 N 推理失败分支，无误边）；resolveDeferredThisMemberRefs 超类型二次 pass 未移植（继承来的 this.member fn-ref 保持 unresolved）；#1230 isLexicallyReachable 仅随 store-holder 过滤（未接入 exact/fuzzy 主过滤）；erlang arity(#1610)/arkts 点前缀属性专用步未移植（形态自然 unresolved 安全）；matchByQualifiedName #1079/#1180 增强与 matchByFilePath bare-filename include 形未移植
- **验证**：typecheck 绿；test/graph 1502=1487 pass/15 fail（**全为既有环境基线**：MCP daemon7/roots3/initialize2/Node26 CLI2/node:sqlite1，零新增）；钉桩面 451/451（3 个 pin 按翻牌语义重协商：kernel-decode drop-200→map-200、value-references×2 记录 fnRef 共发射事实【TS 裸标识符位 value-ref 先发赢 unique-index，边事实唯一不双发】、object-literal-methods 按该测试自带注释翻回 toContain('hardReset')/('fetchUser')）；kernel 电池 58/58；**parity 9 语言 exit 0 不回退**（refMissing/refExtra=0=fn-ref 双臂对称实证，含全语料扫同样 0/0；快照 cbench/kernel-parity/ksd-parity-p51-20260918.json）；新 test/graph/resolution-p51.test.ts 19/19（D7/D8/D9/FN_REF/卫生端到端）
- **主仓重索引 delta 归因**（83s；stash 往返 A/B：pre 码精确复现 P4 基线 128,799/336,220/266,188，post 码重跑字节同 302,312=确定性）：nodes 129,313(+514=本批自身语料) / edges **302,312(−33,908)** / unresolved **305,966(+39,778)** / stmt 67,155。edges−≈unresolved+ 镜像=D8 精度拒绝拆伪边：#915（file→import-node imports 边 15,644→1,598=−14,046；unres imports +13,065）+ #1714/shadow/sealed 裸调用拒绝（calls 边 −21,384 / unres calls +22,750，method-namesake 池 28,362 为上限）；FN_REF 新类：fnRef 边 +546 / function_ref unres 3,620（发射 4,166，unique-or-drop 精度门 by design）；**D9 收敛：self.* unres 2,494→711（−1,783）、this.x.y 4,320→3,732（−588）**、`().` +211=语料演进（本仓无 zustand，store-accessor 收敛≈0）；卫生：dup imports pairs 399→2（余 2=context/index.ts 双 import 语句跨 batch 边界，结果同旧行为）；**召回矩阵（matrix-d/f.sh）本地不可重放**=runner 依赖全局安装二进制重建（端点安全① CI-only/待授权）——parent 收口必办
- **P5-2 待办不变**：9 残留语言开路由决策 + semantics v5 bump + tb3/tb4-v2v3 re-baseline + tb5-v2/tb6-b 重放 + G 臂 12 格重放（需二进制）

### K-v2 P4：parity 重对账 + 挂账清账（2026-09-18，builder=P3 同 session resume，3 commits 未 push）

- **交付**（eafd28a3d 挂账接线 / 6609c4594 scala RAW / 本记账批）：① cargo test 21/21（N Rust 测试面 21=21 零缺失；N 根 13 vitest 套件需 N npm workspace=端点安全内不可跑，fork harness 全语言扫代位其双臂自洽证明）② takeDeferredPreParse 接线（kernel adapter 全 N defer-memo 形：route 点 preParsedSource+deferSlot hoist+export；wasm fallback 消费 sourceIsPreParsed——已路由语言恒等变换，P5 c/cpp 路由前置）③ collectObjectValueReferences vestige 终裁=删除（两臂均无调用点，覆盖⊆#693 行走 hook+extractObjectLiteralFunctions 臂）④ scala return_type wire=fork RAW returnTypeText 镜像（N kernel 用 #750 bare 形=全语言扫描唯一残差 1/430，torture.scala qualRet；parity 裁判=wasm 臂；D5 类偏差注释+上游反馈候选）⑤ harness knownExpectations 重写=全计数器归零守卫语义（剥除族预算退役；dispatch 的 params“11 终态”假设与“P4 保留 order known 项”预期均被实测 0 取代）⑥ kotlin/scala/dart 双臂 value_ref 形态实测=**字节一致**（edgeMetadataShape=0）
- **新基线**：9 路由语言 429/430 byte-parity、0 diff、1 合法 defer（tsx parse-error）、0 kernelErrors、exit 0；归档 cbench/kernel-parity/ksd-parity-p4-baseline-20260918.json（**取代 v4 时代全部基线**；short-corpus 5 语言 dart(7)/jsx(5)/kotlin(6)/luau(6)/scala(8)=语料覆盖事实非缺陷）
- **.node**：darwin-arm64 sha256=189f7f8217da58e09caff88e4712f572fe3dbe1999b5c29b4e1d33df69a73d4e（scala 修复重建，双落点一致，取代 51f20349；其余 7 腿仍待 parent CI）
- **主仓默认路由重索引**（92s 无卡死；强制全量路径=`CODEGRAPH_WASM_RELAUNCHED=1 CHIMERA_ALLOW_UNSAFE_NODE=1 bun src/index.ts graph index -f <root>`——bun 跑源码避开旧全局包混码与 Node26 V8 守卫，relaunch 在 bun 下错位故用守卫 env 跳过）：nodes 128,791→128,799 / edges 336,206→336,220 / unresolved 266,169→266,188 / stmt 66,725→66,733（vs P2 账面，<0.01%）——归因=本批自身 3 个 TS 文件的语料演进（tree-sitter.ts/kernel-index.ts/harness 皆被索引源码），kernel-vs-wasm 贡献≈0（与 byte-parity 一致）；4 file errors=nix 已知缺 blob
- **P5 待办**：9 残留语言开路由决策 + chain-form resolver 配套（#1683/#1496 消费端）+ import-binding/materializeFileLevelImportEdges 双发卫生 + semantics v5 bump + FN_REF_EMISSION_ENABLED 翻牌

### K-v2 P2：fork wasm 提取层升级到上游 N 终态（2026-09-18，builder，6 commits 未 push）

- **交付**（b1e732dd5 / 861ddbac0 / 2ee87c336 / b453778a1 / ef7b9d720 / 3f2445f5f）：① leaf 模块（function-ref.ts 新 vendor、tree-sitter-helpers #780、tree-sitter-types+valueReferenceTypes hook）② 语言面（19 配置采 N + 10 新语言文件 + astro/cfml/razor extractors + LANGUAGES 扩 13 成员 + grammars.ts N 注册表×fork cjs 多级加载器，blob 零新增——裁定⑤）③ 引擎 tree-sitter.ts = N 基底 + fork 补丁集全量重放（statement/value-ref D1 合并/params/RAW returnType/D3 稳定重排/D5 tsjs 作用域大写块/csharp returnField/fn-ref 门控休眠待 P5）④ index.ts cherry-pick #1728（info/exclude+excludesFile+嵌套剪枝，env.md 实弹验证）+ #1628 preload（.h→cpp+objc）⑤ P3 对表批：shadow-prune 改齐 kernel 公式（compute_shadowed_value_names 逐行镜像：decl>file??1、opens_binding_scope 七 kind 集、MAX 20k 预算、检查位=长度门后 dedup 前；纯局部单声明名保留）；params/returnType 与 kernel Extra 线字段逐条比对一致（200/2000/RAW-200-UTF16/jsx 排除/冒号剥离）
- **验证**：typecheck 绿×5 关口；wasm 臂（CODEGRAPH_KERNEL=0）聚焦套件 ~1150 pass/1 已知环境 fail（node:sqlite）；主仓重索引终态（wasm 臂，83s）：nodes 125,067→128,791、edges 262,211→336,206（+28.2%，N 特性族+prune 放宽纯局部名）、unresolved 213,767→266,169、stmt 66,725 存续、astro 7 文件新入库、nix 缺 blob 优雅降级实弹；semantics stamp 仍 v4（P5 bump）
- **窗口白名单（P4 对账）**：kotlin/scala/dart valueRef 双臂均发（P3 已落 N kernel value_ref）但形态待 P4 实测；chain-form refs（#1683/#1496）fork resolver 未消费→unresolved 挂账，P5 配套；fn-ref 双臂休眠（wasm FN_REF_EMISSION_ENABLED=false+kernel decode 丢 200）；**P3 收口后 kernel 臂仍双发 object-literal valueRef**（`{ fn }` → file+constant 双归属 ref，探针实证；wasm 臂单发 constant 归属=N #693 walk 语义、fork 钉桩测试 value-references 期望 1 边仅在 wasm 臂过）——codegraph-kernel/src/tsjs retrack×#693 walk 重叠，属 P3/P4 跟进面，P2 不追平；import-binding/re-export 与 materializeFileLevelImportEdges 双发实锤（单 import → file→symbol ×2 + file→file ×1，文件级 dependents 不重复）——P5 卫生批（parent 裁决仅记录）
- **遗留（parent/P5）**：takeDeferredPreParse 复用未接线（P3 kernel adapter 已落地 export 后 2 行回补——P3 收口后可做）；FN_REF_EMISSION_ENABLED=false 待 P5 翻牌（ReferenceKind+matchFunctionRef）；collectObjectValueReferences 保留但其 extractVariable 调用点由 N #693 walk 取代（覆盖为超集；P4 若 kernel 归属对齐到 declarator 单发则两臂收敛）；liquid/svelte/vue/mybatis extractors 按盘点保留 fork 版（其 F-vs-N 差=跳过的上游 bugfix 演进：svelte/vue 行偏移修、liquid #383 安全+shopify JSON、vue #629 模板组件——建议独立小批采纳）；主仓 .chimera 现为 wasm 臂内容（KERNEL=0 重索引，避免烘入 kernel 臂双发）

### K-v2 P3：vendored kernel re-vendor 到上游 N 终态（2026-09-17，builder，4 commits 未 push）

- **交付**（commit 1fbe50624 快速道 / 5c02e09d1 慢道 tsjs+docstring / f859f27d0 buffers+适配层 / 本记账批）：9 文件整体采 N（kotlin/scala/dart/lua/python/ccpp/java/rustlang/fnref，剥除回滚+N 17 机制随入）；textutil=N+push_json_string 保全；tsjs 两件 = N 基底重放 fork 五件套（statement 全套/value-ref D1 合并含 shadow-prune 吸收 compute_shadowed_value_names/params_json/RAW returnType 200/D5 大写块仅 tsjs），D3 interface 按 N 源码序（PendingInterface 移除，保序归 P2 wasm 重排），D4 docstring 采 N；buffers 双 append 终态 NODE_KINDS 24+EDGE_KINDS 13；kernel-decode.test 领先集归零 []+#808 断言改 property；langs/lib/Cargo.toml/grammars 零动作确认。**wave3 条目里的 quirk 对齐件已全部被本批推翻（路线 a）**
- **.node**：darwin-arm64 终态 sha256=51f20349eab67702af0f627da5efba701951c7b17dab2ffefc646ae7912dcd7c（P3 主体批 6e32fc67 → followup 中间态 ae458f80 → 本终态；staged+全局双落点一致，替 wave3 5e00fd19）；**其余 7 腿仍旧 kernel，8 腿 sha 不一致——parent 波次收口 CI 统一重编后才能发布**。cargo release 干净（3 条 N 自带警告）；kernel 测试族 58/58；typecheck 绿
- **窗口期 parity**（P2 在途，wasm 臂旧 oracle；快照 cbench/kernel-parity/ksd-parity-p3-window-20260917.json）：243 files/30 identical/0 defer/0 kernelErrors；fork 四资产保全：statementMissingInKernel=0（6555 全发射）、params drift 11=全为 #1638 interface 成员 kernel 富化方向、order 44=D3 窗口态、value-ref 冒烟+shadow-prune 实证过；白名单差=kotlin/scala/dart N 语义、ts #693 归属/chain 重编码/import-binding refs、lua 赋值式——P2 收口后收敛，P4 重对账
- **P2 协同四项**（已在 PLAN K-v2 章节入库）：VALUE_REF_LANGS 收窄 wasm 侧；shadow-prune 两臂同式（kernel 参考实现 tsjs/mod.rs）；wasm params/returnType 重放点对齐 kernel Extra；import-binding refs 回归后与 resolution 层双发核对（P5）
- **P3 followup（2026-09-18，P2 收口后钉桩修复，同波待推）**：① object-literal valueRef 双发修——extract_variable 的 pre-#693-walk collect 调用让位给行走 generic hook（单发 constant 归属，wasm oracle 已同构；collect_object_value_references 退役，wasm 侧同名 vestige 可 P4 清），② D3 decode 侧重排落地——kernel/index.ts POST_PASSES 注册 reorderInterfaceMembersToTail（typescript/tsx，contains-边判成员，rest.concat(members) 镜像 wasm extract() 稳定分割；raw wire 保 N 源码序），③ interface function-typed property 促升 method（extract_property 镜像 P2 wasm replay：resolveMethodOnType 只绑 kind=method，降级=丢 call binding）。终验：两红钉桩转绿，P2 钉桩面 451/451，kernel 电池 58/58，**parity typescript 199/199 exit 0 clean（全计数器归零，含 order 44→0、stmtWasm 6713 全发射），快照 cbench/kernel-parity/ksd-parity-p3-followup-ts-20260918.json**，typecheck 绿

### Rust kernel wave3：kotlin/scala/dart 字节级对齐 + 开闸（9 语言路由，2026-09-17）

- **交付**（commit 311bcd9cb、322208fe8、f384dbca1、a60e9f24d，未 push）：上游排查实锤——fork wasm oracle = 上游 pre-feature 版（kotlin.ts@34240eb、scala.ts@8506936、dart.ts@a2ed181，均早于 #708/#750系/#897），vendored kernel = 上游 HEAD R7b+stack-guard，**上游无任何对应旧 wasm 的 kernel 版本可移植**（上游 parity 测试断言的是新 wasm）→ 对账 = 剥离 post-fork 上游特性 + 复原 wasm 臂 quirk：returnType/type-refs/static-member-refs/valueRef 边/property+constant 节点/chain 重编码/literal-receiver skip/paren 转换/modifiers-descent decorates 全剪，scala val/var 改 nodeStack-kind 判定（object val = field）、scala returnType 改 RAW 文本、extends 只取首 named child 原文（dart 得到 `extends "with MixA"` quirk）、dart ctor 走通用 extractName unwrap（named ctor/factory = 以类名命名的 method，bodiless declaration-ctor 不可见）、docstring 换 fork 简化清洗器（`///` 保留第三斜杠）；fn-ref(200) 行保留但 decode 层本就丢弃
- **终表**：harness 21/21 byte-identical（dart 7/7=182/175/157 n/e/r、kotlin 6/6=61/55/285、scala 8/8=169/161/71；41 diff 族→0）；报告归档 /Volumes/workspace/cbench/kernel-parity/ksd-parity-20260917.json；DEFAULT_ROUTED 6→9；EXTRACTION_SEMANTICS_VERSION 3→4（保守 bump：语料短+重编二进制，按 route-change 条款）；.node release sha256=5e00fd19e293d5e31aac93ab085a07e3ba19552719c0e9be62f7231c4e0e62e8（staged+全局安装覆盖 72c5e790）；E2E：v3 旧库报 stale→index 重抽→v4 干净→query/callers 三语言功能正常；主仓冒烟 2,858 files、120,650/250,239 vs 基线 120,697/250,465，delta 全归因本批 .rs 自身删除的 ~40 rust 函数节点（已验证 flush_value_refs 仅剩 php/go/python）；wave1/2 抽查无回归（typescript 199/199，lua/luau 仅既有 acceptable 族）；kernel 测试 67/67、typecheck 干净
- **全量套件对账**：26 fail = 15 已知环境基线 + httpapi-config 8（**2026-09-02 起记录的既有簇**，见下方断言漂移条目）+ HttpApi SDK 2 + ModelsDev 2（后两者隔离重跑：ModelsDev 全过=套件串扰，SDK remote-compaction 1 条 stash 验证与本批无关）——零新增归因本批

### 发布面 kernel prebuild 批：8 腿矩阵本地 6 腿落地 + CI job，端点安全第二次触雷（2026-09-17）

- **交付**（commit b172de20d、679650bbe、7b4a98d64、922e2bc92 + 本批，全部未 push）：build-kernel.sh 多腿/zigbuild/glibc-2.28 钉版/musl crt-static opt-out（必须 CARGO_ENCODED_RUSTFLAGS，zigbuild 会掩掉普通 RUSTFLAGS）；build.ts copyKernelPrebuild 矩阵感知（kernelPrebuildPlatformDir，12 包→ 8 腿，baseline 共享产物）；publish.yml kernel-prebuild job（8 腿矩阵，continue-on-error，artifact 汇入 build-cli，kernel 永不闸发布）；loader 降级测试 +2（不可加载 catch 分支 + 假 triple 子进程探针）；选型实锤：zigbuild=linux 正解、cross 淘汰（无 docker）、cargo-xwin 拒装（红线）、win-gnu 被 napi-build libnode.dll 闸、**win-msvc 腿 napi-build 零额外输入（源码核实）= CI-only**；本地 6 腿 staged+格式验证（sha 清单/证据在 UPSTREAM_RUST_KERNEL_PLAN.md §2.3 增补）；typecheck ✓、46/46 相关单测 ✓、actionlint 零新增 ✓、--single 构建→tarball 静态验证 ✓（kernel sha 字节无损）
- **端点安全第二次触雷（用户投诉，纪律固化）**：npm 安装冒烟中执行 /tmp 新解包 bin/chimera 被 SIGKILL（exit 137；内容与 dist sha 一致——拦的是“新落盘可执行物被执行”模式）。本机硬纪律：① 任何新鲜构建/解包的可执行物一律不执行（含 /tmp、含全局路径）；二进制执行验证（安装冒烟、--version、graph 命令）= CI-only/待授权；② 安装流验证静态化：tar -tzf 清单 + tar -xzO 管道断言（零落盘）；③ zig 自托管子命令全家（objdump/ar/ranlib/dlltool/lib/rc）禁用，产物验证只用 file/shasum//usr/bin/objdump/otool/nm/strings；④ cargo zigbuild 编译+链接允许（全程零拦截）；交叉 .node 只验格式不执行；仓内 bun test（含加载 staged prebuild）既有允许不变。AGENTS.md 的 npm install 全局验证流程在受管机器上**不可执行**
- **待办**：CI 首跑（win32×2 msvc 腿产物 + kernel-prebuild 矩阵接线验证）；musl 实机 dlopen 验证（alpine）；Windows .node 是否纳入 Azure 签名清单（sign-cli-windows 只签 chimera.exe，parent 拍板）

### Rust kernel wave2：TS 开闸完成、微损归零、已推送（2026-09-16）

- **扩展 bench 终判（2026-09-17）**：核心矩阵 12/12 满分保持（kernel 时代零回归；Scope check 12/12 触发、tb5-v2 三格点名 size-table.ts）；探索扫描初判 1/13 全为 harness 假阳性（footprint BASE 取 reflog 尾=clone 点，晚于其的 5 个 fixture commit 使 21 文件恒被判越界），考证历史本意后修为“BASE=最新 reset:/clone: reflog 条目”（防线不减），12 个 verify.sh 修补+tb5-v1 陈旧 pin 重写+tb1/tb2 空行 guard 同族假阳性修复，双向 oracle 13/13 重验后**扫描改判 11/13**（重放本格 agent 实解：tb3-v1 pin1 真失败、tb3-v2 真 footprint 越界（新建 resolution 辅助文件，维持严判——任务意图是扩展现有机制非另起炉灶），余 11 格实解全部 PASS）；备份 v3=cbench-20260917.tar.gz（321MiB，含 repo-g .git 全量=fixture commit 链唯一存续处）。**kernel 战役主体完成**；遗留工单：wasm 返回类型 ref 双发卫生修（需 kernel 镜像同批）、~~kotlin/scala/dart 对账~~（✅ 2026-09-17 wave3 对齐+开闸，见顶部条目）、~~发布面 linux/musl/win prebuild+CI~~（✅ 2026-09-17 本地 6/8 腿落地 + CI job，见顶部条目；待 CI 首跑）、relaunch 姿态小修、tb4-v1 锚点统一（cosmetic）、dependabot 授权
### 第三波：G0+union 已推、Rust kernel 立项、bench 资产全恢复（2026-09-16）

已推 origin/main（..4354468b7 三笔）：G0 上游移植批（Swift regex hang 1043ms→0.03ms、tsconfig extends 丢边、name-lookup 索引 seek、git -uall、availableParallelism）、union 脱壳（initializedDb.close/find.focus 12 条全部翻正，实测 initdb_close 12→0）、UPSTREAM_RUST_KERNEL_PLAN.md（B 案绞杀者，P0-P3，待拍板 K1-K5）。

- **重索引假回归事故**：wave3 验证时 index -f 25min 不完（基线 79s），取证后确认=**环境 I/O 竞争**（bench 资产 builder 同期跑 bun install+1GB tar 备份同盘）；安静环境同二进制重跑 87s 正常。EXPLAIN 实锤 G0 的 lower() 形式 SEEK idx_nodes_lower_name（旧 COLLATE 形式全表 SCAN——fork 一直带着这个上游 bug）。教训：**索引计时类实测不得与重型 I/O 任务并发**
- bench 资产灾后全量恢复：17 任务×{prompt,verify} 齐备（字节级原物+双向回放 oracle）；repo-b 重建（shallow，HEAD 精确对齐，preload 修复）；repo-g 泄漏解答已清+status 空；备份 v2=489MB；遗留：repo-g 对象库 31 处 broken link（HEAD 树完好，runner 不受影响，可从主仓补对象；实验用 --depth 1）
- Rust kernel 双调研对表要点：kernel 同步调用设计→parse-pool 保留；值引用/接口成员/returnType 上游均有对应物（对账即可）；params_json 无对应物=唯一改 Rust 项（extraJson 补丁 tsjs 先行）；fork 无 EXTRACTION_VERSION 机制需 P0 新建；.node 旁挂有 @parcel/watcher+grammar wasm 双先例
- 主仓图终态：nodes 117457 / edges 241451 / refs 34332 / failed 195014

### 图召回+防御五路批次已推送（2026-09-15）

已推 origin/main（a84c65722..7b2969f01 五笔）：接口成员建节点、name-matcher await/type_alias/barrel、WAL valve+parse-pool 卡死防御、LSP typeDefinition+全操作 10s 超时、ProjectionMemo revision 键修复（后者根因：memo 仅按 node id 键，trackToolMutation before/after 跨 sync 复用陈旧冻结对象 → 语义 diff 自比恒空，自 9e1766eb6 起 MMS/MF/MCC 事实全部静默退化为 body；test/tool/chimera.test.ts signature-delta 用例即其回归锚）。

- 主仓重索引实测：114s 无卡死（WAL 防御生效实证，此前 763/2771 处挂死 8min+）；节点 117312、边 222764→240404（+7.9%）、references 29012→34150（+17.7%）、unresolved failed 207271→195608（−11663）、getNodesInFile 类失败 109→0
- 已知环境失败基线更新：**15**（MCP daemon×7/roots×3/initialize×2/Node26 refusal×2/node:sqlite×1）——pr19 pragma 已修（期望对齐 64MB/256MB 默认）
- 集成四目录（graph+chimera+tool+lsp）终态：1957 pass/15 fail，~7min
- 残量缺口状态（2026-09-16 更新）：同名类消歧 E2/E5 已做（三层保守排序）；db.* 大桶经逐站点分诊证实为不可救（外部 bun:sqlite 类型/无注解回调参数/union/ReturnType 别名）；真缺口 cg.* 簇已修（见下）；仍未做：for-of/构造器参数属性证据、union 脱壳（X | null）
- LSP 工具已转正（用户拍板，d5921900c 已推）：registry.ts 无条件注册 tool.lsp，core 旗标表条目保留减上游漂移；验证 typecheck+registry/parameters/lsp 104/104+prompt 79/79

### 第二波：残量召回+Scope check 抑制修复，G 臂 12/12 满分（2026-09-16）

已推 origin/main（d5658fa01、a1050a08b、149c5564a）：

- **残量召回批次**（d5658fa01）：点号工厂证据（`x = [await] Class.m()`，主仓 cg.* 失败 291→5）、import type 默认导入+动态 import 补充（纯 ALLOW 向）、闭包外层参数行走、同名类三层保守消歧；unresolved 再 −868、references +142；重索引 79s
- **Scope check 抑制修复**（a1050a08b）：G 臂 recall-post 轮 tb5-v2 3/3→1/3 回归的根因——declared scope 把 predesign 全部模糊种子（searchNodes 文本命中含 import/stmt 节点）的文件都算已声明，召回富化后 `searchNodes("renderSize")` 命中 size-table.ts 的 import/stmt → 两跳隐藏面被吸收进 scope → 深度消费者提示静默消失。修复=declaredScopeFiles 只认定义类 kind+精确符号名/声明 nodeID。教训：**图富化会改变下游模糊匹配语义，enrichment 批次必须跟 bench 回归**
- **G 臂 n=3 终局 verdict：12/12 满分**（tb5-v2 回 3/3 且三格 Scope check 均点名 size-table.ts；tb6-b 保持 3/3；零噪声零拒改；results-recall-post3）
- **bench 资产事故与迁移**：用户自建 tmp 清理任务 03:42 吃掉 temp 里的 cbench（tasks 全清、repo-g .git 部分损毁）；已字节级恢复（verify.sh 从 session DB 找到创作会话 write 原文=原物，60 历史格回放 cmp 一致；repo-g 99 blob 以精确原 hash 重建，HEAD 7c4366f0 保留）。**cbench 永久家目录=/Volumes/workspace/cbench**（脚本 B= 路径已批量更新），备份 /Volumes/workspace/cbench-backup/cbench-20260916.tar.gz（1.0GB）。教训：临时区的东西被第二次引用就该搬家
- 遗留：repo-g 深层历史 14 commit 后断链（bench 不受影响，可从主仓回灌）；repo-b 未修（B 臂要用先修 node_modules）；13 个旧任务目录未重建（tb1-*~tb5-v1，session DB 有原文可按同法恢复）；Node 26.3.0 非 LTS 警告（索引成功，建议 bench 环境切 Node 22）；dependabot 14 漏洞待用户决定是否排批次

### P0 plan: aijws/grok-4.5 thinking intensity (DONE)

Status: implemented and verified 2026-07-14.

Changes:
- `chimera/packages/chimera/src/provider/transform.ts`
  - `grokReasoningEfforts` / `isGrok45Family` / `grokEffortOptions`
  - variants: grok-4.5 family → low/medium/high
  - options default high for grok-4.5
  - discovery without reasoning still allowed for grok effort models
- `chimera/packages/chimera/test/provider/transform.test.ts` aijws/xai/openrouter coverage

Verify:
- `bun test --timeout 30000 test/provider/transform.test.ts` → 173 pass
- `bun typecheck` → pass

Out of scope (P1 later): Ultra multi-agent, llm.ts codex decoupling.

### Parked: 多会话编辑冲突感知（edit intent claims）

Status: 设计 v2 已完成并获用户认可（2026-08-31），**挂起等待用户完成上游同步**，用户说"我完成了来告诉你"。

核心决策：
- 基于 chimera_predesign 做文件级 edit-intent claim（advisory，非硬锁），存项目级 codegraph.db 作为 CHIMERA_STORAGE_EXTENSION migration v5
- claim 必须有显式释放信号（closeout 挂钩 + 会话 dispose），TTL 只作崩溃兜底
- 等待模式 L0：agent 完成无冲突批次后 park 并报告阻塞点，由用户消息驱动继续；L1 释放通知走 prompt-context.ts 注入；L2 依赖上游 background subagent 模式（当前 checkout 无此实现）
- 分期：P1 核心闭环 + P2 呈现/教学（纯 fork 文件，零上游冲突）可先行；upstream-derived 文件的 advisory 和 L2 等 sync 后

回来时注意：sync 后行号锚点会漂移，需重新核实集成点（store.ts / provenance.ts:801 门禁 / prompt-context.ts / edit.ts:262 / write.ts:55），再出 P1 实现计划。

### 全量测试耗时基线（2026-09-01 实测）

loop 挂起修复前的对比基线（本机 macOS, bun 1.4.0, `bun test --timeout 30000` @ packages/chimera）：
- 325 文件 / 4606 用例 = 2888s（~48min），90 fail + 15 errors；失败用例烧时 1240s（43%），通过用例 1142s
- 大头：session 1303s（prompt.test.ts 698s/33fail + processor-effect.test.ts 463s/16fail，loop 挂起每个烧满 30s）；server 310s；snapshot 266s（0 fail，固有）；project 245s；graph 226s
- 独立故障簇：graph/mcp-daemon.test.ts 7/7 挂 ×10s=73s（待查环境性/真回归）；prompt.test.ts 另有断言漂移——运行时上下文注入完整生产模型目录而非测试 fixture 的 test-model（subagent routing 系列提交后测试未更新）
- junit 原始数据：<tmp>/chimera/junit.xml
- loop 修复落地后重跑一次全量对比；若仍 >25min，剩余大头是 snapshot/project/file 等固有集成成本（真实 git/HTTP server），可考虑分片

### effect beta.83 升级挂起已修复（2026-09-01）

- 根因：升级只 bump 了 effect，漏了 catalog 里的 @effect/platform-node / @effect/opentelemetry（停 beta.57）；beta.57 的 NodeHttpIncomingMessage.text 调用已在 beta.83 移除的 MaxBodySize.asEffect()，测试 LLM server req.json 同步抛 TypeError → 框架 500 → 客户端 5xx 无限重试 → 测试 30s 超时。
- 修复：根 package.json catalog 三件套对齐 beta.83（platform-node、opentelemetry，并新增 platform-node-shared=beta.83 + overrides 钉住，防止 ^range 漂到 4.0.0-rc.112），bun install 更新 lockfile。与上游 opencode 版本组合一致。
- 验证：prompt.test.ts 75/75（基线一致）；test/session 465 pass / 1 fail（唯一失败 compaction 'stops quickly when aborted during retry backoff' 在 beta.59 基线同样失败，既有时序敏感问题）；bun typecheck 通过。
- 待办：基线节提到的'修复后全量对比'尚未重跑（session 目录已从 ~1300s 降到 ~300s）。

### 断言漂移调查（2026-09-02 已解决）

根因：`test/provider/amazon-bedrock.test.ts` 的 bearer-token 用例把 bedrock api key 写入共享 auth.json；bedrock loader（provider.ts，有 TODO 自认 hack）在 list() 读路径把 `process.env.AWS_BEARER_TOKEN_BEDROCK` 永久写进进程且从不删除 → 后续所有测试文件的 Provider 状态从 process.env 拷贝 → bedrock 全量 fixture 模型进入 subagent 目录 → 4000 字符预算截断 test-model → prompt.test.ts 两个断言漂移。修复=该测试 finally 恢复/删除该环境变量（全套件漂移已归零）。
同日修复：43135ac3f 手写迁移 share_url 对 fresh DB 报 duplicate column → db.ts 改为导出 `Database.applyMigrations` 两段式（主链 + 按需 repair），json-migration.test.ts 已切换到共享函数；db.test.ts 加了 fresh-DB 迁移回归用例。
最终全量（2026-09-02）：4624 用例/326 文件 = 1651s（~27.5min），30 fail（剩余为既有簇：graph/mcp-daemon 7、mcp-roots 3、httpapi-config 8 等；tool/chimera 1 与并发进行的工具自愈改造相关）。
遗留：bedrock loader 生产侧仍写 process.env（建议改 providerOptions 传递）；漂移测试固有脆弱（providerCfg 含 openai，mergeProvider 附加语义拉入全量 fixture 模型，fixture 变大可能再超 4000 字符预算）。

### 工具自愈改造（2026-09-02，已提交 e724db0f55 并推送）

- 针对'工具把机械恢复外包给模型'的系统性修复：chimera_search per-term 保底配额（mergePerTermCandidates + applyFinalWindowQuota，queries.ts）+ searchNodesDetailed 遥测（terms/total）；edit hashline 锚点唯一内容匹配自动重定位 + 报错事实化；write 输出自带 hashline 锚点块；chimera_impact 无 seed 时返回候选事实列表；4 个工具描述同步收窄。
- 既有失败与本改动无关（stash 验证）：chimera.test.ts 'preserves caller relation evidence for signature deltas'、node-sqlite-backend getBackend 断言。

### 上游 v2 底座迁移（进行中，2026-09-04）

- 计划书：`UPSTREAM_V2_MIGRATION_PLAN.md`（根目录）——背景、决策、各层细分计划、验收标准、预存失败清单都在里面
- 进度：L0 ✅（grep 权限修复+codemode）→ L1 ✅（Effect beta.83 + schema/protocol 包 + 插件 v2 host）→ L2 ✅（LayerNode 子集 + effect-drizzle-sqlite）；L3 ✅ 完成并已提交 608804036f（2026-09-04：SystemContext 引擎 + session_context_epoch 表/手写迁移 + 提示词装配 Source 化（config flag `experimental.system_context` 默认关，关时字节不变）+ v2 事件契约收编 @opencode-ai/schema），验收细节见计划书 L3 节。五线程工作区已拆分提交：2df4a79094 graph needsMigration 防线 / faf8a419df 调度二期+遥测 / c3411251ed free_models / bf2a2ceeb8 newweb bump / 4354ec94f9 vendored 脱敏 / 608804036f L3 / memory pad 收尾——共 11 个提交已全部推送（2026-09-04：root 至 825f155380，pre-push 全仓 typecheck 17/17 绿；newweb 子仓 12 个提交至 28db62cf 推 logic10492/chimeraUI origin）
- 下一步：SDK/OpenAPI 需重生成（v2 事件漂移，跑 `./packages/sdk/js/script/build.ts`）；newweb `bun run api:inventory:update` 待 root `bun dev generate` 验证自愈后补跑；L4+ 再评估上游 registry 全家桶；GitHub dependabot 报默认分支 11 个依赖漏洞（4 high，预存未处理）
- 硬约束：逐层绞杀、每层树常绿可回退；子代理调度按下方"子代理调度新规"（旧"实现子代理只用 kimi-k3"约定已废止）；探测用 swarm
- 关键坑：上游仓 /Volumes/workspace/opencode（只读）；app-node-builder 是注入式签名（与上游不同）；drizzle-orm 双版本并存是有意的（catalog beta.19=v1 存储，rc.2=effect-drizzle-sqlite 包内固定）；drizzle-kit generate 被 20260714 损坏 snapshot 卡死，迁移手写

### newweb 上游追平（OpenCodeUI v0.6.23→v0.6.45+，221 commits 已归 13 链，2026-09-01 起）

- 上游 = lehhair/OpenCodeUI；packages/newweb 已配 upstream remote 并 fetch 全部历史/tag（`git show upstream/main:<path>` 读上游文件；分叉无共享历史，不可常规 merge）
- A 层 ✅ 已提交（dc0373cb..1aa61ccc 共 4 个，在 main 并已推 origin）；B 层 ✅ 已提交（2026-09-03）：b13e4972 请求风暴（87cfc67f+59be1a8d，isSameBusySessions + missingSessionsKey/inflight/failed refs）；09996a7d 链8 折叠阈值（--fs-base 替代 parseFloat(lineHeight)）+ useDisclosureScrollLock/scrollUtils；df07061a messageStore dirtyParts（d7fbb16b+3619a014+90e2b4d1，与上游终态逐字节一致）；28e191b4 链4 流式性能包（b86fd0a8 删同步高亮 / 3f689a5e+cd67ebf6 SmoothHeight rAF+contain-layout-style / 26b5c149+b1aae0e4 overlayScrollbar / 395830b6 DiffViewer/InputBox/CSS 收窄）
- C 层 ✅ 已提交（2026-09-03 第二批，main 到 4be35bf6）：8c501086 设置搜索（913d949e+fd1de693+dba66d9a 部分，catalog 已覆盖本地 compaction/providers tab）；880ac926 文件内容搜索+拖拽@mention（601df2c7+0d9e04c1，find.text 走本地 ApiScope）；8b4c5e70 MCP resources（cd0b7473，SDK 1.14.41 实际路径是 experimental.resource.list）；4be35bf6 useAutoRefresh（b5fccbac，接本地 registerSessionConsumer 事件总线）。注意 components.json/FileExplorer.tsx 是共享文件：mcp locale 键与 consumerId 行随 880ac926 提交
- 验证基线（C 层后）：typecheck ✓；eslint 0 err/9 warn（全既有）；test:run 609/610——唯一失败 openapi-inventory 是环境性：root 仓 v2 迁移 WIP 使 `bun dev generate` 在 graph/errors.ts:150 解析崩溃（干净树 stash 复现确认），root 修复后自愈。server-workflow-closure 的 find.text claim 已按 AGENTS.md 规则 flip 为 true（C2 上线了该调用）
- **api:inventory:update 当前不可用**：写模式校验 resource.list 不在内嵌 OpenAPI 快照里（快照过旧），而刷新快照依赖 root 仓 `bun dev generate`（WIP 损坏）→ 等 root 修复后统一跑 `bun run api:inventory:update` 把 searchText/resource.list 收进 api-call-inventory.json
- D1 ✅ 已提交（1e6cb7f6）：markdown 管线整换到 a9e77077 终态 + b1aae0e4 回补；依赖 +marked 18.0.5/+morphdom 2.7.8/+dompurify 3.4.11/+@types/dompurify 3.0.5，-streamdown/-@streamdown/math；双锁文件已手工同步；vite/vitest define+worker es 已配；测试重写 3+新增 2。D5 ✅（1e0e75eb）：HTML 沙箱预览 9 提交链，安全模型逐字核对，acc1b7c9 artifact 测试 hunk 已回补；刻意排除 c885c606/87eac61d/HtmlFilePreviewFrame（文件管理器 HTML 预览）。D6 ✅（28db62cf）：shiki 主题用户化，亮/暗独立，settings search 目录已补，备份兼容；bedb7695/e1303d93 判定正交未带。另 c639f8b3 = AGENTS.md 坑位文档。D3 ❌ 不追（多服务器，链6 随之搁置）——D 层拍板至此全部落地
- D2 ❌ 不追（2026-09-03 拍板：机制对比后留自研页块架构——性能够用且零黑箱可测，上游虚拟化 v5 仍有 revert 史+私有字段强转；代价=上游滚动修复以后手工移植；D4 随之搁置）。机制对比结论与 D1 采纳点（a9e77077）在 scouting 报告，关键数字：A 测试 705 行 vs B 1402 行
- 验证基线（全部完成后，main=28db62cf）：typecheck ✓；eslint 0 err/7 warn（全既有，比 B 层时还少 2）；test:run 703/704——唯一失败 openapi-inventory 环境性（root WIP 使 bun dev generate 崩，root 修复后自愈，且自愈后需跑 `bun run api:inventory:update` 把 searchText/resource.list 收进 baseline）
- **root 仓待办** ✅ 已落地：newweb 指针 bump（1aa61ccc→28db62cf）+ bun.lock markdown hunk = bf2a2ceeb8；schema lock 行随 L3 提交 608804036f
- 剩余可摘（Wave E 候选，未批准）：markdown 管线对齐 upstream/main 的 post-D1 perf 链（bedb7695/e1303d93/79458770/b647f5dd/10d07ce7/6aad61d3/9fb2d094/43a0b7e4/5602e384）；c885c606 fenced 语言预览；87eac61d 交互式 SVG+主题变量；HtmlFilePreviewFrame 文件管理器 HTML 预览；c9441219 已随 D2 不追而废
- 移植注意（下轮接管用）：SidePanel/activeSessionStore/MessageRenderer 本地已非 v0.6.23 基线，适配勿整替；`git diff v0.6.23 -- <path>` 查本地定制；markdown 管线文件现在的对齐点是 a9e77077+D5+D6 精选集，查差异用 `git diff <那个组合> -- <path>` 而不是 upstream/main
- 明确不采纳：链6 单独、7c7a47ef（本地方案不同）、Tauri/Docker 本地已分叉、上游默认值调整
- 遗留：scrollUtils.ts 未含 scrollItemIntoView（C1 在 SettingsSearch 内联了私有副本，若移植 eca03f24 需合并）；allowStreamingLayoutAnimation 全链默认 false 是上游 intended，视觉回归需人工过一眼；D6 主题切换建议浏览器冒烟（worker lazy-load 在真实环境未验）
- 并行 worker 教训：共享文件（FileExplorer/components.json）会撞车——C2/C4 撞出语法错误（已修）、C2 移植丢了 search({createPanel}) 接线被 CodePreview 测试抓住（已恢复）。派波次时共享文件要并组或显式点名
- 坑：① newweb 里 `npm install` 必崩（node_modules 是 bun symlink，npm 11 arborist edgesOut bug）→ 锁文件手工补丁 + bun 管安装；② 交接前必须 `bun run typecheck` + `bun run test:run`（drift 环境性失败见上）；③ chimera server 面变更后要 `bun run api:inventory:update`；④ 本地依赖全部锁精确版本

### 子代理调度新规（2026-09-03 用户谕示，覆盖此前所有约定）

- subagent 全面禁用 kimi-k3（root 会话是 kimi-k3，子代理一律改用别的）
- builder 选型原则：大模型（L/XL）用低档思考（variant low）；小模型（flash 级）用高档思考（variant high）；显式传 model+variant，不让调度器自动补
- scout/探测：workload=scout 让调度器选（当前 pick deepseek-v4-flash low），仍可用 swarm
- 旧约"实现子代理只用 kimi-k3 且必须显式 variant: high"（上游 v2 迁移条目，2026-09-03 早些时候）自此废止
- 根 AGENTS.md 调度行已按本新规改写（2026-09-04，随 faf8a419df 提交）
- 2026-09-04 用户谕示增补：qwen3.8-flash 仓库理解有严重缺陷，禁作 scout（scout 结论无下游复验），builder 保留（大模型收尾）。NL2Repo-Bench 无稳定长期指标获取办法，按配置化处理、不改评分锚点。机制=新增 archetype 级 `delegation.scheduling.archetypes.<workload>.excludeModels`（条目精确匹配完整路由 provider/modelID、identity 或 providerID；调度候选过滤 exclusionMatch/resolveSchedule + 显式派发 prepare 强制报错，resume 除外；不依赖 scheduling.enabled）。实现：src/config/delegation.ts、src/agent/subagent-model-scheduling.ts、src/agent/subagent-dispatch.ts + task.test.ts/scheduling.test.ts 用例；全局配置 ~/.config/chimera/chimera.jsonc 已写入 scout 排除 ["qwen3.8-flash"]（生效需跑新构建）。SDK v2 gen 的 DelegationScheduling 类型随既有“SDK/OpenAPI 重生成”待办一并更新，本次未单独跑。

### 工作区核对修复（2026-09-04，已提交）

- 五线程工作区审查发现并修复三处编辑事故：processor.ts text-start case 外不可达死代码残留（删除）；revert.ts v2 事件块误带重复 sessions.setRevert（删除重复，保留原调用+新事件）；resolveSchedule 误删 suppressed/dormant 路由过滤（恢复+补回归测试 test/agent/subagent-model-scheduling.test.ts）。processor/revert 修复随 608804036f、调度过滤守护+回归测试随 faf8a419df 提交

### 上游特性同步 F 线：分诊完成（2026-09-04，文档未提交）

- 388 feat（v1.14.40..9f69463f1d）全量五分类：①可直搬 12 / ②需适配 66 / ③fork 已等价 11 / ④无关 288 / ⑤已同步 11；安全关键词 fix 43 条横切审计：无 P0、fork 需修 5 条——**P1 `08faeb3893` #43675 run 模式子代理权限应答被 sessionID 过滤丢弃→run 挂死**（run.ts:570-590，~10 行，headless/CI 高危）；P2×4 a9c810cbbc（$ARGUMENTS 双重注入）/c035c35eba（坏 JSON 崩启动）/dc978cb889（id 校验）/3a4c253969（textVerbosity 中继注入）。另高优 `ae92f3158f` Copilot token 计费（上游 API 已切换、fork models.ts 旧 schema，现网风险）
- 落地文件：`UPSTREAM_FEATURE_TRIAGE.md`（新增，逐条明细/落点/适配点/排除证据/11 项产品决策清单/fix backlog 方法学）+ `UPSTREAM_V2_MIGRATION_PLAN.md` 新增「上游特性同步（F 线）」章节（F0~F3 批次+L4/L5 并入项），状态行已同步修正为已推送
- 建议顺序：F0（~1 天）→ F1（3-5 天，Copilot 计费提到最前）→ 产品拍板 11 项 → F2 MCP 专项（~1 周，8 条一次做完防反复冲突，含 a131811cdc 命名契约变更须同批）→ L4（llm 族 15 条随整包吸收；03afae5b95 v2-compat 打头阵）→ F3 TUI（~1 周，路径映射 packages/tui/src↔src/cli/cmd/tui，优先 fix 主题 C/B/G）→ L5
- fix backlog ~910 未逐条：无关表面 ~427 封板；core 相关 ≈374 随批次消化 + L4 开工前关键词筛（crash/hang/loss/leak/corrupt/race）防漏 P1
- TUI 同源判定：fork TUI 与上游同源但结构性分叉（@tui/* 别名+专有模块；上游独有 diff-viewer/command-palette 等）→ feat(tui) ②17/④10，无①直搬项；desktop 39 全④（7 条壳级基建可复议）；app/ui/i18n 125 + stats/go/console/web/nix 53 + acp 12 全④（acp=既有拍板）
- 分诊来源：6 个 swarm 代理（reviewer=qwen3.8-max medium ×3 一次成功；scout 首派 muse-spark 区域不可用失败，重派 deepseek-v4-flash low ×3 成功）；报告全文在本会话 tool-output（会话级存储），结论已全部落入两份文档
- F4 后台子代理决策简报完成（2026-09-04，reviewer qwen3.8-max + 2 深读子代理，锚点已复核）：**关键修正=task_status 轮询已被上游删除（dabf2dc013），终态=task(background=true)+注入驱动自动续跑；全链 12 提交非 3 条**。提案：P1 最小闭环 ~3-5 人日（引擎子集+task 参数+config flag 默认关+级联取消，无新表无新事件，与 F2 并行）/P2 并入 L5 或排后（swarm 状态通道被 prompt.ts:684 门挡、预算借用前提冲突）/P3 与 F3 合并（promotion+claims L2，**claims L2 仅依赖 P1**：inject=挂起设计 L1 pull 注入缺的 push 通道）。九拍板点见 TRIAGE §10.5/计划书 F4 节；简报全文=会话 tool-output ses_f8597876bffe4nWvyOGOp2V9Ot
- F4 拍板（2026-09-07 用户谕示）：**做、默认打开（kill-switch，有问题就修）**；④锁死自动续跑；⑤background_concurrent 上限随 P1 落地、级联取消=是；⑧claims 解冻（P1/P2 与 F4-P1 并行，L2 等 inject）；②③⑥⑦⑨按建议。用户用例新增两条 P1 需求：**面向模型的 cancel 表面**（first-wins：N 路探查任一早回即取消其余）+ **会话可寻址 inject**（跨 thread claims 释放广播唤醒；跨进程唤醒=claims L2 开放问题，需 poll→inject 桥）。flag 命名建议 delegation.background_subagents 默认 true。拍板记录全文=计划书 F4 节/TRIAGE §10.8；日期勘误：分诊与简报实为 09-07（文档误标 09-04 已修）。下一步待用户发令：F0（5 修复）+ F4-P1（按拍板 spec）派 builder
- **F4-P1 完成（2026-09-07，未 commit）**：四阶段串行 builder（deepseek-v4-flash high）+root 逐阶段复验。落地：background-job 引擎（内存注册表/limit 拒绝不排队）、task background 参数（kill-switch 关时 schema 换窄字节不变）、会话可寻址 injectSynthetic（claims L2 可直接复用：SessionPrompt.Service.injectSynthetic({sessionID,text})）、task_cancel 工具（归属守卫+幂等）、run-state BFS 级联+session.remove 清理、backgroundTasks prompt-context section（无 job 零字节）。**偏差已认可**：后台 run 不经 DelegationLimiter（background_concurrent=16 独辖，不蚕食前台 128）。验证：F4 家族 113 全绿+typecheck 绿+session 495 pass（唯一失败=预存 compaction 时序）；矩阵 A 注入×compaction 完整 E2E、矩阵 B ultra 剥离锁定。工作区共 35 文件未 commit（3 文档+F0 7 源+测试+F4 四阶段）；建议提交拆分：F0 一批、F4-P1 按四阶段或合一、文档一批。下一步：F1/F2/claims P1P2 未启动；P2 等 L5；P3 等 F3
### chimera web SIGKILL（2026-10-08，已诊断+修复）

- 现象：`chimera web` → `Chimera binary terminated by SIGKILL`（wrapper 报子进程被 SIGKILL）。
- 修复（已随 2026-10-08 工作区批次提交）：build.ts:358-371 darwin 目标 Bun.build 后 adhoc 重签（codesign --sign - --force）+ 磁盘校验，坏签名当场构建失败；签名后到打包零字节改写（assert 只读、wasm/kernel 为兄弟文件、bun pm pack 原样归档），smoke test 在重签之后。
- 审计实测（同日）：dist=tarball=全局安装 sha256 三处一致（713907040e…），两副本 codesign verify 通过、kernel .node valid、--version 正常、web HTTP 200+真实 WebUI 首页。死因=内核对坏内嵌 adhoc 签名 SIGKILL，wrapper（bin/chimera spawnSync）报 terminated by SIGKILL。本机链路结论：修复有效。
- P0 红线（已处理，同批次采纳 process.platform==='darwin' 门控）：publish.yml build-cli 在 ubuntu-latest 无 --single 跑全矩阵（:177/:210/:231），Linux 无 codesign → 门控后本机/macOS runner 构建保持重签+校验、Linux 交叉编译 darwin 腿跳过；CI 侧 darwin 签名保护欠账留给 rcodesign（随发布链断链修复批次，见下条）。
- 既有断链（先于本 diff；966db1b68 scoped rename 2026-08-08 后零 release tag、origin 无 ci/dev/snapshot 分支）：① artifact glob dist/chimera-darwin*（publish.yml:222/243）不匹配实际 dist/@coding-chimera/…；② build.ts release 块 archiveName 含 scope → 归档父目录不存在必失败；③ publish.ts:115-122 期望路径与②产出互斥；④ sign-cli-windows 文件清单同 glob 断。完整发布链 rename 后疑似从未跑通，待真实 CI run 定论。

### dependabot 产品树安全批（2026-10-08，同 session）

- **已修**：mcp-sdk 1.29.0→1.31.0（GHSA-6qxp OAuth 凭据外泄，high；**fork dist 补丁已重放到 1.31.0**——11/13 文件净命中，auth.js 两臂各 1 hunk 因上游 issuer 绑定重排而手工移植 determineScope 调用；未来每次 SDK 升级都要重放补丁，会话过期恢复/offline_scope 是运行时承重行为）；solid-js catalog 1.9.12→1.9.17（带动 seroval/seroval-plugins 1.6.8，清 critical+high，全 solid 工作区含产品）；overrides 新增 proxy-addr 2.0.8/shell-quote 1.11.0/source-map-js 1.2.2/http-cache-semantics 4.3.0/undici@^5→7.30.0（消灭 @actions/github 的 5.29 脏腿及其 busboy 2.1.1 子依赖）/react-router±dom 6.30.6（console/mail @jsx-email 腿）；devalue override 5.9.2→5.9.4。验证：typecheck 绿+test/mcp 43/43+ACP+system 172/172+补丁在 .bun store 实际生效；lock 内网源计数=0。
- **关键事实**：GitHub 19 告警无 API 通道可拉（本机无 gh/token），改用 npm advisory bulk API 扫全 lock（命中 64 条包级别）+ bun.lock parent/child 键手工归位；undici 6.28.1/7.30/8.x 腿全部干净，唯一脏腿是 @actions/github 的 ^5.28.5。
- **待办（另批）**：web 文档站 astro 家族（含 astro<7.2.8 critical RCE——需 astro 7 迁移，连带 h3/srvx/devalue/smol-toml/sharp 腿）；sharp 0.35（miniflare）；fast-xml-parser 5.x（aws-sdk major，XMLBuilder 路径无人用→低风险挂账）；braces（上游无修复版本，不可修）；sprintf-js（无修复版本）；aws-sdk v2（sst 拉入，EOL 类）；katex 0.18（newweb 自钉 0.16.38，低危）。@opentui/solid 钉 exact solid-js 1.9.12→lock 新增嵌套腿（其 seroval 已被全局 override 盖住，无漏洞腿）。