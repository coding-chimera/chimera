# K-v2 开工前三方差异盘点（路线 a：fork 跟进上游 codegraph HEAD）

- 生成：2026-09-17，reviewer 子代理（只读审计，未改动任何仓库文件）
- 三方：**F** = /Volumes/workspace/chimera（HEAD e622b41da6）· **O** = /Volumes/workspace/codegraph @6a056ec5（vendor 基线，只读）· **N** = /Volumes/workspace/codegraph-snapshot/codegraph-ba3c21e50d…（路线 a 目标，只读，无 .git）
- 判定纪律：每条结论附文件级证据；大块 diff 明细归档本目录（见 §5）
- 取舍原则（用户拍板）：同功能双实现逐条比强弱，强者胜；fork 独有且上游无对应物者保全；上游独有者直接采纳

## 0. 总量地图（diff 行数 = +/- 有效行）

### kernel（Rust）
| 文件 | F≠O（fork 改动） | O≠N（上游演进） | F≠N | 分类 |
|---|---|---|---|---|
| tsjs/extractors.rs | 830 | 195 | 999 | **双改冲突（最高风险）** |
| tsjs/mod.rs | 459 | 125 | 584 | **双改冲突（最高风险）** |
| kotlin.rs | 555 | 201 | 712 | 双改，但 fork 侧=纯剥除 → 采 N 即回滚（快速道） |
| scala.rs | 590 | 12 | 602 | 同上（1 处 hunk 交叠 655-673） |
| dart.rs | 560 | 0 | 560 | fork-only=剥除/quirk 复原 → 采 N(=O) 回滚 |
| docstring.rs | 64 | 0 | 64 | fork-only 机制（tsjs 简化清洗器）→ 判定表 D4 |
| textutil.rs | 34 | 0 | 34 | 混合：fork push_json_string（保）+ 剥除 regex（回滚） |
| buffers.rs | 7 | 3 | 10 | 双向 append（statement 节点 + navigates 边）语义无冲突 |
| lua.rs | 0 | 140 | 140 | 上游-only → 干净采纳 |
| python.rs | 0 | 59 | 59 | 上游-only → 干净采纳 |
| ccpp/mod.rs | 0 | 54 | 54 | 上游-only → 干净采纳 |
| rustlang.rs | 0 | 48 | 48 | 上游-only → 干净采纳 |
| java.rs | 0 | 10 | 10 | 上游-only → 干净采纳 |
| tsjs/fnref.rs | 0 | 7 | 7 | 上游-only；fork decode 丢弃 fn-ref(200)，采纳后休眠 |
| langs.rs / lib.rs / 其余 | 0 | 0 | 0 | 无动作 |
| Cargo.toml | 0 | 0 | 0 | **grammar 钉版三方一致** |

