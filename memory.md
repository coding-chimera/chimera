# Temporary Memory

This file is a temporary cross-session memory pad for this checkout.

Use it for short-lived notes that should survive context resets or handoffs while active work is still in progress. Prefer permanent documentation, issue trackers, or code comments for durable project knowledge.

Guidelines:

- Record only concise decisions, pending local context, and handoff notes.
- Remove stale entries once they are resolved or no longer useful.
- Do not store secrets, credentials, tokens, private keys, or long transcripts.

## Notes

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
- F4-P1 阶段 4（收尾）✅ 已完成（2026-09-08，未提交）：prompt-context "Background Tasks" runtime-context section（prompt.ts runtimeContextSections 新 key `backgroundTasks`，kill-switch 开 && 本会话有 running job 才发射，serviceOption(BackgroundJob.Service)）；task.ts freshStart 容量预检移到 materialize 之前（超限不留孤儿会话）；injectSynthetic 会话不存在改类型化 NotFoundError（不再 Effect.orDie），task.ts notify 三处 Effect.ignore→Effect.ignoreCause({log:true})（beta.83 无 ignoreLogged）；run-state/session 尾部空行清理（cosmetic）。新增测试：test/session/background-tasks-context.test.ts（发射/不发射/kill-switch 字节稳定）、inject-synthetic.removed 会话 typed-not-found + notify 吞 defect、inject-synthetic 注入×compaction 边界两侧 E2E（llm.hold 栅门）、task-background 超限不建会话 + ultra 显式拒绝 + parent-ultra 剥离。验证：typecheck 绿；F4 全家族 107 pass；test/session 495 pass/1 fail（compaction 'stops quickly when aborted during retry backoff'=memory 已记录的 beta.59 基线既有时序敏感失败，A/B interleave 证实两树同败）；test/chimera 33 pass；tool.chimera 1 条预存失败照 old 清单。predesign_215fa11fcf145101 / audit_b3c0733a6940b5db、audit_66411680ae9b73f6、audit_aaeab1fee6da4988。下一接力：阶段 5（如有）或提交（不 commit 约束已解除待用户发令）

### F1 批次完成（2026-09-08，本地 8 commit **未 push**——用户指令禁 push）

- 8 commit：7dd57693a 图片缩放+seeding / 5571bb670 headerTimeout / 9fd39ccb9 HTTP 压缩 / aaddd6fbb CLI 双件 / 0efb73724 插件三件套 / 3c396f636 mantle+Cohere / 8674add7f Copilot 计费+tiers / b6a42ec70 SDK v2 重生成（L3/F0 既有漂移一并结清）
- 拍板：worktree 命名 9b7b6cb30f N/A 跳过；M10（f1407e41c4 copilot itemId 键改名）转独立 backlog；Cohere citation_options 随上游 db9391e8a6 回退同步删除；headerTimeout ResponsesTransport 不透传；tiers subagent 仅类型透传；small_model hook 完整移植；Modal 不预置模板
- 验证：typecheck 0（chimera+plugin 双包）；集成门禁 session+provider+agent 48 文件 1217 pass/1 fail（对账表预存 compaction abort flake）；各波聚焦测试全绿；终态 build --single --no-webui ✓（**未运行新二进制**，photon wasm 运行冒烟留给用户）
- 事故与清理（已沉淀 pitfalls #30-33 + #1 第二实例）：I1 手动中止留半编辑态→同 task_id 续派完成；edit 锚点事故吞 env 行→mcp-add 子进程一度污染真实 ~/.config/chimera/chimera.jsonc（mcp.github/local）→已精确清理复核；bun.lock 内网镜像 URL→空串槽脱敏协议；progress.md 已勘误 patch1（旧记录 patch2 不准）
- 权威记录：计划书「F1 完成记录」节 + skill progress.md（已全量刷新）；（上方 F4-P1 两条的“未提交”标记已过期，a143b3c23 已推送）
- 下一接力：F2 MCP 专项（8 条一次做完）∥ claims P1/P2（5 锚点需重核，F1 后 prompt/processor/config 均大改必漂）

### 方向③ codegraph 分诊完成（2026-09-09，文档已入库）

- `UPSTREAM_GRAPH_TRIAGE.md`（仓库根）：a5a8942..6a056ec5（as-of 08-26，禁 fetch）179 条全量五分类 ①8/②68/④101/⑤2，对账平衡；7 代理 swarm（5 reviewer + 2 scout），组报告路径在文档 §8
- P1×8：340d4b0 Swift regex hang（1 行）/474f051 tsconfig extends/02c0e2c WAL 泄漏/8c1e821+ca88d3b#1 valve file-cap/d8f2eea spread crash/03893b0 edge drift（chimera_impact 直接消费污染边）/f2a5df3 stale-slice/c74e8b0 debounce
- 关键结构事实：fork wasm-only 无 kernel/无 resolver-pool（④101 条根因）；双消费面（agent chimera_* + MCP tools.ts）；基线前缺口账本立账（function-ref #807/c-fnptr #954/#825/#1292 等）
- **待用户：16 项拍板一轮过**（文档 §5，每项带建议；核心：A grammar pin 采纳/B union 采纳/D resolver-pool 暂不/E kernel 不移植/F function-ref 独立战役/G C-deferral 缓议/P explore 史诗后排）；拍板后 G0（~1 天）可立即先行
- 批次轮廓：G0 小修→G1 WAL+收敛战役→G7 perf；G2 watcher/G3 检索质量/G5 generated 检测/G8 CLI 小件独立；G4 语法精度（等拍板 A/B）；G6 explore CG 史诗最后（~1-2 周）

### F4-P1.5 嵌套后台孤儿化修复（2026-09-10，未 commit）

- bug：子代理（mid）派后台 leaf 后回合结束，前台 dispatch 立即把"等待中"文本返 root → leaf 结果孤儿化（用户实测 mid-out 缺失）；run 模式对 root 自有 job 同样零等待（F12 根因）。scout 证实上游同样无保护（task.test.ts:897 明确断言不等待）——fork 自研分歧面，F 线同步注意冲突
- 用户拍板：owner 迁移+双写兜底（AGENTS.md:47 契约）/ park 无超时但定时提示 main / run 聚合结果事件流自然流出 / 复用 background_subagents kill-switch / 三阶段串行 builder（deepseek-v4-flash-0731 high）+root 逐阶段复验
- ①引擎：typed ownerSessionId + delivery(pending|delivered) 状态机 + markDelivered/waitOwnerQuiescent + engine 单写者投影；4 消费点迁 typed（prompt backgroundTasks/task-cancel/run-state BFS/session.remove）②dispatch：runPreparedCore park-until-quiescent + 重读最新 assistant 消息 + onParkProgress→ctx.metadata(30s) + BACKGROUND_DESCRIPTION 补句 + 同步路径 pre-materialize（等价）③run：GET /session/:id/background/quiescence 长轮询（clamp 1-120s）+ drainBackgroundJobs + SDK 重生成（backgroundQuiescence）+ loop() idle break 改 drainFinished 门控
- root 复验抓两 bug：waitOwnerQuiescent 热自旋（settled job await 已 resolve done → 改按状态选唯一未决信号 running→done/settled→deliveryDone）；run loop() break 永不触发（末尾 idle 恒先于 drainFinished → attach SSE socket 挂进程 → subscribe 传 AbortController signal + drain finally 1s unref 宽限定时器兜底强关）
- 验证：typecheck 绿（chimera+sdk/js）；终验 464 pass/0 fail（F4 家族+三阶段 22 文件）+ test/session 521 pass/0 fail（compaction flake 未现）；窗口用例（settle 但 delivery pending 仍阻塞）+drift-guard 已锁
- 待办：用户真机复跑原场景（root→mid→leafA/B + run 模式，断言 mid-out/root-out）；contract phase（拆投影）等下个 F 线同步批次后确认（session.ts 已迁，fork 读者已清零）；未 commit 待用户发令

### 工具爆发 bench（2026-09-14，harness 已入库未 commit）

