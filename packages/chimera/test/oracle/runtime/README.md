# WP-07 runtime oracle 向量（静态）

> 状态：静态向量（WP-07，2026-10-30）。本轮**不要求执行**。
> 依据：`packages/chimera/specs/rust-host/runtime/platform-contract.md`、`capability-matrix.md`、`boot-path-capability.md`、`router-contract.md`；`contract_rev = cr-2026-10-30-r1`。
> 范围：关闭/重启、IPC trust、Windows、两变体安装、boot/router 的验收向量；不实现生产 runtime、不编译 Rust、不构建可执行体。

## 1. 文件

| 文件 | 覆盖 |
|---|---|
| `shutdown-restart.vectors.json` | 关闭/重启：SIGTERM、drain、worker 重启、host 重启 sweep |
| `ipc-trust.vectors.json` | socket 权限、nonce、peer credentials、握手超时、无 TCP |
| `windows.vectors.json` | Windows host 不可编译、publish 矩阵无 Windows host、named pipe 目标 |
| `install-variants.vectors.json` | `no-webui` MIT / `with-webui` GPL 两变体安装与 host 缺失降级 |
| `boot-router.vectors.json` | TS 进程内 server、host `Unrouted`、host 无 HTTP、host front door 目标 |

## 2. 向量 schema

每个文件是 UTF-8 JSON，顶层字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `schema` | string | 固定 `chimera.runtime.oracle.v1` |
| `contract_rev` | string | 固定 `cr-2026-10-30-r1` |
| `work_id` | string | 固定 `WP-07` |
| `area` | string | 文件覆盖的平台面 |
| `owner` | string | `runtime owner` |
| `generated_at` | string | `YYYY-MM-DD` |
| `notes` | string | 执行边界/占位符说明 |
| `vectors` | array | 向量列表 |

每个向量：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | `RT-*`，全目录唯一 |
| `title` | string | 一句话说明 |
| `class` | `current-state` \| `target-acceptance` | 冻结现状 / 目标门禁 |
| `platform` | string[] | `darwin`、`linux`、`windows` |
| `workdir` | `repo-root` \| `packages/chimera` | 命令执行目录 |
| `requires` | string[] | 前置工具/产物；缺失时该向量为 `not-run` |
| `command` | string | `bash -lc` 可执行的命令；只用占位符，不写真实 URL/IP/凭据/home 路径 |
| `pass_condition` | object | 判定条件，见下 |
| `expected_today` | `pass` \| `fail` \| `not-run` | 当前工作树预期 |
| `blocked_by` | string \| null | 目标向量阻塞项（G0/T1/G2/G3/G14/D3/D5） |
| `evidence` | string[] | `file:line` 证据 |
| `cleanup` | string | 清理说明（可选） |
| `notes` | string | 向量特定说明（可选） |

`pass_condition` 字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `exit_code` | number | 期望退出码；`77` 表示 skip 时另见 `skip_exit_codes` |
| `skip_exit_codes` | number[] | 允许的 skip 退出码（可选） |
| `stdout_contains` | string[] | stdout 必须包含的子串（可选） |
| `stdout_not_contains` | string[] | stdout 不得包含的子串（可选） |
| `stderr_contains` | string[] | stderr 必须包含的子串（可选） |
| `stderr_not_contains` | string[] | stderr 不得包含的子串（可选） |

## 3. 执行口径

- **current-state**：命令退出 0 表示“现状与文档一致”，不表示契约已满足。例如 `RT-SD-001` 断言 SIGTERM 直接终止（退出 143），这是缺口冻结，不是通过验收。
- **target-acceptance**：命令退出 0 才表示目标契约满足；当前预期通常为 `fail` 或 `not-run`，`blocked_by` 指向阻塞项。
- 执行器必须：
  1. 在临时目录中运行，使用 `mktemp -d`；
  2. 不访问外部网络；所有 HTTP 只用 `localhost:<port>`；
  3. 不写入用户 home；`npm` 安装类向量只在一次性 CI 容器/临时 prefix 中执行；
  4. 失败时保留 stderr 摘要，不保留凭据/nonce；
  5. 对 `not-run` 的向量输出 `SKIP: <requires>`，不得计为通过。
- 本轮不执行任何向量；本目录只提供静态契约。首次执行建议在 `packages/chimera` 的 focused test 环境或 CI 的 Unix 腿进行；Windows 向量只在 Windows runner 执行。

## 4. 占位符

| 占位符 | 含义 |
|---|---|
| `<data-root>` | 项目数据根；由测试临时目录提供 |
| `<db>` | canonical 主库路径；由 launcher/测试提供 |
| `<port>` | 本地空闲端口；由测试分配 |
| `<version>` | 构建版本号；由 `package.json`/构建脚本提供 |
| `<platform>` | 平台包标识（如 `darwin-arm64`、`linux-x64`）；不得写死主机路径 |
| `HOST_BIN` | 已构建的 `chimera-host` 二进制路径；未设置时用仓库内 target 路径 |

## 5. 与门禁的关系

- 本目录的 `target-acceptance` 向量不替代 W0 oracle；它们只覆盖 WP-07 的平台契约面。
- G0 通过前不得执行生产迁移；本目录向量可以随 CI 读取，但不得作为“host 已可发布”的证据。
- `RT-INST-*` 的 npm 安装验收必须在 host 能力首次对用户可启用前完成（`RUST_FULL_MIGRATION_PLAN.md:302`）。
- 所有向量通过后，仍需 parent 独立复验；不接受 builder 自报（`RUST_FULL_MIGRATION_PLAN.md:299`）。