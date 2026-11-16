# Chimera-rs 迁移 Handoff

> 更新日期：2026-11-16（同日代码核实审计见 §8）
>
> 本文是当前接手基线。完整设计与验收标准见 [docs/rfcs/CHIMERA_RS_MIGRATION_PLAN.md](docs/rfcs/CHIMERA_RS_MIGRATION_PLAN.md)。计划文档描述目标；本文只记录已经合入和实际验证的状态，二者不能互相替代。

## 1. 当前仓库基线

| 项 | 当前状态 |
| --- | --- |
| 仓库 | `/Volumes/workspace/chimera-rs` |
| 分支 | `main` |
| HEAD | `af5c1fb docs: add Chimera-rs migration handoff`（本文档提交；上一实现提交为 `71123ce`） |
| 工作区 | 仅本文档的审计更新未提交；无其他脏文件 |
| 合并状态 | `git branch --no-merged main` 为空；15 个功能/历史分支均已合入 |
| 临时 worktree | 已删除；`chimera-rs-*` 临时目录已清理 |
| 分支 | 保留，未删除 |
| 远端 | `origin=https://github.com/codewhale-hq/Codewhale.git`；尚未配置独立 fork upstream/origin |
| 本地提交 | `main` 领先 `origin/main` 57 个提交（含本文档提交），**未推送** |
| 编译缓存 | `/Volumes/workspace/chimera-rs-target` 已删除；仓内仍有 `target/debug`（约 653M，deps/incremental） |
| 历史 | 仓库仍为 shallow（grafted 于 `f5a3dda`），无 tag；FORK-0 的完整历史恢复未完成 |

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

## 8. 2026-11-16 代码核实审计（7 个只读子代理 + 主线交叉验证）

方法：静态核实（文件/符号/测试函数计数），未运行 cargo build/test；§3 的通过计数只核对了测试存在性与数量，全部精确吻合（39+1 ignored、136、27、21、36、24、26、9、2、6、6、1、9；config 869 与静态 878 unit + 9 integration 量级一致）。

### 8.1 声明过强，需降级（附反证）

1. **§2.2 SIGKILL 恢复测试是假的**：`crates/state/tests/turn_store.rs:781` 从不 kill 子进程；子进程过滤器 `turn_store::…` 在集成测试二进制匹配 0 个测试立即退出；父进程手动 `DELETE FROM turn_boots` 删的是自己注册的 `boot-holder` 行（`:823`）。且 `admit_turn/commit_turn_terminal/sweep_turn_state` 在 state crate 之外零调用方——durable admission 未接入 turn loop/app-server。
2. **§2.4 "搜索不改变 pinned tool array" 只在搜索当 turn 成立**：`tool_catalog.rs:1803` `cache.activate_measured` 把 reveal 写入 activation cache；下一 turn `turn_loop.rs:1615` 把 cache 名字并入请求数组并声明 `change:tool_surface`（`:1654`）。与 `tool_catalog.rs:1793-1796` 的设计注释和 RFC §8.2 "compaction 边界才提升" 不一致；无测试覆盖搜索后下一 turn 的数组。by-name 执行与 compaction 提升代码在，但无真实执行/提升→事件测试；权限/隔离/restore 测试是纯投影断言。
3. **§2.3 evidence store 与 swarm 未打通**：`codewhale-evidence` 零依赖方（`lib.rs:5` 自陈不接线）；swarm `from` 端口读遗留 `.codewhale/chimera/obligations.json`/`oracle-results.jsonl`（`tools/subagent/evidence.rs:54`），与 store 的 `.chimera/evidence.db` 是两套。完成 outbox 已持久化+幂等+delivered 标记，但 `pending_completion_outbox_for_session` 无生产调用方，重启后 drain 不存在——"恰好一次跨重启投递"未闭合。
4. **§2.5 Alibailian websearch fallback 只有合同没有行为**：`tools/web_search.rs:1720` `let _ = route_uses_alibailian_websearch_fallback(...)` 丢弃返回值；`SearchBackendChain` 不编码 relay→DeepSeek→Kimi 顺序。subscription turn-state 状态机纯离线（`client/responses/subscription.rs` `#![allow(dead_code)]`），`x-codex-turn-state` 头从未进入生产请求。
5. **§2.7 browser "工具接线" 只到注册层**：`install_browser_manager`（`tools/browser.rs:667`）全仓零调用；生产 `runtime_threads/manager.rs:14775` `browser_manager: None` → 七个工具一律 "host not attached"。真实 CDP 路径静态可证的缺陷：`type_text` 持 page 锁后再调 `click` 二次加锁自死锁（`cdp_driver.rs:529/536/493`）；`open_tab/navigate` 恒返回空 redirects，redirect guard 形同虚设且属导航后事后检查；事件泵用 frame id==target id 判主 frame，generation/current_url 永不更新；snapshot hook 仅 open 时注入一次，跨文档导航后失效；无 `Target.createBrowserContext`，同项目多 session 共享 cookie；manager session 注册表只按 session_id 键控，跨项目同 id 可命中他人 tab（fake 测试因共享 driver+tab id 碰撞而通过）；审批 scope 实为 `browser:{tool}:{hash(input)}`，无 origin 参与。
6. **§2.1 配置 importer 只是库 API**：`crates/cli` 内 `import_chimera_config` 零命中，无 `chimera` 命令入口；P6.1 的"显式 importer"尚未成为产品面。

