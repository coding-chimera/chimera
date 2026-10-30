# WP-04 HTTP oracle fixtures

> 契约版本：`cr-2026-10-30-r1`。工作包：WP-04。
> 这些 fixture 是 **契约/清单**，不是生产实现；不重新生成 OpenAPI，不改 `packages/sdk`。

## 1. 文件

| 文件 | 用途 |
|---|---|
| `httpapi-inventory.frozen.json` | 源 `packages/chimera/test/fixtures/httpapi-inventory.json` 的逐字节只读副本 |
| `coverage-170.json` | 170 条操作 + 每行 `semanticOwner` / `gapAction` / `gapDetail` |
| `triage-96.json` | 96 个 host-first 候选的重新分诊（host-first / session-storage / session-execution）；含 `constructionLayerDeps`（30 条 handler-clean 但 layer-blocked） |
| `sdk-drift-baseline.json` | `packages/sdk/js/src/v2/gen/**` 的 15 个文件哈希与比较范围 |
| `verify-http-contract.ts` | 只读检查程序 |

## 2. 列式 JSON 结构

`coverage-170.json`：

```json
{
  "schema_version": 1,
  "contract_rev": "cr-2026-10-30-r1",
  "kind": "coverage-170",
  "source": {
    "inventory_fixture": "packages/chimera/test/fixtures/httpapi-inventory.json",
    "inventory_sha256": "<sha256>",
    "operationCount": 170,
    "pathCount": 142
  },
  "columns": ["operationId", "method", "path", "group", "migrationClass", "parityCoverage", "semanticOwner", "gapAction", "gapDetail"],
  "rows": [["session.list", "GET", "/session", "session", "host-first", "exercise", "WP-10", "extend-exercise", "recorder/replay + SSE/DBtrace (WP-02/WP-03)"]]
}
```

`triage-96.json`：

```json
{
  "schema_version": 1,
  "contract_rev": "cr-2026-10-30-r1",
  "kind": "triage-96",
  "criteria": { "host-first": "...", "session-storage": "...", "session-execution": "...", "binary": "..." },
  "verdictCounts": { "host-first": 69, "session-storage": 19, "session-execution": 8 },
  "binarySplit": { "host-first": 69, "session-dependent": 27 },
  "columns": ["operationId", "method", "path", "group", "verdict", "binary", "cutoverOwner", "touchPoint", "evidence"],
  "rows": [["session.get", "GET", "/session/{sessionID}", "session", "session-execution", "session-dependent", "WP-10", "Session.get + SessionPrompt.resumeGoalOnOpen kick", "packages/chimera/src/.../session.ts:108-118,463"]]
}
```

`triage-96.json` 另含 `constructionLayerDeps`：30 条 handler 层 host-first 但 group/layer 构造依赖 session 的 operationId 清单，以及 39 条 construction-clean 的计数。

列式设计的目的：170/96 行 fixture 在 diff 中一行一项，避免嵌套对象导致的 review 噪音；`columns` 是唯一 schema 来源。

## 3. 检查命令

从 `packages/chimera` 运行：

```bash
bun test/oracle/http/verify-http-contract.ts
```

检查内容：

| 检查 | 判定 |
|---|---|
| inventory 计数 | 170 ops / 142 paths；`host-first 96 / proxy-first 50 / special 24`；`exercise 116 / none 54` |
| coverage 行 | 170 行；operationId 唯一；method/path/group/class/coverage 与 inventory 一致；每行有 `semanticOwner` |
| owner 计数 | 与 `ownership.counts` 一致且合计 170 |
| triage 行 | 96 行；只覆盖 inventory 的 host-first；method/path/group 一致 |
| triage 计数 | `host-first 69 / session-storage 19 / session-execution 8`；`binary 69/27` |
| 构造层依赖 | `constructionLayerDeps`：30 条 layer-blocked（config 9 / experimental 9 / workspace 4 / memory 8）+ 39 条 construction-clean = 69 host-first；每个 operationId 的 group/verdict 与 triage 行一致 |
| 证据 | `evidence` 中的文件存在，行号不越界 |
| manifest | 源 fixture / coverage / triage 的 sha256 与记录一致；完整 spec 标为 `G0-environment-item` |
| SDK 基线 | `src/v2/gen/**` 文件集合与 15 个 worktree 哈希与 baseline 一致；通过只证明 worktree == baseline，不证明生成器对 HEAD 零 diff（见 `sdk-drift.md` §3.5） |