### wasm TS 提取器（F 的 packages/chimera/src/graph/extraction vs O/N 的 src/extraction）
F 侧基底考证（wasm-base-attribution-v2.txt，blob 级验证）：**F 的 languages/*.ts 全部 = 旧上游基底（2026-04~06）+ 微量 fork delta（0-13 行）**；fork 的大规模自有改动只集中在 tree-sitter.ts（对基底 07af3db +1501 行）、index.ts（+880，chimera 接线）、grammars.ts（+86，runtime 加载适配）、kernel/*.ts（fork 适配层）。

| 文件 | F 基底（上游 commit） | fork delta | O≠N | 分类 |
|---|---|---|---|---|
| tree-sitter.ts | 07af3db (06-06) | **1501** | 510 | **双改冲突（wasm 面最大单体）** |
| index.ts | 35b44e2 | **880** | 542 | 双改，但主题正交（fork=chimera 接线；N=#1728 git watcher/preload）→ 慢道 cherry-pick |
| grammars.ts | cdbf451 | 86 | 12 | fork=runtime 加载适配（保留）；N=+hasTreeSitterGrammar（append，易） |
| languages/typescript.ts | afcb9fa | 1（import 路径） | 11 | 采 N + 重放 import 改写（快速道） |
| languages/javascript.ts | 49e670c | 1 | 2 | 同上 |
| languages/kotlin.ts | 34240eb | 2 | 181 | 采 N 整体（fork delta 仅 import 路径；#708/#750/#897 缺口随 N 补回） |
| languages/c-cpp.ts | c0cf9c1 | 10（union 回port+import） | 171 | 采 N（N 已含 unionTypes，fork delta 缩为 import 改写） |
| languages/scala.ts | 8506936 | 2 | 10 | 采 N |
| languages/lua.ts | 4329a52 | 2 | 5 | 采 N |
| languages/rust.ts | 2d14503 | 5（union_item+valueRef?+import） | 3 | 采 N（N 已含 union_item） |
| languages/csharp.ts | 046e03a | 7（**returnField 'returns' 修复**+import） | 0 | fork-only 修复保留（见 D6） |
| languages/java.ts | 34240eb | 2 | 0 | fork delta=import；F vs O 的 250 行=跳过的上游演进 → 采 N(=O) |
| languages/dart.ts | a2ed181 | 2 | 0 | 同上（F vs O 183 行=上游演进缺口） |
| languages/{go,luau,index}.ts | — | **0（EXACT-BLOB）** | 0 | 无动作 |
| languages/{objc,pascal,php,ruby,swift}.ts | 各旧基底 | 2-5（import+union 回port） | 0 | 采 O(=N) + 重放 import |
| tree-sitter-types.ts | 34240eb | 13（valueReferenceTypes hook） | 23 | 双改小冲突：采 N + 重放 hook 声明 |
| tree-sitter-helpers.ts | c8407ad | 2 | 0 | 采 N；fork delta=import。**注意 D4：F 现为 pre-#780 无 wrapper-climb 版** |
| parse-pool.ts / parse-worker.ts / *-extractor.ts / kernel/*.ts | — | fork-only（O=N 或 F 独有适配） | ~0 | 保留 fork 版；kernel/*.ts 按 P1 契约 append |
| function-ref.ts / extraction-version.ts / store-*.ts / astro / cfml / razor / syntax-tokens.ts | F 未 vendor | — | 小 | 采纳依赖项：N tree-sitter.ts import function-ref.ts → P2 需补 vendor；syntax-tokens=UI-only 跳过 |
| wasm/*.wasm | 三方共享 blob **字节一致**（typescript/kotlin 抽查 md5 相同；F∩O 全同；O∩N 全同） | — | 0 | 钉版有效；F 少 10 个语言 blob（pruned，P2 决策是否补） |

## 1. 面一：wasm TS 提取器三方 diff（细节）

**(a) fork 独有改动（升级必须保留/合并）** — 全部集中在 tree-sitter.ts + types + 少量语言 delta：
1. **statement 发射**：CODEPLAN_STATEMENT_LANGUAGES(ts/tsx/js/jsx) + CODEPLAN_DEPENDENCY_STATEMENT_KINDS（15 种语句型，tree-sitter.ts:138-161）+ extractCodePlanStatementDependencies(:2394) + createNode('statement', `stmt@L:C`)(:2435)，签名截断 240。上游至今无对应物。
2. **value-position refs（召回战役核心）**：valueReferenceTypes hook（tree-sitter-types.ts，O/N 无）+ VALUE_REF_DECLARATION_PARENTS / EXCLUDED_PARENTS / EXCLUDED_ANCESTORS 三表（:177-213）+ extractValueReference(:2068) + valueReferenceKeys 去重(:247) + collectObjectValueReferences（object 简写/pair 值）。typescript/javascript 声明 valueReferenceTypes。
3. **params/returnType 线字段**：extractParamTypePairs(:2958) + returnTypeText（RAW 保留泛型/union/函数类型，:225 注释）+ RETURN_TYPE_MAX_LENGTH=200 → 喂 chimera 审计 MMS/MCC signature-delta。
4. **interface 成员延迟 flush**：pendingInterfaceMembers(:249,989,1742)——契约成员排在同文件实现之后（first-match-by-name 消费方依赖此序，parity harness order-sensitive 的根因）。
5. csharp returnField 'type'→'returns'（tree-sitter-c-sharp 0.23.x 字段改名修复，见 D6）。
6. union 建模回port（c-cpp/rust/objc unionTypes，注释引 6978acc）——**N 已原生含**，fork delta 作废。
7. 机械适配：import 路径 web-tree-sitter→web-tree-sitter-types（全部语言文件）、grammars.ts cjs runtime 多级回退加载、index.ts chimera 接线（880）、kernel/{layout,decode,index,loader}.ts fork 适配层。

**(b) 上游演进 O→N（路线 a 采纳面）**：tree-sitter.ts 510 行 = #1638 interface 成员实节点化（SIGNATURE_METHOD_NODE_TYPES + property_signature→extract_property）、#1675 CommonJS export 赋值命名、isExportedLater、#693 初始化器归属行走（java/kotlin/lua/rust/scala/tsjs/python）、lua 赋值式函数（luaAssignmentTarget/extractLuaFunctionValue）、#1669 declaratorBoundFunction、react-hook bound name、#1683 call-receiver `inner().m`、#1496 `this.field.m`、#1566/#1707 isUnresolvedTsJsChain 防伪、is_abstract 持久化修；languages：kotlin(#1495 positional signature/#693/property accessor 归属)、c-cpp(#1727 纯虚方法/#1505 raw literal/#1729 嵌套伪影)；function-ref.ts +15（jsx_expression/object/shorthand）；grammars.ts +hasTreeSitterGrammar；index.ts 542（#1728 watcher scope、preloadLanguagesForFiles、ScanSkipStats）；extraction-version 25→26；新增 syntax-tokens.ts（UI 高亮，fork 无 UI → 跳过）。

**(c) 双改冲突面**：唯一大冲突 = **tree-sitter.ts**（fork +1501 vs N +510，交叠区=extractFunction/extractVariable/extractInterface/visitNode 派发/call 捕获——N 的 #693/#1638/#1675 与 fork 的 statement/value-ref/params/interface-flush 改在同一批方法内）。次级：tree-sitter-types.ts（13 vs 23，append 级）、index.ts（正交主题，cherry-pick）、typescript/javascript/kotlin/scala/lua/rust/c-cpp（fork delta ≤10 行机械性，采 N 后重放）。

## 2. 面二：vendored kernel 三方 diff（细节）

**(a) fork 独有机制清单（F≠O）**
| 机制 | 位置 | 证据 | 路线 a 处置 |
|---|---|---|---|
| **statement 发射全套**（嵌套重叠+多重归属） | tsjs/mod.rs（is_codeplan_statement_kind 15 kind 表）+ tsjs/extractors.rs（STATEMENT_SIGNATURE_MAX=240）+ buffers.rs NODE_KINDS[24]=“statement”尾append | F tsjs statement 标记 26+26 处 vs O 4+5/N 7+5（均为普通 expression_statement 匹配，非发射机制）；上游三方 grep 零发射代码 | **保全**（原则 2：上游无对应物）；P3 移植到 N 基 kernel |
| tsjs value-ref retrack | tsjs/mod.rs:107-165（VALUE_REF_* 三表镜像 fork wasm）+ extract_value_reference(:501) + value_ref_keys 去重；**替换**了上游 tsjs 的 capture_value_ref_scope/flush_value_refs | F mod.rs 19 处标记 vs O/N 9 处；F 无 flush_value_refs@tsjs | 判定表 D1（双实现） |
| params_json（extraJson 补丁） | tsjs extract_function/extract_method：`extra_json: extract_param_type_pairs_json`；textutil.rs push_json_string（JSON 转义） | F-vs-O patch L2739/2818（F 侧独有）；O/N 全无 extra_json | **保全**（无对应物） |
| tsjs returnType | return_type_text_of + RETURN_TYPE_MAX_LENGTH=200（function/method Extra） | F-vs-O extractors patch（O 侧无此字段） | **保全**（chimera 签名审计依赖） |
| docstring tsjs 简化清洗器 | docstring.rs preceding_docstring_tsjs/clean_comment_markers_tsjs（无 #780 wrapper-climb、`///` 保留第三斜杠、无 pre-trim） | F-vs-O docstring patch 64 行（O 侧无该函数） | 判定表 D4（双实现） |
| builtin-type 修复 | tsjs is_builtin_type **剔除大写块**（Int/String/Any…）——大写块曾压制 `Any` 型ref，主仓 −10 边（kernel-parity tsjs-p2 实证） | F-vs-O mod.rs patch：F 侧注释“STRICT mirror of the fork wasm set” | 判定表 D5 |
| interface 成员延迟 flush | tsjs extract_interface：PendingInterface 队列，成员后置发射 | F-vs-O extractors patch（O 侧为 inline visit） | 判定表 D3（与 N #1638 双实现） |
| **wave1-3 剥除**（被路线 a 推翻=“剥除回滚”） | dart.rs 560 / kotlin.rs 555 / scala.rs 590 / tsjs 特性剥除（react HOC #841、RTK、pinia、vue store、extract_property #808、has_inline_fns 门、literal-receiver、chain 重编码、returnType/type-refs/static-member-refs、valueRef 边 dart/kotlin/scala） | F-vs-O hunk 注释自证：“The fork's wasm oracle predates upstream #708”“byte-parity gate is the fork's wasm arm”“docs/design/{dart,kotlin}-kernel-port-checklist.md” | **回滚**：直接采 N（连同 N wasm oracle 一起换血，两臂自洽） |

**(b) N 的新增（O→N，采纳面，与 dispatch 17 条对应）**：#693 声明初始化器归属行走（java:759/kotlin/python:475/rust:667/scala:656/tsjs:398）＝9181dd1ef 族；lua 赋值式函数（lua.rs +110：assignment_statement 目标、点号赋值、table 内函数、function_definition 停止扫描）＝8c047342c；kotlin positional signature #1495（signature_of）＝748311fef；interface 成员 #1638（method_signature→method 类型、property_signature→实节点、SIGNATURE fallback 防伪）＝ee83636ac；防伪边族：cpp 纯虚方法 #1727（+FLAG_IS_ABSTRACT）、is_unresolved_member_chain #1566/#1707、#1683 call-receiver、#1496 this.field、rust unit-struct 建节点、rustlang `self.m` 前缀 #1861＝8f8081968、CommonJS #1675、is_exported_later、generator_function、#1669、react-hook 命名、jsx/object fnref、navigates 边（Expo router 族）、kotlin property accessor 归属。**均带 wasm 镜像改动**（N wasm/kernel 两臂自洽，直接整体采纳）。

**(c) 冲突面（同文件双改，hunk 交叠实测）**
| 文件 | N hunk 落入 F 改动区 | 结论 |
|---|---|---|
| kotlin.rs | 7/7 全交叠（9,85,489,583,624,795,820 ∈ F 剥除带） | F 侧=纯剥除 → **采 N 整体，快速道** |
| scala.rs | 1/1（655 ∈ F 647-662） | 同上，快速道 |
| tsjs/extractors.rs | 9/11 交叠（20,46,65,270,293,319,373,398,1036,1100；仅 1075 独立） | **慢道手工三方合并**（fork statement/value-ref/params × N 11 hunk） |
| tsjs/mod.rs | 5/6 交叠（55,622,664,704,735,747） | **慢道手工合并** |
| buffers.rs | 文本交叠（F 101-107 × N 104-111）语义正交 | 双 append：NODE_KINDS 24（尾 statement）+ EDGE_KINDS 13（尾 navigates），快速道 |

## 3. 面三：契约面

- **N 变更**：EDGE_KINDS 12→13（尾 append "navigates"，buffers.rs:104-118 + src/types.ts:70）；NODE_KINDS 不变（23）；行布局/ROW_SIZE 不变；**KERNEL_ABI_VERSION 三方均=2，N 未 bump**。langs.rs 三方一致。EXTRACTION_VERSION 25→26（fork 无此文件，用自己的 EXTRACTION_SEMANTICS_VERSION=4）。
- **fork 现契约**：layout.ts KERNEL_ABI_VERSION=2、EDGE_KINDS 12（本地表 + EdgeKindsMatchForkUnion 编译期穷尽断言，import 自 src/graph/types.ts EdgeKind union）；NODE_KINDS 在 src/graph/types.ts（24，'statement' 尾 append，曾从 index 18 移尾）；loader verifyKernelContract=**kernel⊆fork 按名子集门**（索引对齐不要求，decode 走 kernelWireTables 解析）→ **N 系 kernel 的 "navigates" 若未 append 进 fork 表，新 .node 会被门拒收（降级 wasm）**。
- **fork append 清单（P1）**：① src/graph/types.ts EdgeKind union + 'navigates'；② kernel/layout.ts EDGE_KINDS 尾 append（穷尽断言自动校验）；③ graph/queries.ts FILE_PROJECTION_EDGE_KINDS 是否纳入（投影可见性决策，**待 parent 拍板**）；④ graph/index.ts:597 边标签映射（Navigates/NavigatedBy，chimera 关系子句规则是否消费 → 待深查 src/chimera may-impact 表）；⑤ kernel/index.ts re-export 面复核。**KERNEL_ABI_VERSION 不需要动**（append-only + 子集门 + 行布局不变；旧 .node 因缺 navigates 反被拒？否——旧 kernel 表⊆新 fork 表仍过门，安全降级兼容）。
- **EXTRACTION_SEMANTICS_VERSION 4→5 必须 bump**（wasm+kernel 语义双变，触发全量重索引提示）。
- **grammar 钉版**：Cargo.toml 三方字节一致；wasm blob F∩O∩N 一致（md5 抽查 typescript/kotlin + diff -rq 全量无 differ）→ 钉版仍有效，N 的 kernel-grammar-parity 测试可继续沿用。F 的 wasm/MANIFEST.md（fork 独有溯源清单）P2 需更新（若补 10 语言 blob/新 vendoring commit 记录）。

## 4. 面四：resolution/查询层

**结构**：F=12 文件（chimera 重写版）；O=18；N=28（+10 新文件：alias-binding、js-builtins、6 个 router/tier synthesizer、synth-utils 等——**router/tier/synth 族=codegraph-ui Screens/Steps 专用，fork 无 UI → 建议整体跳过**）。F 已裁掉 O 的 c-fnptr-synthesizer/goframe/memory-budget/resolver-pool/resolver-worker/workspace-packages（chimera 有自己的池化/预算）。

**规模**：F vs O：name-matcher 2812（F 1541 行 vs O 2660 行，**不同谱系的重写**）、index 1843、import-resolver 960、frameworks 19 文件（react 102/react-native 58/vue 58/go 36/java 36/python 26…）。O vs N：name-matcher 996、index 359、import-resolver 347、frameworks（express 236/react-native 183/python 149/java 112/csharp 89/react 85）。**hunk 交叠实测：N 的 name-matcher 20 个 hunk 全部落在 F 重写过的区域内** → 不存在文本合并路径，只能按机制逐条移植。

**fork 召回战役资产（F 独有，O/N 均无）**：RESOLVER_RANK 证据类仲裁（index.ts:182，import 6>qualified-name 5>exact 4>instance-method 3>file-path 2>framework 1>fuzzy 0 + 平手按文件/语言邻近）；import-aware veto（name-matcher，逐候选跨文件否决，bench 实证 5 条伪 layout.tsx→wire-session 边）；d2 接收者证据（Promise-peel 仅限 await 初始化、readonly 修饰无条件 peel、点号工厂 `x=[await] Class.m()` 证据、同名类三层保守消歧）；union 脱壳（X|null，initializedDb.close/find.focus 12 条翻正实证）；多语言 BUILT_INS 集（JS 含 Map/Set + PYTHON/GO/PASCAL/C/CPP，index.ts:51-167）。

**N 的 resolution 修复（4297b8e2e/de5adba7e/2c251e2c6 对应物）与重叠评估**：
| N 机制 | 内容 | 与 fork 关系 | 路线 a 后是否单独采 |
|---|---|---|---|
| isVisibleAcrossFiles 套件（2c251e2c6 file-local 族） | C static 翻译单元局部(#1730)、kotlin/java/csharp/swift/scala/dart/php private=文件局部、go 大小写导出、rust 模块目录+trait-impl 可见性(#1861 配套)、JS sealed-module(#1719)、markdown/JSON-require 守卫 | fork veto 只看 import 映射；N 看语言可见性规则+源文本 export 形态——**互补不重复**，N 覆盖面更广（7+ 语言 vs fork 的 import-disciplined 文件） | **采**（移植进 fork 重写版，作为 veto 后置校验；注意 fork 三层消歧与 N “拒绝后不晋升次名”语义要对齐） |
| isBareJsCall(#1714)+local-binding shadow | 裸调用不得绑类方法；文件内局部绑定遮蔽跨文件同名 | fork instance-method rank=3 与 #1714 直接相关（可能互斥/叠加） | **采，需与 RESOLVER_RANK 联动设计**（待深查） |
| js-builtins.ts（de5adba7e Map 内建） | 独立模块，name-matcher+index 共用 | fork 已有 JS_BUILT_INS（含 Map/Set）——**双实现** | 判定表 D7（比对集合差后择强/合并） |
| 4297b8e2e name-matcher+207 | N name-matcher 其余 hunk（含 NO_NESTED_FUNCTIONS c/cpp 伪影豁免、matchByExactName/matchFuzzy  survivor 校验） | fork 重写版无对应 | **逐 hunk 评估移植**（慢道） |
| 8f8081968 rust self-owner | kernel 侧 `self.m` 前缀发射（rustlang.rs） | 采 N kernel 自动获得；**fork resolver 需能消费 `self.m` 形态**（N 注释称 resolver 从 QN 读 owner） | kernel=自动；resolver 消费端**待深查** fork 是否已支持 |
| #1683/#1496 callee 形态（`inner().m` / `this.field.m`） | kernel+wasm 发射端 | 同上：发射随 P2/P3 获得，**fork name-matcher/import-resolver 必须新增形态处理**否则新边解析率下降 | **必须配套采**（P5） |
| alias-binding / router synthesizers / tier | UI+Expo 场景 | fork 无 UI、无 Expo 语料 | **跳过**（navigates 边照收，只是暂无发射场景——N wasm 的 expo 路由合成在 fork 语料上天然零触发） |

## 5. 面五：验证资产复用评估

- **parity harness**：F 的 packages/chimera/script/kernel-parity.ts（bun、order-sensitive、FULL-FIELD 行、deferral 预算、knownExpectations 含 statement/params/order/value-ref 族）＝上游 scripts/kernel-parity.mjs 的 fork 强化版。N 自带 **13 个 kernel-*-parity vitest 套件**（ccpp/csharp/dart/kotlin/lua/php/r/ruby/rustlang/scala/swift/tsjs/grammar + scaffold/deep-nesting/retry-materialize/c-fnptr-sweep）+ __tests__/fixtures/kernel-parity 折磨夹具 + scripts/kernel-parity.mjs（全仓扫）。**适配需求**：P3/P4 先在 N 基 kernel+N wasm 上跑 N 原生套件（免费回归网，fork 无需改）；fork harness 改三处——① knownExpectations 中“剥除族”条目全删（returnType/type-refs/valueRef 边/property+constant 缺失等随 N 采纳消失）② 保留 statement/params_json/order-sensitive/value-position-ref 四类 fork 扩展断言 ③ docstring 期望按 D4 判定改写。F harness 的 --max-deferral、prebuilds 装载路径逻辑不变。
- **grammar 钉版**：仍有效（§3 证据）。N 的 kernel-grammar-parity.test.ts 直接复用。
- **bench 影响面**（/Volumes/workspace/cbench/tasks，17 格）：verify.sh 直接断言图表者≈0（tb4-v1 仅注释级 1 hit）→ 影响是**间接**的：① **tb5-v2（及 tb6-b）Scope check 格**：declaredScopeFiles 语义依赖 searchNodes 文本命中（含 import/**stmt** 节点）——semantics v5 后 statement 仍在但 references/节点总量变化（N 特性增边），**必须重放重验**（memory 已有教训条目“图富化会改变下游模糊匹配语义”）；② **tb3-v1..v3（swift 扩展归属）、tb4-v2/v3（LanguageExtractor hook 契约）**：prompt 直接点名 packages/chimera/src/graph/extraction/{languages/swift.ts,tree-sitter.ts SKIP_RECEIVERS,tree-sitter-types.ts}——fixture 仓（repo-b/repo-g）冻结故重放仍可跑，但 K-v2 后这些文件被 N 版覆盖，**格子的预测效度失效，需 re-baseline（重写 prompt/fixture 或退役）**；tb3-v3 的 'Self' receiver 解法未进 F 基线（SKIP_RECEIVERS 现值无 'Self'），重验时注意别把旧解当基线；③ tb1/tb2/tb4-v1/tb5-v1/tb6-a/c：低依赖，抽验即可。④ G 臂召回矩阵（matrix-d.sh/matrix-f.sh，12/12 满分基线）：semantics v5 重索引后**全量重放**——N 的防伪边族（sealed-module 属 resolution 面，P5 才进）与 #693 增边会双向移动召回/精度指标。⑤ 主仓冒烟基线：v4=120,650 nodes/250,239 edges，v5 预期**上升**（初始化器归属/interface 成员/lua 函数/cpp 纯虚/navigates），delta 归因清单在 P5 出。
- kernel-parity 历史报告（cbench/kernel-parity/*.json 6 份）= v4 时代基线，P4 重对账后全部作废重生成。

## 6. 比对判定表（双实现逐条比强弱）

| # | 条目 | fork 实现 | 上游(N) 实现 | 判定 | 证据与理由 |
|---|---|---|---|---|---|
| D1 | tsjs value-ref | value-position 全量采集（VALUE_REF_* 三表排除 callee/type/import/解构位；object 简写/pair 值；任意标识符） | captureValueRefScope/flushValueRefs：仅文件作用域 const/var、名长≥3 且含大写/下划线、shadow-prune、17 语言、metadata `{valueRef:true}`、N 有 parity 测试背书 | **需合并双方优点（倾向 fork 为主）** | fork 覆盖面严格更宽（函数作值依赖=召回战役主收益，references +17.7%/unresolved −11663 主仓实测、G 臂 12/12）；上游更保守且有测试。**冲突点**：N wasm 的 flushValueRefs 对 ts/tsx/js 也开（VALUE_REF_LANGS 含之）→ 若 fork 同时保留两套会双发边。合并方案：tsjs 用 fork 方案并把 N 的 VALUE_REF_LANGS 收窄到非 tsjs（或 fork 方案内吸收上游 shadow-prune 防遮蔽误报——**fork 现无 shadow-prune，此点上游更强，建议吸收**）。**待 parent 复核** |
| D2 | statement 发射 | 全套（嵌套重叠+多重归属+stmt@L:C 命名+240 截断），chimera 审计/搜索消费 | 无对应物 | **取 fork（原则 2 保全）** | 三方 grep 零上游发射代码；loader 注释自证“kernel simply never emits it” |
| D3 | interface 成员 | 延迟 flush（PendingInterface，成员排同文件实现后，order-sensitive parity 依赖） | #1638：property_signature/method_signature 直接建实节点，挂在成员上的 type ref 更精确（`Api::fetch→PageId`），N wasm+kernel+fixtures 三证 | **倾向取上游 + 评估 fork 序需求是否仍成立** | 上游把“不可见成员”变“精确锚点实节点”，语义完备性明显更强且有测试背书；fork 延迟 flush 的动机是 first-match-by-name 消费方顺序——该消费方在 N 语义下是否仍需保序**待深查**（chimera 侧 first-match 消费者清单）。若需要，可在 decode/store 层排序而非发射层。**待 parent 复核** |
| D4 | tsjs docstring 清洗 | preceding_docstring_tsjs：无 wrapper-climb（export 包装的声明拿不到 docstring）、`///` 留第三斜杠、无 pre-trim——**本质是对 fork 旧 wasm（pre-#780 helpers）的字节对齐件，非独立功能** | #780 wrapper-climb 全语言统一清洗器（N wasm helpers=O helpers，含 climb） | **取上游（剥除回滚类）** | fork 版唯一存在理由是 parity 对齐旧 wasm；P2 采纳 N helpers 后，保留 fork 清洗器反而制造新的两臂不一致。上游语义更强（`export const x` 的 docstring 不再丢失）。**代价**：v4 时代 docstring 字节对比全作废，P4 重对账 |
| D5 | tsjs builtin-type 表 | 剔除大写块（Int/String/Any…）——防 `Any` 型 ref 被压制（主仓 −10 边实证，对齐 fork wasm BUILTIN_TYPES） | 保留大写块（O/N 同） | **待深查后定（倾向随 N，需复测）** | 这是“对齐件”而非独立修复：关键在 **N wasm 的 BUILTIN_TYPES 是否含大写块**——若 N wasm 同样剔除或 N 两臂一致，则随 N 无风险；若 N 两臂都含大写块，fork 当年的 −10 边回归会在 v5 重现，需在 N 语料上复测 `ServerConnection.Any` 类场景再定。**P2 时核对 N tree-sitter.ts BUILTIN_TYPES** |
| D6 | csharp returnField | 'returns'（tree-sitter-c-sharp 0.23.x 字段改名适配；三方共享同一 wasm blob=0.23.x） | 'type'（O/N 均是） | **取 fork（上游疑似休眠 bug）** | blob md5 三方一致 → 同一 grammar 下字段名唯一；0.23.x 已改名则上游 csharp returnType 静默缺失。**待深查**：N csharp.ts 是否另有补偿路径；若无，此修复应保留且值得反馈上游 |
| D7 | JS builtins | index.ts 内联 JS_BUILT_INS（含 Map/Set）+ PYTHON/GO/PASCAL/C/CPP 五族 | js-builtins.ts 独立模块（JS_BUILT_INS + TS_PRIMITIVE_TYPES），name-matcher+index 双消费 | **需合并（集合级比对后取并集，结构取上游）** | 双方都解决“内建名不配图符号”；上游模块化+带 TS 原始类型表，结构更好；fork 多语言覆盖面更广。合并=上游模块骨架 + fork 多语言集合。**待 parent 复核集合差** |
| D8 | 跨文件伪边防御 | import-aware veto（逐候选，import 映射驱动）+ 同名类三层消歧 | isVisibleAcrossFiles（语言可见性规则+sealed-module 源文本检测）+ #1714 裸调用 + local-binding shadow | **需合并双方优点** | 机制正交（import 证据 vs 可见性/形态证据），N 覆盖面广且有 #1719/#1730/#1714 实仓量化证据（vite 157 边/betaflight 145+4306 边）；fork veto 有 bench 5 伪边实证。合并顺序：N 规则做候选前置过滤，fork veto+消歧做 rank 后校验，避免“拒绝后晋升次名”分歧（N 明确拒绝即 unresolved） |
| D9 | 接收者证据 | d2：Promise-peel（await 初始化限定）+readonly peel+点号工厂证据+union 脱壳 | #1496 this.field.m / #1683 inner().m 发射端富化 + awaited-receiver 测试族 | **需合并（不同层，天然互补）** | fork=resolver 消费端强，N=发射端 callee 形态富化；N 形态进来后 fork d2 需新增 `this.field.m`/`inner().m`/`self.m` 形态处理（否则发射了也解析不动，边质量反而下降） |
| D10 | 对象成员/store 提取（react HOC #841、RTK、pinia、vue store、extract_property #808） | fork 已剥除（wasm oracle 无） | N 全套（wasm+kernel+fixtures） | **取上游（剥除回滚，快速道）** | fork 剥除仅为 parity 对齐；无语义分歧 |
| D11 | kotlin/scala/dart 全语言语义（returnType/type-refs/static-member-refs/chain 重编码/val-var 判定/extends quirk/ctor unwrap） | fork=旧 wasm quirk 复原版（wave3） | N=新语义（#708/#750/#897/#1495/#693 全集） | **取上游（剥除回滚，快速道）** | 用户拍板“回 adopt 上游语义”；fork 侧无独立机制混入（hunk 注释自证纯对齐件） |
| D12 | name-matcher 整体谱系 | 1541 行重写（RESOLVER_RANK 仲裁+召回调优） | 3684 行（精度战役+207 hunk） | **保 fork 骨架，移植 N 机制**（无法文本合并：N 20 hunk 全落 F 重写区） | fork 骨架承载 chimera 独有仲裁语义（RESOLVER_RANK O/N 均无）；N 机制逐条按 D7/D8 移植 |

## 7. 双改冲突面 TOP 风险清单（计划关键输入）

| 排名 | 冲突体 | 规模 | 风险 | 策略 |
|---|---|---|---|---|
| 1 | **wasm tree-sitter.ts** | fork +1501（对 06-06 基底）× N +510（对 O）；同方法群交叠 | fork 五大机制（statement/value-ref/params/interface-flush/RAW returnType）与 N 八大特性（#1638/#1675/#693/lua/#1669/#1683/#1496/#1566）改同一批函数；机械合并必炸 | 慢道：以 N 为新基底，把 fork 机制作为**特性补丁集**重放（先 enumerate fork delta 成独立 patch 序列，逐特性 rebase；D1/D3 判定先行，因为 value-ref/interface-flush 决定重放内容） |
| 2 | **kernel tsjs/{mod,extractors}.rs** | F∩N 交叠 hunk 14/17 | 同上双机制交叠 + wire 字段（extra_json/return_type/statement kind） | 慢道：N 为基底 + fork 补丁集重放；buffers 双 append 先行（P1） |
| 3 | **resolution name-matcher.ts** | 谱系级重写 × N 20 hunk 全交叠 | 无文本合并路径；语义合并需 D7/D8/D9 判定 | 慢道：机制移植清单制（不移 hunk 移语义），移植后 G 臂+召回矩阵回归 |
| 4 | kotlin/scala（wasm+kernel 两臂） | kernel 交叠 8/8 hunk | 判定=剥除回滚后风险坍缩为“纯采纳”，但 **parity 期望全套作废重建**（v4 21/21 byte-identical 基线归零） | 快速道采纳 + P4 重对账兜底 |
| 5 | buffers.rs / layout.ts / types.ts 契约 | 双 append | 顺序错=wire 索引错位（append-only 纪律 + 子集门兜底） | 快速道，P1 独立完成并先行合入（新旧 kernel 均兼容） |
| 6 | extraction index.ts | fork 880 × N 542 | 主题正交（chimera 接线 vs #1728/preload），交叠概率低但文件大 | cherry-pick N 的 #1728/preloadLanguagesForFiles（fork sync 层是否消费 **待 parent 定**——fork 有自己的 watcher） |
| 7 | tree-sitter-types.ts / tree-sitter-helpers.ts | 13×23 / 2×70(#780) | helpers 的 #780 climb 与 D4 联动 | 随 D4 判定，快速道 |
| 8 | tsjs/fnref.rs + function-ref.ts | F 未 vendor function-ref.ts | N wasm tree-sitter import './function-ref' → P2 采纳 N tree-sitter 时**必须补 vendor**（否则编译断） | P2 依赖项清单第一位 |

## 8. fork 独有资产保全清单（一件不能丢；判定表裁定“取上游”者除外）

1. **statement 发射全套**（D2）：wasm CODEPLAN_* + createNode('statement') + kernel tsjs is_codeplan_statement_kind/STATEMENT_SIGNATURE_MAX + buffers NODE_KINDS 尾 'statement' + layout/types NODE_KINDS 镜像 + loader 子集门语义 + decode 双相路由注释。消费端：chimera 审计/searchNodes/impact。
2. **params_json + tsjs returnType**（无对应物）：extractParamTypePairs/returnTypeText/RETURN_TYPE_MAX_LENGTH（wasm）+ extra_json/return_type_text_of/push_json_string（kernel）+ decode x: 键展开。消费端：MMS/MCC 签名 diff 审计（9e1766eb6 回归锚）。
3. **value-position refs**（D1 判定“fork 为主+吸收 shadow-prune”）：valueReferenceTypes hook + 三排除表 + collectObjectValueReferences + value_ref_keys。
4. **召回战役 resolution 调优**（D8/D9/D12 骨架）：RESOLVER_RANK 仲裁、import-aware veto、d2 接收者证据（Promise/readonly peel、点号工厂）、union 脱壳、同名类三层消歧、多语言 BUILT_INS。
5. **csharp returnField 'returns' 修复**（D6）。
6. **机械适配层**：web-tree-sitter-types import 体系、grammars.ts cjs 多级回退加载、kernel/*.ts fork 适配（prebuilds 装载、kernelWireTables 双相 decode、子集契约门）、index.ts chimera 接线、parse-pool WAL/卡死防御（G0 已含上游 WAL valve 移植——与 N #1539 重叠部分核对即可）。
7. **验证资产**：kernel-parity.ts（order-sensitive 强化版）、wasm/MANIFEST.md 溯源纪律、cbench 17 格+G 臂矩阵（按 §5 重验/re-baseline）。
8. 已知遗留工单随迁：wasm 返回类型 ref 双发卫生修（需 kernel 镜像同批——P2/P3 同批处理）。

## 9. 建议批次切分（K-v2 阶段划分，文件交集≈零原则）

| 阶段 | 内容 | 规模 | 风险点 |
|---|---|---|---|
| **P0 判定落锤** | 本报告 D1-D9 待复核项拍板（value-ref 合并方案/interface 成员/docstring/builtin 表/builtins 集合/projection navigates）；深查三项（N BUILTIN_TYPES 大写块、N csharp 补偿路径、self.m/新 callee 形态 fork 消费端） | S | 判定错误会返工 P2/P3 |
| **P1 契约 append** | types.ts EdgeKind+queries.ts+layout.ts EDGE_KINDS append 'navigates'；index.ts 标签映射；loader 子集门测试（旧 kernel 仍过门）；**不动语义不重索引** | S | projection/may-impact 是否纳 navigates（parent 拍板）；先行合入使 P3 无契约阻塞 |
| **P2 wasm oracle 升级** | N extraction 全量采纳（tree-sitter.ts 以 N 为基底重放 fork 特性补丁集；补 vendor function-ref.ts；languages 采 N+重放 import 改写/csharp returnField；tree-sitter-types 重放 valueReferenceTypes；grammars.ts 保 fork 加载层+N helper；index.ts cherry-pick #1728/preload 按需；决策：10 语言 blob+astro/cfml/razor 是否扩容） | **L** | 冲突 TOP1；value-ref 双发门（VALUE_REF_LANGS 收窄）；fork 特性补丁集枚举完整性（statement/value-ref/params/interface-flush/RAW returnType） |
| **P3 kernel re-vendor + 移植** | N kernel 全量替换 + buffers 双 append + fork 补丁重放（statement 全套、value-ref retrack 按 D1、extra_json/return_type、push_json_string、textutil regex 恢复核对）+ 剥除回滚（kotlin/scala/dart/tsjs 特性族照单全收 N）+ 8 腿 prebuild 重建（build-kernel.sh，CI-only 执行纪律） | **L** | 冲突 TOP2；D4 判定=删 preceding_docstring_tsjs 全套引用点（tsjs 6 处调用）；.node 不本机执行（端点安全纪律） |
| **P4 逐语言 parity 重对账** | N 原生 13 套件先跑（应全绿=两臂自洽证明）；fork harness knownExpectations 重写（删剥除族、留 statement/params/order/value-position 族）；9 路由语言 byte-parity 重建 + deferral 预算；ksd 报告重生成 | M | v4 21/21 基线作废的心理预期；docstring 字节全变（D4）；statement 在 N 特性叠加后的序稳定性 |
| **P5 semantics v5 + resolution 合并 + 重索引 + bench 重验** | EXTRACTION_SEMANTICS_VERSION 4→5；D7/D8/D9 机制移植（isVisibleAcrossFiles 套件/#1714/js-builtins 合并/新 callee 形态消费端）；全量重索引+delta 归因（预期 edges/nodes 上升）；G 臂 12 格+召回矩阵重放；tb5-v2/tb6-b 重验；tb3/tb4-v2v3 re-baseline 立项 | **L** | resolution 移植与 RESOLVER_RANK 交互（TOP3）；bench 格预测效度处置（退役 vs 重写）；重索引计时不得与重型 I/O 并发（既有教训） |

依赖序：P0→P1→(P2∥P3 可并行，文件交集≈零：P2=packages/chimera/src/graph/extraction/**，P3=codegraph-kernel/**；仅在 P4 汇合)→P4→P5。

## 10. 归档文件清单（本目录）

| 文件 | 内容 |
|---|---|
| REPORT.md | 本报告 |
| diffstat-{FvsO,FvsN}-kernel.txt / diffstat-{FvsO,OvsN}-extraction.txt / diffstat-FvsO-resolution.txt | 逐文件 diff 行数矩阵（五份） |
| diff-OvsN-kernel.patch (1324 行) | 上游 kernel 演进全量（N 采纳面） |
| diff-FvsO-kernel.patch (4402 行) | fork kernel 改动全量（机制+剥除） |
| diff-OvsN-extraction.patch (2428) / diff-OvsN-languages.patch | 上游 wasm 演进全量 |
| diff-FvsO-tree-sitter.ts.patch (5280) | wasm 引擎双改冲突主战场（=diff-FvsO-extraction-tree-sitter.ts.patch 重复件） |
| diff-FvsO-extraction-{index,grammars,tree-sitter-types,tree-sitter-helpers}.ts.patch | 其余共享文件 F-vs-O |
| diff-FvsO-lang-*.ts.patch (19 份) | 逐语言 F-vs-O（python/luau 为空=字节同） |
| diff-FvsO-kernelts-{decode,index,layout,loader}.ts.patch | fork 适配层 F-vs-O |
| diff-OvsN-resolution.patch (3853) / diff-OvsN-resolution-name-matcher.patch / diff-FvsO-resolution-full.patch (8376) / diff-FvsO-resolution-name-matcher.patch | resolution 面四份 |
| fork-deltas-languages.txt | 各语言文件 fork delta 全文（对已验证基底 commit） |
| wasm-base-attribution-v2.txt | wasm 基底考证表（blob 级验证；v1 因 zsh `:s` 修饰符 bug 已废并删除） |

**待深查汇总**：① N wasm BUILTIN_TYPES 是否含大写块（D5）② N csharp returnType 有无补偿路径（D6）③ fork resolver 对 `self.m`/`this.field.m`/`inner().m` 形态的现状消费能力（D9/P5）④ first-match-by-name 消费方在 N interface 语义下是否仍需保序（D3）⑤ graph/index.ts、src/chimera may-impact 对 navigates 的消费决策（P1）⑥ fork 非 tsjs kernel 臂残留 flush_value_refs（go/java/python 等 11 文件）与 F wasm 无 captureValueRefScope 的潜伏两臂差——P2 采纳 N wasm 后自动闭合，但 P4 前这些语言不可开路由。
