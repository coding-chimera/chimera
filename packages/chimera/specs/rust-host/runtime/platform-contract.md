# WP-07 平台契约：关闭/重启、IPC trust、Windows、两变体安装

> 状态：契约稿（WP-07，2026-10-30）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §4（终态架构）、§6（W2/W3）、§10（统一门禁）、§12（风险登记册）、§13（D3/D5）；`packages/chimera/specs/rust-host/{ipc-v0.md,recovery-matrix.md,h2-data-plane.md}`；`manifest.yaml`（`contract_rev = cr-2026-10-30-r1`）。
> 范围：平台契约与静态验收向量；不实现生产 runtime、不编译 Rust、不构建可执行体。
> 向量落点：`packages/chimera/test/oracle/runtime/*.vectors.json`；本轮只交付静态向量，不要求执行。

## 0. 契约分层

本文把每个平台面拆成三层，避免把“目标契约”误读成“当前行为”：

| 层 | 含义 | 写法 |
|---|---|---|
| **当前事实** | 以工作树代码/规格为证据的现状 | 每条给 `file:line` |
| **目标契约** | 首个 host 能力发布前必须满足的验收语义 | 用 `R-*` 编号；未实现处标 `[待接线]` |
| **验收向量** | 可执行命令 + 期望判定 | 引用 `RT-*` id；`current-state` 可立即跑，`target-acceptance` 在 G0/T1 后跑 |

判定口径：

- `current-state` 向量用于冻结现状，允许断言“当前是缺口”；命令退出码 0 表示现状与文档一致，不表示契约已满足。
- `target-acceptance` 向量用于门禁；当前预期失败（`expected_today = fail`），`blocked_by` 指向 G0/T1/具体缺口。
- 所有向量必须可重复、无外部网络、无真实凭据、清理临时目录。

## 1. 关闭/重启契约

### 1.1 目标契约

| 编号 | 契约 | 判定 |
|---|---|---|
| R-SD-1 | host 是 worker 的父进程；关闭时先停止接受新连接/新请求，再向所有 live worker 发 `drain(reason=shutdown)` | 每个 worker 收到 drain 帧 |
| R-SD-2 | host 等待 `drain_deadline_ms`（candidate default 30s）；超时后按 `SIGTERM → SIGKILL` 升级 | deadline 后 worker 不再存活 |
| R-SD-3 | drain 成功：worker 回 `ack(drained)`，host 标记 `exited(normal)`，host 退出码 0 | 无僵尸、无未 ack 的 durable event |
| R-SD-4 | drain 超时：host 强制终止 worker，把该 worker 上非终态 turn 标 `interrupted`；已有 cancel intent 的仍标 `cancelled` | durable 行状态符合 `ipc-v0.md:779-790` |
| R-SD-5 | host 崩溃/重启：启动时扫描 durable 表，把没有当前 live generation 的 `running` 行标 `interrupted`；不得假定 worker 还活着 | 重启 sweep 可重复、幂等 |
| R-SD-6 | worker 崩溃：按 100/500/2000/5000ms 退避（封顶 30s）重启，generation 递增；5 次/5 分钟暂停 workspace | 旧 generation 不能写；新 generation 可服务 |
| R-SD-7 | host 重启后客户端 SSE 通过 `Last-Event-ID` + `stream_epoch` 从 `host_event` 补发；窗口外返回 `stream_reset` | 新增能力，单独标注，不冒充旧 parity |
| R-SD-8 | 任何关闭/重启路径都必须保留已提交的 durable 事实；不能以“进程退出”代替提交确认 | commit-before-ack 不被绕过 |

### 1.2 当前事实

| 事实 | 证据 | 影响 |
|---|---|---|
| host bin 无信号处理 | `chimera-host/src/bin/chimera-host.rs:43-49` | SIGTERM/SIGINT 走默认处置；不能保证 drain。 |
| bin 不调用 `request_drain`/`collect_drain_outcomes`/`kill_worker` | `chimera-host/src/bin/chimera-host.rs` 无这些符号；`runtime.rs:593-703` 只有库层实现 | 关闭路径未接线。 |
| bin 丢弃 `tick()` 的 `drain_expired` | `chimera-host/src/bin/chimera-host.rs:335` | 即使 drain deadline 到期，bin 也不会升级 kill。 |
| bin 只 reap，不重启 | `chimera-host/src/bin/chimera-host.rs:30-33,339-353` | worker 退出后 workspace 不会自动补位。 |
| 重启原语存在但未接线 | `runtime.rs:706-743`；`supervisor.rs:33-44,659-675` | `try_restart` 没有生产调用。 |
| host 启动不做 durable sweep | `chimera-host/src/bin/chimera-host.rs:253-259`；`chimera-host/src/store.rs:212-220` 只有状态字符串 | H2 缺口 G14（`h2-data-plane.md:661`）。 |
| drain 协议与 worker 侧已实现 | `ipc-v0.md:779-790`；`packages/chimera/src/host/worker-bootstrap.ts:466-478,502-528` | 缺的是 host bin 的关闭编排，不是协议本身。 |

