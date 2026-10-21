# LSP 推送式诊断改造（设计定稿）

状态：已定稿（2026-10-16），按 B1 → B2 → B3 批次实施。
设计来源：与 oh-my-pi（omp）LSP 集成的对比调研；用户拍板走纯推送路线。

## 1. 目标与原则

把 LSP 从"模型需要主动查询的工具"改成 IDE 式隐形验证层：

- 模型不主动调任何 LSP 查询 op；写错了系统自动亮红线，每条红线只亮一次
- 读侧语义（定义/引用/影响面）归 CodeGraph（chimera_search / chimera_impact / 传播探针）
- LSP 只做推送：写后诊断、跨文件破坏通知、晚到结果注入
- 降噪只作用于模型可见面；oracle 审计证据照旧全量记录，一条不少

## 2. 范围

**做**：P0 诊断去重账本；P1 跨文件破坏推送（双去重 + 就地明细展示）；P2 非阻塞两阶段等待 + 晚到注入。

**不做**（明确非目标）：

- 新增 lsp 查询 op；把 lsp 工具移出 tool_search deferred；prompt 中推送 LSP 使用
- read 时亮出已有错误（P3，用户明确否决：自己写的时候也不看）
- rename / code_actions 等写侧 op（独立议题另议）
- 全项目 `workspace/diagnostic` 扫描（LSP 3.17 pull，后话）

## 3. 现状（证据锚点）

- 写后诊断已存在且同步阻塞：`src/tool/edit.ts:488-506`、`src/tool/write.ts:113-141`、`src/tool/apply_patch.ts:297-339`、`src/tool/ast_edit.ts:2374-2398` 四处同构尾巴：`lsp.touchFile(path, "document")` → `lsp.diagnostics()` → 内联渲染 + `Chimera.recordToolOracle({kind: "lsp"})`
- `src/lsp/lsp.ts:404-437`：touchFile 按文档版本等诊断新鲜化（`waitForDiagnostics`），diagnostics() 收集全部 client 的 push+pull 合并表（`src/lsp/client.ts:659-665`）
- `src/lsp/diagnostic.ts`：`Diagnostic.report(file, issues)` 渲染 `<diagnostics>` 块
- 现状三个缺口：无去重（同文件错误每次编辑全量重贴）；edit/apply_patch/ast_edit 只贴本文件（write 有跨文件块）；全程同步阻塞
- 传播探针：`src/chimera/propagation-probe.ts`，edit/apply_patch 传符号范围、write 传文件级，渲染 `Propagation check: N dependent symbol(s)...` + 有 predesign 时的 `Scope check:` 行；500ms 预算，超时静默降级

## 4. P0 — 诊断账本（B1）

新模块 `src/lsp/ledger.ts`：

- 作用域：InstanceState（per directory），内部 `Map<sessionID, Map<normalizedFile, FileLedger>>`，session 级隔离（不同会话不共享"已展示"状态）
- `FileLedger = { fingerprints: Map<identity, count>（上次展示的诊断 identity 集）, shownAt: number }`；清理为**纯 LRU**（session 上限 128 × 每 session 文件上限 512）：session id 是 ULID 从不复用，陈旧条目只占内存直到逐出。已否决 Bus 订阅清理方案：必须在组合内唯一的环境 Bus 实例上订阅才能收到事件，而该实例在部分 layer 组合中不可达（且 `Session.Event.Deleted` 是 SyncEvent，不直接流过 Bus）
- **诊断 identity = `hash(severity, source, code, message)`，不含行列位置**。理由：编辑会让同一错误挪行，含位置会把"老错误挪行"误判成新错误（IDE 不会因红线挪行重新提示）。代价：同文件两条 message 完全相同的错误折叠，用 count 兜底
- API（命名以实现为准）：
  - `filterFresh(sessionID, file, diagnostics) → { fresh: Diagnostic[], unchangedCount: number, resolvedCount: number }`
  - `markShown(sessionID, file, diagnostics)` —— 只对真正渲染过的文件调用
