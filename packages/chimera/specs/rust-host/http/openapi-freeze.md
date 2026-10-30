# OpenAPI 与 170-op 清单冻结

> 契约版本：`cr-2026-10-30-r1`。工作包：WP-04。基线：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
> 本文件回答 DoD 第 1 项：冻结当前 server OpenAPI 与 170-op 清单，并证明正式生成链可复验。

## 1. 结论先行

| 项 | 结论 |
|---|---|
| live 权威 | `Server.openapi()` = `OpenApi.fromApi(PublicApi)`（`packages/chimera/src/server/server.ts:159-173`） |
| 操作清单 | 已冻结：142 paths / 170 ops，sha256 `e91fdde891c3ad7f5486f7a44dc2164a102164e92136f26819cc507bc175b757` |
| 分类计数 | `host-first 96 / proxy-first 50 / special 24`；`exercise 116 / none 54` |
| 完整 spec | 仓库内**没有**当前 live 完整 spec 的现成产物；按 G0 环境项生成到 `packages/chimera/dist/openapi-freeze/`（`g0-execution.md` G0-HTTP-01，命令见 §5） |
| stale 产物 | `packages/sdk/openapi.json` 为 109 paths / 127 ops（2026-05-07），不得当实时权威 |
| 可复验性 | `bun test --timeout 30000 test/server/httpapi-inventory.test.ts` 本轮 5 pass / 0 fail；fixture 与 live `Server.openapi()` 一致 |

## 2. 正式生成链

```text
Server.openapi()                         packages/chimera/src/server/server.ts:159-173
  └─ OpenApi.fromApi(PublicApi)          packages/chimera/src/server/routes/instance/httpapi/public.ts
       └─ CLI generate                   packages/chimera/src/cli/cmd/generate.ts:24-66
            └─ bun dev generate          stdout: prettier JSON + x-codeSamples
                 └─ SDK build            packages/sdk/js/script/build.ts:12-48
                      └─ @hey-api/openapi-ts 0.97.3
                           └─ packages/sdk/js/src/v2/gen/**
```

关键事实：

- CLI 默认从 Effect HttpApi 生成；`--hono` 仅用于 parity diff（`packages/chimera/src/cli/cmd/generate.ts:19-25`）。
- CLI 用 prettier `parser=json, printWidth=120` 格式化输出（`packages/chimera/src/cli/cmd/generate.ts:47-57`），因此同一输入应产生字节稳定输出。
- SDK build 把 `bun dev generate` 的输出写到 `packages/sdk/js/openapi.json`，用 `createClient` 生成 `src/v2/gen`，最后删除 `openapi.json`（`packages/sdk/js/script/build.ts:17-54`）。所以**完整 spec 是瞬态产物**，不提交；漂移检查要么在 build 前单独捕获，要么比较生成后的 `src/v2/gen`。
- `src/gen/**` 是 legacy 生成树（最后变更 2026-06-18），build 脚本只对它跑 prettier，不重新生成（`packages/sdk/js/script/build.ts:50`）；不纳入漂移门。

## 3. 冻结物

| 冻结物 | 路径 | 说明 |
|---|---|---|
| 源 inventory | `packages/chimera/test/fixtures/httpapi-inventory.json` | live 漂移源；170 ops / 142 paths；sha256 见上 |
| 冻结 inventory 副本 | `packages/chimera/test/oracle/http/httpapi-inventory.frozen.json` | 源 fixture 的逐字节只读副本；sha256 与源一致 |
| 170-op 清单 | `packages/chimera/test/oracle/http/coverage-170.json` | 本包导出；每行含 operationId / method / path / group / migrationClass / parityCoverage / semanticOwner |
| 96 分诊 | `packages/chimera/test/oracle/http/triage-96.json` | 本包导出；96 个 host-first 候选的重新分诊 |
| 机检清单 | `packages/chimera/specs/rust-host/http/openapi-freeze.manifest.json` | 源哈希、生成链、G0 项、stale 产物 |

冻结方式：只读读取源 fixture，导出为列式 JSON；没有重新生成 spec，没有改 `packages/sdk`。`coverage-170.json` 与 `triage-96.json` 的 sha256 记录在 `openapi-freeze.manifest.json`，`verify-http-contract.ts` 会复算。

## 4. 170-op 分布

| group | operations | exercise | none |
|---|---|---|---|
| config | 10 | 3 | 7 |
| control | 3 | 3 | 0 |
| event | 1 | 1 | 0 |
| experimental | 13 | 11 | 2 |
| file | 6 | 6 | 0 |
| global | 10 | 6 | 4 |
| graph | 6 | 0 | 6 |
| instance | 12 | 9 | 3 |
| mcp | 8 | 8 | 0 |
| memory | 8 | 0 | 8 |
| permission | 2 | 2 | 0 |
| process | 1 | 0 | 1 |
| project | 4 | 4 | 0 |
| provider | 5 | 4 | 1 |
| pty | 8 | 7 | 1 |
| question | 3 | 3 | 0 |
| session | 32 | 27 | 5 |
| sync | 4 | 3 | 1 |
| tui | 13 | 13 | 0 |
| v2 | 5 | 0 | 5 |
| v2 credentials | 2 | 0 | 2 |
| v2 integrations | 7 | 0 | 7 |
| v2 messages | 1 | 0 | 1 |
| workspace | 6 | 6 | 0 |
| **total** | **170** | **116** | **54** |

分类迁移计数（来自源 fixture）：

