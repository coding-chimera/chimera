# WP-09 · hook IPC / JS 兼容拓扑与调用轨迹 fixture

> 状态：**building 交付物**（WP-09，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:263`（WP-09 DoD）、`:22`（W3 缺 hook 风险）、`:63-65`（终态与 plugin-only 边界）、`:129`（plugin loader/SDK 长期 Bun sidecar）、`:181`（W3 最小真实 hook sidecar）、`:200-202`（W5 生态硬化）、`:353`（D2 待拍板）；`packages/chimera/specs/rust-host/manifest.yaml:238-259`（WP-09 条目）；`packages/chimera/specs/rust-host/a0-scope-decisions.md:42,54,68,122`；`packages/chimera/specs/rust-host/partition-table.md:36,59`。
> 本包只出**契约、合成 fixture、harness、文档**；不实现生产 sidecar、不改 `packages/chimera/src/`、不编译 Rust、不构建可执行体。

## 1. 范围

### 1.1 覆盖

| 面 | 产物 | 说明 |
|---|---|---|
| 六类 hook 语义 | `hook-matrix.md` | `config/bootstrap`、`tool.definition`、`chat.params/headers`、`tool.execute.before`、`tool.execute.after`、`auth refresh` 的顺序、可变性、取消、失败策略；每条有 `file:line` 证据 |
| JS 兼容拓扑 | `sidecar-topology.md` | 进程边界、ipc-v0 通道、方法 allowlist、重入、超时/崩溃策略、npm 单一 owner、plugin-only 边界 |
| 轨迹格式 | `trajectory-format.md` | canonical JSONL、事件类型、scope、十层判定、稳定错误码 |
| 调用轨迹 fixture | `packages/chimera/test/oracle/plugin/` | 一次 session 内六类 hook 的完整合成轨迹 + golden + replay + 8 组负例 |

### 1.2 非目标

- 不实现生产 hook sidecar、Rust host、provider transport、session/agent loop、工具执行循环。
- 不修改 `packages/chimera/src/` 或 `packages/plugin/src/`；只读引用。
- 不录制真实 session；fixture 全部是合成输入（`synthetic://`、`ses_synthetic`、`demo.*`）。
- 不做 WP-03 的 fault matrix/统计门；只做 fixture 级负例。
- 不替 §13 D2 决定单/双 sidecar；本文只固定 plugin-only 边界与契约形状。

## 2. 文件索引

```text
packages/chimera/specs/rust-host/plugin/
├── README.md                 # 本文件
├── hook-matrix.md            # 六类 hook 语义矩阵（现状 + 目标建议）
├── sidecar-topology.md       # plugin-only sidecar / IPC / npm owner / 边界
└── trajectory-format.md      # hook 轨迹格式 v1 与判定层

packages/chimera/test/oracle/plugin/
├── README.md                 # 运行方式、覆盖、负例、自验
├── trajectory.ts             # 轨迹 codec + 十层 verifier
├── harness.ts                # 套件编排：golden/replay/覆盖/负例/隐私
├── run.ts                    # bun run 入口（--out / --write-golden）
├── trajectory.test.ts        # bun test 入口
├── fixtures/
│   ├── session-trajectory.ts # 合成轨迹 + 期望顺序/快照/失败策略
│   └── negative-cases.ts     # 8 组负例 + 精确期望码
└── golden/
    └── session-six-hooks.jsonl
```

## 3. DoD 对照

