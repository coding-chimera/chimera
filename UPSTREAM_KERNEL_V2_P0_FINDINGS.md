# K-v2 P0 判定批深查结论（reviewer 子代理，2026-09-17）

只读深查，零写入三方仓。三方：**F** = /Volumes/workspace/chimera · **O** = /Volumes/workspace/codegraph @6a056ec · **N** = /Volumes/workspace/codegraph-snapshot/codegraph-ba3c21e50d9129d2f5f3843ec3728868ae6d47a1。
行号为本次深查时的实测行号（F 仓有 builder 并发，行号可能随他人改动漂移；引用时以符号名为准）。

---

## 1. D3 interface 保序动机 — 判定：**采 N + 保留 fork 保序为增强（重放为 post-walk 数组重排）**

### 双方实现对比

**N（#1638，inline 实节点）**：
- N `src/extraction/languages/typescript.ts:44-52`：`method_signature` 进 `methodTypes`，`property_signature` 进 `propertyTypes`。
- N `src/extraction/tree-sitter.ts:1091-1096`：visitNode 派发处，bodiless SIGNATURE 仅在 `isInsideClassLikeNode()` 下按 method 建节点（防伪门）。
- N `tree-sitter.ts:1560-1576`：`isInsideClassLikeNode` 的 kind 集**含 'interface'** → interface 体内的 method_signature 走 `extractMethod` **inline 建实节点（源码序）**。
- N `tree-sitter.ts:1357-1367`（NOTE 注释）：旧的"signature 挂 enclosing interface"分支已死；references 边改挂**成员节点**（`Api::fetch → PageId`，锚点更精确）。
- N kernel 镜像：`codegraph-kernel/src/tsjs/mod.rs:58-81, 692-695`（同 #1638 语义，kernel 也是源码序 inline）→ **N 两臂自洽，13 个 parity 套件背书**。

**F（延迟 flush）**：
- F `tree-sitter.ts:249`（pendingInterfaceMembers 声明）、`:977-990`（extractInterface：TS 契约语言跳过 inline 建节点，push 队列）、`:334-340`（extract() walk 结束后 flush）、`:1741-1748`（flushPendingInterfaceMembers → extractTsContractMembers）。
- 动机注释（F `tree-sitter.ts:334-339`）：契约成员名（`interface Store { reset() }`）常与同文件后置的具体实现（`reset: () => ...`）同名，**first-match-by-name 消费方必须先看到可执行声明**；并注明"节点 id 含行号，数组位置对图本身 order-neutral"。
- 出处 commit：`a84c65722 feat(graph): index TS interface members as method/property nodes`——修复主仓 426 条 receiver-typed 解析失败；"materialized in a post-walk flush so executable declarations keep their nodes-array precedence (object-literal-methods first-match semantics)"。

### first-match-by-name 消费链（fork 侧实测，保序动机在 N 语义下**仍成立**）

1. F `src/graph/db/queries.ts:866-870`：`getNodesByName` = `SELECT * FROM nodes WHERE name = ?`，**无 ORDER BY** → SQLite rowid 序 = 插入序 = 提取器 nodes 数组序。
2. F `src/graph/resolution/index.ts:324-327`：ResolutionContext.getNodesByName 直通该查询。
3. F `src/graph/resolution/name-matcher.ts:335-392` `resolveMethodOnType`：候选过滤后 **`matches[0]`（388 行）first-match 取胜**（preferredFqn 仅 Java/Kotlin 消歧，372 行）。

→ 若纯采 N（inline 序），**接口声明在实现之前的文件**（常见"契约在顶部"布局）中，契约成员会抢占 `matches[0]`，把 `x.reset()` 绑到无 body 的契约成员而非可执行声明——这正是 a84c65722 修掉的那类损失。fork 保留自己的 resolver 骨架（D12），故该顺序依赖随骨架存活；N 自家 resolver 与 inline 序共存无碍不能推出 fork 也无碍。

### 执行指令（P2/P3/P4）

