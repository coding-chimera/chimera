# G0 环境执行清单（WP-04）

> 契约版本：`cr-2026-10-30-r1`。工作包：WP-04。基线：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
> 本文件只列**在 G0 环境执行**的命令与验收；WP-04 本轮不执行重生成、不编译 Rust、不改 `packages/sdk`。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| 工作树 | 干净 checkout；或已记录本批 `types.gen.ts` 的 external-blocked delta（见 `sdk-drift.md` §4），且不得把该 delta 混入重生成结果 |
| 工具链 | Bun 可用；`packages/chimera` 与 `packages/sdk/js` 依赖已安装 |
| 环境 | 不指向真实后端；不注入真实 provider 凭据；产物目录在仓库外或用未跟踪目录 |
| 基线 | 记录 `git rev-parse HEAD` 与 `git status --porcelain` |
| 产物 | 完整 spec、Hono parity spec、生成日志；默认落点 `packages/chimera/dist/openapi-freeze/`（gitignored），不默认提交 |

建议在开始前记录：

```bash
git rev-parse HEAD
git status --porcelain
cd packages/chimera && bun --version
cd ../sdk/js && bun --version
```

## 1. G0-HTTP-01：捕获完整 live OpenAPI

```bash
cd packages/chimera
ARTIFACT_DIR="${ARTIFACT_DIR:-dist/openapi-freeze}"
mkdir -p "$ARTIFACT_DIR"
bun dev generate > "$ARTIFACT_DIR/openapi.json"
shasum -a 256 "$ARTIFACT_DIR/openapi.json"
```

验收：

- [ ] `openapi.json` 可解析为 JSON；
- [ ] `paths` 数为 142；
- [ ] operation 数为 170（按 `get/post/put/patch/delete` 计数）；
- [ ] operationId 集合与 `packages/chimera/test/oracle/http/coverage-170.json` 完全一致；
- [ ] 记录 sha256 与 `git rev-parse HEAD`。

辅助命令（只读，不写 fixture）：

```bash
cd packages/chimera
bun script/httpapi-inventory.ts --check
bun test --timeout 30000 test/server/httpapi-inventory.test.ts
```

## 2. G0-HTTP-02：Hono parity 差异审计

```bash
cd packages/chimera
ARTIFACT_DIR="${ARTIFACT_DIR:-dist/openapi-freeze}"
mkdir -p "$ARTIFACT_DIR"
bun dev generate --hono > "$ARTIFACT_DIR/openapi.hono.json"
shasum -a 256 "$ARTIFACT_DIR/openapi.hono.json"
```

验收：

- [ ] 对两份 spec 做 path 集合、operationId 集合、schema 引用、SSE response 的差异清单；
- [ ] 每个差异分类为：修复 / `approved_delta` / 已知 legacy 差异；
- [ ] `approved_delta` 记录 reason、expected behavior、affected contract、affected tests、approver；
- [ ] 不允许用“差异来自本批改动”放行（计划 §10）。

建议的差异报告字段：

| 字段 | 说明 |
|---|---|
| `path` | OpenAPI path |
| `operationId` | operationId（缺失时写 `<none>`） |
| `kind` | `missing-effect` / `missing-hono` / `schema` / `sse` / `parameter` / `security` |
| `detail` | 具体差异 |
| `disposition` | `fix` / `approved_delta` / `known-legacy` |
| `owner` | WP-04 或 domain WP |

## 3. G0-HTTP-03：SDK 重生成漂移门

```bash
git rev-parse HEAD
cd packages/sdk/js
bun script/build.ts
git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen
```

验收：

- [ ] 第一次重生成后 `src/v2/gen/**` 相对 committed HEAD 零 diff；或存在显式 `approved_delta`；
- [ ] 连续第二次 `bun script/build.ts` 后相对 HEAD 仍零 diff（确定性）；
- [ ] `git status --porcelain packages/sdk/js/src/v2/gen` 不出现未记录文件；
- [ ] 不把 `dist/**`、`src/gen/**` 的 diff 混入结论。

若失败：

1. 保存 `git diff HEAD --stat` 与 `git diff HEAD` 前 200 行；
2. 判断是 spec 变更、生成器版本变更、还是手改；
3. 只有 spec/生成器变更且符合预期时，才写 `approved_delta`；
4. 只有对 committed HEAD 零 diff 后，才从 HEAD 重录 `sdk-drift-baseline.json` 的哈希；若共享契约变更，递增 `contract_rev`。

