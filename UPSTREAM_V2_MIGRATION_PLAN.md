# Upstream v2 底座迁移计划

状态：L0 + L1 + L2 + L3 已完成（L3 落地 2026-09-04，本地未 push；细分计划与验收见下文）——Effect beta.83、schema/protocol 包、插件 v2 host、codemode、grep 权限修复、LayerNode、effect-drizzle-sqlite、SystemContext 引擎/context epochs/提示词 Source 化/v2 事件契约收编均已落地
制定：2026-08-28，基于对上游 opencode（`refs/remotes/upstream/dev` = `755ebdb94`，v1.18.25）与本 fork（fork 点 `98e091796`，2026-05-07，opencode v1.14.40）的 swarm 探测 + 跨仓图精读（上游克隆仓 `/Volumes/workspace/opencode`，图已索引）。制定基线已过期：2026-09-04 上游 HEAD 为 `9f69463f1d`，与 L3 侦察基线一致。

## 背景事实

- 上游领先 3266 commits（约 3.5 个月），本 fork 独有 225 commits（Chimera graph/audit、改名、多模型调度等）。
- 上游已做系统性 Effect 化重构：新增 `packages/core`（322 文件）、`llm`、`schema`、`protocol`、`server`、`client`、`tui`、`session-ui`、`codemode`、`effect-drizzle-sqlite`；`packages/opencode` 变为薄 CLI 壳（但自身也是过渡态，v1 runtime 365 文件未搬空，v1/v2 经 server routes mergeAll + event-v2-bridge 并存）。
- 双方共同改动 246 个文件，不可直接 git merge；核心热区 `packages/opencode/src` → `packages/chimera/src`（56 文件）。
- 上游 Effect `4.0.0-beta.57 → beta.83`；本 fork 当前 catalog 为 `beta.59`。

## 已确认的决策

1. 目标是上游 v2 能力（Effect 化架构栈），不做零散 cherry-pick。
2. Provider 接入点（认证/新 provider）可以搬；各模型能力差异（reasoning variants 等）必须**配置化**，不写死进代码。
3. 迁移方式：**逐层替换（绞杀者模式）**——每层带适配 shim 或开关，替换期间 chimera 全程可用，每层完成后用户可打开验证，单层可回退。禁止大爆炸式切换。
4. ACP 默认不恢复（fork 已删除 `src/acp` 产品面；如日后需要，底座就位后约 +3 天）。

## 关键架构事实（精读结论，证据为上游仓文件：行号）

- **LayerNode 最小子集**：上游 `packages/core/src/effect/` 实为 8 个源文件（外加 `dfdf` 垃圾文件，勿搬）+ `test/effect/` 6 个测试（其中 `layer-node/` 目录内 3 个）；核心 `layer-node.ts`（333 行，含编译期依赖检查）。坑：`packages/core/src/location-services.ts:92-95` 注释（该文件在 effect/ 之外）要求 replacements 必须在 hoist 期应用；上游 `runtime.ts:3,8` 硬编码 Observability（本仓处置：不绑定上游实现——跳过搬运、保留本仓已适配版）。
- **Session V2 上游未完成**：V2 `compact/shell/skill/wait` 为桩，tool 定义解析/retry/状态持久化未勾选（`llm.ts:43-91` 头注释）。V1/V2 接口不同形状，绞杀层需 "V1 Interface → V2 + SessionV1 事件兼容" 适配器。
- **ProviderV2/ModelV2 是数据 schema**（`packages/schema/src/provider.ts:8-61`），不在 llm 包；llm 包只有运行时（`Route`/`Protocol`/`Auth`/`Provider.Definition`）。
- **配置化精确落点**：`core/src/plugin/variant.ts`——上游只硬编码了 glm-5.2，v1 的 `reasoning_options` 数据驱动（`transform.ts:1653-1671`）尚未移植到 v2。我们直接在此实现数据驱动 variants 生成。
- v2 `supported()` 只映射 `@ai-sdk/{openai,anthropic,openai-compatible}`；`api.type:"native"` 无 runner 路由。迁移 DeepSeek 前需核对 models.dev 快照的 npm 字段。
- 上游把 `@opencode-ai/core` 放在 devDependencies 靠 bun hoisting——**勿照抄**，发布 npm 包会缺依赖。

## 总体大纲

