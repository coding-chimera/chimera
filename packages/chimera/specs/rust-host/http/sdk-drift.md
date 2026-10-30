# SDK 漂移验证契约

> 契约版本：`cr-2026-10-30-r1`。工作包：WP-04。基线：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
> 本文件回答 DoD 第 4 项：SDK 重生成零 diff 或显式 `approved_delta` 的检查程序说明。本轮不执行重生成。

## 1. 结论先行

| 项 | 结论 |
|---|---|
| 生成器 | `packages/sdk/js/script/build.ts`，输入来自 `cd packages/chimera && bun dev generate` |
| 比较对象 | `packages/sdk/js/src/v2/gen/**`（15 个 tracked 文件） |
| 不比较 | `packages/sdk/js/dist/**`（构建产物）、`packages/sdk/js/src/gen/**`（legacy 生成树，build 只跑 prettier） |
| 当前基线 | 已冻结 15 个文件的 sha256，见 `packages/chimera/test/oracle/http/sdk-drift-baseline.json`；**基线从 dirty worktree 捕获**，局限见 §3.5 |
| 既有 delta | `src/v2/gen/types.gen.ts` 相对 HEAD 有 2 行未提交 delta（`timeout?: number`）；归属另一会话 2026-10-29 的进行中 provider 契约工作，本包登记为 **external-blocked**，不是 `approved_delta` |
| 判定 | G0 重生成后 `git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen` 为 0，或存在显式 `approved_delta` |
| 本轮状态 | 未执行重生成；`verify-http-contract.ts` 只证明当前 worktree 与 worktree 基线哈希一致，不能替代 HEAD 比对（见 §3.5） |

## 2. 生成链与比较边界

```text
cd packages/chimera && bun dev generate
  -> packages/chimera/src/cli/cmd/generate.ts:24-66
  -> Server.openapi() / OpenApi.fromApi(PublicApi)
  -> stdout (prettier JSON)

cd packages/sdk/js && bun script/build.ts
  -> packages/sdk/js/script/build.ts:17-21  (写入 packages/sdk/js/openapi.json)
  -> packages/sdk/js/script/build.ts:23-48  (@hey-api/openapi-ts -> src/v2/gen)
  -> packages/sdk/js/script/build.ts:50-51  (prettier src/gen, src/v2)
  -> packages/sdk/js/script/build.ts:52-54  (rm -rf dist; bun tsc; rm openapi.json)
```

比较边界：

| 路径 | 是否比较 | 原因 |
|---|---|---|
| `packages/sdk/js/src/v2/gen/**` | 是 | build.ts 的 `createClient` 输出（`clean: true`） |
| `packages/sdk/js/openapi.json` | 仅捕获时比较 | 瞬态输入；build 结束删除 |
| `packages/sdk/js/src/gen/**` | 否 | legacy 树；build 只 prettier，不重新生成 |
| `packages/sdk/js/dist/**` | 否 | `bun tsc` 构建产物 |
| `packages/sdk/openapi.json` | 否 | stale 历史产物（109/127），不是 live 输入 |

## 3. 检查程序（本轮只写说明，不执行）

### 3.1 前置条件

1. 工作树只包含本批预期改动；对 `packages/sdk/js/src/v2/gen` 没有未记录的手改。
2. `bun install` 已完成；`@hey-api/openapi-ts` 版本为 `0.97.3`（`packages/sdk/js/package.json`）。
3. 当前 worktree 的 `types.gen.ts` 有 2 行 external-blocked delta：先记录，不要把它混进“重生成结果”，也不要在本包写 `approved_delta`。
4. G0 判定必须在 committed HEAD 上进行；baseline 是 worktree 捕获，不能作为 G0 的通过依据（§3.5）。

### 3.2 命令序列

```bash
# 0) 记录重生成前状态与 HEAD
git rev-parse HEAD
git status --porcelain packages/sdk/js/src/v2/gen
git diff HEAD --stat -- packages/sdk/js/src/v2/gen
# 记录 HEAD 侧 types.gen.ts 的 sha256（与 worktree 哈希对照）
git show HEAD:packages/sdk/js/src/v2/gen/types.gen.ts | shasum -a 256

# 1) 可选：先捕获完整 spec（build 会删除 openapi.json）
cd packages/chimera
ARTIFACT_DIR="${ARTIFACT_DIR:-dist/openapi-freeze}"
mkdir -p "$ARTIFACT_DIR"
bun dev generate > "$ARTIFACT_DIR/openapi.before.json"

# 2) 重生成 SDK（默认 Effect HttpApi）
cd ../sdk/js
bun script/build.ts

# 3) 判定：对 committed HEAD 零 diff
git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen

# 4) 确定性：同一环境再跑一次，第二次相对 HEAD 仍零 diff
bun script/build.ts
git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen

# 5) 本包 fixture 自检（不重生成；只证明 worktree == baseline）
cd ../chimera
bun test/oracle/http/verify-http-contract.ts
```