- 落点：`packages/chimera/script/bench/`（burst.ts 主入口 + env/sse/plugin/metrics）；跑法 `cd packages/chimera && bun run script/bench/burst.ts --scenario s1,s2,s3,s4 --sizes 1,5,10,25,50 --repeat 3 --out <json>`
- 机制：TestLLMServer raw chunks 一次响应发 N 个并行 tool_calls（distinct index）→ 真实 streamText 无界并发执行；采样=.chimera/plugin 采样插件（tool.execute.before/after → globalThis）+ part 持久化 time.start/end 事后重建
- 结论：50 调用爆发零错误零超时，无崩溃悬崖；但单 fiber + 每调用 ~7 次同步 SQLite tx 导致 exec 膨胀 ~6x（glob p50 69ms→428ms@n=50），吞吐 ~30-50 calls/s（只读）/161/s（write）；round 间 gap p50 ~20ms 健康
- 优化候选（按 ROI）：①part 状态写批量化/去重 ②processor.ts:476 doom-loop 检查每 tool-call 全量 SELECT parts 的 O(N²) ③注意 bench 用 :memory: sqlite，生产 file-backed WAL 写放大更重
- 局限：s4 write 爆发在未初始化 graph 的 tmpdir 跳过了审计/图同步开销；插件 event 钩子只见到少量事件类型（下限计数）

### relay 非标错误包恢复（TypeValidationError 信封）（2026-09-14，已 commit e5f6a287d，未 push）

- 症状：子代理派发偶发失败，报 "Type validation failed … invalid_union (choices|error)"，真实后端 message（如 "Backend buffer overflow."）丢失且不重试。
- 根因：内部中转 provider 流式返回非 OpenAI 形状错误包 {code,message,request_id} → @ai-sdk/openai-compatible chunk union 校验失败抛 TypeValidationError → MessageV2.fromError 归 Unknown、SessionRetry 不重试。
- 修复：provider/error.ts 新增 parseValidationError（还原 message/code/requestId/responseBody，retryLimit=3）+ safeStringify；message-v2.ts fromError 新增 TypeValidationError 分支（信封→可重试 APIError；非信封→Unknown 行为不变）。
- 验证：bun test message-v2+retry 78 pass/0 fail（父级独立复跑）；bun typecheck 干净。
- 文件：packages/chimera/src/provider/error.ts、src/session/message-v2.ts、test/session/message-v2.test.ts、test/session/retry.test.ts；predesign_e6de1b931263ed92；audit_1cbc14d080b66a7b。
- 待办：relay 侧错误包归一化由用户另会话处理；提交前内网审计（ali-internal-audit）已通过。

### subagent 存活判定与看护误归属教训（2026-09-17，wave3 协调事件）

- 事故：③对账批二派在长调研期（读码/规划，无进程无文件足迹）被看护+parent 的 footprint 探针误判死透；parent 未先 task_cancel 原对象就三派 → 双编辑者同文件。三派教科书规避（零 mutation 转独立审计）救场，反成三方交叉验证。
- 铁律：**存活判定权威 = task_cancel 返回的终态快照**（运行中会被打断=活着，已结束返回 "already completed"）；进程/mtime/commit 足迹探针只作辅证，长调研期可 20+ 分钟零足迹。重派前必先 cancel 原对象。
- 次生误报：parent 自己跑收口重编（build-kernel.sh --zig 五腿）被看护当 builder 越权红线上报——看护看不到 parent 侧命令归属。parent 在看护窗口内跑重型构建前应预期误报（或错峰）；zig 缓存 .o 对象文件≠可执行物，不触 EDR 模式。
- 附带坑：build-kernel.sh 全局 --zig 会把 darwin 腿也推上 zig 路线并编译失败——darwin-x64 必须走 Apple 工具链（无 --zig），linux 四腿才用 --zig。

### 自动循环推进交接（2026-09-17 下午，parent 获全权循环授权）

- **用户拍板批**：kernel 路线 a（取舍原则=双实现比对水平取强者，纯 fork 增量保全）；#12 blockBinding 否决（不接 Claude 5.1+，后果备案）；#13 Astra 引入（品牌重写）；#14 chunkTimeout 默认 300s 跟随；G1 扩容批=做；CI 首跑+Win .node 签名=推迟到大更新后（安全姿势=推 ci 分支只跑 kernel-prebuild）；dependabot 批 1/2=批准（窗口=F2 阶段 A 锁文件 commit 后插批）；resolution 修复包并入 K-v2 P4。
- **在途 agent（宿主重启则全灭，重派前先 task_cancel 权威判活）**：F2 MCP=ses_f51ff1e6bffepFlblkl3CdZ60d；claims P1P2=ses_f51fea452ffeP2k6XFqVA8uvoS；L4 小件批（Astra/timeout/四小件）=ses_f51de3f89ffertaU4d6QjTQxVB；K-v2 三方盘点=ses_f51e7ecceffeWkUX67aQ5XvOzw（含比对判定表）；看护×2=ses_f51fbcee3ffe…（F2/claims）、ses_f51dd0b71ffe…（L4）。
- **lane 地图**：F2=mcp/sdk/package.json/bun.lock；claims=store/provenance/prompt-context/edit/write；L4 小件=provider/config/session prompt；K-v2=只读。锁文件仅 F2 可动。
- **循环队列**：①任一 builder 完成→亲验→ali-internal-audit→push ②F2 阶段 A 落地→dependabot 插批（OSV 清单需重拉，memory 旧记录在 09-14 前条目）③F2+claims 都收口→派 G1 扩容批（吸收上游 5 修复：9b8bb4aba/58c07e874/72c1ff13c/1e4612375/7440d2c47）④K-v2 盘点回→起草战役计划入 UPSTREAM_RUST_KERNEL_PLAN.md K-v2 章→按取舍原则自裁比对判定→分批执行（semantics v5+bench 重验收尾）⑤文档三件套回写（TRIAGE §8 补 #12-15 索引含 #12 否决态/790fb5b86f 标注/f965db9e13 加注）随下一个 docs commit 合并。
- **上游快照**：/Volumes/workspace/codegraph-snapshot/codegraph-ba3c21e50d…（codeload 下载，镜像未动仍禁 fetch）；opencode 漂移档案 /var/folders/…/upstream-drift/（tmp 有被清理风险，关键结论已入库 TRIAGE §11）。
- **推送链**：origin/main=e622b41da。installed 二进制=wave3 全验证（v4 语义+9 语言路由）。

### 用户战略指令：Chimera Rust 化改造（2026-09-17 记录，暂不开工）

- 指令原话要义：TS 一堆运行时引发内存泄漏，根本不适合超长时间运行；**在上游同步工作和 WebUI 吞吐战役完成后**，规划 Rust 化改造。不一定全 Rust——可 Rust/TS 混合；主要目标=减少内存占用+尽可能快+高吞吐。
- 触发条件：F 线/L 线+K-v2+WebUI 战役（W1-W5）收口后启动规划（先出 RUST_MIGRATION_PLAN 调研文档，不直接动手）。
- 已知有利地形：graph 提取核心已 Rust（codegraph-kernel napi）；server/会话运行时/存储/工具层仍是 TS（bun/node）——长时泄漏面主要在 session/server 常驻进程。
- 关联：WebUI W1 内存预算拍板（默认 1024/上限 2048，瘦身优先）与 Rust 化动机同源=内存克制。

### dependabot 零风险批完成（2026-09-17，8538207df+a6218b92c）

- 41 漏洞 pair 清除（hono 39 GHSAs/vite 8/tar CRITICAL/fast-xml-parser CRITICAL/axios/undici/ws/nanoid/js-yaml/OTel 家族/mysql2 等）；OSV querybatch 批端点**有漏报**（4 pair 实锤），终验必须 chunk-250 重扫∪新 pair 逐个 direct query 双通道。
- **新全量基线=26 fail**：httpapi-config×8+HttpApi SDK×2+环境 15（MCP daemon×7/roots×3/initialize×2/Node26×2/node:sqlite×1，F2 行为修复不清环境性失败）+claims prompt-context flake×1（A/B 实证既有，负载敏感 ~30%，claims lane 待修时序）。
- 残留 42 pair 清单=**/Volumes/workspace/cbench/tmp-rescue-20260918/dependabot-batch/hits-final.json**（2026-09-18 从 $TMPDIR/chimera/dependabot-batch 抢救至持久区，tmp 清理无碍；后续专项批：seroval/solid-js patch、ai@6 家族、astro 5→7、wrangler、@hey-api+SDK 重生成、electron、newweb 面三小件移交 newweb 仓；valibot 被 bun update sdk/js 解析 bug 阻塞）。
- provider-utils 4.0.33 否决回滚先例：升后 copilot 面 65 类型错=API 变动信号（零风险标准实证）。

