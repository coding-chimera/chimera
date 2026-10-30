# WP-04：live OpenAPI / inventory 冻结与 SDK 漂移验证

> 状态：**契约/fixture 已落位，G0 环境执行项待跑**。
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §8（WP-04）、§9（work manifest）、§10（统一门禁）、§1 证据基线（HTTP 契约行）、§3（170 op inventory 冻结）、§16（首批顺序）。
> 契约版本：`cr-2026-10-30-r1`。基线 commit：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
> 本包只产出契约、fixture、检查程序与文档；不重新生成 OpenAPI，不改 `packages/sdk`，不写生产迁移代码。

## 1. 本包回答的四个问题

| # | DoD 要求 | 本包落点 | 结论 |
|---|---|---|---|
| 1 | 冻结当前 server OpenAPI 与 170-op 清单；正式生成链可复验 | `openapi-freeze.md`、`openapi-freeze.manifest.json`、`coverage-170.json` | 170-op 清单已冻结；完整 spec 无仓库内现成产物，获取命令标为 G0 环境执行项 |
| 2 | 116/54 覆盖差距逐项有 owner | `coverage-gaps.md`、`coverage-170.json` | 170 行逐项有 `semanticOwner`；116 exercise / 54 none 与 live inventory 一致 |
| 3 | 96 候选按真实依赖重新分诊，产出 host-first / 依赖 session 二分清单 | `triage-96.md`、`triage-96.json` | 96 → handler 层 host-first 69 / 依赖 session 27（storage 19 + execution 8）；其中 30 条 host-first 的 group/layer 构造依赖 session（layer-blocked），首批候选只有 39 条 |
| 4 | SDK 重生成零 diff 或显式 approved_delta | `sdk-drift.md`、`sdk-drift-baseline.json`、`verify-http-contract.ts` | 检查程序与基线已冻结；`types.gen.ts` 的 2 行 delta 登记为 external-blocked（另一会话 2026-10-29 进行中工作，非 approved_delta）；baseline 从 dirty worktree 捕获，G0 必须对 HEAD 比对并重录 |

## 2. 权威与边界

- **live 权威**：`Server.openapi()`，实现为 `OpenApi.fromApi(PublicApi)`（`packages/chimera/src/server/server.ts:159-173`）。CLI 入口 `packages/chimera/src/cli/cmd/generate.ts:24-66`；SDK 生成入口 `packages/sdk/js/script/build.ts:12-54`。
- **操作清单权威**：`packages/chimera/test/fixtures/httpapi-inventory.json`（170 ops / 142 paths，sha256 `e91fdde891c3ad7f5486f7a44dc2164a102164e92136f26819cc507bc175b757`）。该 fixture 由 `packages/chimera/script/httpapi-inventory.ts` 从 `Server.openapi()` 派生；`test/server/httpapi-inventory.test.ts` 负责 live 漂移检查。
- **非权威**：`packages/sdk/openapi.json`（109 paths / 127 ops，openapi 3.1.0，2026-05-07）与 `packages/docs/openapi.json`（指向前者的 symlink）是历史产物，**不得当实时权威**（计划第 25 行明确要求）。
- **不重新生成**：本包没有运行 `bun dev generate` 或 `bun script/build.ts`；只读复制/导出 inventory，并记录完整 spec 的获取命令。

## 3. 文件清单

### 3.1 契约文档（`packages/chimera/specs/rust-host/http/`）

| 文件 | 内容 |
|---|---|
| `README.md` | 本索引、权威边界、DoD 映射 |
| `openapi-freeze.md` | 生成链、冻结物、170-op 摘要、stale 产物、G0 获取命令、确定性 |
| `coverage-gaps.md` | 116/54 差距出处、54 项逐行 owner、116 项按 owner 归组、owner 负载 |
| `triage-96.md` | 96 候选分诊标准、69/19/8 三张表、关键发现、cutover 建议 |
| `sdk-drift.md` | SDK 重生成零 diff / approved_delta 检查程序 |
| `g0-execution.md` | G0 环境执行清单（完整 spec、Hono parity、SDK 重生成、既有 delta 处置） |
| `openapi-freeze.manifest.json` | 机检清单：源哈希、生成链、G0 项、stale 产物 |

### 3.2 Fixture 与检查程序（`packages/chimera/test/oracle/http/`）

| 文件 | 内容 |
|---|---|
| `httpapi-inventory.frozen.json` | 源 inventory 的逐字节只读副本；sha256 与源 fixture 一致 |
| `coverage-170.json` | 170 行操作清单 + 每行 `semanticOwner` / `gapAction` / `gapDetail`；列式 JSON，便于机检 |
| `triage-96.json` | 96 行 host-first 候选分诊；列式 JSON，含 `verdict` / `binary` / `cutoverOwner` / 证据 |
| `sdk-drift-baseline.json` | `src/v2/gen/**` 15 个文件的 sha256、比较范围、既有 worktree delta |
| `verify-http-contract.ts` | 只读检查程序：fixture 一致性、owner 覆盖、分诊完备性、SDK 基线哈希 |
| `README.md` | fixture 结构、检查命令、更新流程 |

## 4. 机检命令

从 `packages/chimera` 运行：

```bash
bun test/oracle/http/verify-http-contract.ts
bun test --timeout 30000 test/server/httpapi-inventory.test.ts
```