Hono parity 可选（只用于差异审计，不作为 SDK 默认输入）：

```bash
cd packages/chimera
ARTIFACT_DIR="${ARTIFACT_DIR:-dist/openapi-freeze}"
mkdir -p "$ARTIFACT_DIR"
bun dev generate --hono > "$ARTIFACT_DIR/openapi.hono.json"
```

### 3.3 比对对象与判定

| 比较 | 命令 | 通过条件 | 失败处理 |
|---|---|---|---|
| 生成树 vs committed HEAD（G0 权威判定） | `git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen` | exit 0 | 进入 `approved_delta` 流程或修复 |
| 文件集合 | `verify-http-contract.ts` 扫描 `src/v2/gen/**` | 与 baseline 的 15 个文件集合一致 | 缺文件/多文件均失败 |
| 文件哈希 vs worktree baseline（仅本包自检） | `verify-http-contract.ts` | 每个文件 sha256 与 baseline 一致 | 说明 worktree 与捕获基线一致；不能单独证明生成器正确（§3.5） |
| 二次生成 | 连续两次 `bun script/build.ts` 后 `git diff HEAD --exit-code` | 第二次为 0 | 视为非确定性，阻塞 G0 |
| 完整 spec | `openapi.before.json` vs G0 捕获物 | path/operation 集合与 `coverage-170.json` 一致 | 记录差异，按 spec 变更处理 |

### 3.4 `approved_delta` 格式

任何非零 diff 只有在 WP 结果中记录以下字段才允许放行：

```yaml
approved_delta:
  - path: packages/sdk/js/src/v2/gen/types.gen.ts
    reason: "为什么必须改；对应哪条 server 契约变更"
    expected_behavior: "重生成后应出现的类型/字段/操作"
    affected_contract: "OpenAPI operationId / schema 名称"
    affected_tests: ["packages/chimera/test/..."]
    approver: "parent 或用户"
    contract_rev: "cr-2026-10-30-rN（共享契约变更时递增）"
```

禁止：

- 仅写“差异来自本批改动”放行（计划 §10）。
- 用 `packages/sdk/openapi.json` 作为输入“修复”差异。
- 手工编辑 `src/v2/gen/**` 后不回写生成链。
- 把 `dist/**` 或 `src/gen/**` 的 diff 混入 SDK 漂移结论。

### 3.5 自证循环与 G0 正确比对程序

**局限**：`sdk-drift-baseline.json` 的 15 个哈希是从当前 worktree 捕获的，而该 worktree 已经包含 `types.gen.ts` 的 2 行 external-blocked delta（`types.gen.ts` 的 worktree sha256 为 `67ea2036...`，HEAD committed blob sha256 为 `3b1a205d...`）。因此 `verify-http-contract.ts` 通过只证明“当前 worktree == 捕获时的 worktree”，不能证明：

- 重生成后的输出等于 committed HEAD；
- 生成器是确定性的；
- 没有手改生成树后同步改 baseline。

如果 baseline 本身吸收了手改或 dirty delta，检查会形成自证循环。baseline 不是 G0 漂移门。

**G0 正确比对程序**（对 committed HEAD 比对，而不是对 baseline 哈希）：

1. 从干净 checkout 开始；若外部 delta 仍未入库，先记录并隔离（stash/revert），`git status --porcelain` 只允许已登记项。
2. 记录 `git rev-parse HEAD` 和 `git status --porcelain packages/sdk/js/src/v2/gen`。
3. 记录 HEAD 侧哈希：`git show HEAD:<path> | shasum -a 256`（至少覆盖 `types.gen.ts`）。
4. 执行 `cd packages/sdk/js && bun script/build.ts`。
5. 用 `git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen` 判定；`HEAD` 形式同时覆盖 staged 与 unstaged，避免 `git diff` 只比 worktree-vs-index 的盲区。
6. 再跑一次 `bun script/build.ts`，重复第 5 步，确认确定性。
7. 只有第 5/6 步通过后，才从 committed HEAD 重录 `sdk-drift-baseline.json`（哈希取 `git show HEAD:<path>` 的结果），并把 `preexisting_worktree_drift` 标记为 resolved/committed；然后运行 `verify-http-contract.ts` 验证 fixture 自洽。
8. 若外部 delta 在 G0 前已入库：HEAD blob 变化，必须按新 HEAD 重录 baseline；不得复用当前 dirty baseline。若仍未入库：G0-HTTP-03 判 **blocked**，不是 pass，也不是 `approved_delta`。

## 4. 当前基线例外：external-blocked（不是 approved_delta）

`packages/chimera/test/oracle/http/sdk-drift-baseline.json` 记录：