### K-v2 主力波进展 + claims 批⑦收口（2026-09-17 晚，覆盖上方交接节的在途/lane/推送链条目）

- **三对象状态**：桥收口（`e27a6b611`/`265c920f4`/`be701d90b`/`b125041c5`，parent 亲验 34/34×2+47/47+store 8/8）；P3 kernel re-vendor 收口（`1fbe50624` 快速道/`5c02e09d1` 慢道 tsjs/`f859f27d0` buffers 双 append 终态/`f45c22598` 记账；fork 五机制保全对账全过：statementMissingInKernel=0、params 11 drift 全为 kernel 富化多出、order 44=D3 设计内窗口态、value-ref 三族+shadow-prune 实证；darwin-arm64 .node sha=`6e32fc67…` 双落点一致，**7 腿未重编=发布闸 CI-only**；parity 窗口快照=cbench/kernel-parity/ksd-parity-p3-window-20260917.json）；**P2 在途**（`b1e732dd5` 1/4+`861ddbac0` 2/4 已落，3/4 tree-sitter.ts WIP 未提交；types.ts 获 parent append-only 裁决；P3 四项协同已中途转达：VALUE_REF_LANGS 收窄/shadow-prune 同式 compute_shadowed_value_names/params+returnType 对齐 kernel Extra 线字段/import-binding 双发风险仅记录）。
- **claims flake 家族第二例结案（parent，`34f745b1d`）**：gate 测试「queues a later predesign…」负载下 ~30% 失败。根因=recordPredesignRun id=sha256(createdAt:payload) 不含 sessionID，同毫秒+同 payload（测试均 {}）→同 id→INSERT OR REPLACE 静默顶掉 ses_a 证据行（行级证据：pdRows 仅 ses_b）。**origin/main 既有**（批⑤引入）。修=predesign id 入 sessionID+recordAuditRun 入 source+provenanceID（auto 审计 payload 无会话区分，swarm 并发同风险）；oracle 富载荷不动。修后 ×15 全绿。第一例 prompt-context flake 仍待修（基线 26 仍含）。
- **波次已推送（覆盖上条陈旧推送链/警示）**：origin/main=`4123b24c4`，18 笔=桥4+P3主4+**P3跟进1**（`4123b24c4`：object-literal 单发+D3 decode 侧重排 POST_PASSES+interface 促升；parity ts **exit 0 clean 199/199 identical**，order 44→0；.node sha=`51f20349…` 双落点）+P2 7+parent flake 修 1+parent docs 1。ali-internal-audit 五类全零命中；安静树全量×2=24/26 fail 全归因：**基线口径更新=25 确定（环境15+httpapi-config8+SDK2）+负载敏感池{claims prompt-context、ModelsDev refresh（30s 瞬态超时、隔离 10/10 绿）}×0-2**；波次面（graph/extraction/kernel/chimera/session）零失败。7 腿重 stage=CI-only 发布闸（随用户 CI 首跑）。
- **看护红线事故结案=伪红线**：跟进批触碰 extraction/kernel/index.ts 被判冻结面违规——实为 parent 看护 charter 起草错误（builder 派单冻结面明写「非 kernel/ 子目录」例外，该文件属 P3 合法 lane），追认无罪；教训=**看护 charter 的 lane 描述必须逐字镜像 builder 派单**。
- **P4 在途（parity 重对账）**：ses_f4fe8d113ffe…（P3 resume，唯一 builder，lane 冻结解除）：13 N 套件跑绿先行+knownExpectations 重写（剥除族清零/params 按 #1638 富化重定基线/order 归零重定）+全语言 parity 复跑基线重生成+takeDeferredPreParse 接线 2 行回补+collectObjectValueReferences vestige 终裁+kotlin/scala/dart 双臂实测+主仓默认路由重索引漂移记录；9 残留语言仍禁开路由（随 P5 定）；semantics v4 保持；看护=ses_f4fe7f9faffe…（12 轮上限）。

### K-v2 P4 推送 + P5-1 在途（2026-09-18，覆盖上节 P4 在途条目）

- **P4 已收口亲验推送**：origin/main=`22a08cd84`（3 笔 eafd28a3d/6609c4594/22a08cd84）；parent 独立复跑：parity ts+scala 抽格 exit 0 全零守卫、cargo test 21/21、kernel 电池+P2 钉桩 509/0、审计五类零命中。**新基线=9 路由语言 429/430 byte-parity/exit 0**（ksd-parity-p4-baseline-20260918.json，v4 21/21 作废）；knownExpectations 全部重写为归零守卫（params 11→0/order 44→0 两预设被实测取代）；.node sha=`189f7f82…` 双落点；主仓默认路由重索引 128,799/336,220/266,188/66,733（Δ<0.01% 归因自身语料）；scala return_type RAW 镜像=上游反馈候选（N kernel bare vs N wasm 不发，fork 裁判取 wasm 臂）。
- **P5 分三段**：P5-1 resolution 机制移植（在途=ses_f4f0cf5bfffeLJ9lKf21NoVZoP，qwen3.8-max-0902 low：D7 builtins 并集+集合差表待 parent 复核/D8 N 前置过滤×fork 后置校验/D9 this.field.m+inner().m+self.m 消费端（chain-form +37k 收敛实测）/FN_REF 双臂翻牌（含 kernel decode 丢 200 修）/import-binding 符号级双边卫生；红线=契约表/semantics v4/9 语言路由/RESOLVER_RANK 仲裁语义）→P5-2 9 语言开路由+semantics v5+重索引→P5-3 bench 重验（G 臂 12 格+tb5-v2/tb6-b+tb3/tb4 re-baseline 立项，parent 主导）。看护=ses_f4fe7f9faffe…（12 轮，RESOLVER_RANK 结构改动=观察项非自动红线）。
- **7 腿 prebuild 仍待 CI 重编**（darwin-arm64=189f7f82 终态，其余 7 腿=wave3 旧 kernel；发布闸随用户 CI 首跑）；基线可直接引用 ksd-parity-p4-baseline-20260918.json。

### K-v2 P5-1 推送 + P5-2 在途（2026-09-18）

- **P5-1 resolution 机制移植已收口亲验推送**：origin/main=`82a38cd73`（单笔 13 文件 +2,539/−207）。D7 零冲突（JS_BUILT_INS 并 WeakMap/WeakSet、TS_PRIMITIVE_TYPES 整体采 N、五族双侧字节同，新模块 resolution/js-builtins.ts）；D8 双层合并（N 前置过滤×fork rank 后校验，N 拒绝=最终 unresolved 禁晋升次名）；D9 实测收敛（self.* −1,783/this.x.y −588）；FN_REF 双臂翻牌（ReferenceKind 联合类型 wire 零变更，.node 未动 sha 仍 189f7f82，fnRef 边 +546）；卫生批 imports 去重落 createEdges 共享层（dup 399→2）。**unresolved +39,778/edges −33,908=精度方向**（#915 import-kind 排除+calls 拒绝族；最大不确定项=calls −21k 召回侧未经 G 臂矩阵复验——本地端点红线禁跑，**待用户授权二进制重建/CI**）。parent 复跑：92/0+parity ts exit 0 全零守卫+审计零命中。快照=ksd-parity-p51-20260918.json。
- **P5-1 遗留排队（pending-parent 清单，待 P5-3 bench 数据定取舍）**：#1108 inferLocalReceiverType 全量移植（Go #1276/PHP 召回恢复）/resolveDeferredThisMemberRefs 超类型二次 pass/#1230 isLexicallyReachable 接入主过滤否/erlang arity+arkts 属性步/matchByQualifiedName #1079/#1180/fnRef×value-ref 标记优先序反转否。
- **P5-2 在途**（同会话 resume ses_f4f0cf5bfffe…）：9 残留语言（go/java/python/rust/ccpp/php/ruby/csharp/swift）parity 先行验证→达标者开 kernel 路由（c/cpp 首次实弹 preParse 路径；残差不可修者暂缓合法）→EXTRACTION_SEMANTICS_VERSION v4→5 唯一授权 bump（needsReindex 用户面实录）→主仓重索引 delta 归因（pre=305,966/302,312）。看护 charter 已镜像（semantics v5=合法任务面非红线；开路由先于 parity 验证=观察项）；召回矩阵/G 臂 runner 仍禁本地跑（依赖全局二进制重建）。
- **升级用户清单新增**：召回矩阵+G 臂 12 格重放需二进制重建授权（或 CI）——K-v2 全量落地后与 7 腿重编/CI 首跑/Win 签名同批处置。