| 层 | 内容 | 工期 | 用户可验证的变化 |
|---|---|---|---|
| L0 | grep 权限修复 + 插件 v2 host + codemode 包 | ✅ 完成 | 安全行为；无破坏 |
| L1 | schema/protocol 包 + Effect beta.59→83 | ✅ 完成 | 无感知（typecheck/test 绿） |
| L2 | LayerNode 最小子集 + effect-drizzle-sqlite + 日志 shim | ✅ 完成 | 无感知 |
| L3 | 提示词层改 `SystemContext.Source`；Session V2 按子能力接入（快照/回滚/epochs 先）；V1 主路径不动 | ~2 周 | 快照/回滚等可见能力 |
| L4 | packages/llm + 逐 provider 迁移（DeepSeek 先）+ 模型能力配置化 | ~2 周 | 新 provider、`model_capabilities` 配置生效 |
| L5 | Agent 子代理调度适配新 State 系统 | ~1 周 | task/swarm 在新底座上 |
| L6 | 清扫（可选长期项，v1 路径自然萎缩） | — | — |

### 配置化三层合并设计（L4 落地）

```
models.dev 数据（最低优先级）
  < provider 配置（opencode.json / chimera 配置的 provider.models）
  < 全局 model_capabilities（最高优先级，可覆盖一切）
```

Model schema 扩展字段：`sampling.{temperature,top_p,top_k}`、`reasoning_protocol`、`variants`、`default_variant`、`default_effort`。现有硬编码（`src/provider/transform.ts` 的温度/topP/topK/族检测/variants、`src/provider/models.ts` 的 `inferReasoningProtocol`、`src/provider/codex-model.ts` 的 profiles）提取为内置默认数据表，行为不变、可被配置覆盖。

## L0 细分计划

### L0.1 — grep 外部目录权限修复 ✅ 已完成（2026-08-31）

上游提交 `1a28924ed`：权限评估必须基于原始路径而非解析后路径，否则符号链接可绕过外部目录检查。本 fork 漏洞仍在。

- [x] 前置确认：本仓无 `reference` 模块，按上游意图适配为「对 resolve 之前的 requested 路径做断言」
- [x] 改 `packages/chimera/src/tool/grep.ts`：requested 原始路径先 `fs.stat` + `assertExternalDirectoryEffect`，`AppFileSystem.resolve()` 仅用于后续搜索
- [x] 回归测试：`test/tool/grep.test.ts` 新增「symlink 别名外部目录必须触发 external_directory 权限请求」用例
- [x] 验证：`bun test test/tool/grep.test.ts` 5 pass + `bun typecheck` 绿 + 审计 `audit_e9ebe1540528e194`
- 回退：单 commit revert

另两项 P0 结论：子代理 deny 继承（`b8ca71d30`）本 fork 已有且更严（`src/agent/subagent-permissions.ts`）；防破坏性 edit（`236cfcbbc`）由 hashline 锚点架构根除。均无需操作。

### L0.2 — 插件 v2 effect host 搬入 ✅ 已完成（2026-09-01，schema 落地后回接）

纯新增，与 v1 插件 API 并存（上游同策略）。

- [x] 前置检查（已做，结论：推迟）：本仓 SDK 无 `./v2/types` 导出且无 `*V2Info` 类型 → 按预案等 L1 schema 包落地后再搬
- [ ] 从上游复制 16 文件到 `packages/plugin/src/v2/`（`options.ts` + `effect/` 下 15 个）
- [ ] `packages/plugin/package.json`：加 `./v2/effect`、`./v2/effect/integration`、`./v2/effect/plugin`、`./v2/promise` 四个 exports + `@ai-sdk/provider` 依赖（确认 catalog 版本 3.0.8）
- [ ] 验证：`packages/plugin` 下 `bun typecheck`；现有 v1 插件回归
- 回退：删 `src/v2/` + revert package.json

### L0.3 — codemode 包搬入 ✅ 已完成（2026-08-31，未接工具）

- [x] 前置实验：beta.59 下 `effect/unstable/http` 与 `effect/JsonSchema` 均在 → 直接搬，无需提前升级 Effect
- [x] 复制 `packages/codemode/`（26 源文件 + 7 测试文件），包名 `@coding-chimera/codemode` v0.0.1 private，acorn 固定 8.15.0
- [x] 适配点仅 1 处：`src/tool-error.ts` `Schema.Defect()` → `Schema.Defect`（beta.59 是实例而非工厂）
- [x] 验证：`bun typecheck` 绿 + `bun test` 263 pass / 0 fail（父代理复验一致）
- [x] 未做：工具注册（`execute` + `experimentalCodeMode` flag）留到 L4 后按需开启
- 回退：删目录

