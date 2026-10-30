# WP-01 分区表：owned_files 两两不相交

> 依据：`RUST_FULL_MIGRATION_PLAN.md` §8（首批工作包）、§9（manifest/ownership 纪律）、§16（首批顺序）。
> 本表是 `packages/chimera/specs/rust-host/manifest.yaml` 的机检依据；所有路径为仓库相对路径，不带主机绝对路径。
> 结论先行：WP-01..WP-10 的 `owned_files` 两两交集为空；WP-02..WP-10 在 §3 各出现且仅出现一次。

## 1. 路径根与语义

- `S = packages/chimera/specs/rust-host`（同树；WP-01 本批落位）。
- `T = packages/chimera/test/oracle`（同树；尚未创建，WP-02 起按包创建）。
- 单树约定：仓库只有一棵权威 specs/test 树，位于 `packages/chimera/` 下；仓库根不再有 `specs/` 与 `test/` 目录，所有 owned/deliverable 路径统一以 `packages/chimera/` 为前缀。
- `X/**` 表示 `X/` 下全部后代路径；不带 `**` 的条目是精确文件路径，只匹配该文件本身。
- 存在性标记：`E` = 当前已存在；`N` = 尚不存在（由所属包创建）；`E*` = 本批由 WP-01 创建。

## 2. WP-01 自有文件

| 文件（精确路径） | 存在性 | 说明 |
|---|---|---|
| `S/manifest.yaml` | E* | WP-01..WP-10 全字段 manifest；机检四字段入口 |
| `S/partition-table.md` | E* | 本表；分区与交集证明 |
| `S/a0-scope-decisions.md` | E* | A0 门记录（范围/非目标/D1–D8/待确认项） |

WP-01 的三个文件都在 `S` 根层，是精确文件，不属于任何 `S/<domain>/**` 目录前缀；因此与 WP-02..WP-10 的 owned_files 无交集。

## 3. WP-02..WP-10 owned_files 分区

| WP | owner | deps | §8 产物（字面） | owned_files | 存在性 | oracle_commands |
|---|---|---|---|---|---|---|
| WP-02 | oracle owner | WP-01 | `packages/chimera/test/oracle/transcript/` | `T/transcript/**` | `T` N；叶子 N | `[]`（W0 harness 未建） |
| WP-03 | oracle owner | WP-02 | `packages/chimera/test/oracle/faults/`、基线描述 | `T/faults/**`、`T/baselines/**`、`T/compare/**` | `T` N；叶子 N | `[]`（同上） |
| WP-04 | HTTP contract owner | WP-01 | 完整 spec、170-op 清单与漂移用例 | `S/http/**`、`T/http/**` | `S` E；子目录 N | `[]`（同上） |
| WP-05 | storage owner | WP-01 | `packages/chimera/specs/rust-host/` 内的权威矩阵 | `S/authority/**`、`T/storage/**` | `S` E；子目录 N | `[]`（同上） |
| WP-06 | graph owner | WP-01 | graph 契约与 fixture 分区 | `S/graph/**`、`T/graph/**` | `S` E；子目录 N | `[]`（同上） |
| WP-07 | runtime owner | WP-01 | runtime/IPC/启动故障矩阵 | `S/runtime/**`、`T/runtime/**` | `S` E；子目录 N | `[]`（同上） |
| WP-08 | provider owner | WP-01、WP-02 | provider-host fixture 分区、profile 准入表 | `S/provider/**`、`T/provider/**` | `S` E；子目录 N | `[]`（同上） |
| WP-09 | plugin owner | WP-01、WP-02 | plugin-host 契约与 fixture 分区 | `S/plugin/**`、`T/plugin/**` | `S` E；子目录 N | `[]`（同上） |
| WP-10 | control-plane owner | WP-02、WP-05、WP-09 | `packages/chimera/test/oracle/control/` | `T/control/**`、`S/control/**`（支撑规格） | `S` E；子目录 N | `[]`（同上） |

补充约束：

- §8 只给概念的包（WP-04/05/06/07/08/09），按 `S/<domain>/**` + `T/<domain>/**` 成对落位；`S` 侧只放契约/规格，`T` 侧只放 fixture 与判定。
- WP-10 的 §8 产物只有 `T/control/**`；`S/control/**` 是支撑规格，不得扩成共享契约根。
- `oracle_commands` 当前一律空数组：W0 harness 未建，命令在对应包进入 building 时写入，且必须是包内可独立运行的 focused 命令。
- 每个包另有独立 build/test 命令、独立结果/checkpoint、独立临时 DB；不共享编译输出。

## 4. 交集为空证明

### 4.1 形式化

```text
P01 = { S/manifest.yaml, S/partition-table.md, S/a0-scope-decisions.md }   # 精确文件
P02 = { T/transcript/** }
P03 = { T/faults/**, T/baselines/**, T/compare/** }
P04 = { S/http/**, T/http/** }
P05 = { S/authority/**, T/storage/** }
P06 = { S/graph/**, T/graph/** }
P07 = { S/runtime/**, T/runtime/** }
P08 = { S/provider/**, T/provider/** }
P09 = { S/plugin/**, T/plugin/** }
P10 = { T/control/**, S/control/** }
```

### 4.2 唯一域名 token

`S` 或 `T` 之下第一段路径是域名 token：`transcript`、`faults`、`baselines`、`compare`、`http`、`authority`、`storage`、`graph`、`runtime`、`provider`、`plugin`、`control`。12 个 token 互不相同，没有任何 token 被两个 WP 复用。