## 4. G0-HTTP-04：既有 `types.gen.ts` delta 处置（external-blocked）

当前 worktree：

```bash
git diff HEAD -- packages/sdk/js/src/v2/gen/types.gen.ts
```

预期看到 2 行新增：`ProviderConfig.codex-responses` 与 `Provider.codex-responses` 各加 `timeout?: number`。

归属：另一会话 2026-10-29 的进行中 provider 契约工作（`packages/chimera/src/config/provider.ts` 新增 RemoteCompaction `timeout`）。本包把它登记为 `external-blocked`，**不是** `approved_delta`，也不代表本包批准该 delta。

处置选项：

| 选项 | 动作 | 适用 |
|---|---|---|
| A. 所属会话 commit | 由外部会话把 provider 契约与生成物一起提交；G0 按新 HEAD 重录 baseline | 生成链已包含该字段 |
| B. 所属会话 revert | 恢复 HEAD 版本，确认重生成不会再次产生 | 确认是误生成/未完成工作 |
| C. G0 前已入库 | 按新 HEAD 重录 `sdk-drift-baseline.json`（哈希取 `git show HEAD:<path>`），并把 `preexisting_worktree_drift` 标记为 resolved/committed | delta 已 commit |
| D. G0 时仍未入库 | G0-HTTP-03 判 **blocked**，不是 pass；不得写 `approved_delta` 绕过 | 外部会话未完成 |

验收：

- [ ] `git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen` 在干净 checkout 上为 0；
- [ ] 若 delta 已入库，`sdk-drift-baseline.json` 已按新 HEAD 重录（含 `head_sha256` / `worktree_sha256`），并同步更新 fixture/manifest；
- [ ] 不把当前 dirty baseline 的哈希当作 G0 通过证据（§3.5 自证循环）。

## 5. 汇总记录模板

```yaml
wp04_g0_result:
  head: "<commit>"
  executed_at: "<ISO-8601>"
  environment: "<CI runner / local>"
  artifacts:
    openapi: { path: "packages/chimera/dist/openapi-freeze/openapi.json", sha256: "<hash>", paths: 142, operations: 170 }
    openapi_hono: { path: "packages/chimera/dist/openapi-freeze/openapi.hono.json", sha256: "<hash>" }
  checks:
    inventory_check: pass|fail
    inventory_test: pass|fail
    sdk_regen_zero_diff: pass|fail
    sdk_second_run_zero_diff: pass|fail
  approved_delta: []
  blockers: []
```

## 6. 禁止事项

- 不在受管端点编译/运行新的 Rust 可执行体；本清单只跑 TS 生成/检查命令。
- 不把真实后端 URL、内网域名、IP、凭据、用户 home 绝对路径写入产物或日志。
- 不修改已应用的迁移、不写生产迁移代码。
- 不 commit/push，除非用户或 parent 明确要求。

## 7. 与 WP-04 其他文档的关系

| 文档 | 关系 |
|---|---|
| `openapi-freeze.md` | 说明为什么完整 spec 是 G0 项、生成链与确定性 |
| `sdk-drift.md` | 说明漂移门的比较对象、判定、approved_delta 格式 |
| `openapi-freeze.manifest.json` | 记录 G0-HTTP-01..04 的机检字段 |
| `packages/chimera/test/oracle/http/verify-http-contract.ts` | 不重生成的 fixture/基线自检；可在 G0 前后各跑一次 |

## 8. 建议与待拍板

### 8.1 建议

1. G0 执行产物默认放 `packages/chimera/dist/openapi-freeze/`（gitignored）或仓库外目录，只在 WP 结果中记录 sha256 与计数；不把完整 spec 默认提交。
2. Hono parity 差异先出报告再决定修复/approved_delta，不直接改 SDK 生成物。
3. SDK 重生成前先记录 `git status`，把既有 delta 与本次重生成结果分开报告。

### 8.2 待拍板

| 项 | 需要决定 | 默认建议 |
|---|---|---|
| D-WP04-3 | 完整 spec 是否版本化进仓库 | 不版本化；G0 生成 + 哈希 + 清单 |
| D-WP04-4 | `types.gen.ts` 既有 2 行 delta 的归属与处置 | external-blocked；由所属会话 commit/revert；本包不批准 `approved_delta`；G0 时若已入库则按新 HEAD 重录 baseline |
| D-WP04-11 | CI 漂移门是否作为 PR 必需检查 | G0 后启用；启用前先清干净基线 |