### L0 完成验收

1. `packages/chimera` 下 `bun typecheck` + `bun test --timeout 30000` 全绿
2. `chimera run` 跑真实任务行为不变
3. 安全验证：对软链接指向的外部目录跑 grep → 应弹权限询问
4. codemode 测试套件全过

执行顺序：L0.1 → L0.3 前置实验（决定 Effect 升级是否提前）→ L0.2 → L0.3。

## L2 细分计划 ✅ 已完成（2026-09-03）

目标：搬入新底座骨架（LayerNode 服务组装机制 + effect-drizzle-sqlite），不接任何现有代码，为 L3 Session V2 打地基。行为零变化。

实际结果：L2.1 搬入 6 文件，落点 `packages/core/src/effect/` + `packages/core/test/effect/`（**非原计划的 packages/chimera**——与上游同构，且本仓 runtime/memo-map/observability/logger 本就在此；`runtime.ts`/`memo-map.ts` 本仓已有等价实现，跳过；`app-node-builder.ts` 改为注入式签名以切断对上游 30+ v2 服务模块的依赖链，`node-build.test.ts` 因此未搬，location-map 自动路径暂无测试覆盖——L3 接 location 栈时补）；L2.2 整包搬入零适配（drizzle-orm 固定 1.0.0-rc.2，不动根 catalog 的 beta.19）；L2.3 确认并存即可。提交：L2.1 = `8025a5942b`、L2.2 = `d1e1caad04`（均 2026-09-03）。

### L2.1 — LayerNode 最小子集 ✅

从上游 `packages/core/src/effect/` 搬入（`/Volumes/workspace/opencode` 只读参考）：

- [x] 搬入文件：`layer-node.ts`（333 行核心：Node 声明 + 编译期依赖检查）、`app-node.ts`、`app-node-builder.ts`、`app-node-platform.ts`、`service-use.ts`、`memo-map.ts`、`keyed-mutex.ts`、`runtime.ts` —— 实际搬入 6 个：layer-node/app-node/keyed-mutex/service-use 与上游字节一致，app-node-builder/app-node-platform 为适配版；memo-map/runtime 跳过（本仓已有等价实现）
- [x] **不搬**：`dfdf`（上游垃圾文件，已确认未搬）
- [x] 适配点：上游 `runtime.ts:3,8` 硬编码 Observability——实际处置为**跳过搬运**，保留本仓 core 既有适配版（import 本仓自己的 `./observability`），不绑定上游实现
- [x] 注意 hoist 约束：replacements 必须在 hoist 期应用（上游 `packages/core/src/location-services.ts:92-95` 注释），搬运时保留该顺序约定
- [x] 落点：**实际落 `packages/core/src/effect/`**（原计划 packages/chimera 有变；与 chimera 现有 `src/effect/run-service.ts` 的 makeRuntime/InstanceState 体系并存，未动旧代码）
- [x] 搬入上游对应测试：落 `packages/core/test/effect/`——`layer-node/` 2 个（node-build.test.ts 按计划未搬）+ `keyed-mutex.test.ts`（observability.test.ts、cross-spawn-spawner.test.ts 本仓已有，无需搬）
- [x] 验证：新测试 17 pass / 0 fail + `packages/core` `bun typecheck` 绿（2026-09-04 复核）

### L2.2 — effect-drizzle-sqlite 包 ✅

- [x] 从上游 `packages/effect-drizzle-sqlite/` 整包搬入（src/ 19 个 .ts + test/ + examples/ + AGENTS.md，`diff -r` 与上游字节一致；仅 sst-env.d.ts 合理未搬。唯一后续偏差：2026-09-04 敏感内容审计将 vendored AGENTS.md 第 11 行引用的上游作者本机目录路径脱敏为通用表述——校验 Effect API 用 node_modules 内 `effect` 源码或公开 `Effect-TS/effect-smol` 仓）
- [x] 包名按本仓惯例保留 `@opencode-ai/effect-drizzle-sqlite`，private
- [x] 依赖核对：effect catalog: → 4.0.0-beta.83；drizzle-orm 钉 1.0.0-rc.2 于包内、`@effect/sql-sqlite-bun` 显式钉 beta.83；根 catalog drizzle-orm/drizzle-kit 保持 1.0.0-beta.19-d95b7a4 未动（提交 `d1e1caad04`）
- [x] 不从 `src/storage/db.ts` 迁移任何东西——现有存储层不动（两个 L2 提交对 `packages/chimera/src/storage/` 零触碰）
- [x] 验证：包内 `bun typecheck` 绿 + `bun test` 7 pass / 0 fail（2026-09-04 复核）