### 1.3 验收向量

| ID | 类型 | 判定 | 说明 |
|---|---|---|---|
| `RT-SD-001` | current-state | 当前 SIGTERM 直接终止，退出码为信号值（通常 143），不产生 drain ack | 冻结“无信号处理”现状 |
| `RT-SD-002` | target-acceptance | SIGTERM 后 host 退出 0；worker 收到 drain 并退出 0；无孤儿进程 | `blocked_by: T1` |
| `RT-RS-001` | target-acceptance | 杀死 worker 后 host 按退避重启，新 generation = 旧 + 1；旧 generation 写入被拒 | `blocked_by: T1` |
| `RT-RS-002` | target-acceptance | 预置非终态 `session_turn_checkpoint` 行后重启 host，该行变 `interrupted`；已有 cancel intent 的保持 `cancelled` | `blocked_by: T1 + G14` |
| `RT-RS-003` | current-state | 源码探针确认 bin 没有 `try_restart`/`request_drain` 调用 | 冻结接线缺口 |

## 2. IPC trust 契约

### 2.1 目标契约

| 编号 | 契约 | 判定 |
|---|---|---|
| R-IPC-1 | IPC 只监听本机 Unix domain socket；不监听 TCP，不暴露网络端口 | `ss`/`lsof` 无 TCP listen |
| R-IPC-2 | IPC 目录 `0700`、socket 文件 `0600`；祖先目录权限不被隐式收紧 | `stat` 精确匹配 |
| R-IPC-3 | 只删除“已证明死亡”的 stale socket；非 socket 文件、live socket 一律拒绝 | 删除前 probe；拒绝码稳定 |
| R-IPC-4 | 每个 worker spawn 时注入一次性 nonce；`hello.nonce` 不匹配返回 `unauthorized` 并关闭 | 错误帧 + 关闭 |
| R-IPC-5 | 连接建立后读取 peer credentials（Linux `SO_PEERCRED`，macOS `LOCAL_PEERCRED`），uid 必须与 host 一致；Windows named pipe 校验客户端身份 | 不一致返回 `unauthorized` |
| R-IPC-6 | nonce 不写入日志/错误详情；错误消息只给诊断，不回显 nonce | stderr/error frame 扫描 |
| R-IPC-7 | 握手阶段使用独立读超时（candidate 10s）；超时返回 `handshake_timeout` 并关闭 | 超时判定 |
| R-IPC-8 | `CHIMERA_HOST_IPC=off|observe|enforce` 必须 gate 行为；`enforce` 前 R-IPC-5/R-IPC-7 必须就绪 | kill switch 行为矩阵 |

### 2.2 当前事实

| 事实 | 证据 | 影响 |
|---|---|---|
| 目录/文件权限已实现 | `chimera-host/src/host.rs:418-422,500-526` | R-IPC-2 满足。 |
| stale/live/non-socket 策略已实现 | `host.rs:451-460,500-526`；测试 `host.rs:993-1090` | R-IPC-3 满足。 |
| nonce 校验已实现 | `chimera-host/src/handshake.rs:436-441`；错误码 `handshake.rs:274,285,440` | R-IPC-4 满足。 |
| peer credentials 未实现 | `ipc-v0.md:128-136`；源码无 `getpeereid`/`SO_PEERCRED`/`LOCAL_PEERCRED` | R-IPC-5 未满足；H2 缺口 G3。 |
| Rust 握手读超时未实现 | `ipc-v0.md:138-150`；H2 缺口 G2（`h2-data-plane.md:648`） | R-IPC-7 未满足。 |
| `CHIMERA_HOST_IPC` 只解析不 gate | `host.rs:199-256`；bin 只在启动行打印（`chimera-host/src/bin/chimera-host.rs:303-312`） | R-IPC-8 未满足。 |
| 当前信任边界 | 目录/文件权限 + nonce；同用户进程默认可连 | 不是“零信任”；文档不得夸大。 |

### 2.3 验收向量

| ID | 类型 | 判定 | 说明 |
|---|---|---|---|
| `RT-IPC-001` | current-state | 启动 host 后 IPC 目录 `0700`、socket `0600` | 需要已构建 host 二进制 |
| `RT-IPC-002` | current-state | nonce 不匹配返回 `unauthorized`（现有单元测试） | `cargo test` 可跑 |
| `RT-IPC-003` | target-acceptance | 不同 uid 连接返回 `unauthorized` 并关闭 | `blocked_by: G3` |
| `RT-IPC-004` | current-state | 源码/运行探针确认 host 不监听 TCP | 冻结“仅 Unix socket” |
| `RT-IPC-005` | target-acceptance | 10s 内不发送 `hello` 返回 `handshake_timeout` | `blocked_by: G2` |

