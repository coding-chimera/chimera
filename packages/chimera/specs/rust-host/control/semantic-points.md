# WP-10 · 343 语义点映射（点/桶 → owner → fixture）

> 状态：契约阶段。`contract_rev = cr-2026-10-30-r1`。
> 机读文件：`packages/chimera/test/oracle/control/semantic-points.json`；生成器：`packages/chimera/test/oracle/control/build-semantic-points.ts`。
> 本文解释 343 的构成、字段语义、fixture 状态策略与复现方式；不重复 README 的 DoD 自评。

## 1. 结论先行

- `semantic-points.json` 覆盖 **343/343**：223 个逐点行 + 12 个 mechanical 桶（合计 120 点）。
- 每个行/桶都有 `owner_role` 与 `fixture`；`fixture.status` 只允许 `existing-domain / existing / pending / not-applicable`。`existing-domain` 表示域级 fixture 关联，`existing` 预留给真正的点级 parity。
- 67 个逐点行的 `fixture.status = existing-domain`，指向控制域 behavior fixture（域级关联）；156 个逐点行 + 120 个 mechanical 点是 `pending`。计数口径不变：`existing-domain 67`，`existing 0`。
- `control-check.ts` 强制：`points.length = 223`、`Σbucket.count = 120`、`223 + 120 = 343`、owner 非空、fixture 引用可解析。

## 2. 343 的来源

| 证据 | 内容 |
|---|---|
| `RUST_FULL_MIGRATION_PLAN.md:264` | WP-10 DoD 写“343/343 语义点” |
| `RUST_FULL_MIGRATION_PLAN.md:320` | 完整清单本轮存于本机 tool-output 归档 |
| `RUST_FULL_MIGRATION_PLAN.md:79` | 343 分档：mechanical 120 / di 74 / structured-concurrency 68 / coordination 45 / streaming 31 / hard 5 |
| `memory.md:22` | W-E 战役收口：343 个非平凡语义点，完整数据指向归档 |
| 归档 `tool-output/tool_1817c7215001Jj52Lh6h4U02cg` | `totalSemantics = 343`、`modules[].semanticsCount`、`nonMechanical.length = 223`、`byClass.mechanical = 120` |

## 3. 行/桶 schema

### 3.1 逐点行（`points[]`）

| 字段 | 含义 | 来源 |
|---|---|---|
| `id` | `WE-<module>-<NNN>`，归档 `nonMechanical` 数组内的全局序号 | 生成器 |
| `module` | 12 个 W-E 模块之一 | 归档 |
| `primitive` | Effect/协调原语名（截断 160 字符） | 归档 `primitive` |
| `where` | 模块相对 `file:line` | 归档 `where` |
| `portability` | `di / structured-concurrency / coordination / streaming / hard` | 归档 `portability` |
| `owner_role` | 模块 owner 角色 | 生成器映射表 |
| `fixture` | `{status, ref}`；`existing-domain` 指向域级控制 fixture，`existing` 预留给点级 parity，`pending` 指向计划槽位 | 生成器 |
| `control_domains` | 该点关联的控制域（默认域 + 关键词覆盖） | 生成器 |
| `existing_suite` | 该模块的代表性生产测试文件 | 生成器 |
| `purpose` / `contract` | 归档中的用途/契约摘要（截断） | 归档 |
| `note` | 状态说明 | 生成器 |

### 3.2 mechanical 桶（`mechanical_buckets[]`）

| 字段 | 含义 |
|---|---|
| `id` | `WE-mechanical-<module>` |
| `module` | 模块名 |
| `count` | `semanticsCount - nonMechanical`；12 个桶合计 120 |
| `owner_role` | 模块 owner |
| `fixture` | 固定 `pending`，ref `pending:<module>/mechanical-bucket` |
| `control_domains` | 模块默认控制域 |
| `note` | 明确说明归档只有模块级计数，没有逐点 `file:line` |

### 3.3 `source`

| 字段 | 值 |
|---|---|
| `plan` | `RUST_FULL_MIGRATION_PLAN.md:264,320` |
| `archive` | `tool-output/tool_1817c7215001Jj52Lh6h4U02cg` |
| `archive_date` | `2026-10-28` |
| `total` | 343 |
| `enumerated` | 223 |
| `mechanical_buckets` | 120 |
| `explanation` | 中文说明“223 逐点 + 120 模块级桶，不伪造逐点 file:line” |