- 渲染规则（统一尾巴 helper 内执行）：
  - 有新鲜错误 → 只贴新鲜明细 + 尾部 `(另有 M 条既有诊断未变化)`
  - 无新鲜、有既有 → 一行 `本文件 M 条已知诊断未变化`
  - 此前有、现归零 → 一行 `此前 N 条诊断已全部消除`（resolved 信号，pass 证据）
- oracle 记录不变：照旧全量、pass/fail 按诊断计数

## 5. P1 — 跨文件推送 + 双去重（B2）

统一尾巴 helper（建议 `src/tool/mutation-diagnostics.ts`），edit/write/apply_patch/ast_edit 四处共用。流程：

1. 本文件（含 rename 目标等全部 mutation 触及文件）→ 走账本渲染
2. 跨文件候选 = diagnostics map 其他路径，依次减去：
   - 本次 mutation 触及的文件
   - 该 session 活跃 predesign run 申报的 `files`（复用探针 Scope check 的同一申报数据访问器）
   - 探针本屏**实际渲染条目**所在的文件（见下）
3. 探针覆盖文件 → **诊断明细完整挂在探针条目下**，不再出现在跨文件块：

```text
Propagation check: 3 dependent symbol(s) may be affected:
- authenticate (src/auth/session.ts:42)
  ⤷ LSP 45:7  error TS2322: Type 'string' is not assignable to type 'Session'
  ⤷ LSP 46:3  error TS2304: Cannot find name 'mintToken'
- loginRoute (src/routes.ts:17)
```

  - 明细复用 `diagnostic.ts` 的 pretty 格式；每条目下有界（≤3 条，超出 `+N more`）
  - 明细既然真展示了，**标 shown**（与账本语义一致）
  - suppression 只用探针渲染出来的条目，不用全量计算集（未展示的压了会真丢信息）
  - 探针 500ms 降级静默时该道过滤为空集，退化为纯 predesign 过滤
4. 探针未覆盖的红文件 → 跨文件块完整明细展示（有界，超出折叠 `+N more files with new errors`），标 shown
5. 零新鲜一个字不占

边界：diagnostics map 只含服务器 touch/open 过的文件，不是全项目扫描。

## 6. P2 — 非阻塞 + 晚到注入（B3）

现状：`touchFile(..., "document")` 内联 `waitForDiagnostics` 阻塞工具返回。改为两阶段：

- **阶段 A（内联）**：小预算（默认 ~800ms，可配 `inlineBudgetMs`）等新鲜诊断；拿到 → 走账本渲染，体验与现状一致
- **阶段 B（晚到）**：预算内未拿到 → 工具结果立即返回，detach fiber 继续等（总预算 ~12s）：
  - 每文件 mutation 版本计数（工具尾巴 bump）；fiber 捕获 detach 时版本，完成时已变 → 整条丢弃（陈旧不进会话）
  - 有新鲜错误 → 记 oracle（`kind: "lsp"`, fail, linked 到该次 mutation 的 provenanceID）→ 复用 Linked Verification Evidence 管线（`src/chimera/prompt-context.ts`），下一轮 runtime-context 单行浮出
  - 无新鲜 → 记 pass oracle
- 冷启动（服务器启动/索引中）自然落入阶段 B，不阻塞编辑
- v2 升级项（本方案不做）：轮中注入（需 agent loop 在工具调用间隙挂通知队列）

## 7. 配置与文案

- 新行为配置节（与 `src/config/lsp.ts` 的 server 配置分开，避免混型；遵循 config 模块自导出惯例）：
  - `dedupe`（默认 true）、`crossFile`（默认 true）、`late`（默认 true）、`inlineBudgetMs`（默认 ~800）
- 顺手修 `src/tool/lsp.txt:25` 残留的 "opencode" 字样
- edit/write 等 .txt 若有"写后附带 LSP errors"措辞，对齐为"只推新鲜诊断"语义

## 8. 批次与验收