| DoD | 交付 | 自评 |
|---|---|---|
| 1. 六类 hook 各列顺序、可变性、取消、失败策略（依据 `src/plugin/` 与 `packages/plugin` 源码，引用 `file:line`） | `hook-matrix.md` §1–§2；每条有证据；§4 列已知差异 | **满足**。六类共 6 行；`chat.params`/`chat.headers` 两个触发点、`tool.before`/`tool.after` 两个失败语义分别展开；`auth refresh` 覆盖 loader + lazy refresh + auth.set。 |
| 2. ≥1 条完整轨迹 replay fixture：一次 session 内六类 hook 的实际调用序列（合成标注；含参数快照与顺序断言） | `fixtures/session-trajectory.ts`（85 events）、`golden/session-six-hooks.jsonl`、`trajectory.ts` verifier、`harness.ts` | **满足**。header `synthetic: true`；覆盖六类；每个 scope 有 output 快照、mutation 链、最终 snapshot；order/mutation/auth/cancel/policy/replay 全部断言；`bun run test/oracle/plugin/run.ts` 19/19 pass。 |
| 3. JS 兼容拓扑契约：sidecar 进程边界、IPC 通道、超时/崩溃策略；npm 包单一 owner 约定 | `sidecar-topology.md` §1–§4 | **满足**。进程边界、ipc-v0 复用、方法 allowlist、重入、超时表、崩溃矩阵、失败码、npm 单一 owner、文件锁与降级均有证据/建议标注。 |
| 4. 明确 plugin-only sidecar 边界：不承载 session/agent loop（与计划 §2 决策一致） | `sidecar-topology.md` §5；`hook-matrix.md` §5 | **满足**。允许/禁止面逐项列出；明确“插件工具体可在 sidecar 执行，但工具循环/权限/结果落库在 host”；引用 `RUST_FULL_MIGRATION_PLAN.md:65`。 |

## 4. 关键结论摘要

1. **顺序**：内置插件固定顺序 → 外部插件配置顺序 → 每个 hook 按注册顺序串行。外部 import 并行，但 `applyPlugin` 串行，注册顺序不受 import 完成顺序影响（`plugin/index.ts:190-272`；`loader.ts:193-228`）。
2. **可变性**：所有 hook 共享同一个 output 对象；后注册插件看到前一个插件的修改。`config` 直接改 config 对象；`tool.before` 的 args 就是工具体收到的对象；`tool.after` 的 output 被 `completeToolCall` 持久化；`chat.headers` 覆盖同名模型 header。
3. **取消**：hook 没有 AbortSignal/超时；中断只停止 host 等待，不取消插件 Promise。工具路径用 `executeGuarded` race abort（`prompt.ts:1249-1280`）；取消的 call 不得有 after。
4. **失败**：`config`/`dispose` 吞错继续；`tool.definition`/`chat.params`/`chat.headers` 失败让该操作失败；`tool.before` 失败不执行工具；`tool.after` 失败丢弃已完成结果；`auth.loader` 失败是 provider state defect；`auth.refresh` 失败让请求失败（xai 的 auth.set 失败被吞，是现状差异）。
5. **拓扑**：建议每 workspace 一个 plugin-only Bun sidecar；复用 ipc-v0（`plugin.loader` capability）；host 是顺序/截止/取消/最终状态/auth/config 的唯一权威；sidecar 只执行 JS 并返回 mutation + trace。
6. **npm**：sidecar 是 npm resolve/install、plugin-meta、config patch 的唯一 owner；host 永不执行 npm；文件锁是跨进程兜底，不是多 owner 许可。
7. **边界**：sidecar 不承载 session/agent loop、历史、prompt assembly、provider transport、权限、工具调度、DB、HTTP、graph/MCP。插件工具体可在 sidecar 执行，但工具循环/权限/结果落库在 host。

## 5. 与其它 WP 的边界

| WP | 关系 |
|---|---|
| WP-02 | 复用 transcript v1 的 header/event/footer、digest、seq 规则；不修改 `test/oracle/transcript/`。本格式的 `format` 独立，WP-02 parser 不接受本格式。 |
| WP-03 | 本包只做 fixture 级负例；fault matrix/统计门留给 WP-03。 |
| WP-04 | `sdk.call` allowlist 需要按 WP-04 的 live operation 清单收敛；本文只列现状观测到的最小集合（`session.message`/`session.get`/`auth.set`）。 |
| WP-05 | auth store 的权威/保留/恢复由 WP-05 定义；本文只固定“host 是 auth 唯一 writer，sidecar 通过 RPC 写”。 |
| WP-07 | IPC transport/握手/取消/drain/崩溃复用 ipc-v0；本文不重新定义帧格式。 |
| WP-08 | provider transport 与 auth refresh 的 provider 侧归属由 WP-08 定义；本文只覆盖插件 hook 的调用顺序与 sidecar 边界。 |
| WP-10 | control-plane 的 hook/permission/question/job family 轨迹可复用 `hook.start`/`hook.end`/`sdk.call` 形状，但需自己的 event kind/verifier。 |

