# Chimera-rs 迁移 Handoff

> 更新日期：2026-11-16
>
> 本文是当前接手基线。完整设计与验收标准见 [docs/rfcs/CHIMERA_RS_MIGRATION_PLAN.md](docs/rfcs/CHIMERA_RS_MIGRATION_PLAN.md)。计划文档描述目标；本文只记录已经合入和实际验证的状态，二者不能互相替代。

## 1. 当前仓库基线

| 项 | 当前状态 |
| --- | --- |
| 仓库 | `/Volumes/workspace/chimera-rs` |
| 分支 | `main` |
| HEAD | `71123ce fix: honor explicit telemetry enablement and short CLI persistence` |
| 工作区 | 干净 |
| 合并状态 | `git branch --no-merged main` 为空；15 个功能/历史分支均已合入 |
| 临时 worktree | 已删除；`chimera-rs-*` 临时目录已清理 |
| 分支 | 保留，未删除 |
| 远端 | `origin=https://github.com/codewhale-hq/Codewhale.git`；尚未配置独立 fork upstream/origin |
| 本地提交 | `main` 领先 `origin/main` 56 个提交，**未推送** |
| 编译缓存 | `/Volumes/workspace/chimera-rs-target` 已删除；下次构建需要重新编译 |

当前没有运行中的后台构建或测试任务。

## 2. 已完成并合入的能力

### 2.1 集成与基础修复

- 所有 worktree 提交和未提交变更已归并到主仓；重复模块、字段、静态项及冲突已清理。
- `cargo check --workspace` 通过。
- 配置 importer 支持严格 schema、JSONC、对象递归合并、数组最终值替换、权限只能收紧、secret redaction 和 CAS/reload 回归。
- 修复 `--telemetry true` 无法从默认 off 开启的问题；保留 env 显式 off、非法值、floor 和文件持久 off 的优先级。
- 短 CLI 的 dry-run、pending、kill-switch 与 help 路径已验证。

### 2.2 多项目与持久 Runtime

- 请求级 project scope、workspace 文件路由、scope lease/pin/idle recycle、home scope 保留。
- read denylist 按 Engine/ToolContext 隔离，两个相反 denylist 的 Engine 不互相覆盖。
- durable turn admission、lease、幂等、恢复、原子 terminal commit 和 SIGKILL 恢复测试已入仓。
- `RuntimeWorkspaceScopes` 与 project-scope 测试已修正并通过，但完整多项目全局态审计尚未完成。

### 2.3 Swarm 与 evidence

- 已有 `agent` 批量扇出、参数校验、并发上限、preset、七类 evidence source、outbox 和基础完成通知实现。
- evidence store 已覆盖 obligations/oracles、版本化状态、project 隔离和 restart/replay。
- **Fleet 尚未退役**：`crates/engine/src/fleet/` 仍完整存在；durable swarm ledger/profile、Fleet importer、Workflow/Lane/API/TUI 控制面收口未完成。

### 2.4 工具渐进式披露

- reveal 采用追加式 session 记录；搜索时不改变 pinned tool array。
- revealed tool 可按名执行，compaction 边界再提升并记录 `change:tool_surface`。
- 权限、session 隔离、restore/replay、off-array 有界性和 prefix hash 测试已通过。

### 2.5 Provider

- Alibailian relay 与官方 Model Studio 分离，包含 structured output、强制工具 backstop、hosted search、fallback、header 和 reasoning sampling 合同。
- ChatGPT subscription 增加独立 Responses profile、endpoint fence、headers、turn-state/offline state machine 和订阅配额语义。
- endpoint credential fence 仅接受精确的 `/backend-api/codex`，邻近路径不会继承订阅身份。
- **真实 OAuth、真实 provider、WS、remote compaction、native tool_search replay 和 429 收据仍未完成。**

### 2.6 CodeGraph 与 predesign

- CodeGraph Rust core 首批 extraction、wire、store/resolver 基础已入仓；未知语言 fail-closed 已有回归。
- 尚未完成统一 mutation tracker、图增量传播、watcher、推送上下文、等价 bench 和旧图工具退役。
- predesign 目前主要只有提示词语义；edit-intent claims、FCFS waiter、唤醒、replay、family 豁免和故障关闭尚未形成完整实现。