### L2.3 — 日志 shim（并存保证）✅

- [x] 确认现有 `@opencode-ai/core/util/log` 在 beta.83 下继续工作（L1 已验证 typecheck 绿，此项多为确认——2026-09-04 复核无异常）
- [x] 若 LayerNode 落地需要上游 observability/logging，则以独立模块搬入，**不改**现有 `util/log` 调用点（实际以并存+桥接落地：core `logger.ts` 73 行包装 util/log、`observability.ts` 107 行独立；L2 提交零触碰调用点。调用点数 2026-09-04 复测为 **127 处** = src 82 + test 45，原「84 处」失真）

### L2 完成验收

1. 全部相关包 `bun typecheck` 绿
2. LayerNode 与 effect-drizzle-sqlite 自带测试全过
3. `chimera run` 行为与 L1 构建完全一致（无感）

> 2026-09-04 复核：第 1、2 条在 L2 提交时点成立（packages/core 与 effect-drizzle-sqlite typecheck 绿、17 + 7 测试全过）；第 3 条为结构佐证（L2 纯增量、LayerNode 落地件暂无生产消费者——project.ts/sync 仍用 chimera 本地旧 service-use），未直接运行 chimera run 对比。另：工作区未提交的 L3 改动一度使 packages/chimera typecheck 红（缺 applyMigrations 导出、hasColumn 裸类型标注）且将 share_url 幂等修复从 applyMigrations 挪进 Client() 导致 31 个测试失败（违反本仓 Database 契约「修复必须走 applyMigrations、所有迁移路径经过它」）；2026-09-04 已将 db.ts 恢复为 HEAD 规范形态（两遍式 applyMigrations），typecheck 复绿、31/31 测试通过。

## L3 细分计划（2026-09-03，基于上游仓 9f69463f1d + 本仓三方侦察）

目标：提示词层获得 SystemContext.Source 归因 + context epoch 持久化（baseline 缓存稳定 + 源级差分增量注入）；session 事件契约收编到 packages/schema（唯一权威）；V1 主路径行为字节不变。

### 侦察结论（范围裁剪依据）

1. 上游 SystemContext（`packages/core/src/system-context/index.ts:32-39`）是结构化提示词源引擎：`Source<A>{key, codec, load, baseline, update, removed}`，支持 initialize/reconcile/replace，按 session 持久化 `Generation{baseline, snapshot}`（`session_context_epoch` 表，`session/sql.ts:168-176`）；源变化时用 `update()` 产增量文本注入合成消息（`context-epoch.ts:72-76`）而非重建 baseline——核心收益是 provider 提示词缓存断点稳定 + 来源归因 + 跨重启可恢复。
2. 上游 v2 提示词只剩 `[agent.info?.system, system.baseline]`（`runner/llm.ts:197-217`），模型/provider .txt overlay 在上游 v2 **尚未移植**。本仓 `src/session/system.ts` 的 SPECIALIZATIONS/OVERLAYS/ULTRA_LAYERS 体系比上游 v2 完整，必须保留并以 Source 化增强，**不能照抄上游退化形态**。
3. 上游 SystemContext 全家桶（registry/builtins/instruction-context/skill-guidance/reference-guidance）挂在 LayerNode + Location/FSUtil/Global 服务树上；本仓 LayerNode（L2 搬入）目前是无生产消费的闲置骨架。→ 只搬引擎（index.ts），不搬 registry 全家桶。
4. 本仓已有完整 V1 快照/回滚：`src/snapshot/index.ts`（826 行 git 快照）、`src/session/revert.ts`、TUI `/undo`（`cli/cmd/tui/routes/session/index.tsx:547-604`）、HTTP 路由。上游 V2 revert(stage/clear/commit) 的用户面也仍走 V1 legacy，且 V2 compact/shell/skill/wait 均为 `OperationUnavailableError` 桩（`core/session.ts:229-261`，头注释 `runner/llm.ts:43-91` 核实属实）。→ **快照/回滚不重建，只做契约对齐与事件补齐**。
5. packages/schema（L1 vendor）尚无 runtime 消费者；本仓 `src/v2/session-event.ts` 与 `schema/src/session-event.ts` 重复定义且已漂移（fork 版缺 Moved/PromptAdmitted/RevertEvent.*、Step.Started 缺 messageID）。契约须先收编，否则双源漂移。
6. `src/session/llm.ts:181-185` 有 2-part 缓存重整（system>2 项折成 header+rest），Source 结构化必须发生在装配点（`llm.ts:157-172`）、重整之前。
7. drizzle-kit generate 当前不可用，新表迁移需手写（参照 `20260901000000_add_session_share_url` 模式，经 `Database.applyMigrations` 幂等通道）。