- **P2**：采纳 N 的成员建节点路径（实节点 + 成员锚 references + SIGNATURE 防伪门），**同时把 fork 保序重放为 extract() 末尾的稳定重排**（stable partition：TS 契约语言的 interface 成员节点移到 nodes 数组尾部）。依据 F `tree-sitter.ts:338` 注释，重排对图语义中立（id 含行号、边按 id 引用）；比保留 pendingInterfaceMembers 队列更小、且不与 N 的 inline 建节点/防伪门交叠。**重排范围必须精确等于旧延迟范围**（仅 interface 成员；type-alias 成员 F 现本就 inline，见 F `:1688`），否则引入新的 parity 序漂移。
- **P3**：fork kernel tsjs 若同步实现成员发射，采用源码序（随 N kernel）；序差由 harness knownExpectations 承载。
- **P4**：F `script/kernel-parity.ts` 的 `node:order-mismatch` 已知项（`:33` 注释、`:340-423` 比较器、`:767` nodeOrderMismatch_total）**保留**（wasm 重排 vs kernel 源码序）。
- **可选（P5）**：resolver 侧加固——`resolveMethodOnType` 在同名候选中优先有 body/可执行声明者，替代 `matches[0]` 数组序依赖；落地后可整体移除保序重排并清零 nodeOrderMismatch 期望。不在 P2 做。

---

## 2. D5 builtin 大写块 — 判定：**fork 修复保留，但必须改写为 tsjs 作用域（wasm+kernel 双侧）**

### 证据

- **N wasm 含大写块**：N `tree-sitter.ts:6256-6271` BUILTIN_TYPES 尾块 `'Int','Long','Short','Byte','Float','Double','Boolean','Char','Unit','String','Any','AnyRef','AnyVal','Nothing','Null'`，注释"Scala (capitalized primitives + ubiquitous stdlib aliases)"（6265）。
- **关键差异——N 的大写块有真实消费方**：N `tree-sitter.ts:6240-6242` `TYPE_ANNOTATION_LANGUAGES` = ts/tsx/**arkts**/dart/kotlin/swift/rust/go/java/csharp/**scala**/**php**；而 F `:2903-2906` 无 scala/php/arkts。fork 当年能整块删，是因为 fork wasm 的 scala 根本不走这个共享集合。
- **N kernel tsjs 同样含大写块**：N `codegraph-kernel/src/tsjs/mod.rs:115-129`（126-127 行 `Int..Null`）。
- **N 无补偿路径**：压制发生在发射期（`BUILTIN_TYPES.has → 不 push unresolvedReference`），resolution 侧（js-builtins 等）无法恢复未发射的边。
- **fork 修复的实证依据**：F `codegraph-kernel/src/tsjs/mod.rs:165-171` 注释——大写块压制 `ServerConnection.Any`（nested_type_identifier 叶 type_identifier），主仓 −10 边，kernel-parity tsjs-p2 实证；并注明"sibling language modules 的大写块**不得**出现在 tsjs"。F wasm 侧同样已删（F `tree-sitter.ts:2910-2923` 无大写条目）。

### 判定推理

整块随 N（作废 fork 修复）→ `Any`/`String` 型 ref 压制在 v5 重现（−10 边回归）。整块照 fork 删（纯保留）→ **N 语义下会误伤 Scala/PHP**（`Int`/`String`/`Any` 变成 unresolved ref 噪声；F 现状因 scala 不在 TYPE_ANNOTATION_LANGUAGES 而侥幸无害，采 N 后该前提消失）。另注意 F wasm 现状的整块删除对 java/dart/kotlin/swift/csharp 的 `String` 等也已放行（fork 侧既有过度删除），改写为 tsjs 作用域顺带修正这一点。

### 执行指令

- **P2（wasm）**：在 N 基底上重放为**语言作用域**判断——大写块仅当 `this.language ∈ {typescript, tsx, javascript, jsx}` 时不生效（实现可拆两个集合或加语言条件），scala/php/java 等保持 N 行为。
- **P3（kernel）**：`tsjs/mod.rs` 重放 F 的无大写块版 `is_builtin_type`（F `:172-184` 现成）；N 兄弟模块（scala.rs 等）自带副本不动。
- **P4**：复测 `ServerConnection.Any` 场景（+10 边回归验证）+ Scala 语料抽验（确认 `Int`/`Any` 未泄漏为 ref）。

---

## 3. D6 csharp returnField — 判定：**上游已补偿（非休眠 bug）；fork delta 保留，但重新定性为 fork RAW returnType 补丁的依赖件**

### 证据

- **N 双路补偿**：
  1. N `src/extraction/languages/csharp.ts:36-56` `extractCsharpReturnType` **直接读 `childForFieldName('returns')`**（注释明言 "The return type lives in the `returns` field"），经 `getReturnType` hook 挂接（csharp.ts:101；hook 声明 N `tree-sitter-types.ts:279`；引擎消费 N `tree-sitter.ts:1669, 1873`）——服务 #645/#608 链式调用返回类型。
  2. N `tree-sitter.ts:6381-6387` `extractCsharpTypeRefs`：`getChildByField(node,'type') ?? getChildByField(node,'returns')`，注释明言 "tree-sitter-c-sharp 0.23.x — older builds used `type` for both"——type-ref 路径已覆盖字段改名。