## 3. Windows 契约

### 3.1 当前事实

| 事实 | 证据 | 影响 |
|---|---|---|
| host crate 直接依赖 `std::os::unix` | `chimera-host/src/host.rs:29-30` | 不能在 Windows 编译。 |
| bin 读 `/dev/urandom` 生成 nonce | `chimera-host/src/bin/chimera-host.rs:190` | 无跨平台 RNG；Windows 无此设备。 |
| publish host-prebuild 明确排除 Windows | `.github/workflows/publish.yml:189` | 6 个 host leg 全是 Linux/macOS。 |
| H2 把 Windows host 列为非目标 | `h2-data-plane.md:39` | Windows 一律 legacy。 |
| 发布矩阵有 Windows CLI 产物 | `.github/workflows/publish.yml:120-131,316-338` | CLI 可安装，但 host 不可用；两件事不能混为一谈。 |

### 3.2 目标契约（D3 未拍板前的候选）

D3 仍待拍板（`RUST_FULL_MIGRATION_PLAN.md` §13 D3）。在拍板前，只冻结“不得假设”的边界：

- **R-WIN-1**：Windows 上没有 host 二进制时，launcher 必须走 legacy，不得因缺失 host 而崩溃；`rust` 模式显式要求 host 时必须返回启动错误，不静默降级。
- **R-WIN-2**：若未来支持 Windows host，transport 必须是 named pipe（或等价的本机 IPC），并校验客户端身份/ACL；不得把 Unix socket 路径规则套到 Windows。
- **R-WIN-3**：nonce 生成必须使用跨平台 OS RNG；不得依赖 `/dev/urandom`。
- **R-WIN-4**：Windows 的安装/启动验收必须与 Unix 分开列；不能以“CLI 能装”证明 host 可用。

### 3.3 验收向量

| ID | 类型 | 判定 | 说明 |
|---|---|---|---|
| `RT-WIN-001` | current-state | `cargo check --target x86_64-pc-windows-msvc` 因 `std::os::unix` 失败 | 冻结“当前不可编译”；需要 Windows target/toolchain |
| `RT-WIN-002` | current-state | `publish.yml` 的 host-prebuild 矩阵不含 `win32` | 源码探针，跨平台可跑 |
| `RT-WIN-003` | target-acceptance | Windows named pipe 上完成 hello/ready/ack，错误身份返回 `unauthorized` | `blocked_by: D3 + T1` |

## 4. 两变体安装契约（with-webui GPL / no-webui MIT）

### 4.1 变体矩阵

| 维度 | `no-webui` | `with-webui` |
|---|---|---|
| npm 包名 | `@coding-chimera/chimera` | 同左（包名不因变体改变） |
| license | `MIT` | `GPL-3.0-only` |
| 许可证文件 | `LICENSE` | `LICENSE`、`LICENSE-MIT`、`NOTICE` |
| WebUI 资源 | 不嵌入（`embedLegacyWebUi=false`、`embedNewWebUi=false`） | 嵌入 NewWeb（`embedNewWebUi=true`） |
| tarball 后缀 | `-no-webui` | `-with-webui` |
| host 二进制 | 当前不随包；缺失时 legacy | 同左 |

证据：`packages/chimera/script/package-variant.ts:7,88-93,141-142`；`packages/chimera/script/build.ts:159-183,422-433`；测试 `packages/chimera/test/script/package-variant.test.ts:80-117`。

### 4.2 目标契约

| 编号 | 契约 | 判定 |
|---|---|---|
| R-INST-1 | 两个变体都使用同一公共包名与同一 `chimera` bin；变体只体现在 tarball 文件名与 license/资源元数据 | `package.json.name` 相同 |
| R-INST-2 | `no-webui` 必须是 MIT，且不得包含 `NOTICE`/`LICENSE-MIT` 或嵌入 WebUI 资源 | 安装后 `license`/文件清单 |
| R-INST-3 | `with-webui` 必须是 GPL-3.0-only，包含 `NOTICE` 与 `LICENSE-MIT`，并嵌入 NewWeb 资源 | 安装后 `license`/文件清单 |
| R-INST-4 | 用户安装验证必须用 npm（不是 `bun install -g`）；安装后 `command -v chimera`、`chimera --version`、`npm ls -g` 三项通过 | 三项命令 |
| R-INST-5 | `with-webui` 启动 `chimera web --open=false` 后，`/` 不得返回 missing-assets 文本 | HTTP 根响应 |
| R-INST-6 | host 二进制缺失时，两个变体都必须能走 legacy；不得因 host 缺失导致 CLI 启动失败 | 无 host 的安装 smoke |
| R-INST-7 | host 二进制存在时，postinstall 只做 warn-only 探测；探测失败不得让安装失败 | 安装退出码 0 |