### 2.7 Browser

- Rust browser crate、CDP driver、fake driver、project/session manager 和工具接线已入仓。
- 已有基础 fake/manager 与 Engine browser 测试。
- **真实 Chromium smoke、完整 SSRF/redirect、artifact auth/TTL、资源清理、配额和多项目生命周期验收未完成。**

### 2.8 配置、提示词与品牌

- 静态 provider profile 已接入单一 `BASE_PROMPT`，没有第二 base prompt；相关 prompt 测试通过。
- `chimera` 二进制路径已存在。
- `chimera.toml`、`.chimera`、`CHIMERA_HOME`、最终 crate 改名、独立发布源与新 org/origin 尚未收口。

## 3. 已实际运行的验证

| 命令/范围 | 结果 |
| --- | --- |
| `cargo fmt --all -- --check` | 通过 |
| `cargo check --workspace` | 通过 |
| `cargo test -p codewhale-config` | **869 passed; 0 failed; 1 ignored** |
| `cargo test -p codewhale-config --test configured_models` | **9 passed; 0 failed** |
| config doc-test | **1 passed; 0 failed** |
| `cargo test -p codewhale-engine alibailian` | **27 passed; 0 failed** |
| `cargo test -p codewhale-engine tool_catalog` | **39 passed; 0 failed; 1 ignored** |
| `cargo test -p codewhale-engine prompts` | **136 passed; 0 failed** |
| `cargo test -p codewhale-engine read_guard` | **2 passed; 0 failed** |
| `cargo test -p codewhale-engine subscription` | **21 passed; 0 failed** |
| `cargo test -p codewhale-engine swarm` | **36 passed; 0 failed** |
| `cargo test -p codewhale-app-server project_scope` | **9 passed; 0 failed** |
| `cargo test -p codewhale-state --test turn_store` | **24 passed; 0 failed** |
| `cargo test -p codewhale-evidence` | **26 passed; 0 failed** |
| `cargo test -p codewhale-browser` | **6 passed; 0 failed** |
| `cargo test -p codewhale-cli --test telemetry_kill_switch_dispatch` | **6 passed; 0 failed** |
| `cargo test -p codewhale-cli --test help_dispatch` | **1 passed; 0 failed** |

### 尚未取得的证据

- CI 结果与完整受影响测试套件结果；上述不是 full workspace test。
- 真实 `chimera` 多项目端到端产品验收。
- 真实 Chromium open/snapshot/click/type/screenshot/evaluate/close 及截图证据。
- 真实 provider 登录、请求、WS、429/Retry-After 收据。
- 容量基线、30 分钟开发门、24h/72h soak。
- 新 org 的 CI、签名、release 和 update 验证。

## 4. 剩余工作包与建议顺序

### P0：集成与 CI 收尾

1. 审查当前 56 个本地提交，决定推送/PR 策略；未经授权不发布、不改写历史。
2. 跑受影响完整套件和 CI，记录真实结果，修复回归后再更新完成状态。
3. 配置独立 fork remote；保留上游只读同步边界。

### P1：PROJ 多项目全局态收尾

1. 审计 retry 展示、终端宿主、prompt override、first notice 和 cwd 回退。
2. 完成配置 generation、全 loaded-thread reload preflight、项目级配置隔离和跨进程失效。
3. 补齐不同 model/config/graph/browser 状态下的多项目并发与回收测试。
4. 验收前不宣称高并发能力已经成立。

### P2：SWARM-2 / Fleet 单向退役

1. 完成 durable swarm ledger/profile、恰好一次完成 outbox、restart/resume、取消和部分失败。
2. 收口 Workflow/Lane、HTTP/TUI、429 governor、本地/远程 placement 和 receipts。
3. 编写 Fleet ledger/profile importer，校验计数、哈希和重放。
4. 删除旧 Fleet 写路径、控制面和不再使用的代码，不保留长期双轨。

### P3：CodeGraph / mutation / 推送上下文

