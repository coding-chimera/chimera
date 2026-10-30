# WP-03 · 同环境重复基线与噪声带（baseline v1）

> 状态：**verified 交付物（review 修正后）**（WP-03，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:257`（WP-03 DoD：统计层给出同环境重复基线与噪声带）、`RUST_FULL_MIGRATION_PLAN.md:300`（压测阈值按同环境重复基线签定）、`packages/chimera/specs/rust-host/manifest.yaml:88-107`（WP-03 manifest 条目）、`packages/chimera/specs/rust-host/partition-table.md:30,53`（`T/baselines/**` 独占分区）、`packages/chimera/specs/rust-host/a0-scope-decisions.md:36,64`（WP-03 范围与 W0 四层出口）。
> 本目录只做统计层、测量 CLI、基线数据与文档；不写生产迁移代码、不编译 Rust、不构建/执行新鲜可执行体（`a0-scope-decisions.md:50-51`）。

## 1. 结论先行

- 对 WP-02 `runSuite()` 做 **1 次 warm-up + N=5 次计时运行**；每次 24/24 checks 通过，两个 scenario 的 transcript sha256 在全部 6 次运行中逐字节稳定。
- 实测计时样本（warm-up 不计入）：`[11, 13, 17, 15, 11]` ms；median `13` ms，MAD `2` ms，噪声带 `[0, 33]` ms。
- 统计门分三部分：**同环境校验**（baseline 与当前测量的 runtime/platform 必须一致）、**hash 稳定性**（硬门）与 **duration 中位数不高于噪声带上沿**（同环境性能门，单侧：更快不算回归）。三者独立报告，不把性能抖动伪装成语义差异。
- 基线数据在 `baseline.json`；刷新命令是 `bun run test/oracle/baselines/measure.ts --runs 5 --write-baseline`。

## 2. 方法

### 2.1 采样

`measure.ts` 每次调用执行：

1. **1 次 warm-up**：完整跑一遍 WP-02 `runSuite()`，用于预热模块/文件系统缓存；其耗时**不计入** `samples_ms`，但其 transcript hash 与 checks 仍参与稳定性检查。
2. **N 次计时运行**（默认 `N = 5`，最小 5）：每次完整跑 `runSuite()`，记录墙钟毫秒、每个 scenario 的 transcript sha256 与字节数、checks 通过数。
3. 每次运行后 `cleanupSuite()` 删除临时目录，避免仓库内残留。

`runSuite()` 的语义见 `test/oracle/transcript/harness.ts:230-258`；它本身已包含双臂隔离、golden 对账、因果层、重放层与 10 组负例。

### 2.2 噪声带公式

对样本 `x_1..x_N`：

```text
median   = 中位数(x)
MAD      = 中位数(|x_i - median|)
half     = max( ceil(3 × MAD), ceil(0.20 × median), 20 )
low      = max(0, ceil(median - half))
high     = ceil(median + half)
```

- `3 × MAD` 吸收普通抖动；MAD 对离群点不敏感。
- `20% × median` 是相对下限，防止大基线在 MAD 很小时带过窄。
- `20 ms` 是绝对下限，针对当前 10 ms 级 harness 的计时器/调度粒度与受管端点并发负载；否则零 MAD 会得到零宽带。
- 门禁比较的是**候选测量的中位数**，不是单个样本；单次冷启动离群不会直接判负。
- 门禁是**单侧**的：只有 `candidate.median > high` 才判负；候选更快（`median < low`）不判负，因为性能提升不是回归。
- `cv = 样本标准差 / 均值` 只作为可读指标，不参与判定。

### 2.3 为什么不用均值/标准差做唯一门

当前 harness 只有 10 ms 量级，均值/标准差对一次冷启动非常敏感（例如 warm-up 33 ms、正式样本 11–17 ms）。MAD + 相对/绝对下限的组合更稳健，也更容易解释“同环境基线”的含义。该选择是**建议**，不是跨环境性能承诺；见 §6.2。

## 3. 实测数据（本批）

环境：`bun 1.4.0`，`darwin-arm64`，受管端点同环境单机测量。基线文件不含主机名、路径或凭据。

### 3.1 计时样本

| 指标 | 值 |
|---|---|
| measured runs | 5 |
| warm-up（不计入） | 33 ms |
| `samples_ms` | `[11, 13, 17, 15, 11]` |
| min / max | 11 / 17 ms |
| median | 13 ms |
| mean | 13.4 ms |
| sample stdev | 2.61 ms |
| MAD | 2 ms |
| CV | 0.1946 |
| half width | 20 ms |
| **noise band** | **`[0, 33]` ms** |

### 3.2 输出 hash 稳定性

| scenario | transcript sha256 | bytes |
|---|---|---|
| `deterministic-four-classes` | `ed59ce7e331884853d600ecf2a2c37ddc5d5172646a0f5700be5c2d3664c0ac7` | 2604 |
| `causal-order-four-classes` | `3a5983c97620d1e33d01cd7a80b0c29811fe35919e6750c91d99d099cb278046` | 3007 |

全部 6 次运行（1 warm-up + 5 measured）逐 scenario 相同；WP-02 checks 每次 24/24。

### 3.3 基线文件字段

| 字段 | 含义 |
|---|---|
| `format` / `version` | 固定 `chimera.oracle.baseline` / `1` |
| `contract_rev` | 固定 `cr-2026-10-30-r1` |
| `environment` | `runtime` / `platform` / `note`；不含主机名、路径、凭据 |
| `runs` | measured runs 数（≥5） |
| `samples_ms` | 按运行顺序的计时毫秒 |
| `duration` | min/max/median/mean/stdev/MAD/CV/noise band |
| `hashes` | 每个 scenario 的 sha256 与字节数 |
| `checks` | WP-02 suite 的 total/passed |
| `method` | 噪声带、hash 稳定性、门禁的文字定义 |

## 4. 判定码

`checkAgainstBaseline()`（`stats.ts`）按以下顺序返回稳定码：

| 码 | 条件 |
|---|---|
| `BASELINE_INVALID` | 基线自身 `runs < 5` |
| `BASELINE_ENV_MISMATCH` | 基线 `environment.runtime` / `platform` 与当前测量不一致 |
| `BASELINE_RUNS_INSUFFICIENT` | 候选测量 `runs < 5` |
| `BASELINE_SAMPLE_COUNT_MISMATCH` | `samples_ms.length !== runs` |
| `BASELINE_CHECKS_FAILED` | WP-02 checks 未全通过 |
| `BASELINE_HASH_DRIFT` | scenario 集合或任一 transcript sha256 不同 |
| `BASELINE_DURATION_OUT_OF_BAND` | 候选 `duration.median_ms` **高于**基线 `high_ms`（单侧；更快不判负） |
| `BASELINE_OK` | 全部通过 |

同环境校验与 hash 检查都在 duration 之前：跨 runtime/platform 不比较性能，语义/输出漂移优先于性能漂移。

## 5. 刷新与使用

以下命令均从 `packages/chimera` 执行：

```bash
# 1) 采集并刷新 committed baseline（只在同环境类、fixture/golden 有意变更时执行）
bun run test/oracle/baselines/measure.ts --runs 5 --write-baseline

# 2) 同环境门禁：重新测量并与 baseline.json 比较
bun run test/oracle/baselines/measure.ts --runs 5 --check

# 3) 只打印测量 JSON（不写文件）
bun run test/oracle/baselines/measure.ts --runs 5 --json

# 4) 统计层/基线 schema 单元测试
bun test --timeout 30000 test/oracle/baselines/baselines.test.ts
```

刷新纪律：

- `--write-baseline` 是 `baseline.json` 的唯一维护路径；不要手改计时数字。
- 只在同一机器类（同 OS/arch、同 Bun 主版本、同负载条件）刷新；跨机器类不共享 duration 门，只共享 hash 门。
- 刷新后 review diff：`samples_ms`、`duration`、`hashes`、`checks` 四项必须能解释；hash 变化必须对应 fixture/golden 的有意变更。
- `baselines.test.ts` 会把 `baseline.hashes` 与当前 WP-02 golden 重新计算并比对；golden 变了而基线没刷新时，测试会失败（这是有意的 drift guard）。
- `--check` 先比较 `baseline.environment` 的 `runtime` / `platform`；跨 runtime/platform 直接判 `BASELINE_ENV_MISMATCH`，不会拿别环境的 duration 门做比较。

## 6. 建议与待拍板（分开标注）

### 6.1 建议（未拍板）

- 保持“1 次 warm-up + 5 次 measured”的采样形状；warm-up 参与 hash/check 稳定性但不参与 duration。
- 当前 10 ms 级 harness 保留 `20 ms` 绝对下限；如果后续 harness 增长到秒级，可去掉绝对下限或改为 `max(3×MAD, 20%×median)`。
- 保持单侧门：只对 slowdown 判负；性能提升不应触发 `BASELINE_DURATION_OUT_OF_BAND`。
- CI 只跑 `baselines.test.ts`（schema + hash + golden 一致性），不把 duration 门做成跨机器硬门；duration 门用于同环境发布前检查。
- 基线文件只记录 runtime/platform，不记录主机名、用户名、路径；后续新增字段沿用该约束。

### 6.2 待拍板

- duration 门是否要进入 CI 的硬门禁，还是仅作为同环境人工/发布前检查。当前实现支持 `--check`，但 README 不建议跨环境执行。
- 是否需要 per-scenario 计时或 p95，而不是 suite 级墙钟中位数；当前样本量 N=5，p95 没有统计意义。
- 是否需要按 OS/arch 维护多份 baseline（当前只有一份 `darwin-arm64` 实测）；若 CI 有多平台，需要 parent 决定基线矩阵。
- `BASELINE_DURATION_OUT_OF_BAND` 的阈值公式是否升级为共享契约；若升级，按 `partition-table.md:133` 递增 `contract_rev`。

## 7. 与 WP-02 的边界

- 只读复用 `test/oracle/transcript/harness.ts` 的 `runSuite()` / `cleanupSuite()`；不修改 WP-02 任何文件。
- 基线 hash 直接钉住 WP-02 `golden/*.jsonl`；WP-02 golden 的变更会通过 `baselines.test.ts` 暴露，而不是静默漂移。
- 本目录不是性能 benchmark：它只回答“同一环境下，WP-02 harness 的输出是否稳定、耗时中位数是否显著漂移”。

## 8. 证据索引

| 证据 | 位置 |
|---|---|
| WP-03 DoD：同环境重复基线与噪声带 | `RUST_FULL_MIGRATION_PLAN.md:257` |
| 压测阈值按同环境重复基线签定 | `RUST_FULL_MIGRATION_PLAN.md:300` |
| 统一门禁：全量测试 + `bun typecheck` | `RUST_FULL_MIGRATION_PLAN.md:297` |
| WP-03 manifest（owner/deps/owned_files/DoD） | `packages/chimera/specs/rust-host/manifest.yaml:88-107` |
| WP-03 分区 `T/baselines/**` | `packages/chimera/specs/rust-host/partition-table.md:30,53` |
| 共享契约变更递增 `contract_rev` | `packages/chimera/specs/rust-host/partition-table.md:133` |
| WP-03 范围与 W0 四层出口 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:36,64` |
| 不写生产迁移代码 / 不编译新可执行体 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:50-51` |
| WP-02 `runSuite()` / `cleanupSuite()` | `packages/chimera/test/oracle/transcript/harness.ts:230-276` |
| WP-02 golden 文件 | `packages/chimera/test/oracle/transcript/golden/determinism.jsonl`、`golden/causality.jsonl` |
| WP-02 把 fault matrix/比较器/统计门划给 WP-03 | `packages/chimera/test/oracle/transcript/README.md:186` |

## 9. 自验记录（本批实测）

| 命令 | 结果 |
|---|---|
| `cd packages/chimera && bun run test/oracle/baselines/measure.ts --runs 5 --write-baseline` | 6 次运行（1 warm-up + 5 measured）全部 24/24 checks；hash 稳定；写入 `baseline.json` |
| `cd packages/chimera && bun run test/oracle/baselines/measure.ts --runs 5 --check` | `BASELINE_OK` |
| `cd packages/chimera && bun test --timeout 30000 test/oracle/baselines/baselines.test.ts` | 17 pass / 0 fail（32 expect calls） |

以上命令均在 `packages/chimera` 内运行；WP-02 临时目录在 OS 临时目录并在每次运行后清理，不在仓库内留下未跟踪产物。