### L3.1 — SystemContext 引擎搬入（纯机制，零接线）✅ 已完成（2026-09-04）

- [x] 搬上游 `packages/core/src/system-context/index.ts` → 本仓 `packages/core/src/system-context/index.ts`（与上游**逐字节一致**；引擎本身无 LayerNode 依赖，无需剥离）
- [x] 搬上游测试 `packages/core/test/system-context/index.test.ts`（18 用例全保留）
- [x] 适配：仅 `packages/core/package.json` 增 `./system-context` 显式 exports（通配模式不做目录 index 回退）
- [x] 不搬：registry.ts、builtins.ts、instruction-context.ts、skill/guidance.ts、reference/guidance.ts（依赖未迁移服务树，L4+ 再议）
- [x] 验证：typecheck 绿 + 18 pass / 0 fail；audit 零传播
- 回退：删目录

### L3.2 — context-epoch 存储与服务（接 DB，不接提示词装配）✅ 已完成（2026-09-04）

- [x] 新表 `session_context_epoch`（session_id PK+FK cascade / baseline / snapshot JSON / baseline_seq），手写迁移 `migration/20260903000000_session_context_epoch/`（IF NOT EXISTS 幂等）
- [x] 移植上游 `session/context-epoch.ts` → `src/session/context-epoch.ts`（Context.Service + makeRuntime 形态；initialize/prepare/reset）
- [x] `ContextUpdated` 经 L3.4 收编后的 src/v2 桥接通道发布（flag 门控）；`ContextSnapshotDecodeError` 入 `src/session/error.ts`
- [x] 验证：9 用例全过（含迁移幂等、reconcile/replace 路径、坏 snapshot 报错）+ typecheck 绿
- 语义差异（已记录）：事件无事务 commit hook，改为「先落库后发事件」；baseline_seq 用墙钟毫秒（本仓无持久化事件序列）；latestCompaction 查 V1 summary 消息标记
- 回退：删文件；迁移幂等无副作用

### L3.3 — 提示词装配 Source 化（flag 门控，默认字节不变）✅ 已完成（2026-09-04）

- [x] `src/session/system.ts` LayerEntry 增 `key` 并全量标注（core/default、model/<slug>、overlay/<id>、variant/ultra-* 等）；新增 `providerSegments/overlaySegments/ultraVariantSegments`，原 `provider()/overlay()/ultraVariant()` 保持 `string[]` 包装不变
- [x] `src/session/llm.ts` 装配点经 `src/session/system-context.ts`（新）构建带 key 分段，在缓存重整**之前**完成 epoch 处理；**设计偏差**：用单 carrier Source（快照值为分段数组）而非每段一个 Source——引擎 render 用 `\n\n` 拼接无法复现本仓 `\n` 字节一致要求，分段归因粒度由快照值保留
- [x] flag 定为 config `experimental.system_context`（默认 false）：开启后首轮 initialize 落库 baseline（=默认路径 join 串）；源不变复用 baseline；源变化 baseline 不动、delta 作为额外一条请求级 system 消息注入（不入消息存储）+ 发 ContextUpdated + 快照前进；epoch 故障降级默认路径不阻断会话
- [x] OAuth/workflow/system.map 三消费路径兼容（baseline+delta 均为文本）
- [x] 验证：typecheck 绿 + 新测试 10 用例全过（含字节不变断言、故障降级）+ test/session/ 484 pass（唯一失败为预存 compaction abort 时序）
- 回退：flag 默认关；代码单 commit revert

### L3.4 — session 事件契约收编到 packages/schema ✅ 已完成（2026-09-04）