1. 补齐 store/resolver、增量 sync、依赖级联、watcher、只读池和生命周期。
2. 在统一 mutation 管线接入 before/after revision、失败可恢复、去重和持久事件。
3. 用 ToolResult/`<context_update>` 推送有界图证据，保持 session 可重建。
4. 通过等价 bench 后再删除拉取式图工具；未过门不得宣布退役。

### P4：Predesign / Coordination

1. 在现有 `CoordinationLedger`/write claims 内实现 edit-intent，不建第二锁库。
2. 完成 FCFS waiter、queue position、wake-priority、TTL、session remove 和 host death。
3. replay 必须重读并校验；family 豁免只限 edit-intent，不能绕过原 WriteScopeClaim。
4. claims 启用且已有协调状态时，存储故障按可恢复的 fail-closed 处理。

### P5：Browser / Provider 真实表面

1. 运行真实 Chromium smoke，保留截图和日志；补齐 artifact auth/TTL、redirect 和资源清理。
2. 完成多项目、多 session context/cookie/tab/approval 隔离。
3. 分别验收 OpenAI API 与 ChatGPT subscription，完成 OAuth、WS、native replay 和 remote compaction。
4. 验收 Alibailian relay、Model Studio hosted search、真实 429 和 fallback；mock 不替代真实收据。

### P6：配置、品牌与发布

1. 落地 `chimera.toml`、`.chimera`、`CHIMERA_HOME` 和显式 importer；运行时不保留长期双写/shim。
2. 独立机械改名 crate/文档/发布资产，保留 LICENSE、NOTICE、作者和历史记录。
3. 新 org/origin、签名、checksum、update 源准备好后再启用发布和自更新。
4. 同步 `docs/features.toml`、config example、schema 和文档。

### P7：容量与最终产品验收

1. 跑单项目、多项目、超订阅、图叠加、browser 叠加和故障矩阵。
2. 采集 p50/p95/p99、吞吐、公平性、RSS、FD、SQLite lock、队列与重复/丢失事件。
3. 启动真实 `chimera`，完成多项目会话、swarm、图推送、predesign 和 browser 路径。
4. 完成 30 分钟开发门及 24h/72h soak 后，才可宣称容量与生产验证完成。

## 5. 外部前置条件

- 新 org/repo URL、推送权限和独立 remote 策略。
- 真实 provider 凭证与测试账号；密钥不得写入仓库或日志。
- 系统 Chrome/Chromium；CI 不下载浏览器。
- 长时间 soak 环境、容量数据采集和 CI runner。
- 自有发布签名、release/update 源；未具备时保持关闭。

## 6. 下一位接手者执行规则

1. 先阅读本文件和 [docs/rfcs/CHIMERA_RS_MIGRATION_PLAN.md](docs/rfcs/CHIMERA_RS_MIGRATION_PLAN.md)，不要把计划中的目标当成已完成事实。
2. 从当前 `main` 开始，不需要恢复已删除的 worktree；保留现有分支作为历史证据。
3. 每个切片开工前重新记录 Chimera 源 commit、工作树 diff 和实际文件哈希；源仓库持续变化。
4. 保持单 `Engine::run_turn`、单模型侧 `agent` 入口、单 write-claim 权威和单 base prompt。
5. 不为图、predesign、provider、browser 或配置再建平行框架；优先扩展现有模块。
6. 每个切片运行对应行为/边界/错误/隔离/恢复测试，引用真实 `N passed; M failed`，过滤器必须 `N > 0`。
7. 区分库测试、真实二进制、真实浏览器、真实 provider、CI 和发布状态；缺哪项就明确保留为未完成。
8. 切片完成后更新本文件的状态和证据，再考虑下一个切片；不要重新创建长期 worktree 集合。

## 7. 快速恢复命令

```sh
git status --short --branch
git branch --no-merged main
git log --oneline -10
cargo fmt --all -- --check
cargo check --workspace
```

按变更区域使用 `scripts/dev-test.sh <area|path> [filter]` 选择最快的相关测试；不要用零匹配过滤器冒充通过。