- N `returnField: 'type'`（N csharp.ts:100）对 csharp 实为**死配置**：csharp 在 `extractTypeAnnotations` 入口即分发到 `extractCsharpTypeRefs`（N `:6287`），永远到不了泛型 `returnField` 读取点（N `:6339`，全文件唯一消费处）。
- **F 引擎同样有 extractCsharpTypeRefs 补偿**（F `tree-sitter.ts:3041-3047`，'type' ?? 'returns'）——即 fork 的 type-ref 路径本就不依赖 returnField delta。
- **fork delta 的真实消费方 = fork 独有 RAW returnType 线字段**：F `tree-sitter.ts:2929-2946` `returnTypeNode()` 读 `extractor.returnField` → `returnTypeText()`（RAW，MMS/MCC 签名审计）；调用点 extractFunction（F `:778,787`）/ extractMethod（F `:897,904`），**无语言门**（PARAM_TYPE_LANGUAGES 仅限 ts/tsx/js，F `:228`；returnType 路径不限）→ csharp 方法在 fork 依赖 `returnField:'returns'` 才有 Node.returnType。
- F 引擎**无 getReturnType hook**（F tree-sitter.ts / tree-sitter-types.ts grep 零命中）——但 P2 以 N 为基底后该 hook 天然存在。

### 执行指令

- **P2**：采 N csharp.ts 整体（含 preParse #237、record_declaration、getReturnType、packageTypes 等），**重放 1 行 delta：`returnField: 'type'` → `'returns'`**（F csharp.ts:22-25 注释一并带走）。安全性：N 引擎唯一泛型消费点（6339）对 csharp 不可达（6287 分发在前），改值不影响 N 任何特性；同时 fork 重放的 returnTypeNode/returnTypeText 补丁即恢复 csharp 供给。备选（更优雅但工作量更大）：把 fork returnTypeNode 补丁改为优先 `extractor.getReturnType?.()` 文本——不作为 P2 阻塞项。
- **无需向上游反馈 bug**（原判"上游疑似休眠 bug"撤销）。
- **P4**：csharp parity 对账时确认 Node.returnType 字段两侧供给一致（kernel csharp.rs 是否发 return_type 属 P3 补丁集范围）。

---

## 4. ⑥ 潜伏两臂差 — 判定：**现状无活雷；"P2 自动闭合"论断不成立（应为 P2+P3 联合闭合，且 kotlin/scala/dart 在 P2 后反而新开差）**

### 现状普查（实测）

- **F kernel value_ref 文件共 11 个**，其中：
  - 非 tsjs 残留（上游机制，F wasm 无对应发射面）= **9 个**：`ccpp/mod.rs, csharp.rs, go.rs, java.rs, php.rs, python.rs, ruby.rs, rustlang.rs, swift.rs`（报告"11 文件"把 tsjs 两文件也算进去了——`tsjs/mod.rs, tsjs/extractors.rs` 是 fork 有意重track，wasm 侧有 valueReferenceTypes 对应物，不属潜伏差）。
  - F kernel **kotlin.rs/scala.rs/dart.rs/lua.rs 无 value_ref**（wave1-3 剥除/本就没有）。
- **F wasm 发射面**：`captureValueRefScope/flushValueRefs/VALUE_REF_LANGS` grep 零命中；fork 机制 = valueReferenceTypes hook，仅 `languages/javascript.ts` 与 `languages/typescript.ts` 声明 → **F wasm 只对 ts/tsx/js/jsx 发 value-ref**。
- **F DEFAULT_ROUTED**（F `src/graph/extraction/kernel/index.ts:158-180`）= lua, luau, typescript, tsx, javascript, jsx, kotlin, scala, dart（九语言 ✔）。

### 踩雷核查（当前路由 × 残留差）