## 6. 自验（本批实测）

| 命令（在 `packages/chimera` 内） | 结果 |
|---|---|
| `bun run test/oracle/plugin/run.ts` | PASS（19/19 checks；85 events；8 组负例全部按期望码拒绝） |
| `bun test --timeout 30000 test/oracle/plugin/trajectory.test.ts` | 10 pass / 0 fail（48 expect） |
| `bun run test/oracle/plugin/run.ts --write-golden` | 写出 `golden/session-six-hooks.jsonl`（85 events），随后 19/19 pass |
| `bun typecheck` | 通过（tsgo 无输出；本批实测） |

> `bun typecheck` 属于统一门禁（`RUST_FULL_MIGRATION_PLAN.md:297`），建议由 parent 在 G0 聚合时统一跑；本包 focused 命令不把它塞进 `oracle_commands`。

## 7. oracle_commands 建议（供 manifest 回填，未拍板）

```yaml
oracle_commands:
  - "cd packages/chimera && bun run test/oracle/plugin/run.ts"
  - "cd packages/chimera && bun test --timeout 30000 test/oracle/plugin/trajectory.test.ts"
```

说明：第一条是 focused 主判定（19 项）；第二条验证 bun test 集成与逐项负例断言。`bun typecheck` 是包级统一门禁，不列入 WP-09 focused 列表。

## 8. 待拍板

1. **D2 拓扑**：plugin sidecar 是否与长尾 provider/orchestrate sandbox 共用进程（`RUST_FULL_MIGRATION_PLAN.md:353`）。本文建议 plugin-only 独立。
2. **超时数值**：`sidecar-topology.md` §3.1 全部是建议起点，需 H0/H1 校准。
3. **重试策略**：只读 hook 的“重启后重试 1 次”是否足够；`tool.after` 的 `unknown_side_effect` 是否需要人工确认。
4. **内置插件归属**：codex/copilot/xai 等内置 auth 插件是否也迁移到 sidecar，还是 host 原生实现。
5. **轨迹格式升级**：是否把 `chimera.oracle.plugin.hook-trace` 升级为跨语言共享契约；若是，按 `partition-table.md:133` 递增 `contract_rev`。
6. **真实录制隐私边界**：本包只冻结格式与合成 fixture；真实 session 录制的脱敏/采样策略未定。

## 9. 证据索引

| 证据 | 位置 |
|---|---|
| WP-09 DoD | `RUST_FULL_MIGRATION_PLAN.md:263` |
| W3 缺 hook 风险 | `RUST_FULL_MIGRATION_PLAN.md:22` |
| 终态架构 / Bun 兼容 sidecar | `RUST_FULL_MIGRATION_PLAN.md:92-114` |
| plugin-only 边界 / 删除 Bun session worker | `RUST_FULL_MIGRATION_PLAN.md:63-65` |
| plugin loader/SDK 长期 Bun sidecar | `RUST_FULL_MIGRATION_PLAN.md:129` |
| W3 最小真实 hook sidecar | `RUST_FULL_MIGRATION_PLAN.md:181` |
| W5 生态硬化 | `RUST_FULL_MIGRATION_PLAN.md:200-202` |
| D2 待拍板 | `RUST_FULL_MIGRATION_PLAN.md:353` |
| WP-09 manifest | `packages/chimera/specs/rust-host/manifest.yaml:238-259` |
| WP-09 范围/非目标 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:42,54,68,122` |
| WP-09 分区 | `packages/chimera/specs/rust-host/partition-table.md:36,59` |
| Hooks 类型 | `packages/plugin/src/index.ts:223-341` |
| trigger 实现 | `packages/chimera/src/plugin/index.ts:314-327` |
| 插件注册/加载 | `packages/chimera/src/plugin/index.ts:97-108,190-205,249-272` |
| ipc-v0 | `packages/chimera/specs/rust-host/ipc-v0.md` |
| `plugin.loader` capability | `packages/chimera/src/host/ipc-handshake.ts:40-63` |
| npm/meta/install | `packages/chimera/src/plugin/loader.ts`、`meta.ts:50-60`、`install.ts:344-349`、`shared.ts:193-204` |