### K-v2 战役代码面全部推送完成（2026-09-18，parent 收口，覆盖上节 P5-2 在途条目）

- **P5-2 已亲验推送**：origin/main=`f59b20c96`。parent 复跑：parity go+rust+ts 抽格 exit 0（rust 25/25、knownExpectations 全零）、kernel 电池+selector+p51+钉桩+version 102/0、.node sha `ff65c3ce…` 双落点一致、**安静树全量 5,333 pass/25 fail=确定基线（环境15+SDK2+httpapi-config8）精确吻合零新增、负载敏感池零触发**（v5 bump 跨面零回归实证）、审计五类零命中。**19/20 kernel 语言已路由**（r 暂缓零语料）；needsReindex 实录=`Semantics: v4 — does not match v5`；重索引终态 129,318/302,325/305,887/67,162/v5/fnRef 543；stale-process 污染事故已清（混码增量 sync 158 条 raw fnr 边，全量重索引清除，pre 快照 cbench/k-v2-p5-2/db-pre/；pitfall 候选：编辑窗口内避免混码进程增量 sync）。
- **K-v2 战役代码面收口**：P0→P1→P2→P3（+跟进）→P4→P5-1→P5-2 全链推送；PLAN K-v2 章已补 P5-1/P5-2/收口宣告三条目。**待用户授权批（「大更新」条件成就）**：P5-3 bench 重验（召回矩阵 matrix-d/f+G 臂 12 格+tb5-v2/tb6-b+tb3/tb4-v2v3 re-baseline，runner 依赖全局二进制重建）+8 腿 CI 重编+CI 首跑+Win 签名；P5-1 遗留六项待 P5-3 数据定取舍。可选：r 语料补全、混码污染存储层守卫（缓行）。上游反馈候选池：scala+七语言 RAW 镜像。下一战役=Rust 化规划调研（用户战略指令，触发条件已成就）。

### Rust 化调研交付（2026-09-18，RUST_MIGRATION_PLAN.md 已入库，待用户决策）

- **核心实测**：现网 `chimera web` 20h22m RSS **3.29GB**（footprint 2090MB，主体=JSC 堆 tag1 1779MB dirty）vs 短跑标定底座 410-460MB/8 路峰值 1002MB——长时维度泄漏实证（用户论断定量坐实）；另有 10 天孤儿 bun 进程 176MB。**PID 43877/18926 重启清理=待用户处置**（调研只读未动）。
- **结论**：候选面 Top3=storage 访问层(+3.0)/graph resolution-store 引擎(+2.5)/server 纯逻辑面(+2.0)；session/bus/tool/pty/provider 五个 Effect 重灾区明确不迁；推荐 **A(napi 绞杀)主+B(watcher/daemon sidecar)补+C(Rust 宿主)远景 R6 决策点**；路线图 R0-R6，**R1=TS 侧泄漏修复批+24h soak harness（不写 Rust、不依赖 Rust 决策、其数据是 R2 立项裁判）——parent 建议先行，待用户拍板**。泄面清单：A 类无界常驻 10 项/B 类释放缺口 6 项（含 tui/worker.ts:44 GlobalBus.on 无 off 唯一未配对点）/C 类结构放大器 4 项；热点：processor.ts:476 O(N²) parts/每调用 ~7 同步 tx/gzipSync/SystemPrompt 无缓存重装配。盲区：3.29GB 无对象级归因（R1 soak 补）、零新 microbench（端点约束，R2/R3 立项需 CI 实测）。
- **claims flake 家族第一例结案（builder，`892349d21` 已推送）**：prompt-context 测试 ~30% 负载敏感失败。根因=queueConflicts 同毫秒 tie-break 用 predesign-id 字典序而非到达序（后注册 `predesign_ctx`<先注册 `predesign_holder_ctx` 抢队首，holder 被忽略→blocked 行缺失）。修=readActiveEditIntentClaims ORDER BY rowid 到达序+queueConflicts 数组序 rank+ownFiles 显式 sort；确定性探针（同毫秒 0→1 conflict）+家族 43/0+×15+并发负载 ×5 全绿；桥批/34f745b1d 语义零回退；rowid 与 INSERT OR REPLACE 重注册回队尾语义自洽。**全量基线口径终态=25 确定（环境15+httpapi-config8+SDK2）+负载敏感池仅剩{ModelsDev refresh}×0-1**。

### K-v2 战役全收口宣告（2026-09-18，P5-3 bench 复验闭环，parent）

- **P5-3 bench 重验结案（builder，零 commit，归档 cbench/k-v2-p5-3/）**：二进制重建三重 sha 对账（tarball==installed==kernel .node ff65c3ce）+EDR 合规姿态（allowScripts 门控安装期零执行+静置 3m+金丝雀 rc=0）；44 格重放：**G 臂 12/12 PASS**、matrix-f flash 4/4、dsv4f 腿因 `deepseek-v4-flash-0731` relay 退役改继任 dsv41f 重放 4/4 PASS（数据标注继任、不与 0731 基线字节比）、tb5-v2/tb6-b B 臂 FAIL 均在既有预期带、tb3-v2 双臂 FAIL=footprint 历史严判类（kernel-sweep 同格同判，非图回归不改判）；tb3/tb4-v2v3 re-baseline 归档 results-p53-*。**核心判定：calls −21k=无损精度收益**（2-hop/3-hop/fan-out/cascade/fuzzy 全判别面 PASS，P5-1 拆除的 −21,384 method-namesake 伪边零召回损失；边界：bench 语料纯 TS）。主仓冒烟：新二进制全量重索引 112s 精确复现基线（129,320/302,327/305,900/67,164/v5/fnRef 543，Δ≤13=语料演进）；**混码污染第二实例实锤**（286 条 raw fnr 脏边，indexed_at 钉死 claims-fix 编辑窗口 07:38-07:43，恢复=全量重索引已三次实证）。
- **Parent 裁决**：①遗留六项=五项维持 pending（数据不足：#1108/deferred this-member 二次 pass（理论恢复池=function_ref unres 3,620 vs resolved 543 供未来成本收益）/#1230/erlang+arkts/#1079+#1180）+fnRef×value-ref 优先序**维持现状**（fnRef 543==基线无双发信号）②Go/PHP/erlang/arkts 语料判别格=缓行可选（独立小批候选）③tb3-v2 footprint 严判格任务面重协商=backlog（bench 治理项非回归）④**K-v2 战役宣告全收口**：P0→P5-3 全链完成，路线 a 裁定+bench 复验+parity 基线三层证据闭环。
- **cbench harness 维护已办（parent）**：matrix-f/tb5/tb5v2 三脚本 `deepseek-v4-flash-0731 high`→`deepseek-v4.1-flash high`（tag dsv4f→dsv41f，继任约定入库）。
- **风险登记（活跃）**：43877 旧宿主（wave3 码）仍 watch 主仓——R1 编辑窗口可能第三次混码污染（仅污染本地 .chimera，恢复=全量重索引；R1 收口后 parent 统一重索引）；**用户择机重启 43877 换新二进制**（新装已在盘；重启会终止本会话，会话持久可恢复）。授权例外已随 P5-3 收口失效，**打包冒烟为剩余授权面**（env.md 条款：随打包冒烟批次收口失效）。
- **R1 泄漏修批+打包冒烟已派**（并行，lane 分离：R1=仓库源码 TS 修，冒烟=全局安装面零仓库改动）；R1 性能敏感验证段需安静机（冒烟短跑先行，R1 计时段在后）。

### 宿主重启交接（2026-09-18，用户主动重启 43877 换新二进制）