| 批次 | 内容 | 主收益 | 测试 |
|---|---|---|---|
| B1 | P0 账本 + 四处尾巴统一走 helper + resolved 信号 + dedupe 开关 + lsp.txt 修正 | 降噪 | `test/lsp/ledger.test.ts`（指纹位置稳定/resolved/session 隔离/清理）；二次编辑不重复推 |
| B2 | P1 跨文件对齐 + predesign 过滤 + 探针覆盖文件就地明细 | 破坏通知 | 申报文件被过滤；探针覆盖文件明细挂条目下且不重列；探针降级退化正确；标 shown 语义 |
| B3 | P2 两阶段等待 + 晚到 oracle + late/inlineBudgetMs 开关 | 时延 | fake client 延迟发布 → 工具不阻塞、oracle 晚到记录、版本过期丢弃 |

每批独立可落、独立带测试。验证：`bun typecheck` + focused `bun test --timeout 30000`（从 packages/chimera 跑）。

## 9. 后续议题（不在本方案）

- `rename` / `code_actions` 写侧 op（LSP 对 CodeGraph 的不可替代价值，另立项）
- 轮中晚到注入（agent loop 钩子）
- 全项目 `workspace/diagnostic`（LSP 3.17）
- 探针 × LSP 的 merged 渲染格式在 WebUI/TUI 侧的呈现

## 10. e2e 实测与服务器选型决策（2026-10-16 记录）

**实测验证**（chimera serve + 真实 tsserver，演示项目 lsp-push-demo）：内联推送、账本去重（"本文件 N 条已知诊断未变化"）、resolved 信号（"此前 N 条诊断已全部消除"）、oracle 审计保真（去重只影响展示）、晚到落盘（跨文件错误完整入 payload）全部工作。

**开销计量**（M2/16GB，bench 脚本在临时目录 lsp-bench/）：

| 服务器 | 热闲置 RSS | 编辑延迟 | 备注 |
|---|---|---|---|
| TLS 栈（4 node 进程） | 441–549MB | push ~360ms | 干净编辑不重发（烧预算）；TS7 无 tsserver.js 静默不可用 |
| TS7 原生 `tsc --lsp`（单进程） | 46.7MB demo / 83.5MB 500模块 | **pull 0–4ms** | 纯 pull、功能面完整、EOF 干净退出 |
| rust-analyzer | 250–570MB 起步 | pull ~180ms | 首诊断 4–14s；父进程 SIGKILL 后孤儿存活 35s+ |
| clangd | 39MB | push ~60ms | 带 --background-index 也这么省 |

幂等性结论：无 Serena 式失败模式——spawn 一次 + 在飞去重 + 文件级复核（~60ms CPU/编辑），所有等待有预算。

**选型决策（用户拍板）**：

- **TS：用 TS7**。项目装 TS7 → 原生 `tsc --lsp --stdio`；TS≤6 → 现有 TLS 栈（版本保真，诊断语义与真实构建一致）
- **C/C++：用 clangd**。默认开级别（便宜、快、干净退出）
- rust-analyzer / jdtls 等重服务器：opt-in（入场费高 + RA 孤儿风险）
- 幂等性无忧，但**默认开启的前置护栏**（按优先级）：① 干净编辑快速放行（无发布 + 缓存空 ⇒ 视为到达，不烧满 800ms）② 默认禁网络下载（`OPENCODE_DISABLE_LSP_DOWNLOAD` 策略反转）③ 空闲逐出 / 机群上限 ④ RA 进程组杀

**待办**：

- TS7 分支从 `node bin/tsc` 壳改为直启平台原生二进制（`@typescript/typescript-<platform>-<arch>/lib/tsc`，包内 `getExePath.js` 解析；省 60–80MB wrapper）
- 会话预热 B4（轻量服务器会话启动预热 + "启动中"明示 + 晚到闭环承接）：方案 A（交互会话预热轻量服务器）已获推荐待定
- mux daemon（per-project 共享 LSP 机群）：中期架构项，一并解决多进程乘法 / run 模式冷启动 / 晚到 fiber 进程随退三问题；omp `mux/daemon.ts` 可作参考
