# WP-08 · genai 准入规格（GP-0 / GP-1）

> 依据：`RUST_FULL_MIGRATION_PLAN.md:414-420`（§15.4 GP-0..GP-4）、`:385-392`（§15 建议与职责）、`:432-454`（§15.6 Codex crates）、`:262`（WP-08 DoD）。
> 本文件只定义 **验收判定**；GP-0/GP-1 的编译/运行在隔离环境执行，不在本受管端点进行（`packages/chimera/specs/rust-host/a0-scope-decisions.md:51`）。本包不实现生产 transport。

## 1. 范围与前置

- **候选**：genai `=0.7.2`（固定版本，不写 `^`/`~`）；替代候选为 codex-rs `codex-api`（仅 Codex 特殊通路，§15.6）。
- **输入**：本包的 `profile-admission.md`、`ordering-contract.md`、六项 fixture 与 validator。
- **执行者**：GP-0/GP-1 的独立评估包；WP-08 只提供规格，不执行、不回填结果（`RUST_FULL_MIGRATION_PLAN.md:416`）。
- **硬门**：GP-0/GP-1 可在 W0 oracle 四层之后、T1 之前执行；不依赖 T1（`RUST_FULL_MIGRATION_PLAN.md:464-467`）。生产 host 不得绕过 W0 门。

## 2. GP-0：profile 与 oracle

**目标**：固化版本、实际路由/model/auth/options、受支持与兼容清单，并用本包 fixture 做第一轮对账（`RUST_FULL_MIGRATION_PLAN.md:416`）。

| ID | 验收判据 | 证据要求 | 通过条件 | 失败动作 |
|---|---|---|---|---|
| G0-1 | genai 版本固定 `=0.7.2` | 评估 crate 的 `Cargo.toml`、lockfile、依赖树 | 精确版本；lockfile 可复现；无浮动范围 | 停止；不得用其他版本冒充 |
| G0-2 | 六项 profile 的 **实际** route/model/auth/options 已回填 | 每 profile 一行：endpoint 类别、wire model、auth 类型、关键 options、是否启用 | 六行齐全；与 `profile-admission.md` 判定一致 | 缺行即不通过 |
| G0-3 | 六项 fixture 在 adapter 的同一 client 边界后重放 | 每项 fixture 的请求规范化 diff、事件账本 diff、digest | 零 diff；或每处差异有 `approved_delta`（原因/期望/影响/测试） | 有未登记差异即不通过 |
| G0-4 | 受支持/兼容/未覆盖清单与理由 | 引用本包 profile 表 + 实际证据；不得按 provider 名字批量推断 | 每项有判定与理由；未覆盖项有兼容分支 | 缺理由即不通过 |
| G0-5 | OAuth 路径的账号头、刷新去重、持久化、401 行为已验证 | 刷新并发测试、401 重试测试、凭据回写证据 | 同一 credential 只刷新一次；401 最多刷新一次 + 重试一次；不重放工具 | 任一项失败 → P3 降级兼容 |
| G0-6 | 无真实端点/凭据进入产物 | 扫描 fixture、cassette、日志、错误体 | 只出现 `synthetic://`、`<REDACTED:...>`、`acct-placeholder` | 出现即不通过并清理 |
| G0-7 | Codex 直连依赖形态已固定（若选 codex-api） | vendoring/git pin、依赖闭包、LICENSE/NOTICE、上游 HEAD | 只复用 wire 层；不引入 codex-core；许可文件随分发 | 未固定 → P4/P5/P6 保持兼容边 |
| G0-8 | 结果记录可复验 | 命令、版本、lock hash、fixture digest、逐项 pass/fail、执行环境 | 第三方可按记录复跑 | 记录不完整即不通过 |

**GP-0 出口**：G0-1..G0-8 全部通过或显式登记 `approved_delta`，才能进入 GP-1。GP-0 不通过时，P1/P2 可保留 TS 对照；P3/P4/P5/P6 直接标记兼容/未覆盖，不阻塞其他 profile 的 W3 闭环（`RUST_FULL_MIGRATION_PLAN.md:454`）。

## 3. GP-1：隔离 SDK adapter / harness

**目标**：在独立目录证明单请求 → 流式工具调用 → 测试 caller 执行工具 → 结果回放 → 下一轮响应；SDK 不自行循环（`RUST_FULL_MIGRATION_PLAN.md:417`）。