- 9 个残留语言（go/java/python/rust/c/cpp/php/ruby/csharp/swift）**全部不在 DEFAULT_ROUTED** → 当前无活雷。
- **lua/luau（重点核查）干净**：F kernel lua.rs 无 value_ref（不在普查清单）；F wasm lua.ts/luau.ts 无 valueReferenceTypes；N wasm `VALUE_REF_LANGS`（N `tree-sitter.ts:445`：ts/js/tsx/arkts/go/python/rust/ruby/c/java/csharp/php/scala/kotlin/swift/dart/pascal）**不含 lua/luau** → 采 N 后也不会开差。
- tsjs（routed）：fork 两臂各有对应机制（wasm hook + kernel retrack），D1 合并方案负责防双发（VALUE_REF_LANGS 收窄到非 tsjs）——不属本项潜伏差。
- kotlin/scala/dart（routed）：F 两臂现均不发 → 现状一致。

### "P2 采 N wasm 后自动闭合"验证 → **部分成立，需修正**

- 对 9 个残留语言：P2 后 N wasm 开始发（VALUE_REF_LANGS 17 语言含全部 9 个），与 F kernel 残留发射**方向性对齐**——但它们本就未路由，"闭合"只在 P4 开路由对账时才被检验；且 F kernel 残留 = O 基线机制，与 N wasm 的 O→N 演进（shadow-prune 等）可能存在细节差，**闭合质量要靠 P4 parity 实测，不能假定**。
- **对 routed 的 kotlin/scala/dart：P2 反而新开差**——N wasm VALUE_REF_LANGS 含 kotlin/scala/dart，P2 后 wasm 臂发 value-ref；F kernel（P3 前）不发。**闭合依赖 P3**（N kernel `dart.rs/kotlin.rs/scala.rs` 均含 value_ref，实测普查确认）。P2→P3 窗口内 parity harness 对这三门语言必炸 valueRef 差。
- pascal/arkts 在 VALUE_REF_LANGS 但**无 kernel 臂**（F/N kernel 目录均无对应模块）→ wasm-only，无 parity 面，非雷。

### 执行指令

1. **P2/P3 落地纪律**：两批必须原子落地或 P3 紧随 P2；窗口期内 parity 跑 kotlin/scala/dart 需白名单 valueRef 差（或干脆不跑）。
2. **P4 前路由禁开清单（确认版）**：go, java, python, rust, c, cpp(ccpp), php, ruby, csharp, swift——即 9 个残留语言，现状已全部未路由，**保持不动即可**；kotlin/scala/dart 已路由但依赖 P3 完成才两臂一致，P3 前不得重跑其 byte-parity 门。
3. lua/luau 无本项风险，无需动作。
4. 报告表述修正：残留 = 9 文件（非 11）；"自动闭合"改为"P2 对齐 wasm 侧、P3 闭合 kernel 侧、P4 实测验证"。

---

## 5. ③ watcher 等价性 — 判定：**有缺口（.git/info/exclude、core.excludesFile、嵌套 .gitignore 目录剪枝三点）；P2 内 cherry-pick，改动小且正交**

### 双方机制

- **N（#1728 后）**：
  - `readGitExcludeExtraPatterns`（N `src/extraction/index.ts:345-380`）：读 `.git/info/exclude` + `git config core.excludesFile` 全局排除，并入 buildDefaultIgnore。
  - `listGitIgnoredDirectories`（N `index.ts:383-410`）：`git ls-files -z -o -i --exclude-standard --directory` 枚举 ignored-untracked 目录，剪枝**嵌套 .gitignore 效应**（flat matcher 覆盖不到的）。
  - `buildDefaultIgnore`（N `index.ts:415-430`）= 默认模式 + 根 .gitignore + 上述两项。
  - N `src/sync/watcher.ts:32, 334`：watcher scope 对齐 `git ls-files --exclude-standard`。
- **F**：
  - `buildDefaultIgnore`（F `src/graph/extraction/index.ts:297-302`）= DEFAULT_IGNORE_PATTERNS + **仅根 .gitignore**。无 info/exclude、无 core.excludesFile、无嵌套目录剪枝。
  - F watcher（`src/graph/sync/watcher.ts`，chokidar 实现）`:304-316` 复用 buildDefaultIgnore 做 `ignored` 回调；`:207,351` 恒忽略 .chimera/.codegraph/.git。
  - F 的 **git 枚举路径已对齐 exclude-standard**：`collectGitFiles` 用 `git ls-files -z -o --exclude-standard`（F `index.ts:377`）及 `-o -i --exclude-standard`（`:402, :529`）。

### 缺口判定

文件级扫描（git 可用时）F 已等价；**缺口在 watcher 与非 git FS-walk 回退路径**：三类规则（info/exclude、全局 excludesFile、嵌套 .gitignore 目录）F 的 ignore matcher 不认 → watcher 可能对索引器排除的树注册监听/放行事件（无谓 churn、增量重扫噪声），两 scope 静默分叉——正是 N #1728 修的问题（N index.ts:350-351 注释原文）。