| 字段 | 值 |
|---|---|
| path | `packages/sdk/js/src/v2/gen/types.gen.ts` |
| status | `modified-vs-HEAD` |
| numstat | `2 0` |
| observed_change | `ProviderConfig.codex-responses` 与 `Provider.codex-responses` 各加 `timeout?: number` |
| last_commit | `fcdb1f75b`（2026-10-29，provider 相关） |
| head_sha256 | `3b1a205da7587390f4d1e5a15d061c47baa3b6a9a102d9614f5fe688569bda6b`（HEAD committed blob） |
| worktree_sha256 | `67ea2036312335087568d2a274ab183ad80b8ccde8c222a47486c71033758dbc`（当前 dirty worktree） |
| ownership | external-session-in-progress（2026-10-29 provider remote-compaction timeout 字段） |
| classification | `external-blocked` |
| approved_delta | `false` |
| resolution | 由所属会话 commit 或 revert；若 G0 前入库，按新 HEAD 重录 baseline；否则 G0-HTTP-03 blocked |

归属证据：`git status --short` 同时显示 `packages/chimera/src/config/provider.ts`（新增 RemoteCompaction `timeout` 字段）与 `packages/sdk/js/src/v2/gen/types.gen.ts`（对应生成物）为 modified；`git log -1 -- packages/sdk/js/src/v2/gen/types.gen.ts` 为 `fcdb1f75b`（2026-10-29）。本包**不断言**这是手改；它更像另一会话进行中的 provider 契约工作的未提交生成物。无论来源如何，本包都**不**为它写 `approved_delta`：`approved_delta` 需要 reason/expected behavior/affected contract/tests/approver，且本包无权代表外部会话批准。

## 5. 建议的 CI 门

建议在 CI 中增加一个独立 job（不与单元测试混跑）：

```bash
# 干净 checkout；baseline 必须是从 HEAD 记录的版本
git rev-parse HEAD
git status --porcelain packages/sdk/js/src/v2/gen
cd packages/sdk/js
bun script/build.ts
git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen
cd ../../chimera
bun test/oracle/http/verify-http-contract.ts
```

门禁语义：

- 失败时输出 `git diff HEAD --stat` 与 `git diff HEAD` 的前 N 行，便于定位；
- 若 PR 携带 `approved_delta`，job 读取该字段并逐 path 校验 diff 是否被覆盖；
- 未携带 `approved_delta` 的任何 diff 一律 fail；
- 不允许用 `--no-verify` 或跳过 job 放行；
- `verify-http-contract.ts` 的 baseline 哈希只作为本包 fixture 自检，不作为 CI 漂移门的唯一证据。

## 6. 建议与待拍板

### 6.1 建议

1. 漂移门只比较 `src/v2/gen/**`；`src/gen/**` 标记 legacy，不再作为 SDK 生成目标。
2. 每次重生成前捕获 `openapi.json`，把 spec diff 与 SDK diff 分开报告；否则 build 删除瞬态文件后无法解释类型变化。
3. 连续两次生成做确定性检查；非确定性直接阻塞 G0，不进入 approved_delta。
4. 把 `types.gen.ts` 的既有 delta 作为 G0-HTTP-04 的 external-blocked 前置项，不把它算作“本批重生成结果”，也不在本包写 `approved_delta`。
5. baseline 只在 committed HEAD 上记录；禁止从 dirty worktree 记录（否则形成 §3.5 的自证循环）。G0 时若外部 delta 已入库，按新 HEAD 重录。

### 6.2 待拍板

| 项 | 需要决定 | 默认建议 |
|---|---|---|
| D-WP04-4 | `types.gen.ts` 既有 2 行 delta 的归属与处置 | external-blocked；由所属会话 commit/revert；本包不批准 `approved_delta`；G0 时若已入库则重录 baseline |
| D-WP04-11 | CI 漂移门是否作为 PR 必需检查 | G0 后启用；启用前先清干净基线 |
| D-WP04-12 | `src/gen/**` 是否删除/冻结 | 冻结为 legacy；不纳入漂移门 |

## 7. 证据索引

| 证据 | 位置 |
|---|---|
| SDK 生成链 | `packages/sdk/js/script/build.ts:12-54` |
| CLI 生成 | `packages/chimera/src/cli/cmd/generate.ts:24-66` |
| live spec | `packages/chimera/src/server/server.ts:159-173` |
| SDK 包版本/脚本 | `packages/sdk/js/package.json` |
| 当前基线 | `packages/chimera/test/oracle/http/sdk-drift-baseline.json` |
| 检查程序 | `packages/chimera/test/oracle/http/verify-http-contract.ts` |
| 既有 delta 的 provider 侧改动 | `packages/chimera/src/config/provider.ts`（dirty diff：RemoteCompaction `timeout`） |
| HEAD vs worktree 哈希 | `sdk-drift-baseline.json` 的 `preexisting_worktree_drift.head_sha256` / `worktree_sha256` |
| 计划门禁 | `RUST_FULL_MIGRATION_PLAN.md:258,294-304` |