| ID | 验收判据 | 证据要求 | 通过条件 | 失败动作 |
|---|---|---|---|---|
| G1-1 | 隔离目录，不接 T1/生产 host | 目录布局、依赖图、启动命令 | 无生产 `src/` 依赖；无 T1 服务；无真实 provider 调用（CI 用 cassette） | 不通过；不得把 harness 混入生产 host |
| G1-2 | 单回合调用 | 一次 `exec_chat`/`exec_chat_stream` 只产生一个 provider 回合 | 请求体、事件账本与 fixture 一致 | 不通过 |
| G1-3 | 流式工具调用 + caller 执行 | 测试 caller 执行工具、结果回放、下一轮请求 | 工具只执行一次；结果以稳定 `call_id` 回放；下一轮请求合法 | 不通过 |
| G1-4 | SDK 不自行循环 | 代码/调用轨迹 | SDK 不自动执行工具、不自动续轮；loop 在测试 caller/host | 不通过 |
| G1-5 | 正常终态与 call_id 对齐 | 事件账本、终态、call_id 表 | 恰好一个 `finish`；每个 call 有匹配结果；无重复终态 | 不通过 |
| G1-6 | capture 模式声明 | `delta`/`cumulative` 两种 chunk 切法 | 两种切法归一化后事件账本一致 | 不通过 |
| G1-7 | 错误/取消/超时 | EOF、cancel、timeout 注入 | 不补成功；保留片段；不执行半截 tool-call | 不通过 |
| G1-8 | hosted/provider-executed | hosted tool 事件 | `providerExecuted: true`；宿主不重复执行；结果同流 | 不通过 |
| G1-9 | 复用既有 oracle | `packages/llm/test/recorded-golden.ts:58-93`、`recorded-scenarios.ts:91-121,206-213,275-284` | wire shape 匹配则直接复用；不匹配则重录/翻译并登记 `approved_delta` | 未登记差异即不通过 |
| G1-10 | 结果记录可复验 | fixture digest、diff、命令、产物路径 | 第三方可按记录复跑 | 记录不完整即不通过 |

**GP-1 出口**：G1-1..G1-10 通过后，P1 可作为 W3 首条闭环候选；P2 作为第二个独立对账项；P3/P4/P5/P6 仍需 GP-2/GP-4 对应项。

## 4. GP-2 / GP-3 / GP-4 边界

| 包 | 本包提供 | 不在本包执行 |
|---|---|---|
| GP-2 协议与故障对账 | `ordering-contract.md` 的事件序/工具闭环/终态/framing 规则；六项 fixture | 多工具同帧、碎片/累计参数、reasoning/text 混合、usage 尾帧、invalid JSON、EOF/取消/超时/429、结构化/媒体输出；Responses 与 signed/encrypted replay 的独立验收 |
| GP-3 并发与资源 | 资源/并发判据的边界（1/26/50/100、chunk 大小、慢消费者） | 独立 provider bench、TS vs Rust 延迟/CPU/RSS/fd/队列比较、阈值签定 |
| GP-4 特殊通路与生产准入 | Codex 直连评估点（§5）；兼容分支判据 | WS/native tool_search/remote compaction/OAuth 矩阵的生产验收；reqwest/TLS/proxy/crypto/MSRV/平台构建；生产注入 |

GP-2/GP-3 的失败不自动否定 GP-1；但 GP-4 的生产准入必须同时满足 GP-2/GP-3 的对应项（`RUST_FULL_MIGRATION_PLAN.md:418-420`）。

## 5. Codex 直连通路评估点（§15.6）

> 结论方向：**建议**直接复用 codex-rs wire crates（`codex-api`），不逐行翻译 `codex-responses.ts` + `plugin/codex.ts`；依赖 vendoring/git pin、Apache-2.0 LICENSE+NOTICE、上游同步策略。D8 待拍板（`RUST_FULL_MIGRATION_PLAN.md:359,432-454`）。

| ID | 评估点 | 通过条件 | 失败动作 |
|---|---|---|---|
| C-1 | 复用边界 | 只复用 `ResponsesClient`（HTTP）、`ResponsesWebsocketClient`（WS）、`AuthProvider`；不引入 `codex-core` 的 session/world-state/hooks | 越界即不通过 |
| C-2 | 请求模型 | `ResponsesApiRequest` 缺 `instructions/temperature/top_p/max_output_tokens` 且 `parallel_tool_calls` 必填；有 fork/扩展或 HTTP raw body、WS 自定义请求方案 | 无法表达 Chimera 请求 → 保留兼容边 |
| C-3 | 事件映射 | `ResponseEvent`/`ResponseItem` ↔ `LLMEvent` 显式 adapter；encrypted reasoning、tool_search、compaction wire 都能映射 | 映射缺口未登记 → 不通过 |
| C-4 | 认证 | Chimera 实现 `AuthProvider`；刷新/去重/持久化仍归 Chimera；WS 的同步 `add_auth_headers` 有前置刷新方案或上游补丁 | 未解决 → P4 保留 TS 兼容 |
| C-5 | 依赖形态 | `codex-api` 是 workspace 内部 crate（`0.0.0`、path-only deps、未发布）；vendoring/git pin；锁定 `codex-client`/`codex-protocol`/`codex-tools` 闭包；建立上游同步策略 | 未固定 → 不进入生产 |
| C-6 | 许可 | Apache-2.0；分发保留 `LICENSE` 与 `NOTICE`（含 Ratatui MIT 声明） | 缺失 → 不进入生产 |
| C-7 | cassette | 现有 recorded-golden 绑定 Chimera LLM client 的 wire shape；Rust 通路位于同一 client 边界之后，或重录/翻译 cassette | 不能复用断言 → GP-2 重录 |
| C-8 | 安全 | codex checkout 只读；不打印 codex 后端地址；不读取/输出 auth 配置 | 违反即停止 |
| C-9 | 平台 | reqwest/TLS/system-proxy/crypto features、MSRV、原平台构建矩阵实际验证 | 未验证 → 不进入生产 |