### 执行指令（P2 批内）

- cherry-pick N 的 `readGitExcludeExtraPatterns` + `listGitIgnoredDirectories` 进 F `buildDefaultIgnore`（两函数自包含、与 fork 880 行 chimera 接线正交；F watcher 因复用 buildDefaultIgnore 自动受益，无需改 watcher.ts 本体）。注意 F 的 readGitignorePatterns/resolveGitDir/expandUserPath 等依赖件在 F 是否同名存在，缺则一并搬。
- `preloadLanguagesForFiles`（N `index.ts:768`，消费点 `:1997, :3219`）：F 无对应物（grep 零命中）——**性能项非正确性缺口**，可选 cherry-pick，需适配 fork grammars.ts 多级回退加载器；建议放 P2 尾部低优先。

---

## 附加核验

### A. N 的 13 个 kernel-*-parity vitest 套件 — **存在性与入口确认 ✔（未跑）**

- 13 个文件实存于 `N/__tests__/`：kernel-{ccpp,csharp,dart,kotlin,lua,php,r,ruby,rustlang,scala,swift,tsjs,grammar}-parity.test.ts。
- 辅助件实存：kernel-scaffold.test.ts、kernel-deep-nesting.test.ts、kernel-retry-materialize.test.ts、c-fnptr-kernel-sweep.test.ts、`__tests__/fixtures/kernel-parity/`、`scripts/kernel-parity.mjs`。
- 入口：`vitest.workspace.mts` engine 项目 include `__tests__/**/*.test.ts`（exclude 仅 ui-package.test.ts）；`package.json:31` `"test": "vitest run"`。
- 可跑性未验证（约束：不安装不跑）；P4 执行时预期需 prebuild kernel 二进制装载路径适配（F harness 的 prebuilds 逻辑可参照）。

### B. fork kernel-parity.ts "改三处"定位准确性 — **①②准确，③定位不准（非独立代码位）**

- **① knownExpectations 剥除族**：实位 `F script/kernel-parity.ts:757-777`。剥除族条目 = `returnTypeFieldDrift_total/_tsjs`（758-762）、`refMissing_total/refExtra_total`（773-774，承载 kotlin/scala/dart valueRef/type-refs 剥除差）；`nodeOrderMismatch_total`（767）**按本报告 D3 判定应保留**（若采纳重排方案）。
- **② statement/params 断言**：`statementNodesWasm_total`（768）、`statementMissingInKernel_total`（769）、`paramsFieldDrift_total_expect0`（763）+ 头部文档 `:8-12, :33`——保留，定位准确。
- **③ docstring 期望**：**无独立代码位**。docstring 仅出现在 FULL-FIELD 比较字段清单（`:14` 文档、`:233` 字段表）；D4（采 N #780 helpers）的影响通过逐文件 identical/diff 计数与 deferral 预算体现——"改写"动作实为 **P4 基线报告重生成**，不是 harness 代码修改。报告"三处"应修正为"两处代码 + 一处基线重生成"。

---

## 对 P1（契约 append）的新发现

- **五处清单完备性：无新增阻塞面**。补充证据：
  - `src/chimera/codegraph-adapter.ts:9,198,202` 仅把 `EdgeKind` 作透传过滤参数类型（非穷尽 switch），union 扩 'navigates' 不破坏；`layout.ts:146-147` 的 `EdgeKindsMatchForkUnion` 编译期断言会自动强制 ②与① 同步（append 后即校验）。
  - **发射面预警**：N 的 `src/extraction/` 全目录 grep 'navigates' **零命中**；N kernel 仅 `buffers.rs:120` 占位 EDGE_KINDS 表项（无发射逻辑）。即 navigates 的实际发射方在 N 的 resolution 层 router/tier synthesizer 族（fork 已判定跳过）→ **P1-P4 完成后 fork 语料 navigates 边数恒为 0，parity 两臂均不发，无对账风险**；P1 append 属纯契约预留。报告 §3 "navigates 照收但零触发"论断由此坐实。
  - ③（FILE_PROJECTION_EDGE_KINDS 纳入与否）与 ④（index.ts:597 标签映射 + chimera may-impact 关系子句是否消费）仍待 parent 拍板——本批无新证据改变其决策性质（零发射下两决策均可安全推迟，建议 P1 先做 ①②⑤，③④ 挂起至 navigates 真有发射方时再定）。