- **重启前状态**：origin/main=`e1d392af9` 零未推；**R1 泄漏修批在途**（ses_f4c7d23eeffevDxuk7qwT3NN66，qwen3.8-max-0902 low，派单范围=RUST_MIGRATION_PLAN §1.4 A/B 类逐项+热点四项+A3 注册表 SQLite 持久化+soak harness，每修复项独立小 commit 标 (R1)）+**看护在途**（ses_f4fe7f9faffeOMbb8wpfHpTnGm，双对象 charter 已转 R1 单对象）——宿主重启=两者全灭，工作树可能残留 R1 未提交 WIP。
- **重启后 playbook（恢复会话首件事）**：①DB 权威判死 R1/看护（chimera.db message 表 mtime 停更=死；勿盲 resume）②盘点 git status/log origin/main..HEAD：R1 已落地 (R1) commit 清单+未提交 WIP 面③决策：R1 会话可 resume 则续派收尾（带 WIP 盘点结果）；不可则新派 builder 从 WIP+已落地 commit 接续（防重复修：先比对 §1.4 清单已修项）④R1 收口后统一全量重索引（混码污染恢复+新宿主新码图谱）⑤队列不变：R1 亲验五关→推送→24h soak→R2 立项材料。
- **重启后环境**：全局二进制=with-webui `a1397cdf`（含 K-v2 全量+claims 双修+wave-4 路由+v5）；旧宿主混码污染源消失；workbrief 工具增量语义（d8c0582e8）生效；授权例外已失效（后续二进制构建需重新授权）。
- **用户拍板快照**：①R1 批准（执行中）②P5-3 批准（已完成结案）④进程处置（18926 已清；43877=本次重启）⑤WebUI 三项（已完成）；③CI 批明令后延；⑥code-mode/拍板池挂起。

### R1 泄漏修批结案 + 推送纪律事故记录（2026-09-18）

- **R1 收口亲验通过（18 commits 已在 origin/main，随 f86a0bc85 入远端）**：修 16 项（A2-A10/B1/B2/B3/B5+热点四项，每项独立小 commit+测试，新增 8 测试文件/13 用例）+伪报核清 2 项附证据（B4 cachedScan 单槽闭包无累积、B6 refreshPromise finally 双分支清空）+范围外 2 类（A1/C1-C4）；40 文件 +1380/−92；A3 持久化=新表 background_job（additive 迁移 20260918000000，开机对账 interrupted 终态+delivery-pending 永不逐，**migration 目录合法面追认**）；热点：partsTail 降序键域扫描拆 O(N²)/Token 增量估算+二分 splitTurn/gzip 异步化/SystemPrompt 每回合缓存+纯函数层 memo（指令文件生效点后移至回合边界，已入 commit 文档）。parent 复验：触面家族 151/0+typecheck 绿+全量日志核账 25 fail=基线精确吻合（5401 tests/383 files）；补跑五类审计**零命中**。短 soak 双臂 45min：**footprint 斜率 +35.9→−33.7 MB/h 泄漏金标准翻转**（24h 终判待排）；burst glob p50=114ms（目标<200）；webui-perf/burst 绝对基线今日双臂同漂→**历史锚点 1002.4MB/428ms 需安静窗重锚**。
- **推送纪律事故（parent 自记，未造成实质后果）**：交接 push f86a0bc85 未重扫 origin/main..HEAD，把 R1 的 18 笔在途 builder commit 一并带上远端，违反既定纪律「多 builder 期推送前必扫全部待推范围」；幸而补跑审计零命中。**新 pitfall：parent 自己的 chore push 也必须每次先 `git log origin/main..HEAD` 重扫+全范围审计，交接/重启等「以为只有一笔」的时刻恰恰是盲点**；另：重启前「零 commit」判断错误源于只看了本会话旧时点盘点，未重查——交接盘点必须在交接时刻实时重跑。纠正：重启交接节「零 commit 零 WIP」条目作废，R1 实际零损失（commit 全在 main，后台全量套件进程也随 nohup 存活完赛）。
- **flake 登记册新增**：json-parity find.file（负载池，隔离 3/3 绿；与 claims prompt-context（已修）/ModelsDev refresh 同族）——全量基线口径：25 确定+负载池{ModelsDev, json-parity find.file}×0-2。
- **待办队列**：①24h soak 排期（harness=cbench/rust-plan/soak-harness/，README 含双臂命令，heap snapshot@2GB 内建）②webui-perf/burst 绝对基线安静窗重锚③R2 立项材料（soak 数据裁判；A3 durable 写路径入 R2 桥接候选清单）④B4/B6 伪报结论批注 RUST_MIGRATION_PLAN §1.4（随下个文档批）⑤R1 后全量重索引（本轮执行）。

### 24h soak 在跑（2026-09-20 10:20 启动，跨会话条目）

- **进程**：PID 95506（caffeinate -is 包装防休眠）`bun /Volumes/workspace/cbench/rust-plan/soak-harness/soak.ts --tag r1-after-24h --minutes 1440`；after-only 臂（对照=短 soak control +35.9 MB/h + 现网 3.29GB@20h）。预计结束 **2026-09-21 ~10:20**。运行目录 `/Volumes/workspace/cbench/rust-plan/soak-r1-after-24h/`（samples.jsonl 60s/行、server.out、result.json 完跑后出现、heap snapshot@2GB 自动落 xdg/share/）。端口 48177，隔离 XDG，不碰宿主 60091/60089。
- **看护**：异步子代理 ses_f435fb553ffeSw6xlEErx2ejQ0（background，30min 巡检，monitor.log 落 run 目录，红线只上报不处置）。红线=进程死无 result.json/采样停滞>10min/footprint 连续3轮>3GB/磁盘<10Gi/assertions false。
- **启动插曲（pitfall 自记）**：parent 四次忘传 workdir 导致 nohup `bun soak.ts` 相对路径连续失败（还把一个 nohup.log 落进仓根已删）——**长进程启动命令必须显式 workdir 或全绝对路径**，启动后必须 100s 级存活验证再放手。
- **soak 期间纪律**：安静机（不跑重型 bench/冒烟/全量套件）；机器保持通电勿合盖休眠（caffeinate 只挡 idle/system sleep，挡不了断电/合盖无电源场景）。
- **完成后动作**：读 result.json 终判（assertions 四项+slopeMBPerHour+footprint 24h 曲线）→ 安静窗基线重锚（webui-perf 8 路+burst）→ R2 立项材料呈用户（含 A3 durable 写路径入 R2 桥接候选）。

### opencode 新漂移批（2026-09-20，跨会话条目）

- **量化+分诊+入库完成**：窗口 9f69463f1d..ebb7b76e（155 commits）；28 条 fork 相关面五分类 ①2/②11/③3/④7/⑤5；§13 增刊已入 UPSTREAM_FEATURE_TRIAGE.md；产物 opencode-snapshot/drift-20260920/。安全/行为双筛 0 命中。
- **在途**：移植 builder ses_f425fe820ffe5Ko5D2gjM3uPud（4 件：time.start/service tiers/happy-dom/logo，commit 标 drift-20260920）+看护 ses_f425f6affffeT6VEsJuoD7O6Kh（log=cbench/watch-drift-20260920.log）。builder 回报后：亲验→全量对账→push（必重扫 origin/main..HEAD+五类审计）→沉淀四连。
- **L4 草案已入计划书**（L377 起，待审定+用户批复开工；http-recorder 连带 vendor 与拍板#7 前置是决策点）。拍板#16 新增=f12e14cf16 desktop client_id（缓）。
- **pitfall 自记**：chimera_swarm 连续五次参数空发（序列化丢失），改用并行 task 派发成功——swarm 大 payload 不稳时降级 task 逐个派。
- **拍板#12 否决（2026-09-20 用户裁决）**：Anthropic blockBinding 适配不移植——远端自带 system prompt 致前缀客户端不可控，无优雅适配落点。L4.5 子批取消；3f39a329c3/68abdce1a0/9a71624d2d 改判④；已入库 TRIAGE §13.5 + 计划书 L432/L379/L444/L446。Anthropic 若开放前缀可控面需重新拍板。
- **drift-20260920 批收口已推送**（origin/main=d4a5034a2，7 commits：builder 4 件+docs 2 件+titlebar 修复 1 件）。全量套件 27 fail=基线 25+ModelsDev 负载池+lsp.request（lsp.request 经 b202b4e23 干净 worktree 复现实锤=预存环境失败，非本批引入；建议基线重述为 26 确定+负载池，待下轮安静树确认）。**pre-push 插曲**：happy-dom bump 使 turbo cache 失效暴露 titlebar.tsx 潜在 strict-null 错误（env.d.ts 可选声明，cache 掩盖已久），最小修复 ?? "" 后直推——已沉淀 pitfalls #40。builder 待决项裁决：happy-dom 20.14.5 接受（^20.12.0 超集）；ghostty-web 钉 83c0a07 不随漂（刻意 bump 决策留待）。
- **block_reason 批已推送**（620132aff）：task 工具加 block_reason 可选字段（仅 background 广告面内，窄集无孤儿字段）+BACKGROUND_DESCRIPTION 叙事翻转（task.ts 内，task.txt 未动=builder 合理纠偏）+ultra.txt 规则 7+multiAgentPolicy ultra 段同步句+锚点测试。**v1 软强制无运行时闸**（字段入会话记录即留痕；硬闸=v2 可选）。builder 对 task.txt 的偏离判定正确（永广告面 vs kill-switch 门控面）。验证：224 聚焦+846 家族+typecheck 全绿。