退出码：全部通过为 0；任一失败为 1。

## 4. 更新流程

### 4.1 inventory 变化

1. 先运行 live 检查：

   ```bash
   cd packages/chimera
   bun test --timeout 30000 test/server/httpapi-inventory.test.ts
   ```

2. 如果 `packages/chimera/test/fixtures/httpapi-inventory.json` 确实需要更新（由 inventory owner 执行，不属于 WP-04 owned files）：

   ```bash
   bun script/httpapi-inventory.ts --write
   ```

3. WP-04 重新导出 `coverage-170.json` / `triage-96.json`：
   - 以新的源 fixture 为输入；
   - 逐行 review 新增/删除/改名的 operation；
   - 更新 `openapi-freeze.manifest.json` 的 `inventory_sha256`、`coverage_170.sha256`、`triage_96.sha256`；
   - 更新 `coverage-gaps.md` / `triage-96.md` 的表格；
   - 运行 `verify-http-contract.ts`。

4. 若 operation 数不再是 170，必须递增 `contract_rev` 并在 WP 结果中记录差异；不能静默改计数。

### 4.2 分诊变化

- 只在 handler 的真实调用链变化时改 `verdict`；
- 每次改 verdict 必须同时更新 `touchPoint` 与 `evidence`；
- `binary` 必须与 verdict 一致；
- 更新 `verdictCounts` / `binarySplit`，并同步 `triage-96.md`；
- 运行检查程序。

### 4.3 SDK 基线变化

只在以下情况更新 `sdk-drift-baseline.json`：

1. G0 对 committed HEAD 重生成后零 diff（哈希不变，无需更新）；
2. 有 `approved_delta` 且 parent 已批准；
3. 生成器版本变更导致全量格式化差异，且已记录原因；
4. 外部 delta 入库后，按新 HEAD 重录（当前 baseline 从 dirty worktree 捕获，不能直接沿用）。

更新后必须：

- 从 HEAD 内容重算 15 个文件的 sha256（`git show HEAD:<path> | shasum -a 256`），不是从 dirty worktree 计算；
- 更新 `preexisting_worktree_drift` 的 `status` / `head_sha256` / `worktree_sha256`；
- 运行 `verify-http-contract.ts`；
- 若共享契约变化，递增 `contract_rev`。

## 5. 禁止

- 不把 `packages/sdk/openapi.json` 当 live 输入；
- 不手工编辑 `packages/sdk/js/src/v2/gen/**`；
- 不在 fixture 中写真实后端 URL、内网域名、IP、凭据、用户 home 绝对路径；
- 不用 `sed`/脚本批量重写 fixture 行；用结构化导出并 review diff。

## 6. 与契约文档的关系

| 契约文档 | 对应 fixture |
|---|---|
| `packages/chimera/specs/rust-host/http/openapi-freeze.md` | `coverage-170.json`、`openapi-freeze.manifest.json` |
| `packages/chimera/specs/rust-host/http/coverage-gaps.md` | `coverage-170.json` |
| `packages/chimera/specs/rust-host/http/triage-96.md` | `triage-96.json` |
| `packages/chimera/specs/rust-host/http/sdk-drift.md` | `sdk-drift-baseline.json` |
| `packages/chimera/specs/rust-host/http/g0-execution.md` | 以上全部（G0 执行后回填哈希） |