### 4.3 当前事实

| 事实 | 证据 | 影响 |
|---|---|---|
| 变体/许可证映射已实现并有单测 | `package-variant.ts:88-93`；`package-variant.test.ts:80-117` | R-INST-1/2/3 的元数据层已满足。 |
| build 支持两种变体与 tarball 后缀 | `packages/chimera/script/build.ts:159-183,422-433` | 构建入口存在。 |
| publish 分两次构建两变体 | `.github/workflows/publish.yml:309-338` | CI 产物分开。 |
| host 未进入 npm 产物 | `packages/chimera/script/build.ts:118,400` 只有 kernel；`packages/chimera/script/postinstall.mjs:29,62` 只探测 kernel；`.github/workflows/publish.yml:173-190` | R-INST-6 的“缺失时 legacy”尚无真实 host 可验；R-INST-7 未实现。 |
| `chimera web` 的 missing-assets 文本 | `packages/chimera/src/server/shared/newweb-ui.ts:14`；`packages/chimera/src/server/shared/ui.ts:12` | 用于 with-webui 验收判定。 |
| 健康端点 | `packages/chimera/src/server/routes/global.ts:45-62`；`packages/chimera/src/server/routes/instance/httpapi/groups/global.ts:46` | 用于 no-webui/with-webui 的 server smoke。 |

### 4.4 验收向量

| ID | 类型 | 判定 | 说明 |
|---|---|---|---|
| `RT-INST-001` | current-state | `bun test test/script/package-variant.test.ts` 通过；license/文件映射与矩阵一致 | 轻量、当前可跑 |
| `RT-INST-002` | target-acceptance | 安装 `no-webui` 两个 tarball 后：`license=MIT`、无 `NOTICE`、`chimera --version` 成功、`/global/health` 返回 healthy | 需要构建产物 |
| `RT-INST-003` | target-acceptance | 安装 `with-webui` 后：`license=GPL-3.0-only`、`NOTICE` 存在、`chimera web` 根路径不含 missing-assets | 需要构建产物 |
| `RT-INST-004` | current-state | 安装包内不存在 `bin/host/chimera-host`；`chimera --version` 仍成功 | 冻结 host 未打包现状 |

## 5. 失败与降级矩阵

| 条件 | legacy | proxy | rust |
|---|---|---|---|
| 无 host 二进制 | 正常 | 降级 legacy + 告警 | 启动错误或显式降级（需用户同意） |
| host 启动失败（socket/schema/preflight） | 正常 | 降级 legacy | 启动错误 |
| canonical DB 未解析（`--db` 缺失） | 正常 | `host_db_unresolved` → legacy | 启动错误 |
| IPC 握手失败 | 正常 | 该 worker 不接入，legacy | 启动错误或 503 |
| drain 超时 | 正常退出 | 强制终止 + `interrupted` | 强制终止 + `interrupted` |
| peer credentials 不匹配 | 正常 | 拒绝该连接，legacy | 拒绝该连接 |
| Windows 无 host | 正常 | 降级 legacy | 启动错误 |
| 两变体 host 缺失 | 正常 | 降级 legacy + 告警 | 启动错误 |

证据与设计依据：`h2-data-plane.md:642-670`（降级矩阵/缺口）、`ipc-v0.md:779-790`（drain）、`RUST_FULL_MIGRATION_PLAN.md:298-302`（回退纪律）。

## 6. 建议与待拍板

### 6.1 建议

- **S1**：先接线“关闭/重启”再谈 `rust` 模式；否则 host 无法证明“提交过的事实不丢”（R-SD-8）。
- **S2**：`RT-SD-001`/`RT-RS-003` 这类 current-state 探针应保留在 CI 的“已知缺口”清单，不要因为测试绿就误判契约完成。
- **S3**：两变体验收用 npm 而不是 Bun；这是用户安装路径，Bun 全局安装会掩盖 postinstall/平台包问题（`packages/chimera/AGENTS.md` 的安装验证规则）。
- **S4**：Windows 的 CLI 安装验收与 host 能力验收分开；前者已存在，后者未实现，不得合并宣称。

### 6.2 待拍板

- **D3**：Windows host transport（named pipe）与兜底策略；当前只能 legacy。
- **D5**：首个 host 能力发布版本是否同时把 host 二进制放进平台包；若放，postinstall 探测和两变体资产需同批验收。
- **host 二进制分发形态**：平台包 `bin/host/` vs 独立 `@coding-chimera/chimera-host-<platform>` 包；H2 建议前者，但需发布 owner 确认。