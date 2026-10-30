# WP-09 · plugin hook 轨迹 oracle（合成 fixture）

> 状态：**building 交付物**（WP-09，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:263`（WP-09 DoD）、`packages/chimera/specs/rust-host/plugin/{README,hook-matrix,sidecar-topology,trajectory-format}.md`、WP-02 transcript v1（`packages/chimera/test/oracle/transcript/`，只读引用）。
> 本目录只做**格式、合成轨迹、golden、replay 校验、负例**；不录制真实 session、不导入生产 `src/` 深内部件、不执行插件、不编译 Rust。

## 1. 覆盖

| 类 | 轨迹内容 | 断言 |
|---|---|---|
| `config/bootstrap` | 内置插件注册 → 外部插件注册 → `config` hook（alpha→beta）→ bootstrap end | 注册顺序、internal 先于 config、config 链式修改、bootstrap 内调用 |
| `tool.definition` | `read` 与 `bash` 各 alpha→beta；跨工具事件交错 | 每工具顺序、跨工具交错不破坏 per-tool 断言、description/parameters 修改 |
| `chat.params` | builtin→alpha→beta | params 链式修改（temperature、maxOutputTokens、options.reasoningEffort） |
| `chat.headers` | builtin→alpha→beta；alpha 内 `sdk.call(session.message)` | headers 链式修改、hook 内重入顺序 |
| `tool.execute.before` | call-1 alpha→beta 改 args；call-2 alpha 中途取消 | args 链式修改、before 先于 after、取消无 after |
| `tool.execute.after` | call-1 alpha→beta 改 output/metadata | output/metadata 链式修改、最终 snapshot |
| `auth refresh` | `auth.loader` 一次；`auth.refresh` 一次（single-flight）；`sdk.call(auth.set)`；第二个请求不重复 refresh | loader 早于首个 llm.request；refresh 晚于 headers；auth.set 往返；single-flight |

## 2. 文件

| 文件 | 作用 |
|---|---|
| `trajectory.ts` | 轨迹 codec（canonical JSONL、header/event/footer、sha256）+ 十层 verifier + 稳定错误码 |
| `harness.ts` | 套件编排：golden 字节、replay、六类覆盖、顺序、快照、auth、取消、失败策略、隐私、负例 |
| `run.ts` | `bun run` 入口；`--out` / `--write-golden` |
| `trajectory.test.ts` | `bun test` 入口（10 tests / 48 expect） |
| `fixtures/session-trajectory.ts` | 合成轨迹（85 events）+ `EXPECTED_ORDER` / `EXPECTED_SNAPSHOTS` / `FAILURE_POLICY` |
| `fixtures/negative-cases.ts` | 8 组负例 + `applyNegativeCase` |
| `golden/session-six-hooks.jsonl` | 提交的 golden（85 events） |

## 3. 运行方式

以下命令均从 `packages/chimera` 执行：

```bash
# 主判定（19 项）
bun run test/oracle/plugin/run.ts

# 保留 summary.json 到指定目录
bun run test/oracle/plugin/run.ts --out <out-dir>

# 只在 fixture 有意变更时重生成 golden
bun run test/oracle/plugin/run.ts --write-golden