| migrationClass | count | 含义 |
|---|---|---|
| host-first | 96 | inventory 首次分类；本包已重新分诊，见 `triage-96.md` |
| proxy-first | 50 | 先走 Bun 代理 |
| special | 24 | SSE / WebSocket / TUI / PTY 等特殊面 |

## 5. 完整 spec 的获取（G0 环境项）

仓库内没有当前 live 完整 spec。`packages/sdk/openapi.json` 是 2026-05-07 的 109 paths / 127 ops 旧产物；`packages/docs/openapi.json` 是指向它的 symlink。二者都不是当前 142/170 的权威。

**产物落点（默认）**：`packages/chimera/dist/openapi-freeze/`。`dist/` 是构建输出且被 `packages/chimera/.gitignore` 忽略，不会误提交；若 G0 runner 需要仓库外目录，覆盖 `ARTIFACT_DIR` 即可。不要把这里的冻结产物与 `packages/sdk/js/openapi.json`（SDK build 的瞬态输入，build 结束即删除）混淆。

在 G0 环境执行（不要在 WP-04 本轮执行）：

```bash
cd packages/chimera
ARTIFACT_DIR="${ARTIFACT_DIR:-dist/openapi-freeze}"
mkdir -p "$ARTIFACT_DIR"

# 1) Effect HttpApi 完整 spec（冻结主产物）
bun dev generate > "$ARTIFACT_DIR/openapi.json"

# 2) Hono parity spec（仅用于差异审计）
bun dev generate --hono > "$ARTIFACT_DIR/openapi.hono.json"

# 3) 记录哈希（macOS 用 shasum -a 256；Linux 可换 sha256sum）
shasum -a 256 "$ARTIFACT_DIR"/openapi.json "$ARTIFACT_DIR"/openapi.hono.json | tee "$ARTIFACT_DIR/sha256.txt"

# 4) 操作清单漂移检查（只读）
bun script/httpapi-inventory.ts --check

# 5) live inventory 测试（只读）
bun test --timeout 30000 test/server/httpapi-inventory.test.ts
```

产物清单：

| 产物 | 路径（从仓库根） | 是否提交 |
|---|---|---|
| Effect 完整 spec | `packages/chimera/dist/openapi-freeze/openapi.json` | 否（G0 环境产物） |
| Hono parity spec | `packages/chimera/dist/openapi-freeze/openapi.hono.json` | 否 |
| 哈希记录 | `packages/chimera/dist/openapi-freeze/sha256.txt` | 否 |
| 哈希与计数回填 | WP 结果 / `openapi-freeze.manifest.json` | 是（只记哈希与计数） |

验收：

- `openapi.json` 的 path 数为 142、operation 数为 170；
- operationId 集合与 `coverage-170.json` 完全一致；
- `sha256.txt` 记录两份 spec 的 sha256，并回填 WP 结果；
- Effect 与 Hono 的差异逐项分类为 `approved_delta`（原因、期望行为、受影响契约、对应测试）或修复；
- 是否把完整 spec 提交进仓库由 parent 拍板（见 D-WP04-3）；默认不提交。

## 6. 确定性

| 层 | 保证 | 证据 |
|---|---|---|
| JSON 序列化 | prettier `parser=json, printWidth=120` | `packages/chimera/src/cli/cmd/generate.ts:47-57` |
| 操作排序 | inventory 按 path 排序，再按固定 method 顺序 | `packages/chimera/script/httpapi-inventory.ts:218-245` |
| SDK 输出 | `clean: true`，删除已移除的操作 | `packages/sdk/js/script/build.ts:23-29` |
| fixture 比较 | 字节比较，不排序掉因果错误 | `packages/chimera/test/server/httpapi-inventory.test.ts:9-12` |

建议的复验方式：同一环境连续生成两次完整 spec，第二次与第一次做字节比较；若不一致，先查生成器顺序/时间字段，不得用“本批改动”放行（计划 §10）。

## 7. 建议与待拍板

### 7.1 建议

1. 仓库只版本化操作清单与 owner/分诊 fixture；完整 spec 作为 G0 环境产物，记录 sha256，不默认提交。
2. `packages/sdk/openapi.json` 保留为历史产物并显式标 stale；不要用它做 SDK 重生成的输入。
3. 每次 SDK 重生成前先捕获 `openapi.json`（build 会删除它），把 spec diff 与 `src/v2/gen` diff 分开报告。

### 7.2 待拍板

| 项 | 需要决定 | 默认建议 |
|---|---|---|
| D-WP04-3 | 完整 spec 是否版本化进仓库 | 不版本化；G0 生成 + 哈希 + 清单 |
| D-WP04-5 | `packages/sdk/openapi.json` 是否永久标 stale | 保留、标 stale、不更新 |
| D-WP04-6 | Hono parity 差异的放行标准 | 仅 `approved_delta`；不接受“来自本批改动” |

## 8. 证据索引

| 证据 | 位置 |
|---|---|
| live spec 入口 | `packages/chimera/src/server/server.ts:159-195` |
| CLI 生成 | `packages/chimera/src/cli/cmd/generate.ts:19-66` |
| SDK 生成链 | `packages/sdk/js/script/build.ts:12-54` |
| inventory 派生 | `packages/chimera/script/httpapi-inventory.ts:213-288` |
| inventory 首次分类声明 | `packages/chimera/script/httpapi-inventory.ts:16-17` |
| live 漂移测试 | `packages/chimera/test/server/httpapi-inventory.test.ts:1-60` |
| 计划要求 | `RUST_FULL_MIGRATION_PLAN.md:25,151,258` |