第一条检查本包 fixture 的自洽性；第二条检查 live inventory 与冻结源 fixture 是否一致（只读，不写 fixture）。两条都通过才说明“清单冻结 + 分诊/owner 自洽 + SDK 基线未漂移”。

## 5. 结论摘要

- **170-op 清单**：142 paths / 170 ops；`host-first 96 / proxy-first 50 / special 24`；`exercise 116 / none 54`。
- **96 候选重分诊**：handler 层不触碰 TS session 语义的有 **69** 条；**19** 条只触碰 session 存储/消息行；**8** 条触碰 session 执行语义。69 条中又有 **30** 条的 group/layer 构造依赖 `Session`/`SessionPrompt`/`BackgroundJob`/`SessionStatus`（config 9 / experimental 9 / workspace 4 / memory 8），不能进入首批；首批候选为 **39** 条 construction-clean 路由。
- **覆盖差距**：54 条 none 全部有 domain owner；116 条 exercise 的剩余差距是 recorder/replay + SSE/DBtrace，归 WP-02/WP-03 扩展，WP-04 负责 HTTP 契约层。
- **SDK 漂移**：当前 `packages/sdk/js/src/v2/gen/types.gen.ts` 有 2 行未提交 delta（`timeout?: number`），归属另一会话 2026-10-29 的进行中 provider 契约工作，本包登记为 **external-blocked**，不是 `approved_delta`。baseline 从 dirty worktree 捕获，`verify-http-contract.ts` 通过只证明 worktree == baseline；G0 必须用 `git diff HEAD --exit-code` 对 committed HEAD 比对，若 delta 已入库则重录 baseline。

## 6. 建议与待拍板

### 6.1 建议（本包已按此产出）

1. 以 `coverage-170.json` 作为 170-op 清单的版本化冻结物；`packages/chimera/test/fixtures/httpapi-inventory.json` 继续作为 live 漂移源，两者用 sha256 绑定。
2. 完整 OpenAPI 文档不进仓库，按 G0 环境项生成到 `packages/chimera/dist/openapi-freeze/` 并记录 sha256；仓库只保留操作清单与 owner/分诊 fixture。
3. SDK 漂移门只比较 `packages/sdk/js/src/v2/gen/**`；`src/gen/**` 是 legacy 输出，`dist/**` 是构建产物，均不纳入。
4. 96 候选按 **39/30/27** 执行：39 条 construction-clean 可进首批；30 条 layer-blocked 与 27 条 session-dependent 在 layer/数据面/会话运行时换权前继续走 Bun 代理。

### 6.2 待拍板（parent / 用户）

| 项 | 需要决定 | 影响 |
|---|---|---|
| D-WP04-1 | 是否接受 39/30/27 三分作为 W2 首批范围 | 直接决定首条 Rust 主控闭环的路由宽度；首批只从 39 条 construction-clean 中选 |
| D-WP04-2 | 19 条 session-storage 路由是否允许在数据面迁移后先接 host，还是必须等 session 运行时 | 影响 WP-05/WP-10 的依赖顺序 |
| D-WP04-3 | 完整 spec 是否要版本化进仓库（当前建议 G0 环境生成、仓库只存哈希与清单） | 影响仓库体积与漂移门的比较对象 |
| D-WP04-4 | `types.gen.ts` 既有 2 行 delta 的归属与处置 | external-blocked；由所属会话 commit/revert；本包不批准 `approved_delta`；G0 时若已入库则按新 HEAD 重录 baseline |
| D-WP04-5 | 是否接受 `packages/sdk/openapi.json` 永久标记为 stale（不删除、不更新） | 影响文档/工具对旧 spec 的引用 |

## 7. 证据索引

| 证据 | 位置 |
|---|---|
| 计划中的 HTTP 契约结论 | `RUST_FULL_MIGRATION_PLAN.md:25` |
| 96 路由不抢跑 | `RUST_FULL_MIGRATION_PLAN.md:37`、`:245` |
| 170 op inventory 冻结要求 | `RUST_FULL_MIGRATION_PLAN.md:151` |
| WP-04 DoD | `RUST_FULL_MIGRATION_PLAN.md:258` |
| inventory 首次分类声明 | `packages/chimera/script/httpapi-inventory.ts:16-17` |
| inventory 派生源 | `packages/chimera/script/httpapi-inventory.ts:213-214` |
| exercise 覆盖判定 | `packages/chimera/script/httpapi-inventory.ts:177-186,242` |
| exerciser 双臂/隔离说明 | `packages/chimera/script/httpapi-exercise.ts:1-20,68-69` |
| 生成链 | `packages/chimera/src/cli/cmd/generate.ts:24-66`、`packages/chimera/src/server/server.ts:159-195`、`packages/sdk/js/script/build.ts:12-54` |
| live inventory 测试 | `packages/chimera/test/server/httpapi-inventory.test.ts:1-60` |
| 构造层 session 依赖 | `packages/chimera/src/server/routes/instance/httpapi/handlers/config.ts:28-29`、`experimental.ts:27,28,29`、`workspace.ts:13`、`memory.ts:8`；`packages/chimera/src/control-plane/workspace.ts:171-172,1085,1087`；`packages/chimera/src/tool/registry.ts:576,586`；`packages/chimera/src/memory/memory.ts:420-425` |
| SDK delta 归属 | `packages/chimera/src/config/provider.ts`（dirty RemoteCompaction `timeout`）；`sdk-drift-baseline.json` 的 `head_sha256`/`worktree_sha256` |