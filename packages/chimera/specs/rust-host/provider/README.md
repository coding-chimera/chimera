# WP-08 · Provider profile 协议/请求/流/auth fixture 与 genai 准入规格

> 状态：**building 交付物**（WP-08，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:262`（WP-08 DoD）、`:385-454`（§15 genai 与 Codex 调研）、`packages/chimera/specs/rust-host/manifest.yaml:215-236`（WP-08 manifest 条目）、`packages/chimera/specs/rust-host/partition-table.md:35`（`S/provider/**`、`T/provider/**` 独占分区）、`packages/chimera/specs/rust-host/a0-scope-decisions.md:41,51,65`（范围、非目标、GP-0/GP-1 门）。
> 本目录只做 **契约、profile 准入表、对账保序规则、合成 fixture 与判定 harness**；不实现生产 transport、不编译 genai/Codex crates、不调用真实 provider、不写生产迁移代码（`a0-scope-decisions.md:50-54`）。

## 1. 结论先行

- **六项 profile 全部有判定**：Chat/API-key、Responses/API-key 判为 **genai 可接管**；Responses/OAuth 判为 **需兼容**；WS、native tool_search、remote compaction 判为 **未覆盖**（genai 0.7.2 无完整原生契约），保留专用 transport 或兼容分支。
- **首批建议只选 Chat/API-key 闭环**：与 §13 D1、§16 第 3 步一致；Responses/API-key 独立对账，OAuth/WS/tool_search/compaction 分开验收，不按 provider 名字推断全部能力（`RUST_FULL_MIGRATION_PLAN.md:352`）。
- **Codex 特殊通路不按“genai 已覆盖”处理**：HTTP/WS/auth 优先评估 codex-rs `codex-api` wire crates；compaction 与 native tool_search 的循环仍归 Chimera（`RUST_FULL_MIGRATION_PLAN.md:432-454`）。
- **重试、token 刷新、auth 生命周期全部归 Chimera**；genai 只提供单回合传输与错误分类，不拥有 agent loop、工具执行、OAuth 登录/刷新、retry/replaySafe 策略（`RUST_FULL_MIGRATION_PLAN.md:389-392`）。
- **对账保序规则已冻结为可执行判定**：六项 profile 各 ≥1 组合成请求/流式事件 fixture，validator 校验流序号、事件序、工具调用闭环、终态与敏感信息；`bun run test/oracle/provider/run.ts` 当前 6/6 profile、0 issue。

## 2. 交付物

| 文件 | 内容 | 对应 DoD |
|---|---|---|
| `README.md` | 范围、结论、DoD 映射、运行方式 | 全包入口 |
| `profile-admission.md` | 六项 profile 表、hosted tools、重试与刷新归属、auth 矩阵 | DoD 1、2 |
| `ordering-contract.md` | 流式事件序、工具调用闭环、SSE/WS framing、对账算法 | DoD 2 |
| `genai-admission.md` | GP-0/GP-1 验收判定、GP-2..GP-4 边界、Codex 直连评估点 | DoD 4 |
| `../test/oracle/provider/` | 六项 profile 合成 fixture、validator、负例测试 | DoD 3 |

## 3. 六项 profile 摘要

| # | profile | 传输 / auth | genai 判定 | 首个动作 |
|---|---|---|---|---|
| P1 | Chat/API-key | Chat Completions SSE / API key | 可接管 | **首个闭环候选**；GP-1 先做 |
| P2 | Responses/API-key | Responses SSE / API key | 可接管（独立对账） | GP-1 第二个；验证 reasoning 加密回放与 `response_id` |
| P3 | Responses/OAuth | Responses SSE / OAuth bearer + account header | 需兼容 | 先验证 token 刷新/账号头/加密历史；未过则保留兼容边 |
| P4 | WS | Responses WebSocket JSON / OAuth | 未覆盖（genai）；codex-api 有 WS client | 按 §15.6 评估 codex-api；未过则 TS provider-only 兼容 |
| P5 | native tool_search | Responses provider-defined `tool_search`（client execution） | 未覆盖（genai）；wire 格式可复用 | Chimera 自有 client-execution 循环；codex-api 只复用 wire |
| P6 | compaction | Responses compaction v2 SSE + legacy JSON | 未覆盖（genai）；codex-api 不含 compaction | Chimera 自有 eligibility/protocol/fallback；只复用 wire 格式 |

判定词汇与逐项证据见 `profile-admission.md` §2-§3。

## 4. 与 §15.4 的对应

| §15.4 包 | 本包提供 | 本包不执行 |
|---|---|---|
| GP-0 profile 与 oracle | 六项 profile 准入表、fixture、判定命令 | 固化实际路由/model/auth/options；执行并回填结果 |
| GP-1 隔离 SDK adapter/harness | 单请求→流式工具调用→caller 执行→结果回放→下一轮的验收判据 | 编译/运行 genai PoC；接 T1 或生产 host |
| GP-2 协议与故障对账 | 事件序、工具闭环、终态、SSE/WS framing 的对账规则 | 多工具同帧、碎片/累计参数、429/取消/超时的完整故障矩阵 |
| GP-3 并发与资源 | 资源/并发判据的边界说明 | 1/26/50/100 并发压测与阈值 |
| GP-4 特殊通路与生产准入 | Codex 直连评估点、兼容分支判据 | vendoring/git pin、生产注入、平台 CI 分区 |

## 5. 运行方式

以下命令均从 `packages/chimera` 执行：

```bash
# 1) 六项 profile fixture + 事件序 + 工具闭环 + 敏感信息校验
bun run test/oracle/provider/run.ts

# 2) bun test 入口（含 7 组故意破坏的负例）
bun test --timeout 30000 test/oracle/provider/provider.test.ts

# 3) 包级类型检查（统一门禁，不属于本包 focused oracle）
bun typecheck
```

当前实测结果见本文件 §9；fixture 格式与判定规则见 `packages/chimera/test/oracle/provider/README.md`。

## 6. DoD 逐项映射

| DoD | 落点 | 自评 |
|---|---|---|
| 1. profile 表至少列六项，每项标 genai 可接管/需兼容/未覆盖，引用 file:line | `profile-admission.md` §2-§3；`RUST_FULL_MIGRATION_PLAN.md:396-403`；`packages/llm/src/protocols/*`、`packages/llm/src/route/*` | 满足 |
| 2. 含 hosted tools、重试与 token 刷新归属；对账保序规则 | `profile-admission.md` §4-§6；`ordering-contract.md` §2-§5 | 满足 |
| 3. 六项 profile 各 ≥1 组请求/流式事件 fixture（合成、无真实端点/凭据、Codex 写“codex 后端”） | `packages/chimera/test/oracle/provider/fixtures/` 六个 JSON；validator 全过 | 满足 |
| 4. GP-0/GP-1 验收判定（与 §15.4 对齐），含 Codex 直连通路评估点（§15.6） | `genai-admission.md` §2-§5 | 满足 |

## 7. 边界与已知限制

- **不实现生产 transport**：本包不新增 `src/` 代码，不导入生产 provider SDK，不编译 Rust，不调用真实 provider（`a0-scope-decisions.md:51,54`）。
- **fixture 是协议级合成数据**：不是真实 cassette，不证明真实网络 chunk 边界、真实账号/模型行为或真实 provider 错误体；这些由 GP-0/GP-2 在隔离环境执行。
- **六项 profile 的 genai 判定是静态研究结论**：依据 §15 的 0.7.2 发布源码复核，未编译、未实测；正式采用以 GP-0/GP-1 结果为准（`RUST_FULL_MIGRATION_PLAN.md:422`）。
- **Codex 相关一律写“codex 后端”占位**：不写真实后端地址、账号、模型部署后缀；auth fixture 只使用 `<REDACTED:...>` 与 `acct-placeholder`。
- **跨实现 parity 不在本包**：本包只冻结 TS 侧协议/事件形状与判定；Rust adapter 的 parity 由 GP-1/GP-2 证明。

## 8. 建议与待拍板（分开标注）

### 8.1 建议（未拍板）

- 建议把 **P1 Chat/API-key** 作为 W3 首条闭环的唯一 provider 候选；P2 作为第二个独立对账项，不与 P1 混在同一验收里（与 §13 D1 一致）。
- 建议 genai 固定 `=0.7.2`，adapter 显式关闭 genai 内部重试；所有 retry/replaySafe 由 Chimera 外层拥有（`RUST_FULL_MIGRATION_PLAN.md:389-392`）。
- 建议 P3/P4/P5/P6 先按兼容分支设计：P3 用 genai + Chimera auth adapter；P4/P5/P6 用专用 transport 或 codex-api，不把“API-key Responses 通过”当作 OAuth/WS/tool_search/compaction 通过。
- 建议把本包的 `ordering-contract.md` 作为 GP-2 的最小对账基线，后续故障矩阵只扩展、不另起一套事件序。

### 8.2 待拍板

- **D1 首个 provider profile**：是否接受“Chat/API-key 先闭环，Responses/OAuth/WS 分开验收”（`RUST_FULL_MIGRATION_PLAN.md:352`）。
- **D8 Codex 特殊通路**：是否接受直接复用 codex-rs wire crates（vendoring/git pin、Apache-2.0 LICENSE+NOTICE、上游同步策略）（`RUST_FULL_MIGRATION_PLAN.md:359,432-454`）。
- **provider 长尾取舍**：是否接受“主力 Rust + 长尾 Bun 兼容边”的长期混血（`RUST_FULL_MIGRATION_PLAN.md:349`）。
- **P2 的 genai 采用**：Responses/API-key 是否在 GP-1 通过后直接进入 W3，还是与 P1 一样先保留 TS 对照一个发布周期。
- **WS/native tool_search/compaction 的 W3 归属**：未过 GP-4 时是否保留 TS provider-only 兼容执行体，以及该执行体是否与 plugin sidecar 同进程（§13 D2）。

## 9. 自验记录（本批实测）

| 命令 | 结果 |
|---|---|
| `cd packages/chimera && bun run test/oracle/provider/run.ts` | PASS（6 fixtures，6/6 profiles，0 issues） |
| `cd packages/chimera && bun test --timeout 30000 test/oracle/provider/provider.test.ts` | 10 pass / 0 fail（23 assertions） |
| `cd packages/chimera && bun typecheck` | 通过（tsgo --noEmit，无输出）；新增 TS 只依赖既有 `test/oracle/transcript/format.ts` 与 Node/Bun 标准库 |

## 10. 证据索引

| 证据 | 位置 |
|---|---|
| WP-08 DoD | `RUST_FULL_MIGRATION_PLAN.md:262` |
| §15 genai 建议与职责 | `RUST_FULL_MIGRATION_PLAN.md:385-392` |
| §15.2 能力分诊 | `RUST_FULL_MIGRATION_PLAN.md:396-403` |
| §15.3 adapter 硬约束 | `RUST_FULL_MIGRATION_PLAN.md:407-410` |
| §15.4 GP-0..GP-4 | `RUST_FULL_MIGRATION_PLAN.md:414-420` |
| §15.5 固定版本证据 | `RUST_FULL_MIGRATION_PLAN.md:426-430` |
| §15.6 Codex crates | `RUST_FULL_MIGRATION_PLAN.md:432-454` |
| WP-08 manifest | `packages/chimera/specs/rust-host/manifest.yaml:215-236` |
| WP-08 分区 | `packages/chimera/specs/rust-host/partition-table.md:35` |
| WP-08 范围/非目标 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:41,51,65` |
| packages/llm Chat 协议 | `packages/llm/src/protocols/openai-chat.ts:26-29,91-108,481-499` |
| packages/llm Responses 协议 | `packages/llm/src/protocols/openai-responses.ts:28-30,152-166,543-604,959-1021` |
| packages/llm auth/retry | `packages/llm/src/route/auth.ts:17-40,112-150`；`packages/llm/src/route/executor.ts:91-97,345-378` |
| packages/llm WS transport | `packages/llm/src/route/transport/websocket.ts:7-33,125-136,209-277` |
| packages/llm 事件词汇 | `packages/llm/src/schema/events.ts:78-208`；`packages/llm/src/schema/ids.ts:39` |
| packages/llm recorded-golden/scenarios | `packages/llm/test/recorded-golden.ts:58-93`；`packages/llm/test/recorded-scenarios.ts:91-121,206-213,275-284` |