# bun test 入口
bun test --timeout 30000 test/oracle/plugin/trajectory.test.ts
```

`run.ts` 默认在 OS 临时目录创建输出目录并写 `summary.json`；golden 固定在仓库内。`--write-golden` 会覆盖 golden，CI 不应使用。

## 4. 判定层与错误码

| 层 | 判定 | 主要错误码 |
|---|---|---|
| 完整性 | header/format/version/contract_rev/work_id/synthetic/footer digest/event_count/seq/字段 | `TRACE_*` |
| 注册顺序 | `plugin.registered` 的 order/去重/internal-before-config/先注册后 hook | `PLUGIN_*` |
| 取消 | 每个 cancelled op 最多一个未结束 hook；取消后无 mutate/end；取消 call 无 after | `HOOK_CANCEL_ORDER` / `HOOK_AFTER_ON_CANCELLED_CALL` / `HOOK_CANCEL_MISSING` |
| 阶段顺序 | config/bootstrap、auth.loader/provider.init、tool.definition/tool.list、params→headers、before→after | `CONFIG_PHASE_ORDER` / `AUTH_LOADER_ORDER` / `HOOK_PHASE_ORDER` |
| 重入 | `sdk.call` 在 hook.start/end 之间；auth.refresh 的 sdk.call 有前置 refresh | `HOOK_REENTRANCY_ORDER` |
| hook 顺序 | `${hook}|${scope}` 的 plugin 序列与 expectation 逐项一致 | `HOOK_ORDER_MISMATCH` / `HOOK_MISSING` / `HOOK_DUPLICATE` / `HOOK_UNEXPECTED` |
| mutation 链 | hook.start output 等于共享对象；mutate before/after 连续；snapshot 等于最终对象 | `HOOK_MUTATION_CHAIN` / `HOOK_SNAPSHOT_*` |
| auth | loader 一次；refresh single-flight/`auth.set`/并发≥2/正 lifetime；refresh 晚于 headers | `AUTH_LOADER_ORDER` / `AUTH_REFRESH_POLICY` / `AUTH_REFRESH_ORDER` |
| 失败策略 | 8 个 policy hook 各一行，`host_effect` 固定映射 | `HOOK_FAILURE_POLICY` |
| replay | parse→encode 字节一致 | `TRACE_ENCODING_UNSTABLE` |

## 5. 负例（8 组）

| id | 层 | 破坏 | 期望码 |
|---|---|---|---|
| `order-swap-chat-params` | semantic | 交换 chat.params alpha/beta 块 | `HOOK_ORDER_MISMATCH` |
| `missing-tool-after-beta` | semantic | 删除 after beta 块 | `HOOK_MISSING` |
| `duplicate-tool-before-alpha` | semantic | 复制 before alpha 块 | `HOOK_DUPLICATE` |
| `tamper-before-args` | semantic | 改 before 的 `before` 值 | `HOOK_MUTATION_CHAIN` |
| `phase-after-before-before` | semantic | after 块移到 before 块之前 | `HOOK_PHASE_ORDER` |
| `cancel-emits-after` | semantic | 取消 call-2 补 after 块 | `HOOK_AFTER_ON_CANCELLED_CALL` |
| `integrity-stale-footer` | integrity | 删一行保留旧 footer | `TRACE_BODY_DIGEST` |
| `integrity-seq-order` | integrity | 改 seq 并重算 footer | `TRACE_SEQ_ORDER` |

语义负例会重新编码并重算 footer，确保进入语义层；integrity 负例专门验证格式层。每个负例都断言**精确错误码**，不是“只要抛错”。

## 6. 自验（本批实测）

| 命令（`packages/chimera`） | 结果 |
|---|---|
| `bun run test/oracle/plugin/run.ts` | PASS 19/19；85 events；8 负例全部按期望码拒绝 |
| `bun test --timeout 30000 test/oracle/plugin/trajectory.test.ts` | 10 pass / 0 fail（48 expect） |
| `bun run test/oracle/plugin/run.ts --write-golden` | 写出 `golden/session-six-hooks.jsonl`（85 events），随后 19/19 pass |

## 7. 已知限制

- **合成轨迹**：`header.synthetic: true`；不是真实 session 录制，不能作为“真实 hook 顺序”的证据。它只冻结契约形状与当前源码推导出的顺序。
- **不覆盖真实插件执行**：fixture 不加载 npm 包、不执行插件代码；插件行为由 `hook-matrix.md` 的源码证据描述。
- **不覆盖 provider 网络**：auth refresh 只记录 single-flight/`auth.set` 事实，不记录真实 HTTP。
- **跨实现 parity 未建立**：本包只有 TS oracle；Rust recorder 若要复用格式，需另做双臂字节对账（类似 WP-02 的已知限制）。
- **`sdk.call` allowlist 未收敛**：fixture 只覆盖 `session.message` 与 `auth.set`；完整 allowlist 由 WP-04 的 operation 清单决定。
- **取消语义是“host 不再观察”**：当前 TS 没有 AbortSignal；轨迹的“start 无 end”不声称插件 Promise 已停止。
- **task after 的 `undefined`**：fixture 只覆盖 registry 工具路径；task 路径的 `undefined` 是 `hook-matrix.md` §4 的已知差异，未在 golden 中建模。

## 8. oracle_commands 建议（供 manifest 回填，未拍板）

```yaml
oracle_commands:
  - "cd packages/chimera && bun run test/oracle/plugin/run.ts"
  - "cd packages/chimera && bun test --timeout 30000 test/oracle/plugin/trajectory.test.ts"
```

## 9. 证据索引

| 证据 | 位置 |
|---|---|
| WP-09 DoD | `RUST_FULL_MIGRATION_PLAN.md:263` |
| 六类 hook 语义 | `packages/chimera/specs/rust-host/plugin/hook-matrix.md` |
| 轨迹格式 | `packages/chimera/specs/rust-host/plugin/trajectory-format.md` |
| sidecar 拓扑 | `packages/chimera/specs/rust-host/plugin/sidecar-topology.md` |
| WP-02 transcript v1 | `packages/chimera/test/oracle/transcript/README.md:52-85` |
| WP-02 format/codec | `packages/chimera/test/oracle/transcript/format.ts:144-178,236-281` |
| WP-02 harness | `packages/chimera/test/oracle/transcript/harness.ts:150-228` |
| 合成轨迹 | `packages/chimera/test/oracle/plugin/fixtures/session-trajectory.ts` |
| golden | `packages/chimera/test/oracle/plugin/golden/session-six-hooks.jsonl` |