- [x] packages/chimera 增 `@opencode-ai/schema` workspace 依赖；`src/v2/session-event.ts` 重写为桥接（407→171 行）：事件形状/durable 元数据以 schema 为权威，fork 侧派生 SyncEvent 发布定义，保留 flag 门控发布机制；补齐 Moved/PromptAdmitted/ContextUpdated/RevertEvent.*/Step.Started.messageID
- [x] V1 revert/unrevert 行为不变，flag 门控通道增发 RevertEvent.Staged+Committed/Cleared；projectors-next 补三个 no-op projector（V1 已自行持久化）
- [x] revert 列类型对齐**放弃**：schema Revert.State 的 messageID 品牌与 V1 Session.Info.revert 类型不兼容，留待 session-message 对齐后续项
- [x] 验证：typecheck 绿 + v2/revert-event/httpapi-session 等测试全绿（2 个预存失败经 git stash 复核确认）
- 回退：单 commit revert
- 遗留：SDK/OpenAPI 生成物与 v2 事件漂移（需跑 `./packages/sdk/js/script/build.ts` 重生成，独立后续项）；src/v2/session.ts 与 schema 的其余漂移已记录未修
- 回退：单 commit revert

### L3.5 — 收尾验收 ✅（2026-09-04）

1. ✅ typecheck：packages/chimera + packages/core 全绿；packages/core 测试 112/113（唯一失败为预存 cross-spawn cwd）
2. ✅ packages/chimera 全量套件：4648 pass / 37 fail → 修复 1 个预存失效断言（`task.test.ts:2066` variants 列表漏 ultra，dcfb89d4b6 引入）后 **36 fail 全部对账为预存/环境**：MCP 家族 12、config HttpApi 8、HttpApi SDK 2、tool.chimera 1、compaction abort 1、Node 26 安全闸家族 5、low-rss pragma 失配 1、plugin-config 挂死 1（干净 HEAD 复核）、InstanceState 负载抖动 5（单跑 12/12 全过）
3. ⚠️ 默认路径 `chimera run` 真实任务对比未跑（需真实 provider 额度）；替代证据：flag-off 字节不变测试断言 + 全量套件行为不变
4. ⚠️ flag-on 用户可验证项为模块/服务级覆盖（system-context-flag 10 用例），未做真实端到端；手动验证路径：config 开 `experimental.system_context` → 跨轮改指令文件 → debug 事件流见 `session.next.context.updated`
5. ✅ 本文件勾选 + packages/chimera/AGENTS.md 已补 Source/epoch 说明（L3.3 完成）

执行顺序（实际）：L3.1 → L3.4 → L3.2 → L3.3 → L3.5（原 L3.2∥L3.4 因共享 package.json/session-event.ts 改串行）。实际工期 2 天。

### L3 待定

- ~~flag 形态~~ → 已定：config `experimental.system_context`（L3.3）
- epoch 表清理策略：已随 session 删除 FK cascade（L3.2 迁移测试覆盖）
- 上游 registry 全家桶（builtins/instructions/skill-guidance/reference-guidance 的 Source 化）留待 L4+ 评估，本期只做模型层 Source 化

## 顺带发现的本仓问题（独立于迁移）

- `chimera graph status` 不支持 `-p/--projectPath`（`query` 有、`status` 没有，帮助文案与实际 flag 不符）。
- Node 26 下只读 graph 子命令被 tree-sitter 版本安全闸硬拦截，需 `CODEGRAPH_ALLOW_UNSAFE_NODE=1` 绕过——只读命令不应触发该闸。
- `drizzle-kit generate` 当前不可用：`migration/20260714000000_memory_system/snapshot.json` 格式与 drizzle-kit 不兼容（malformed）；最新两个迁移目录（model_telemetry 系列）已只有 migration.sql 无 snapshot.json。已手写 `20260901000000_add_session_share_url` 修复存量库缺列问题（`43135ac3f`）。
- Effect 升级后复测确认以下测试失败为预存问题，与升级无关：MCP daemon/handshake 9 个（MCP 已非 CodeGraph 接入面）、httpapi-config 8 个、httpapi-sdk 2 个、tool.chimera 1 个、cross-spawn cwd 1 个（macOS /var 软链）、compaction abort 时序 1 个。建议后续专项清理。
- 2026-09-04 L3.5 复核新增预存确认（干净 HEAD stash 复核）：`test/graph/pr19-improvements.test.ts` 的 low-rss pragma 用例失败——源码 `src/graph/db/index.ts:46` 默认 `CHIMERA_SQLITE_CACHE_MB=64`（-65536）与测试期望 -8192 失配；`test/provider/provider.test.ts` 的「plugin config enabled and disabled providers are honored」挂死（90s 超时，与 L3/WIP 均无关，疑与插件 host 子进程有关）。另：InstanceState 3 个用例全量负载下超时、单跑全过（负载抖动）。

## 待定

- ACP 是否恢复（默认否）。
- 上游跟踪分支 `upstream-sync` 的建立与周期性同步节奏（建议每层开始时 re-fetch 一次）。