### 24h soak 完赛终判（2026-09-21 ~10:21，跨会话条目）

- **result.json**：assertions 四项全 true；1441 样本 24.0h；21,008 llm 请求/152 会话/2.47M SSE 事件零 gap 零解析错；RSS slope +49.2 MB/h；footprint 三段斜率 +17.2/+5.9/+10.5（减速后温和）；fp 谷线 ~750-760MB、锯齿峰 max 1205MB（dispose churn 节拍，从未触 2GB snapshot）；RSS max 1495/end 1237。
- **裁决**：对照现网修复前 3.29GB@20h=**2.7× 改善**，灾难性泄漏类已消除；残余温和增长大部分=harness 结构性（152 会话只增不减，非泄漏）；R1 出口判据"终值≤1.5×底座(615-690MB)"严格未达（谷线 750）——记录为部分达成。
- **R2 立项含义**：内存论据减弱（但未归零），R2（storage Rust 桥）改由吞吐论据驱动（store 30% 墙钟/tx 膨胀 6×）；heap snapshot 未触发=无对象级归因（此水位不需要）。
- **基线重锚在途**：builder ses_f3e2f1893ffeQMJB4u11ApFFI7（webui-perf 8 路+burst 新锚点→cbench/baseline-20260921.md）。
- 产物：cbench/rust-plan/soak-r1-after-24h/（result.json/samples.jsonl/monitor.log 49 巡检行）。看护 ses_f435fb553ffeSw6xlEErx2ejQ0 已正常关闭。

### L4 开工（2026-09-21 用户批复"那你开工啊 ci延到最后去"，跨会话条目）

- **在途**：L4.0 builder ses_f3e23ad47ffeN2BKfxP4HUUpY0（v2-compat 移植，config 车道，dsv41f low）∥ L4.1 builder ses_f3e237357ffe7MOecqBxdlAqA1（SDK bump 六条+bedrock patch+gitlab variants，锁文件车道，qwen3.8-max low）∥ 双对象看护 ses_f3e221b7affe2vatIgkvBgwE5M（cbench/watch-l4-20260921.log）∥ 基线重锚 builder ses_f3e2f1893ffeQMJB4u11ApFFI7（bench 在跑，L4 双 builder 被令验证前 pgrep 等清空）
- 车道：L4.0=config/ 独占；L4.1=package.json/bun.lock/patches/transform.ts/provider.ts 独占；交集零。收口=parent 亲验+重扫+五类审计+push。
- 待呈用户：http-recorder 连带 vendor（L4.2 前）+拍板#7（L4.4 前）；拍板#16/CI 批/code-mode #6 挂起维持。
- **基线重锚完成（2026-09-21 安静窗，已亲验）**：新锚点 webui-perf 8 路峰值 RSS=**994.0MB**（旧 1002.4，−0.84%）；burst glob p50=**223ms**（环境地板值，负载 4.8-6.9；R1 安静窗曾测 114ms——同日 A/B 口径判据，禁跨日直比）；burst write=155.3/s（−3.5% 噪声内）；**新增 footprint 锚点=679MB/620MB JSC dirty**（采纳为常设追踪指标）。产物 cbench/baseline-20260921.md+.runs/anchor-20260921-*。全量测试基线口径重述为 **26 确定（lsp.request 入列）+负载池×0-2**。
- **L4.0+L4.1 联合收口已推送**（origin=81175a2ff，4 commits）：v2-compat 双读+SDK bump 六条+bedrock none patch（拍板#12 剥离 blockBinding hunks）+gitlab variants（fork 适配超上游）。全量 26 fail=基线精确。§11.6 品牌分裂已 scoped cast 处置（Symbol.for 实证）。下一批=L4.2 llm 整包 vendor（先呈用户 http-recorder 决策）。看护 ses_f3e221b7affe2vatIgkvBgwE5M 随双 builder 完成自行关闭。
- **L4.2 收口已推送**（cff1f3051）：llm 整包 152 文件+http-recorder 24 文件 vendor（@coding-chimera/llm、@coding-chimera/http-recorder 双 private 包），零接线零消费者，schema/llm 与上游字节一致。验收：llm 328 测试/http-recorder 33/双 typecheck/全量 27 fail=26 基线+compaction 已知 flake。审计命中=recorded fixture 假凭据（占位值豁免）。下一批=L4.3 配置化三层合并（含 policies warn+subagent_depth 再议小修）。

### 宿主重启交接（2026-09-21，build-install 后用户重启宿主）