**GP-4 出口**：C-1..C-9 与 GP-2/GP-3 对应项通过后，Codex 通路才可生产准入；未通过项保留 TS provider-only 兼容执行体，不阻塞其他 provider 的 W3 闭环（`RUST_FULL_MIGRATION_PLAN.md:454`）。

## 6. 准入决策与回退

| 状态 | 条件 | 动作 |
|---|---|---|
| `accepted` | GP-0 + GP-1 全过；无未登记差异 | 进入 GP-2/GP-3；P1 可作为 W3 候选 |
| `accepted-with-delta` | 有显式 `approved_delta` | 记录原因/期望/影响/测试；进入 GP-2 |
| `compat` | GP-0 识别缺口，GP-1 用兼容分支补齐 | 标记兼容边；不进入生产 host；继续 oracle |
| `uncovered` | genai 无原生契约 | 保留专用 transport / TS provider-only；GP-4 再评估 |
| `rejected` | 版本/许可/安全/复现性失败 | 停止该 profile；不影响其他 profile |

**回退纪律**：provider 是只读/无状态能力时可用 kill switch 回 TS；涉及凭据/持久化时先 drain/确认 checkpoint，再受控回退。不能把写回退称作单纯 toggle（`RUST_FULL_MIGRATION_PLAN.md:298`）。

## 7. 证据与产物要求

GP-0/GP-1 的结果记录必须包含：

1. **版本**：genai `=0.7.2` / codex-api git pin；lockfile hash；依赖树。
2. **路由**：每 profile 的实际 endpoint 类别、wire model、auth 类型、关键 options；不写真实地址/凭据。
3. **fixture**：本包六项 fixture 的 digest；请求规范化 diff；事件账本 diff。
4. **判定**：逐项 G0-*/G1-*/C-* 的 pass/fail/waived；失败原因与后续动作。
5. **环境**：OS/arch、TLS/proxy 配置类别、是否使用 cassette；不写内部域名/IP。
6. **复跑命令**：从评估目录可独立执行；不依赖 T1/生产 host。
7. **许可**：若引入 codex-api，附 LICENSE/NOTICE 与上游 HEAD。

产物不得包含：真实后端 URL、内网域名、IP、凭据、用户 home 绝对路径、内部部署型号后缀。模型只写公开通用名；Codex 相关一律写“codex 后端”占位。

## 8. 建议与待拍板

### 8.1 建议（未拍板）

- 固定 genai `=0.7.2`；adapter 关闭 genai 内部重试；retry/replaySafe 由 Chimera 外层拥有。
- 首个 GP-1 只做 P1 Chat/API-key；P2 独立对账；P3 用 genai + Chimera auth adapter；P4/P5/P6 先按兼容/未覆盖设计。
- GP-1 的 cassette 优先复用 `packages/llm/test/recorded-golden.ts:58-93` 与 `recorded-scenarios.ts:91-121,206-213,275-284`；wire shape 不匹配时重录，不把旧断言硬套到 Rust 通路。
- Codex 直连先做 C-1..C-4 的隔离验证，再做 C-5..C-9 的分发/平台验证；不先接生产 host。

### 8.2 待拍板

- D1：首个 profile 与 genai PoC 准入顺序（`RUST_FULL_MIGRATION_PLAN.md:352`）。
- D8：codex-api 的 vendoring/git pin、许可、上游同步策略（`RUST_FULL_MIGRATION_PLAN.md:359,447-448`）。
- provider 长尾：是否接受“主力 Rust + 长尾 Bun 兼容边”（`RUST_FULL_MIGRATION_PLAN.md:349`）。
- P2 是否在 GP-1 通过后直接进入 W3，还是保留 TS 对照一个发布周期。
- P4/P5/P6 未过 GP-4 时的兼容执行体归属（与 §13 D2 的 sidecar 拓扑一起定）。

## 9. 证据索引

| 证据 | 位置 |
|---|---|
| §15.1 职责 | `RUST_FULL_MIGRATION_PLAN.md:389-392` |
| §15.4 GP-0..GP-4 | `RUST_FULL_MIGRATION_PLAN.md:414-420` |
| §15.6 Codex crates | `RUST_FULL_MIGRATION_PLAN.md:432-454` |
| §16 首批顺序 | `RUST_FULL_MIGRATION_PLAN.md:458-469` |
| 既有 recorded-golden | `packages/llm/test/recorded-golden.ts:58-93` |
| 既有 recorded-scenarios | `packages/llm/test/recorded-scenarios.ts:91-121,206-213,275-284` |
| 本包 profile 表 | `packages/chimera/specs/rust-host/provider/profile-admission.md` |
| 本包保序契约 | `packages/chimera/specs/rust-host/provider/ordering-contract.md` |
| 本包 fixture/validator | `packages/chimera/test/oracle/provider/` |