### 8.2 HANDOFF 低估的已有实现（后续切片可直接复用）

- **429 governor 已实现并接线**（`tools/subagent/governor.rs` AIMD DynamicGate，engine/app-server/TUI 装配齐全）；P2 缺的只是真实 429 收据。
- **Lane/Fleet 控制面 Cli+Slash 两表面 + ControlReceipt 已完成**（`crates/lane/src/control.rs`，45 测试）；缺 HTTP 表面与 swarm 侧 run receipt。
- **全 loaded-thread reload preflight 已实现且有 API 级拒绝测试**（`runtime_threads/manager.rs:4067-4143`；`runtime_api/tests.rs:15970` 等）。
- **终端宿主、prompt override 已有**（`runtime_api/terminal.rs`、`system_prompt_override` + 存活测试）；P1.1 剩 retry 展示（`will_retry` 无发射者）、first notice 键控、cwd 回退。
- **真实 OAuth 已完整实现**（PKCE/device code/回调/刷新，`runtime/src/oauth.rs`），缺的只是真机验收，不是代码。
- **`.chimera` 目录已部分落地**（evidence store `EVIDENCE_DIR=".chimera"`），但与 `.codewhale` 双目录并存，P6 需统一。
- **`<context_update>` 追加通道已存在**（`core/engine.rs:7661`），当前只喂项目指令漂移，可直接复用为图推送；写工具统一 admission 缝 `validate_claim`（`engine.rs:385-470`）是 MutationTracker/edit-intent gate 的现成接入点。
- **CoordinationLedger 已有** flock 单写者、单调 sequence、write claim 全生命周期、冲突 receipt、replay 严格校验、worktree 豁免、host-death 判定；P4 缺的是 edit-intent/waiter/wake/TTL/family 豁免层，不是锁库。
- codegraph 内核 154 个测试在仓（store/resolver/句柄生命周期/整文件增量批），但零依赖方，engine 完全未接线。

### 8.3 对 §4 顺序的修正建议

- P0 增加 FORK-0 遗留项：仓库仍 shallow，完整历史/tags 未恢复。
- P1 前置：把 turn store 接入 turn loop/app-server（当前零调用方），并重写 SIGKILL 测试为真 kill+真子进程持锁；`idle_scopes_recycle_with_jitter_pin` 测试空转需补真实回收断言。
- P2 拆出高优先小切片：evidence store ↔ swarm `from` 接线（含 legacy JSON importer 已有）、outbox 恢复 drain 接入 engine 恢复路径；429 governor 与 Cli/Slash 控制面从清单划掉。
- P3/P4 复用 §8.2 所列现成接入点，不新建框架。
- P5 browser 在"真实 smoke"之前先补生产 host 安装点与 CDP 缺陷修复（死锁/redirect/hook/context 隔离），否则 smoke 必然失败；披露语义（§8.1.2）需先裁决"下一 turn 提升"是有意的 Codewhale 行为还是回归，再更新注释/测试或代码。