## 4. 逐模块拆分

| 模块 | 总数 | 逐点 | mechanical 桶 | owner_role | 默认控制域 |
|---|---:|---:|---:|---|---|
| session-prompt | 31 | 21 | 10 | session-prompt owner | prompt-assembly |
| session-core | 28 | 19 | 9 | session-core owner | prompt-assembly |
| session-stream | 36 | 17 | 19 | session-stream owner | compaction |
| session-infra | 25 | 15 | 10 | session-infra owner | job-family |
| server-httpapi | 35 | 24 | 11 | server-httpapi owner | mcp-transports |
| server-core | 33 | 26 | 7 | server-core owner | mcp-transports |
| agent | 25 | 17 | 8 | agent owner | job-family |
| tool-core | 36 | 25 | 11 | tool-core owner | mutation-chain |
| tool-graph | 30 | 22 | 8 | tool-graph owner | mutation-chain |
| provider | 23 | 14 | 9 | provider owner | compaction |
| config-storage | 23 | 14 | 9 | config-storage owner | config-bootstrap |
| plugin | 18 | 9 | 9 | plugin owner | config-bootstrap |
| **合计** | **343** | **223** | **120** | — | — |

默认控制域只是“该模块主要影响哪个控制域”的粗映射；`control_domains` 还会按 `primitive/where/purpose/contract` 中的关键词追加（goal、workbrief、tool_search、compaction、skill、instruction、mcp、background job、retention、claim/audit、config、prompt）。因此一个点可以有多个控制域。

## 5. fixture 状态策略

### 5.1 `existing-domain`

- 当该点的关键词命中某个控制域，且该域有 behavior fixture 时，生成器把 `fixture` 设为 `existing-domain`，`ref` 指向该域的主 fixture。
- 例：session-prompt 中命中 `goal` 的点指向 `goal/transitions`；命中 `tool_search` 的点指向 `tool-search/score-and-reveal`；命中 `compaction` 的点指向 `compaction/select-and-prune`。
- **注意**：这是域级关联，不是点级 parity。`note` 明确写“domain-level behavior fixture covers the same control area; W-E point-level parity remains pending.”

### 5.2 `pending`

- 没有关键词命中，或命中域没有合适 fixture 时，`fixture.status = pending`，`ref = pending:<module>/<id>`。
- `pending` 不是“无 owner”；每个 pending 行仍有 `owner_role`，并且 `existing_suite` 给出该模块的代表性生产测试文件（存在性由 `control-check.ts` 校验）。
- 12 个 mechanical 桶全部 `pending`；这是对归档缺口的诚实表达。

### 5.3 `not-applicable`

- 本包当前没有 N/A 行；如果后续某点确认“纯 mechanical、无行为语义”，可改为 `not-applicable` 并填写 `reason`。
- `control-check.ts` 要求 `not-applicable` 必须有非空 `reason`。

## 6. 复现

```bash
cd packages/chimera
bun test/oracle/control/build-semantic-points.ts --source <archive-path>
bun test/oracle/control/control-check.ts
```

生成器只读取归档的 `## Result` JSON，不读取凭据/网络/生产 DB。归档不在仓库内，因此：
- 仓库内的 `semantic-points.json` 是版本化权威；
- 重新生成需要本机归档；如果归档丢失，应以现有 JSON 为准，不要凭记忆重写 343 行。

## 7. 已知限制

- 归档的 `where` 是模块相对 `file:line`，不是绝对路径；生成器不做跨模块路径补全。
- `purpose`/`contract` 被截断到 240/160 字符，完整文本仍在归档；截断不影响 `where`/`owner`/`fixture` 的机检。
- 67 个 `existing-domain` 是域级关联，不能作为“343 项已逐点测试”的证据；正确口径见 `known-differences.md` D3。`existing` 预留给真正的点级 parity，当前为 0。
- 120 个 mechanical 点没有逐点 `file:line`；如果 G0 要求逐点，必须重跑 W-E census（见 `known-differences.md` D1/P1）。