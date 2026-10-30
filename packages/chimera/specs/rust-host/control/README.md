# WP-10 · 控制面契约与行为 fixture

> 状态：**building 交付物**（WP-10，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:264`（WP-10 DoD）、`RUST_FULL_MIGRATION_PLAN.md:320`（343 语义清单说明）、`RUST_FULL_MIGRATION_PLAN.md:284`（family 256 边界）、`packages/chimera/specs/rust-host/manifest.yaml:272-293`（WP-10 manifest 条目）。
> 依赖已 verified：WP-02 transcript 格式（`packages/chimera/test/oracle/transcript/README.md:52-85`）、WP-05 表级权威/保留矩阵（`packages/chimera/specs/rust-host/authority/table-authority-matrix.md:20-58`）、WP-09 hook 轨迹（`packages/chimera/specs/rust-host/plugin/trajectory-format.md`）。
> 本包只做**契约、机读清单、合成 fixture、校验脚本与文档**；不写生产迁移代码、不编译 Rust、不执行新鲜可执行体、不导入生产 `src/` 深内部件、不改 manifest/lockfile。

## 1. 结论先行

- `packages/chimera/test/oracle/control/` 下有三层机读产物：
  1. `semantic-points.json`：343 个 W-E 语义点的“点/桶 → owner → fixture 状态”映射；
  2. `domains/*.json`：12 个控制域的清单（含 `待补` 点与 owner 角色）；
  3. `fixtures/**/*.json`：29 组合成输入 → 期望行为判定，由 `fixtures/judges.ts` 的纯参考判定器执行。
- `control-check.ts` 可独立运行，校验计数、owner 非空、fixture 存在性/schema、引用闭包、域覆盖，并实跑 29/29 组 fixture；`control.test.ts` 是 `bun test` 入口。
- 343 的真实构成：**223 个逐点枚举 + 120 个模块级 mechanical 桶**。归档只对 223 个非 mechanical 点给出 `file:line`，其余 120 个只有模块级计数；本包用 12 个 bucket 承载，不伪造逐点行号（详见 §3 与 `semantic-points.md`）。
- 控制域 fixture 是**合成参考判定**，不是 TS-vs-Rust 生产 parity harness；已知差异单列于 `known-differences.md`。

## 2. 范围与非目标

### 2.1 覆盖域（12 个）

| 域 | 清单 | 行为 fixture | 契约文档 |
|---|---|---|---|
| config/bootstrap | `test/oracle/control/domains/config-bootstrap.json` | `fixtures/config-bootstrap/`（2 组） | 本文件 §4 |
| skills | `domains/skills.json` | `fixtures/skills/`（2 组） | 本文件 §4 |
| instructions | `domains/instructions.json` | `fixtures/instructions/`（2 组） | 本文件 §4 |
| workbrief | `domains/workbrief.json` | `fixtures/workbrief/`（2 组） | 本文件 §4 |
| goal | `domains/goal.json` | `fixtures/goal/`（2 组） | 本文件 §4 |
| prompt assembly | `domains/prompt-assembly.json` | `fixtures/prompt-assembly/`（2 组） | 本文件 §4 |
| tool_search | `domains/tool-search.json` | `fixtures/tool-search/`（2 组） | 本文件 §4 |
| compaction | `domains/compaction.json` | `fixtures/compaction/`（2 组） | 本文件 §4 |
| mutation 链 | `domains/mutation-chain.json` | `fixtures/mutation-chain/`（6 组） | `mutation-chain.md` |
| MCP 三 transport | `domains/mcp-transports.json` | `fixtures/mcp-transports/`（2 组） | `mcp-transports.md` |
| job family | `domains/job-family.json` | `fixtures/job-family/`（2 组） | `job-family.md` |
| retention | `domains/retention.json` | `fixtures/retention/`（3 组） | `retention.md` |

### 2.2 明确非目标

- **不实现生产迁移代码**：本包没有 Rust crate、没有 TS 生产改动、没有 manifest 回填。
- **不做真实 session/网络/DB 录制**：fixture 全部是合成输入；不打开 SQLite、不启动 MCP、不执行插件、不调用 provider。
- **不声称 343 项已逐点测试**：只有 67 个 W-E 点关联到域级行为 fixture（`fixture.status = existing-domain`），156 个点与 120 个 mechanical 桶仍是 `待补`；这正是 DoD 允许的 `已有/待补/不适用` 三态。
- **不替代 WP-02/WP-03/WP-05/WP-09**：transcript、fault matrix、表级矩阵、hook 轨迹各自仍以原包为权威；本包只做控制面语义的汇总与衔接。

## 3. 343 的出处与真实枚举数

### 3.1 出处

- 计划正文：`RUST_FULL_MIGRATION_PLAN.md:264` 的 WP-10 DoD 写“343/343 语义点”；`:320` 说明完整清单本轮存于本机 tool-output 归档；`:9` 与 `:79` 记录 W-E 解剖战役的 343 分档。
- 本机会话记忆：`memory.md:22` 记录“343 个非平凡语义点分档=mechanical 120 / di 74 / structured-concurrency 68 / coordination 45 / streaming 31 / hard 仅 5”，完整数据指向 `tool-output/tool_1817c7215001Jj52Lh6h4U02cg`。
- 归档实际内容：12 个模块的 `semanticsCount` 之和 = 343；`nonMechanical` 数组长度 = 223；`byClass.mechanical = 120`。

### 3.2 实际枚举数与差异

| 口径 | 数量 | 说明 |
|---|---:|---|
| 模块计数总和 | 343 | 12 个模块 `semanticsCount` 相加 |
| 逐点枚举（`nonMechanical`） | 223 | 有 `module/primitive/where/purpose/contract/portability`，`where` 为 file:line |
| mechanical 桶 | 120 | 归档只有模块级计数，没有逐点 `file:line` |

逐模块拆分（`semanticsCount - nonMechanical = mechanical`）：

| 模块 | 总数 | 逐点 | mechanical 桶 |
|---|---:|---:|---:|
| session-prompt | 31 | 21 | 10 |
| session-core | 28 | 19 | 9 |
| session-stream | 36 | 17 | 19 |
| session-infra | 25 | 15 | 10 |
| server-httpapi | 35 | 24 | 11 |
| server-core | 33 | 26 | 7 |
| agent | 25 | 17 | 8 |
| tool-core | 36 | 25 | 11 |
| tool-graph | 30 | 22 | 8 |
| provider | 23 | 14 | 9 |
| config-storage | 23 | 14 | 9 |
| plugin | 18 | 9 | 9 |
| **合计** | **343** | **223** | **120** |

**解释**：343 这个数没有错，但“逐点 file:line 清单”只覆盖 223 点。WP-10 不把 120 个 mechanical 点拆成 120 条伪造行；而是生成 12 个 bucket，每个 bucket 的 `count` 等于该模块 mechanical 数，`fixture.status = pending`，owner 角色指向模块 owner。`control-check.ts` 断言 `223 + Σbucket.count = 343`。

### 3.3 两层语义模型

- **W-E 层（343）**：Effect 原语/生命周期语义，回答“迁 Rust 时哪些点不能丢”。`semantic-points.json` 的 `points` 与 `mechanical_buckets` 是这一层。
- **控制域层（60+）**：产品行为语义，回答“控制面在给定输入下应如何判定”。`domains/*.json` 的 `semantic_points` 是这一层。
- 两层通过 `control_domains` 与域清单的 `fixture` 引用衔接；`control-check.ts` 校验 12 个域都至少被一个 W-E 点/桶引用。

## 4. 12 域契约摘要

| 域 | 核心断言 | 证据 |
|---|---|---|
| config/bootstrap | 源合并顺序 global→environment→project→managed；plugin.init 晚于 config.get；bootstrap 服务并发初始化且单点失败不阻断 | `src/config/config.ts:737-775`、`src/project/bootstrap.ts:43-64` |
| skills | 外部/配置目录/`skills.paths`/`skills.urls` 发现；非内置同名覆盖内置并告警；frontmatter name 不一致拒绝 | `src/skill/index.ts:100-203` |
| instructions | 全局首个存在文件、项目首个文件族；`config.instructions` 本地/远程分流 | `src/session/instruction.ts:106-166` |
| workbrief | 空白压缩、12 条/300 字符上限；空 brief 删除行；固定 8 段渲染 | `src/session/work-brief.ts:55-118` |
| goal | active→complete/blocked/paused、paused→active；3 次空转或 3 次工具失败置 blocked；预算优先于 resume；自动续跑 <25 | `src/session/goal.ts:23-25,101-106,147-170,293-348` |
| prompt assembly | provider/agent→overlay→capability→multi-agent→ultra→input/system→user/system；override 抑制 capability；ultra 仅 root | `src/session/llm.ts:230-255`、`src/session/system.ts:142-197` |
| tool_search | 3×id+1×description+1×prefix；同分 id 升序；limit≤20；deny/subagent-hidden 过滤；压缩边界提升 | `src/session/tool-search.ts:199-247,386-399` |
| compaction | tail_turns/preserve_recent_tokens 选择；最近 2 turn 起扫、PRUNE_PROTECT=40000、PRUNE_MINIMUM=20000；受保护工具不裁剪 | `src/session/compaction.ts:39-40,145-155,284-384` |
| mutation 链 | predesign→claim→mutation→auto audit→oracle→obligation 的 gate 与 closeout | 见 `mutation-chain.md` |
| MCP 三 transport | local stdio；remote StreamableHTTP→SSE；auth 错误停止回退 | 见 `mcp-transports.md` |
| job family | BFS 256；active=running∨delivery-pending；取消级联；generation 安全 markDelivered | 见 `job-family.md` |
| retention | session 30 天、committed evidence 30 天、active obligation 保护、短 TTL | 见 `retention.md` |

## 5. 运行方式

以下命令均从 `packages/chimera` 执行：

```bash
# 完整校验（清单 + schema + 引用闭包 + 29 组 judge）
bun test/oracle/control/control-check.ts

# bun test 入口
bun test --timeout 30000 test/oracle/control/control.test.ts

# 重新生成 semantic-points.json（需要本机 W-E 归档）
bun test/oracle/control/build-semantic-points.ts --source <archive-path>
```

`control-check.ts` 期望输出：

```text
PASS contract_rev cr-2026-10-30-r1
PASS semantic points: 223 enumerated + 12 buckets = 343
PASS fixture status: existing-domain 67, existing 0, pending 276, not-applicable 0
PASS domains: 12 manifests, 29 fixtures (14 behavior, 15 negative)
PASS judges: 29/29 fixtures executed
PASS owner: every semantic point, bucket, and domain point has a non-empty owner_role
```

## 6. DoD 自评

| DoD | 状态 | 证据 |
|---|---|---|
| 343/343 每个有 owner + fixture（已有/待补/不适用），不允许空 owner | 达成（映射层） | `semantic-points.json`：223 点 + 12 桶 = 343；owner 全非空；67 existing-domain / 276 pending / 0 N/A（`existing` 点级 parity 为 0） |
| 先找到 343 出处；实际枚举数不同则如实记录并解释 | 达成 | §3；223 逐点 + 120 模块级桶，未凑数 |
| 覆盖 config/bootstrap、skills、instructions、workbrief、goal、prompt assembly、tool_search、compaction、mutation 链、MCP 三 transport、job family、retention | 达成 | 12 个 `domains/*.json`，每域 ≥1 组 behavior fixture |
| 每域机读清单 + ≥1 组行为 fixture；待补点显式列出并指派 owner | 达成 | 12 个清单；29 组 fixture；`fixture.status=pending` 的点保留 owner_role |
| `control-check.ts` 校验计数、owner、fixture 存在性/schema；实跑证据 | 达成 | §5 输出；`control.test.ts` 1 pass / 4 expect |
| `specs/rust-host/control/` 控制面契约：mutation 链、MCP 三 transport、job family 取消/quiescence、retention 30 天与 WP-05 衔接 | 达成 | `mutation-chain.md`、`mcp-transports.md`、`job-family.md`、`retention.md` |
| 新增能力与已知差异单列 | 达成 | `known-differences.md` |

## 7. oracle_commands 建议（供 manifest 回填，未拍板）

```yaml
oracle_commands:
  - "cd packages/chimera && bun test/oracle/control/control-check.ts"
  - "cd packages/chimera && bun test --timeout 30000 test/oracle/control/control.test.ts"
```

## 8. 证据索引

| 证据 | 位置 |
|---|---|
| WP-10 DoD | `RUST_FULL_MIGRATION_PLAN.md:264` |
| 343 归档说明 | `RUST_FULL_MIGRATION_PLAN.md:320` |
| family 256 边界 | `RUST_FULL_MIGRATION_PLAN.md:284` |
| WP-10 manifest | `packages/chimera/specs/rust-host/manifest.yaml:272-293` |
| 343 来源记忆 | `memory.md:22` |
| WP-02 transcript | `packages/chimera/test/oracle/transcript/README.md:52-85` |
| WP-05 权威矩阵 | `packages/chimera/specs/rust-host/authority/table-authority-matrix.md:20-58` |
| WP-09 hook 矩阵 | `packages/chimera/specs/rust-host/plugin/hook-matrix.md` |
| 机读清单 | `packages/chimera/test/oracle/control/semantic-points.json`、`domains/*.json` |
| 行为 fixture | `packages/chimera/test/oracle/control/fixtures/**/*.json` |
| 校验脚本 | `packages/chimera/test/oracle/control/control-check.ts` |