- **重启动因**：宿主 60091 二进制 a1397cdf 装于 09-18 16:05，比 R1 首个修复 commit（16:16）早 11 分钟——**不含 R1 任何泄漏修复**，3 天跑到 JSC 3.3GB（修复前剖面继续）。重启换含 R1 全量+drift 批+block_reason+L4.0-L4.2 的新二进制（worktree 隔离构建，源码=3daaf141b）。
- **新宿主启动命令（取证武装）**：`OPENCODE_AUTO_HEAP_SNAPSHOT=true OPENCODE_AUTO_HEAP_SNAPSHOT_MB=1500 chimera web`——过 1.5GB 自动落 heap snapshot 到 ~/.local/share/chimera/log/，供对象级归因（R2 立项最后一块实证）。
- **重启杀死的在途对象（恢复后盘点）**：L4.3 builder ses_f3d57d8baffe3EBxzXuCOWHmwA（配置化三层合并，config/provider/session 面 WIP 在盘上）+其看护 ses_f3d5798d9ffewHluxX14Quj8yf。**恢复 playbook**：①`git status`/`git diff` 盘点 L4.3 实际落地②`sqlite3 chimera.db` 判死③同 task_id 续派（pitfall #8），带上 WIP 盘点结果④看护重派。
- **排队批**：Responses Wire 保真层（W1→W3→W2→W6 串行+W4 并行+W5 收尾）——L4.3 收口后立即派；证据重钉件=cbench/responses-wire/evidence-recheck-3.0.88.md（3.0.88 全成立；红旗=3.0.65 previousResponseId 跳门，store:false 下不激活）；计划全文在用户 2026-09-21 消息/本文件上文。
- **等用户拍板**：拍板#7（L4.4 前置）/拍板#16/CI 批（最后）/code-mode #6/存量拍板池。
- **新锚点**：webui-perf 994.0MB / burst glob p50 223ms（环境地板）/ footprint 679MB 新追踪 / 全量基线 26 确定+负载池×0-2。
- **杂项**：用户取样文件 “chimera”的取样.txt 在仓根未跟踪（建议删或归档 cbench，勿提交）；build-l4 worktree 与 cbench/build-l4.log 为本次构建产物，装完可清。
- **重启完成（2026-09-21，新宿主 PID 23637）**：新二进制（含 R1 全量+block_reason+L4.0-4.2，worktree 隔离构建）+取证武装 OPENCODE_AUTO_HEAP_SNAPSHOT=true/MB=1500 已确认在 env。残留验证服务 23036 已清。build-l4 worktree（cbench/build-l4）构建完可留作下次构建参照（包级 node_modules 需全量克隆的教训：newweb 嵌套 cp 陷阱+sweep 漏嵌套目录）。
- **L4.3 收口已推送**（28495e563+122a095d7）：配置化三层合并+policies warn 小修。验收=golden 逐字节等价+三族 1263+723+548 绿+全量 27 fail=26 基线+compaction flake。**L4 主线只剩 L4.4**（拍板#7 前置）。SDK gen 待办：config schema 变更需 `./packages/sdk/js/script/build.ts` 重生成（L4 收口时统一跑）。
- **Responses Wire 主线已派**：主线 ses_f3cdd6640ffeZuRki2WcEBBR4P（W1→W3→W2→W6）∥ 文档线 ses_f3cdd281bffeEkEw1v4XgWM8N6（W4）+看护 ses_f3cdcc1cbffe3Ds4ECagChGiGz。证据=cbench/responses-wire/evidence-recheck-3.0.88.md（3.0.88 全成立；红旗=previousResponseId 跳门）。
- **Responses Wire 批全收口已推送**（origin=b0a349a76）：W1 store 配置化（cf476fe23）/W3 回放补偿中间件（19ed055cd，身份制：非 openai responses 一律补偿不看 store）/W2 hosted web_search 注入通用化（30617685f，alibailian+responses 裸 webSearch()）/W6 SSE reasoning 重写器（b0a349a76，帧边界字符串级替换）+W4 文档线（66cac1690）。验收：401 聚焦+5497 全量 25 fail（基线下沿，SDK 桶一条 flaky 转绿）+typecheck 绿+审计零命中+W4 文档与实现键名一致。看护双例（伪红线→修正 charter 重派）均正常关闭。遗留：①实时 E2E 由用户在中转渠道上自验（注入/补偿/重写三件套）②W6 .done 映射保持计划字面（harmless，SDK 丢弃 unknown）③phase2=web_extractor/code_interpreter（F9：web_extractor 必须与 search 同请求）④pitfall #42 已沉淀。
- **拍板#7 已决（2026-09-22 用户裁决，三层全保留）**：①opencode provider/zen 服务保留（不彻底切割上游，定位声明=基于 opencode 基座）②UI 总体显 Chimera 但 opencode provider 自身保持 opencode 品牌显示（无自有托管服务）③第三方 integration 标识头（X-Cerebras-3rd-Party-Integration、User-Agent: opencode/...）继续用 "opencode" 值（coding plan 门户只认 opencode）。已回写 TRIAGE §8/②表行 + 计划书 L427/L446。**L4.4 前置消解，L4 全线解锁**。同家族拍板#8（NVIDIA X-BILLING-INVOKE-ORIGIN）未裁决，倾向沿用同一逻辑。
- **双批并行已派（2026-09-22，用户选"两个并行"）**：L4.4 builder ses_f38b3d339ffeSU40t7N2J73trb（qwen3.8-max low；llm.ts:491 seam+DeepSeek 试点+integration 三件保留吸收+拍板#9 维持 strict:false+6618e2bce2 重判）∥ F3+F4-P3 builder ses_f38b337e5ffevp807kzKr8KRMJ（qwen3.8-max low；promote/ctrl+b/端点/SDK 重生成/claims L2 + feat(tui)②15 + fix C/B/G 族优先 + drift 红旗 7561b4a050/a97622c801；newweb 仓内提交不碰 gitlink）+ 双对象看护 ses_f38b2c1eaffeLFnSh9T6Y6P5ji（log=cbench/watch-l44-f3-20260922.log，parent push 豁免已入 charter）。车道：A=provider/llm/schema/config；B=cli/server/chimera/session(除llm.ts)/agent/sdk。收口=parent 亲验+全量+审计+推送。
- **宿主第二次重启（2026-09-22 13:57 local）**：旧 23637 死前**取证武装立功**——heap snapshot 在 13:53/13:55 连续触发两份（~/.local/share/chimera/log/heap-23637-2026-09-22T0553*.heapsnapshot），即新二进制（含 R1 全修）在真实负载下 <24h 越 1.5GB 阈值，**R2 内存论据的关键对象级归因材料已到手**（待分析，用 Chrome DevTools/heapsnapshot 解析）。新宿主 PID 90852（同二进制，取证 env 待确认是否继承——若用户手动重启可能丢了 OPENCODE_AUTO_HEAP_SNAPSHOT，需提醒）。
- **用户报告 bug（待立项排查）**：重启后刷新 WebUI **无法获取模型列表**。已取证：server `/provider` 健康（224 providers，connected=[ali-inc,opencode]，default 已填），`/config` 正常，宿主 log 无 provider 错误（仅有另一项目 .chimera 的 NpmInstallFailedError=@opencode-ai/plugin@0.0.7-beta2-patch1 未上 registry，独立小事）→ 指向 **WebUI 前端/传输层**（SSE 同步/SDK client/水合时序），非 provider 装配。待办：复现（浏览器 devtools 看 WebUI 实际请求的端点与报错）→ 定位（候选面=packages/newweb 模型 store、sdk v2 client、server SSE 事件流）。优先级=用户日常面，建议排进近期批。
- **子代理复活**：B（F3+F4-P3，ses_f38b337e5ffevp807kzKr8KRMJ）与看护（ses_f38b2c1eaffeLFnSh9T6Y6P5ji）经同 task_id 续派恢复（首次误派新会话已 cancel 纠正，pitfall：续派必须显式传 task_id）。B 的 4 笔 F4-P3 commit 完好。
- **L4.4 亲验进度**：车道合规 ✅ seam 抽验 ✅ provider 族 509/0 ✅；待 B 收口后统一 typecheck+全量+审计+推送（pitfall #37：B 中途件在栈内，整体推迟）。
- **heap snapshot 实际盘点修正**：不是 2 份而是 **41 份**（~250MB/份，共 ~10GB），跨度 09-21 08:58→09-22 05:55 UTC ≈21h——即新二进制（含 R1）真实负载下持续压 1.5GB 阈值，R2 内存论据比"两次触发"更强。解析子代理已派 ses_f382faa65ffeunZFA6INAdVLXu（qwen3.8-max low，抽样 6-7 份建趋势+归因下钻，报告→cbench/rust-plan/heap-23637-analysis/report.md，红线=strings 表原始内容禁入报告、快照只读禁删）。解析完 parent 裁决快照清理（10GB）。
- **heap 解析结案（ses_f382faa65，报告=cbench/rust-plan/heap-23637-analysis/report.md，脚本可复跑）**：①最大户=web-tree-sitter 4×WebAssembly.Memory 96.4MB（唯一真单调增长 +16MB/21h，WASM 线性内存高水位设计如此，非 JS 泄漏）②**JSC 堆仅 460-570MB 平稳振荡，1.5GB RSS 中约 1GB 在堆外 native 侧（SQLite 页缓存/Bun 分配器滞留/保守根）——R2 论据定型为"native 内存可归因化"而非 JS 泄漏**③R1 修复经快照核验全部 hold（payload 字符串桶首末反降 119.6→108.9MB）④resolution 5000 条 LRU×8 已饱和于上限（有界✅）⑤观察项=Uint8Array StrongRootBlock 末段 +7.3MB/4h⑥死代码发现：import-resolver.ts:817 importMappingCache（只声明不读写，入清理 backlog）⑦R2 前置建议=先跑一次 native 侧 profile（malloc stack logging/leaks/footprint -w）再定 R2 范围。41 份快照（10GB）留待用户裁决清理。
- **nix grammar 警告定性（用户截图问询）**：设计内行为（K-v2 判例⑤：9 语言采纳代码不附带 blob，loader 优雅降级+警告，grammars.ts:396-402 注释明记）。触发=仓根 nix/ 目录的 .nix 文件。UX 打磨项入册（警告降级一次性 debug 级/友好文案），暂不修。
- **WebUI 模型列表 bug 排查结案（scout ses_f3818296+parent 浏览器复现）**：WebUI 实际走 `GET /config/providers`（非 /provider），实测健康（200/2 providers/13 models active）。parent 浏览器复现：**干净 profile 下 WebUI 完全正常**（头部渲染 Qwen3.8 Max 0902、会话列表全载）→ **bug 是用户浏览器本地状态依赖**（localStorage `srv:<id>:hidden-model-keys` 全隐藏 / server 选择条目失效 / warmup 竞态单次抓取失败后无重试）。代码级根因三候选（newweb useModels.ts:48-51 error 无消费者渲染 / 无重试 / requestQueue 单飞饿死致 isLoading 卡死）。**修复批已定义（排在 B 收口后，newweb 车道避让）**：①error 渲染+重试钮 ②warmup 后有界重试 ③model.status 缺失按 active ④ModelSelector loading 不禁用 ⑤provider.ts:1243 空 models 守卫。用户侧即时 workaround：清 localStorage 的 hidden-model-keys 或换浏览器 profile。
- **运维红线（呈用户）**：新宿主 90852 压力比旧宿主更高（14 次快照/1.5h vs 旧 40 次/21h；RSS 1.32GB@1.5h；eviction 日志已在打）——在途 3 个子代理会话+本会话大卡司都在宿主进程内。**快照磁盘燃烧 ~2.2GB/h（136GB 剩余≈60h）**——建议：①用户择机再重启（手头批收口后）并考虑调高/关闭快照阈值②parent 裁决清理旧快照（留首尾样本）。scout 附带发现：90852 无逐请求 http 日志（兄弟进程有，配置差异？）；chimera.db 2.1GB；chimera grep 工具疑似返回过陈旧索引内容（cors.ts 案例），全量重索引待批收口后跑。
- **检查点推送完成（origin=528eadda9）**：B 因 provider 侧错误中断时落地 5 笔（红旗双修+startupFailed 修复+C/B/G 族）+parent 簿记 3 笔，全量 5527 tests/25 fail（基线下沿，lsp.request 本轮转绿）+typecheck 绿+审计零命中后推送。B 已同 task_id 二次续派（剩余=claims L2→feat②15→fix 余族）。插曲正名：pre-push 钩拦截 B 的 startupFailed 破窗一次=钩子立功非事故；"栈只有 8 笔"乌龙=origin 已被 parent 早前推送前移（对账纪律=盘点前先 fetch）。
- **F3+F4-P3 批全收口推送（origin=d9f65efec）**：B 三续跑完成（F4-P3 六件全落地+claims L2 查明预存已落地 c55f5a8e2/F3 feat② 移植4降级12/fix 八族消化 D/J/K/O/R 留待）+parent 的 nix 判例⑤单项翻案（vendor blob 4acffa1c+MANIFEST 登记+冒烟测试 test/graph/nix.test.ts+静默名单移除 nix）。验收：全量 5540/30 fail=基线 25+compaction 负载池+snapshot/vcs 4 条超时（隔离复跑 64/0 绿=负载性，入负载池登记）+typecheck 绿+审计零命中。计划书已回写 F3+F4-P3 完成记录。newweb 853ba1d6 在嵌套仓待用户 gitlink 决策。
- **flake 登记册新增**：snapshot.test.ts/vcs.test.ts 4 条为负载敏感超时族（30s 阈值，高负载批次复现、隔离必绿）——基线口径=26 确定+负载池{ModelsDev, json-parity, compaction, snapshot/vcs 超时族}×0-5。
- **快照清理完成（用户指令）**：79 份删除，留 4 份首尾锚点（heap-23637 0858/055559、heap-90852 062111/105054）；磁盘 97→117Gi。注意：快照仍在以 ~2.2GB/h 续增，根治靠 R2 或调高阈值。
- **新二进制构建+安装完成（2026-09-22 晚）**：OPENCODE_CHANNEL=latest build --single（with-webui，53.7MB，冒烟过）→ npm 全局安装 → 四项验证全过（含 port 14096 WebUI 资产 200）。**版本号仍为 0.0.7-beta2-patch1**（version.ts 未被要求 bump，同串不同 sha——以后本地构建考虑显式 --version 区分）。**等用户重启宿主 90852 生效**（含 L4.4/F3/F4-P3/nix 全部今日成果）。
- **DeepSeek 实时 E2E 用户明示暂缓**。
- **WebUI 模型列表修复批已派**（ses 新 builder，五项修复，newweb 仓内提交）。
- **WebUI 模型列表修复批收口推送（父仓 3c9f07047）**：五项全落地——newweb 仓 4 笔（82e91d78 status 宽松化/35a43330 有界重试/51ff944b loading 不锁/5471761f error 渲染+Retry+i18n）+父仓 provider.ts:1243 空守卫。验证：newweb 757/757+新增 5 用例、父仓 provider 族 511/0、双 typecheck 绿、审计零命中。**注意：今天 19:01 装的新二进制不含本批（构建先于本批）——用户侧修复要等下一次 build+安装+重启**。newweb 5 commit 未推其 remote、gitlink 未动（均待用户决策）。
- **全面收口战役开拔（2026-09-23 用户谕示"推进到上游同步全部完成"）**：四路并发——M10 builder ses_f33e514acffe7ERRY1pRSg2OZb（f1407e41c4 copilot providerMetadata 改名，qwen3.8-max low）∥ F3 遗留 builder ses_f33e4a763ffedtfBSRbnGRdWpl（D/E/F/J/K/O/R 族+pinned 族，qwen3.8-max low）∥ L5 规划侦察 ses_f33e40b59ffe0HaeKE10sUdsWw（scout，core trunk+integration runtime+调度适配+sdk/client 复评清单）∥ 方向③侦察 ses_f33e3aefeffeGg0Rg7nXAL7ydf（G 系对账+漂移+graph 小批备料）∥ 双对象看护 ses_f33e364c0ffeLh6M2BOdgXrV2z（log=cbench/watch-m10-f3leftover-20260923.log）。后续波次：L5 细分计划（依 scout 报告由 parent 起草入计划书）→ L5 执行批 → graph 小批 → CI 批（最后）。
- **方向③对账结案（scout ses_f33e3aef）**：G 系 16 拍板项=已吸收/过时 8（A/B/C/E/F/G/M/O）、仍开放 8（D resolver-pool/H deprioritize 配置/I 238dbc5 机制/K telemetry N-A/L init --yes/N salvage 可见性/P explore 预算史诗 + J 部分）。**镜像 6a056ec5 比 K-v2 同步点 ba3c21e50d 旧=09-17 后漂移本地盲区**（参照源=codeload 快照）。K-v2 遗留六项零变化（五 pending+fnRef 维持）。批次定义：**G-A**（4 提取器采纳 N，低风险）已派 builder；**G-B**（CG-33 三件套：ORDER BY/definitionDelta/drift 工具，改同名选边语义）须先落 drift 基线工具再移植，且与 G1 中立约束有历史冲突记录=排后；低成本件 L(init --yes)+N(salvage 可见性) 可并入后续小件批。
- **L5.0 决策闸已裁（parent，终报可覆议）**：①最小 seam（Location shim ~10 行，省 2k 行 project 闭包）②DB 隔离=chimera-v2.db（上游迁移不碰生产 chimera.db——lineage 分叉 P0 风险）③L5.4 正式关闭（sdk/client 5 条全堵 v2 服务树，维持④，schema 部分已自动吸收）。L5 细分计划已入计划书 L455-468。scout 关键修正：上游 background-job 不接 State（fork 引擎是超集，L5.3 与 State 零耦合可并行）；76ee87ead8=215 文件 v2 runtime 整包非单件。
- **L5.1 builder 已派**（ses 新，qwen3.8-max low，Lane A=packages/core）。并发面：M10(provider)/F3 遗留(cli)/G-A(graph)/L5.1(core)+看护。
- **M10 收口推送（a48f259c7 已上远端）**：copilot providerMetadata openai→copilot 改名（vendored responses 两件，与上游 post-patch 字节一致）+itemId 剥离按 fork 语义落 fetch 层名单（provider.ts:2297，transform 层保留 itemId 的既有裁决不动）。验证：provider 族 517/0（parent 复跑一致）+邻接 70/0+审计零命中。边界：codex-responses.ts 未碰（strict:false 维持）；a86ecf3bba（transform 层 strip）未移植=后续可选项。