- 每个 `P_i`（i≥2）只包含 `S/<token>/**` 或 `T/<token>/**`，不包含裸 `S/**` 或 `T/**`。
- 因此任意 `i != j` 的两个集合，其路径在第一段（`S`/`T` 之后）即出现不同 token，`P_i ∩ P_j = ∅`。
- `P01` 的三个条目都是 `S` 根层精确文件，不匹配任何 `S/<token>/**` 前缀（token 集合不含 `manifest.yaml` 等文件名），故 `P01 ∩ P_i = ∅`（i≥2）。

### 4.3 两两矩阵

| ∩ | P01 | P02 | P03 | P04 | P05 | P06 | P07 | P08 | P09 | P10 |
|---|---|---|---|---|---|---|---|---|---|---|
| P01 | — | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| P02 | ∅ | — | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| P03 | ∅ | ∅ | — | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| P04 | ∅ | ∅ | ∅ | — | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| P05 | ∅ | ∅ | ∅ | ∅ | — | ∅ | ∅ | ∅ | ∅ | ∅ |
| P06 | ∅ | ∅ | ∅ | ∅ | ∅ | — | ∅ | ∅ | ∅ | ∅ |
| P07 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | — | ∅ | ∅ | ∅ |
| P08 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | — | ∅ | ∅ |
| P09 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | — | ∅ |
| P10 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | — |

### 4.4 覆盖检查

- §3 表恰好 9 行：WP-02、WP-03、WP-04、WP-05、WP-06、WP-07、WP-08、WP-09、WP-10，各一次，无遗漏、无重复。
- manifest 的 `works` 列表同样 10 条：WP-01（本节 §2）+ WP-02..WP-10（本节 §3）。
- 依赖闭合（§8）：A0 → WP-01；WP-01 → WP-02/04/05/06/07；WP-02 → WP-03/08/09；WP-02+WP-05+WP-09 → WP-10。无环。

## 5. 存在性标记

本批前实测：

- `E packages/chimera/specs/rust-host/`（既有 3 个 spec：`h2-data-plane.md`、`ipc-v0.md`、`recovery-matrix.md`）。
- `E packages/chimera/test/`。
- 仓库根 `specs/`、`test/` 均不存在（`ls -d specs`、`ls -d test` 报 No such file or directory）。

本批后：

- `E* S/manifest.yaml`、`E* S/partition-table.md`、`E* S/a0-scope-decisions.md`（`S = packages/chimera/specs/rust-host`，与既有 3 个 spec 同树）。
- `N S/{http,authority,graph,runtime,provider,plugin,control}/`：由 WP-04/05/06/07/08/09/10 各自创建。
- `N T/` 及 `N T/{transcript,faults,baselines,compare,http,storage,graph,runtime,provider,plugin,control}/`：由 WP-02..WP-10 各自创建。

## 6. 共享证据路径永不 owned

共享证据 = 只读输入，不属于任何 WP 的 `owned_files`：

- `RUST_FULL_MIGRATION_PLAN.md`（计划本体）。
- `packages/chimera/specs/rust-host/{ipc-v0.md,recovery-matrix.md,h2-data-plane.md}`：同树既有 spec（早于本批存在），不属于任何 WP 的 `owned_files`；WP-05/06/07 只能新增 `S/<domain>/**`，不得改写它们。
- `packages/chimera/src/**`、`packages/chimera/test/**`（既有测试与实现）、`packages/chimera/script/**`。
- `packages/llm/test/recorded-*.ts` 等既有 cassette/oracle 基线；`packages/sdk/**`、`packages/plugin/**`。
- `codegraph-kernel/**`、`chimera-host/**` 及任何构建产物。

规则：

1. 任何 WP 都不得在 `owned_files` 声明上述路径；读取不产生所有权，引用只进 `result_refs`。
2. 需要修改共享证据时，只能由 parent 另立工作包或给出 `approved_delta`（原因、期望行为、受影响契约与测试），并同步递增 `contract_rev`。
3. 新增证据文件一律落在本包 `S/<domain>/**` 或 `T/<domain>/**` 内，不新建共享根（如 `T/harness/**`、`S/common/**`）。共享 harness 若确需存在，必须整包归属单一 WP，否则即碰撞点。
4. 同树既有 spec（`h2-data-plane.md`/`ipc-v0.md`/`recovery-matrix.md`）是只读证据，不是任何 WP 的可写目标；WP-01 自身的三个文件（`manifest.yaml`/`partition-table.md`/`a0-scope-decisions.md`）由 WP-01 独占。

## 7. CI/build-root 单写者

- Cargo 清单与锁文件、各 crate 的 `mod.rs`/registry、schema、SDK 生成物、CI workflow、集成 build root，由 **CI/build-root 集成 owner** 独占，刻意不在本分区枚举，也不属于 WP-02..WP-10。
- 任何 WP 不得声明这些路径；新增依赖或改锁文件须经 `approved_delta`，由该 owner 串行落地。
- 集成编译只在单一 build root 执行；各包不得共享编译输出、临时 DB 或生成目录。

## 8. 禁止路径审计与变更流程

- 禁止路径审计：任何 `owned_files` 不得出现 `RUST_FULL_MIGRATION_PLAN.md`、`packages/chimera/src/**`、既有同树 spec（`h2-data-plane.md`/`ipc-v0.md`/`recovery-matrix.md`）、`T/**` 之外的既有测试路径、CI/build-root 路径。
- ownership 不是自动锁：same-family claims 豁免；派发前仍须检测文件交集。跨 family 的写冲突按先到先得处理，不得并行改同一文件。
- 变更流程：分区调整 = 共享契约变更，须 parent 签定 + 递增 `contract_rev`（`cr-YYYY-MM-DD-rN`）+ 重跑依赖包的入口检查；旧值保留在 `result_refs`。
- 纯包内实现变更、不改共享契约的，不递增 `contract_rev`，只更新该包 `file_hashes`。