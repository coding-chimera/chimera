# Upstream v2 底座迁移计划

状态：L0 + L1 + L2 + L3 已完成并推送（L3 落地 2026-09-04，五线程拆分 8 提交，origin/main 已同步；细分计划与验收见下文）——Effect beta.83、schema/protocol 包、插件 v2 host、codemode、grep 权限修复、LayerNode、effect-drizzle-sqlite、SystemContext 引擎/context epochs/提示词 Source 化/v2 事件契约收编均已落地。特性侧：fork 点以来上游全量 feat/安全 fix 分诊已完成，见「上游特性同步（F 线）」章节与 `UPSTREAM_FEATURE_TRIAGE.md`。批次：F0 ✅（bdaffa827）、F4-P1 ✅（a143b3c23）已推送；**F1 ✅ 完成（2026-09-08，本地 8 commit 未 push，见「F1 完成记录」）**；F2/claims P1P2 未启动。
制定：2026-08-28，基于对上游 opencode（`refs/remotes/upstream/dev` = `755ebdb94`，v1.18.25）与本 fork（fork 点 `98e091796`，2026-05-07，opencode v1.14.40）的 swarm 探测 + 跨仓图精读（上游克隆仓 `/Volumes/workspace/opencode`，图已索引）。制定基线已过期：2026-09-04 上游 HEAD 为 `9f69463f1d`，与 L3 侦察基线一致。

## 背景事实

- 上游领先 3266 commits（约 3.5 个月），本 fork 独有 225 commits（Chimera graph/audit、改名、多模型调度等）。（2026-09-04 复测：fork 点口径 3273 / v1.14.40 tag 口径 3299，其中 feat 388、fix 1044——全量分诊见 F 线章节）
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
建议执行顺序：**F0 → F1（Copilot 计费提到最前）→ F2 ∥ claims P1/P2（已解冻）→ L4（含并入项）→ F3 ∥ F4-P3 → L5（吸收 F4-P2）**。其余 10 项拍板不阻塞上述批次，可穿插进行。
批次进度（2026-09-10）：**F0 ✅**（bdaffa827 已推送）；**F4-P1 ✅**（a143b3c23 已推送）；**F1 ✅ 完成**（本地 8 commit 未 push：7dd57693a 图片缩放+seeding / 5571bb670 headerTimeout / 9fd39ccb9 压缩 / aaddd6fbb CLI 双件 / 0efb73724 插件三件套 / 3c396f636 mantle+Cohere / 8674add7f Copilot 计费+tiers / b6a42ec70 SDK 重生成，见下方「F1 完成记录」）；**F4-P1.5 ✅ 嵌套后台孤儿化修复**（2026-09-10，本地未 commit，见下方「F4-P1.5 完成记录」）；F2/claims P1P2 未启动（队列下一步：F2 ∥ claims P1/P2）。
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

| **F4 后台异步子代理（P1 已完成 2026-09-07）** | 按上游 HEAD 终态做——`task(background=true)` + Deferred 驱动合成消息注入自动续跑父循环（**task_status 轮询已被上游 dabf2dc013 删除，不作引入目标**）；全链 12 提交。P1 最小闭环已落地（引擎+task 接线+可寻址 inject+task_cancel+级联取消+backgroundTasks section+验收矩阵，见下方完成记录）；P2 swarm/预算/dispose 整合；P3 TUI ctrl+b promotion + server 端点 + SDK 重生成 + claims L2 接线。拍板详情见「F4 拍板记录」与分诊文档 §10 | P1 ✅ ~4 人日实际（四阶段）；P2 ~2-4；P3 ~3-5 | P2 并入 L5 或排 L5 后；P3 与 F3 合并（吸收 `3003867c25`）；claims L2 的 inject 前置已就绪 |
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

## 上游特性同步（F 线）：分诊结论与批次计划（分诊与拍板 2026-09-07）

定位：与 L4~L6 底座绞杀并行的**特性侧**工作流。决策#1「不做零散 cherry-pick」针对架构层；F 线是**系统分诊后的批次化执行**，两者不冲突。fork 点以来上游累积的特性缺口此前从未分诊，本次完成全量覆盖。

分诊范围与总量：`v1.14.40..9f69463f1d`（3299 commits：388 feat / 1044 fix），6 个并行只读分诊代理 + root 汇总对账。**388 feat 全量五分类：①直接可移植 12、②需适配 66、③fork 已等价 11、④无关 288、⑤已同步 11**（各组对账吻合）。**安全/权限关键词 fix 43 条全量横切审计：无 P0，但 5 条 fork 需修（含 1 条 P1）**；fix(tui) 91 条主题级归纳。逐条明细（落点、适配点、fork 证据路径、排除证据）= `UPSTREAM_FEATURE_TRIAGE.md`。

### 批次计划

| 批次 | 内容 | 规模 | 前置/备注 |
|---|---|---|---|
| **F0 安全/正确性修复** | **P1 `08faeb3893`** run 模式子代理权限应答被过滤 → 子代理挂起 → 整个 run 卡死（fork 重子代理工作流直接命中，headless/CI 高危；落点 `src/cli/cmd/run.ts:570-590`，~10 行）。P2×4：`a9c810cbbc` $ARGUMENTS 文件双重注入（prompt.ts:2355-2368）、`c035c35eba` OPENCODE_PERMISSION 坏 JSON 启动崩溃（config.ts:818-819）、`dc978cb889` permission/question id 校验（两处 one-liner）、`3a4c253969` textVerbosity 注入门控（transform.ts:1172-1181，中继生态挂 gpt-5.x id 即请求失败）。随批核查 `f4851e3bd9` question 按目录路由 | ~1 天 | 无前置，立即可做 |
| **F1 高价值特性** | **`ae92f3158f` Copilot token 计费（现网风险，建议提到最前）**：上游 Copilot API 已切 token 计费，fork models.ts 旧 schema 存在解析/计费失配；`f965db9e13` headerTimeout 可配（中继+长推理生态防挂起，四落点全在近零适配）；`ffea6c7974` HTTP API 响应压缩（自包含中间件）；`85ce6a5f95` 图片自动缩放（fork 现状大图直通上下文，free/中继模型爆仓风险）；`c2b1ebd9dc` 定价 tiers（subagent_model_schedule 以 $/task 消费定价，直接受益）；`9b7b6cb30f` worktree 命名去重；`9f42bd4a85` bedrock mantle 加载侧补齐（fork 认得出跑不了）；CLI 小件包：Modal 发现/xAI Grok OAuth/plugin dispose/mcp add 非交互/logout 搜索/全局配置 seeding/Cohere North | ~3-5 天 | 无硬前置 |
| **F2 MCP 专项** | 8 条一次做完（fork MCP 面停在 fork 点形态，逐条 cherry-pick 会反复冲突）：`921b1c6a34` SDK v2 升级（1.27.1→1.29.0+patch；拆步：依赖升级+OAuth/session-recovery 先行，code-mode 后置）、`e8e83afbce` server instructions 注入、`c6cc13e183` resource templates、`3f3f120825` resource 读工具、`f55a931f59` roots、`07b983e82f` logs、`7e7ad37736` cwd、`a131811cdc` mcp__ 命名约定（**契约变更**：permission 通配/prompt 引用/TUI 显示须同批） | ~1 周 | MCP fix（29 条）随本批消化 |
| **F3 TUI 批次** | feat(tui) ②17 条，路径映射 `packages/tui/src/X` ↔ `packages/chimera/src/cli/cmd/tui/X`（同源但结构性分叉，无①直搬项）；fix(tui) 91 条按主题消化，优先 C 族（子代理/工具行渲染，10 条）、B 族（thinking，6）、G 族（事件流/同步，8） | ~1 周 | 3 条依赖后端能力（project-copy/background-job），决策#2/#5 不批则降④；diff-viewer 族（feat 7+fix 7）随决策#2 |

#### F3+F4-P3 完成记录（2026-09-22，builder ses_f38b337e5 三续跑完成；commit 栈见 git）

- **F4-P3 全落地**：promote/waitForPromotion 引擎 `96e8030b8` → 端点双 parity `f82b13c26` → SDK 重生成 `0f912f6c8` → ctrl+b `833f340c8` → capabilities 门控 `53ffa3f18`（吸收 `2892e97c57`）→ newweb `(background)` 标记（嵌套仓 `853ba1d6`，gitlink 未动）。claims L2 经查**预存已落地**（`c55f5a8e2` editIntentWatch→injectSynthetic 链路+24/24 测试），无需新工。
- **F3 feat② 17 条终局**：移植 4（`0de5f1ff36`/`51da3483a9`/`34e5809059` 于 `948302198` + `2892e97c57`）；`3003867c25` 由 F4-P3 吸收；降级/顺延 12（ffcb45d7c9/f591bf5f93 缺 project-copy 后端、39c6dd1c32 待拍板#6、888c4cb504 待拍板#3、6d4f3b4ab2+8f8b161cae 无插件表面、28a06e52fc/b8cfd69acf/pinned 族 f33b4455a1+12583b18f0 需独立批、cb65926c82 fork 已等价、e7c59b17a8/f99339e525/f6e5e2533e/f620b39484 fork 无此表面、c416ede20d/7b56a1cea3 release-date 顺延）。
- **fix(tui) 消化**：红旗双修 `4b6e57560`+`721e2df2c`；C `8bc0102dd` / B `d8d103914` / G `41dd47c6b` / I+N `717f2f83e` / misc `84b4c8fbd` / M+H `dfcb70f65` / L+M `20c4ad713`；安全邻接 4 条核实已吸收；**D/J/K/O/R 五族留待后续批**。
- 车道外一笔：`src/effect/app-runtime.ts` BackgroundJob.defaultLayer 一行（已注记）；上游 `43c24d8d0f` 的 config-service 无关重构刻意不搬。

#### F3 遗留批完成记录（2026-09-23，builder ses_f33e4a763）

- **D 补全 5 条全移植**（`3bb107139`：目录作用域文件补全/MCP 资源 name 匹配/斜杠 description key/@阈值/models mo 别名）
- **E keybind**：1 先前已移植（prompt.skills 于 84b4c8fbd）/1 已等价（cb65926c82 空 variant_list 在 fork 不可达）/2 降级（3cdd431794 move 命令无表面；ecdfcd91ca tab-cycle 架构不同）
- **F 内联错误**：2 移植（`c3acb9234` org/skill 错误内联）；3 已等价（上游自己删了 aggregate-failures 机制，fork 已与 HEAD 形态一致）
- **J 对话框**：2 移植（`af1e5e17f` onMouseUp 拖选守卫+间距）；1 已等价
- **K move/working-copy 6 条全降级**（依赖 project-copy 后端，同决策#2 条款）
- **O worker**：1 移植（`7e46f1d31` 拒收处理器摘除）；2 已等价；1 降级（split-footer 架构）
- **R 杂项**：5 移植（`962daf241` footer 沉底/gutter 标记/宽字符折叠+5 测试/Vue 高亮/tips 缩短）；3 已等价
- **pinned 会话切换族全量移植**（`3b4d6a414`，按上游 HEAD 终态：pin/slots 1-9/leader 快捷/Prune on delete；刻意不移植上游已删的 Recent 组；fork 适配 CommandOption.value 路径）
- 安全邻接、D/E/F/J/K/O/R 全族就此清零；遗留仅 K 族（绑决策#2）与 split-footer 架构件（决策#3）
| **F4 后台异步子代理（已拍板 2026-09-07：做，默认打开）** | 按上游 HEAD 终态做——`task(background=true)` + Deferred 驱动合成消息注入自动续跑父循环（**task_status 轮询已被上游 dabf2dc013 删除，不作引入目标**）；全链 12 提交。P1 最小闭环（background-job 引擎子集 + task background 参数 + **cancel 表面（first-wins 用例）** + **会话可寻址 inject（跨 thread claims 用例）** + `delegation.background_subagents` 默认 true + background_concurrent 上限 + 级联取消）；P2 swarm/预算/dispose 整合；P3 TUI ctrl+b promotion + server 端点 + SDK 重生成 + claims L2 接线。拍板详情见下方「F4 拍板记录」与分诊文档 §10 | P1 ~3-5 人日（+cancel 表面/可寻址 inject ~1）；P2 ~2-4；P3 ~3-5 | P1 可立即开工、与 F2 并行；P2 并入 L5 或排 L5 后；P3 与 F3 合并（吸收 `3003867c25`）；claims P1/P2 与 F4-P1 并行、claims L2 依赖 F4-P1 inject |
| **L4/L5 并入项** | llm 包 8 条 + native-llm + connector auth + opencode integration×2 + provider↔integration 映射 + variant.ts 配置化落点（`42bb793574`，计划书已点名）随 L4 整包 vendor 自然吸收，勿单独 cherry-pick；`03afae5b95` v1 加载 v2 config 为 L4/L5 启动第一批（防用户 v2 配置在 chimera 下丢失）；sdk/client v2 表面 5 条 L4/L5 启动时复评升② | 随 L4/L5 | — |

建议执行顺序：**F0 → F1（Copilot 计费提到最前）→ F2 ∥ F4-P1（已拍板可立即开工）∥ claims P1/P2（已解冻）→ L4（含并入项）→ F3 ∥ F4-P3 → L5（吸收 F4-P2）**。其余 10 项拍板不阻塞 F0/F1/F2/F4-P1，可穿插进行（它们门控的是：F3 三条后端依赖 TUI 项、codemode 接线、L4 内品牌/strict 选择、desktop/diff-viewer/split-footer/reference 取舍）。

### 需产品拍板（11 项，门控对应批次；全表见分诊文档 §8）

desktop 是否重启维护（壳级 7 条④→②）；TUI diff-viewer 是否引入；run split-footer 55 文件架构是否整搬；scout/reference 物化仓库体系 vs fork 跨项目 graph（可组合：先物化再 graph init）；**后台异步子代理：已拍板（2026-09-07）——做、默认打开、claims 同步解冻，详见 F4 拍板记录**；codemode v1 接线是否启用（包已 vendor 但运行时零引用，vendor 意图需澄清）；opencode 品牌 integration/zen provider 是否保留（L4 内）；NVIDIA X-BILLING-INVOKE-ORIGIN 值 OpenCode vs Chimera；Codex strict 策略（fork `codex-responses.ts:1150` 显式 strict:false 与上游相反）；TUI yolo permission mode；newweb 多服务器权限状态串台复核（独立立项，非上游移植）。

### F4：后台异步子代理（已拍板 2026-09-07；提案与简报见下，拍板记录见节末）

关键修正：分诊时锁定的 task_status 轮询工具已被上游上线 11 天后整体删除（`dabf2dc013`，2026-05-25）；HEAD 终态 = `task(background=true)` 立即返回 + Deferred 驱动向父会话注入合成消息**自动续跑**（带 "DO NOT sleep, poll" 反轮询指导）。完整能力链 12 核心提交 + 3 TUI 边缘 fix（分诊文档 §10.1）。上游 flag 至 HEAD 仍默认关（未毕业）→ fork 用 config `experimental.background_subagents` 默认关，照抄上游"关时 jsonSchema 换窄、字节不变"门控手法（HEAD task.ts:362-366）。

fork 侧有利事实（均经锚点核验，详见分诊文档 §10.3）：机制层原语全数现成——子代理 work fiber 本就 fork 在 instance scope、等待方只 Deferred.await（runner.ts:80-136 支持重新 attach）；合成消息原语在（message-v2.ts:125 + prompt.ts:1884-1908）；task_model 授权/路由全前置在 prepare，后台化=派发点立即 fork，授权面零改动（前提：不做排队延迟启动）；`experimental.system_context` 已验证 flag 模式；memory_job 是将来要 durable 时的现成模板。主要冲突点：delegation-limiter 借用机制以"父阻塞"为前提（后台子终生持 permit，需拍板 background_concurrent 独立上限）；swarm 状态通道被 prompt.ts:684 running/pending 门挡住（需换通道，三选一）；closeout 责任改为"子会话内自收尾 + 父在注入轮汇总"。

分期（详细落点/验收/回退见分诊文档 §10.4）：

- **P1 最小闭环（~3-5 人日，拍板后与 F2 并行，文件交集≈零）**：新建 `src/agent/background-job.ts` 引擎子集（list/get/start/extend/wait/cancel，done Deferred，interrupt-only→cancelled，同 id 去重；job id=子会话 id；**有意不持久化**，崩溃后从持久化子会话降级重建）+ task.ts background 参数与换窄门控 + 级联取消（run-state.ts:88-96 挂 BFS 传递闭包、session.ts:711-734 挂单层清理）+ task.txt/系统提示词同改。无新表无新事件。验收：flag 关全量字节不变；flag 开 E2E 六场景 + 注入轮撞 compaction 用例。
- **P2 swarm/预算/dispose 整合（~2-4 人日，并入 L5 或排 L5 后避免返工）**：预算策略（background_concurrent 视拍板）+ swarm 后台化（forEach→fork+句柄，状态通道选型）+ closeout 协议成文 + dispose 矩阵。
- **P3 TUI/WebUI 表面 + claims L2（~3-5 人日，与 F3 合并）**：引擎补 promote/waitForPromotion（不中断不重启纤维）+ TUI ctrl+b（fork 键位在 context/keybind.tsx）+ server experimental 端点双 parity + SDK 重生成 + newweb capabilities 门控；claims L2 = 释放钩子经 P1 inject 通道唤醒 parked 代理（L1 是 pull 型注入，parked 代理没有下一轮，inject 正是缺失的 push 通道）——**claims L2 仅依赖 P1**。与 F3 去重：`3003867c25` 在 P3 吸收，F3 清单标记。

L5 seam 条款：P1 把后台语义隔离在"引擎服务 + task 工具分支"两个 seam 内；若 L5 整包引入 v2 runtime，换用上游 core/background-job.ts 引擎（`76ee87ead8` 随包到位）、协议不动（~0.5-1 人日吸收）。"等 L5 白嫖"的代价 = 产品面与 claims L2 阻塞数月且以 L5 整包引入为前提，不建议。

九个拍板点（详见分诊文档 §10.5）：①做不做（建议做）②工具形态（建议 task 加参数）③查询面（建议不复活 task_status，可见性走 prompt-context section）④注入语义（自动续跑 vs noReply，可 config 化）⑤预算语义（background_concurrent？级联取消=建议是）⑥P2 时机（建议并入 L5 或排后）⑦持久化（建议内存+降级重建）⑧是否同时解冻 claims 设计（其 P1/P2 纯 fork 文件可独立先行）⑨L5 换引擎条款（建议接受）。

残余风险：上游自身仍锁实验 flag（fork 同样默认关灰度）；注入自动续跑 × fork 特有路径（remote-compaction/hash-diff/ultra 策略）未验证；swarm 状态通道是 P2 最大不确定项（三选项各 ~1 人日级差异）。

#### F4 拍板记录（2026-09-07 用户谕示）

- **①=做，且默认打开**（推翻简报与上游的"默认关灰度"建议）：flag 保留但降为 kill-switch 语义，命名建议移出 experimental 命名空间（`delegation.background_subagents` 默认 true）；"关时字节不变"从灰度手段降级为回退保障。用户姿态：有问题就修。
- **两个一等用例（用户提出，直接改写 P1 需求）**：
  1. **先到的赢（first-wins）并行探查**：并行 N 路后台探查，任一路提早带回足够结论 → 主代理立即取消其余各路，不再干等。→ **P1 新增需求：面向模型的 cancel 表面**（按 task_id 取消后台任务；引擎 cancel 本在 P1 清单，需补模型可见入口——形态：task 参数 vs 独立小工具 task_cancel，按 one-action-per-tool 风格实现时定）；swarm 原生 first-wins 等 P2，P1 期间 task.txt/系统提示词教"N× task(background) 手动 fan-out + 取消落败者"模式。
  2. **跨会话（同项目跨 thread）编辑同步**：同项目跨 thread 行为会大量增多，多 thread 编辑同一文件的冲突自然依赖 predesign → edit-intent claims：两边先后/同时完成 predesign 后，先完成方的释放广播唤醒另一等待 thread 开工。→ **P1 的 inject 原语必须做成会话可寻址**（按 sessionID 向目标会话注入，而非写死 job 的父会话），claims L2 复用同一通道零额外引擎改造。
- **⑧=claims 解冻**：跨 thread 同步升级为一等需求。claims P1/P2（纯 fork 文件、零上游冲突）与 F4-P1 并行先行；claims L2 在 F4-P1 inject 就绪后落地；重启前重核五个漂移锚点（store.ts / provenance.ts:801 / prompt-context.ts / edit.ts:262 / write.ts:55）。
- **④被锁死=自动续跑**：用例 1 要求首完成即时唤醒（否则 first-wins 取消不成立），noReply 降为省 token 的 config 逃生口。
- **⑤升级**：默认开 → `background_concurrent` 独立上限**随 P1 落地**（防预算蚕食从保险变为必须，值可配，打满=拒绝并报错不排队）；级联取消=是（用户停止=停整棵树，孤儿 job 不烧 token/permit）。
- **②③⑥⑦⑨按建议执行**：task 加 background 参数（关时 jsonSchema 换窄）／不复活 task_status、可见性走 prompt-context "Background tasks" section／P2 并入 L5 或排后／内存引擎+崩溃降级重建／L5 seam 换引擎条款接受。
- **默认开的验收强化**：P1 测试矩阵必含——注入轮×compaction 相撞、ultra/多代理策略×后台派发、上限打满拒绝行为、级联取消 BFS、cancel 表面、跨会话 inject 寻址、kill-switch 关闭时字节不变。WebUI 兼容注意：默认开即 background part metadata 立刻到 newweb，P1 采用兼容渲染或接受 raw 展示至 P3。
- **新增开放问题（不阻塞 P1）**：跨进程唤醒——inject 限同进程会话；独立 CLI 进程里的 parked thread 无法被 inject 唤醒（WebUI 多 thread 同进程不受影响）。claims L2 需 poll→inject 桥（各进程轻量轮询项目 DB 的 claims 释放记录、唤醒本进程 parked 会话），列为 claims L2 设计点。**（已解决：2026-09-17 claims 批⑦桥落地，见文末「claims 批⑦完成记录」节）**

#### F4-P1 完成记录（2026-09-07，已提交 a143b3c23 并推送）

四阶段串行派工（builder=deepseek-v4-flash-0731 high，root 逐阶段 diff 复审+独立重跑）：

1. **阶段1 引擎**：`src/agent/background-job.ts`（382 行：list/get/start/extend/wait/cancel，done Deferred，tail 串行 extend，token 防 ABA，interrupt-only→cancelled，内存注册表有意不持久化，BackgroundJobLimitError 打满拒绝不排队）+ config `delegation.background_subagents`（默认 true，kill-switch）/`background_concurrent`（默认 16）。
2. **阶段2 task 接线**：`background` 参数（双 schema，kill-switch 关时 jsonSchema 换窄+description 字节不变，照抄上游手法）；后台派发=prepare 授权/路由/遥测照常→materialize 建子会话→jobs.start（fork run）→notify 纤维 wait 终态→injectSynthetic 注入父会话自动续跑（`<task_result>/<task_error>` fork 文案）；resume 撞 running→extend 串行。**会话可寻址 inject 原语**（prompt.ts injectSynthetic，claims L2 可直接复用）；dispatch 拆分 materialize/runPreparedCore/runPreparedBackground，同步路径 limiter 与行为零变化（task.test 66/66）。
3. **阶段3 cancel 表面+级联**：新工具 `task_cancel`（.ts+.txt，归属守卫=仅派发会话可取消、终态幂等、kill-switch 关清晰报错、可见性跟随 task 不进 explore allowlist）；run-state.cancel 入口 BFS 传递闭包（pending frontier+cancelled visited+running 过滤保终止，防环测试锁 onInterrupt 恰一次）+ 自然递归链核实成立（双保险）；session.remove 单层清理；BackgroundJob.defaultLayer 三处挂点凭层 memoization+InstanceState 同实例（测试实证）。
4. **阶段4 可见性+矩阵**：prompt-context `backgroundTasks` section（仅本会话 running job、三重门控、缺席零字节、参与 hash-diff）；容量预检前移 materialize 之前（超限不留孤儿会话）；injectSynthetic 类型化 NotFoundError+notify ignoreCause({log:true})（父会话已删时安静落空不杀纤维）；**矩阵A 注入×compaction 相撞=完整 E2E**（llm.hold 栅门，存储一致+三轮续跑+无重复消化）；**矩阵B ultra×后台**（显式 ultra 拒绝+父 ultra 剥离测试锁定）。

**与拍板记录的实现偏差（root 复审认可）**：后台 run 不经 DelegationLimiter——拍板⑤默认口径为"后台子终生占 permit+独立上限"，实现改为完全解耦（background_concurrent(16) 独辖后台，永不蚕食前台 max_concurrent(128)，总并发上界 128+16 仍有界）：解耦从根上消除"蚕食"问题，优于缓解方案，意图不变。

**验证**：F4 测试家族 113 pass/0 fail（7 文件）+ typecheck 绿 + test/session 495 pass（唯一失败=compaction abort 时序预存，memory.md beta.59 基线佐证）+ tool 目录仅预存 tool.chimera 1 条（stash 复核）。各阶段 predesign/audit 齐全（阶段4：predesign_215fa11fcf145101、audit_aaeab1fee6da4988 等），obligations 0。

**残余/非阻塞**：swarm 原生 first-wins 等 P2（P1 期用 N×task(background)+task_cancel 手动模式，task.txt 已教）；newweb `(background)` 专属渲染属 P3（metadata 已发布）；跨进程唤醒（claims L2 poll→inject 桥）仍开放；compaction 时序用例高负载偶败（预存）。

#### F4-P1.5 完成记录（嵌套后台孤儿化修复，2026-09-10，本地未 commit）

用户实测发现：root→mid（前台 task）→leafA/B（后台）场景下，mid 派发后台任务后自身回合结束即被 dispatch 当作完成、把"等待中"文本返回 root，root 写盘退出，leaf 聚合结果孤儿化（mid-out 缺失）。确诊两处断链：runPreparedCore 在子会话 loop break 时取最后文本当终态、不感知自有 background job；run 模式 prompt 返回即进程退出（src/cli 零等待）。scout 调研证实上游同样无保护（上游 task.test.ts:897 明确断言 background 完成不等待父 prompt）——fork 自研分歧面，F 线同步时注意冲突。

用户拍板（2026-09-10）：owner 迁移+双写兜底（契约见 packages/chimera/AGENTS.md pitfall 节）；park 不设超时但定时提示 main；run 聚合结果经事件流自然流出；复用 background_subagents kill-switch；三阶段串行 builder（deepseek-v4-flash-0731 high）+ root 逐阶段复验。

1. **阶段1 引擎**：typed `StartInput/Info.ownerSessionId` + `delivery(pending|delivered)` 状态机（start 即 pending；notify fiber 在 injectSynthetic **完整返回**——即唤醒回合跑完——后 ensuring markDelivered）+ `markDelivered`/`waitOwnerQuiescent` 原语（raceAll 后重读快照，封死"唤醒回合内又注册新 job"窗口）；engine 单写者投影 metadata.parentSessionId/sessionId（expand phase）；四消费点迁 typed（prompt backgroundTasks / task-cancel 归属守卫 / run-state BFS / session.remove 清理）。**root 复验抓热自旋**：settled job await 已 resolve 的 done deferred 会让 settle→delivery 窗口（=整个唤醒 LLM 回合）空转烧核 → 改为按状态选唯一未决信号（running→done，settled→deliveryDone）。
2. **阶段2 dispatch park**：runPreparedCore 在 prompt() 返回后若 child 有未落定 owned job 则 park 至 waitOwnerQuiescent，quiescent 后**重读最新 assistant 消息**作为 output/error 判定——前台/后台路径共享 core，嵌套 background mid 同步被修（其 job 保持 running 至聚合完成）；onParkProgress 周期回调（默认 30s、进入 park 立报、无放弃型超时）→ task.ts 前台路径转 ctx.metadata（parked/waitingBackgroundTasks/parkElapsedMs）；BACKGROUND_DESCRIPTION 补子代理 park 语义句（kill-switch 关时字节不变）；同步路径 pre-materialize（时序等价，既有测试佐证）。
3. **阶段3 run drain**：新路由 `GET /session/:id/background/quiescence`（长轮询，timeout 默认 30s、clamp [1,120000]，返回 quiescent/running/pendingDeliveries）+ SDK 重生成（sdk.session.backgroundQuiescence）；run.ts `drainBackgroundJobs` 在 prompt/command 返回后长轮询至 quiescent，每轮打印 waiting 进度行（聚合结果经 loop() 事件流自然流出）；loop() 的 idle break 改 drainFinished 门控以保持唤醒回合打印。**root 复验抓 attach 挂起**：末尾 idle 事件恒早于 drainFinished 置位 → break 永不触发 → attach 模式 SSE socket 把进程挂住 → subscribe 传 AbortController signal + drain finally 1s unref 宽限定时器兜底强关流。

验证：typecheck 全程绿（chimera+sdk/js 双包）；终验矩阵 **464 pass/0 fail**（F4 家族+三阶段触改共 22 文件）+ **test/session 521 pass/0 fail**（既有 compaction flake 未复现）；关键窗口用例（settle 但 delivery pending 仍阻塞）+ drift-guard（投影≡typed 字段）已锁入引擎测试。predesign_4605530377c92c68 / predesign_db8894e81c17e5ce；audit_c0bfd9e0d68433db / audit_0abad7340d6678a9。

残余/非阻塞：用户真机复跑原始场景待做（root→mid→leafA/B、run 模式、断言 mid-out/root-out 均产出）；parked 前台 dispatch 全程占用 DelegationLimiter permit（leaf 并发另由 background_concurrent 独立封顶，可接受）；contract phase（拆投影）按 AGENTS.md 等下个 F 线同步批次后确认（fork 侧 metadata 读者已清零）；run.ts 遇无此路由的旧 server 时 drain 降级为一行 warning 不卡死。
#### F1 完成记录（2026-09-08，本地 8 commit **未 push**——用户指令禁 push）

落地清单（每项经 ali-internal-audit 内容审计 + chimera_audit 显式种子 + 父级独立复验）：

1. `7dd57693a` 图片自动缩放 + 全局配置 seeding（85ce6a5f95+981e00971a 终态 + 487575773d）：photon-node 0.3.4 精确锁定 + wasm 补丁（上游终态版）；Image.normalize 接 prompt/processor（ResizerUnavailableError 降级直通）；prompt-harness fixture 源头供给 Image 层（一处治愈 5 个传播面测试文件）；seeding 品牌 = chimera.jsonc + coding-chimera schema URL。
2. `5571bb670` headerTimeout（f965db9e13+67caf894e0 终态）：schema/HeaderTimeoutError/openai loader 默认 300s/fetch wrapper abort 信号（fork replay・itemId strip・UA 守卫全保留）；**父拍板：ResponsesTransport 不透传**（fork 特有路径，最小 parity 面，已记偏差）。
3. `9fd39ccb9` HTTP 响应压缩（ffea6c7974 HEAD 终态）：Effect httpapi 后端 zlib 中间件（跳过条件全套），errorLayer↔cors 之间装配；Hono 后端已有压缩不动。
4. `aaddd6fbb` CLI 双件（ba57718b05+3f0ef9b71c）：mcp add 非交互（add [name]+--url/--env/--header）+ logout 模糊搜索；子进程测试以仓库 cwd + 显式 env spawn（pitfalls #32 教训）。
5. `0efb73724` 插件三件套（519d344470+341c64cc97+b32debb8a3 HEAD device-only 终态）：Hooks.dispose+宿主 finalizer 错误隔离、Modal 动态发现（不预置 URL 模板）、xAI device flow（不带 loopback 回调页；referrer/User-Agent 功能参数保留）。
6. `3c396f636` bedrock mantle + Cohere North（9f42bd4a85+0bb677cef9）：bedrock 4.0.96→4.0.112；BUNDLED_PROVIDERS/选择函数/getModel 第4参（Wave 3 复用）/itemId strip/sdkKey/variants/store/media 八点补齐；north temperature+variants；**citation_options 随上游 db9391e8a6 回退同步删除**（侦察漏查回退提交，builder 实现时标记，父核实上游 HEAD 后删除——坑 #1 第二实例）；@aws-sdk/credential-providers 未 bump（mantle 不需要，实测绿）。
7. `8674add7f` Copilot token 计费 + 定价 tiers（ae92f3158f+ec50db334b+373cd08b98+b8374b5a7c+561afb401a 合并终态 + c2b1ebd9dc；getUsage 同函数体故单 builder 合流）：/models 改 effect Schema 宽容解码+usable 守卫+pickerEnabled 暴露集（修复 P0 解析炸→静默回退）；AIC→USD 换算（含 batch_size 防除零）；includeRawChunks→processor raw case→finish-step 合并重置→getUsage totalNanoAiu/1e11 权威成本三元；X-GitHub-Api-Version 2026-06-01 + title X-Interaction-Type；small_model hook 完整移植（UTILITY_MODELS 顺序首中）；endpoint 内存态路由；tiers 三级级联选档 + ModelPricing 类型透传（effectivePricing 消费不变——basket 全<200k 收益≈0，主收益=session 成本精度）。**f1407e41c4（M10：copilot providerMetadata 键改名+itemId 剥离名单）不并入→独立 backlog**（跨 vendored 文件+codex-responses 边界，父拍板）。
8. `b6a42ec70` SDK v2 types 重生成：headerTimeout/attachment/tiers/delegation-background 四 schema 面落地，**L3 v2 事件漂移与 F0 schema 精化的既有待办一并结清**（单文件 +32/-2）。

范围拍板与排除：`9b7b6cb30f` worktree 命名去重 = **N/A 跳过**（fork 从未继承上游 list()/外部工作区特性面，candidate() 已有创建名去重；若将来引入外部工作区再评）。

验证：全树 typecheck 0 错（chimera+plugin 双包）；集成门禁 test/session+provider+agent 48 文件 **1217 pass/1 fail**（唯一失败=对账表预存 compaction abort 时序 flake）；各波聚焦测试全绿（I1 210+109/P1 184+15/S1 15/S2 4/L1 126/W2 368/W3 142+20）；终态单二进制 build --single --skip-install --no-webui 通过（photon wasm+bedrock 4.0.112 打包无破坏；**未运行新二进制**，运行冒烟留给用户）。

过程事故与清理（详见 skill pitfalls #30-33）：I1 builder 被手动中止留半编辑态挡全树验证→父小修+同 task_id 续派完成；edit 锚点事故吞测试 env 行→mcp-add 子进程一度污染真实 ~/.config/chimera/chimera.jsonc（mcp.github/local）→已精确清理复核；bun.lock 内网镜像 URL 18 处→空串槽脱敏（协议入 pitfalls #33）。

残余非阻塞：单二进制 photon wasm 运行冒烟待用户；baseline（AVX2）target 构建未验；M10 backlog；web/docs config.mdx attachment 段未做；copilot chat 路径 raw usage 离线不可证（不带时回退 token 估算，可接受）；UTILITY_MODELS 代际会过时（上游同款跟随）。

### fix backlog 方法学（详见分诊文档 §7）

1044 fix 中：43 条安全关键词已全量逐条（→F0）；fix(tui) 91 条主题级（→F3）；无关表面 ~427 条（app227/stats84/desktop33/console27/ui21/acp19/data16）直接封板；**core 相关 backlog ≈374 条不单独展开**——随对应特性批次消化（MCP fix 随 F2、provider/openai/llm/core fix 随 L4、tui fix 随 F3、session/compaction fix 随 F1 对应项），并在 L4 开工前跑一次独立关键词筛（crash/hang/loss/leak/corrupt/race）防漏 P1 级——F0 的 P1（#43675）即为此类筛法命中。

### F 线验收

1. 每批次落地后：`bun typecheck` + 聚焦测试绿 + 单批次单提交可回退
2. F0 落地后回归验证：run 模式子代理触发权限询问 → 正确弹出并应答（不再挂死）
3. 每批开工前 re-fetch 上游做增量关键词筛（衔接「待定」节的周期性同步节奏）
4. 分诊文档随批次推进勾选状态，避免二次分诊


## 顺带发现的本仓问题（独立于迁移）

- `chimera graph status` 不支持 `-p/--projectPath`（`query` 有、`status` 没有，帮助文案与实际 flag 不符）。
- Node 26 下只读 graph 子命令被 tree-sitter 版本安全闸硬拦截，需 `CODEGRAPH_ALLOW_UNSAFE_NODE=1` 绕过——只读命令不应触发该闸。
- `drizzle-kit generate` 当前不可用：`migration/20260714000000_memory_system/snapshot.json` 格式与 drizzle-kit 不兼容（malformed）；最新两个迁移目录（model_telemetry 系列）已只有 migration.sql 无 snapshot.json。已手写 `20260901000000_add_session_share_url` 修复存量库缺列问题（`43135ac3f`）。
- Effect 升级后复测确认以下测试失败为预存问题，与升级无关：MCP daemon/handshake 9 个（MCP 已非 CodeGraph 接入面）、httpapi-config 8 个、httpapi-sdk 2 个、tool.chimera 1 个、cross-spawn cwd 1 个（macOS /var 软链）、compaction abort 时序 1 个。建议后续专项清理。
- 2026-09-04 L3.5 复核新增预存确认（干净 HEAD stash 复核）：`test/graph/pr19-improvements.test.ts` 的 low-rss pragma 用例失败——源码 `src/graph/db/index.ts:46` 默认 `CHIMERA_SQLITE_CACHE_MB=64`（-65536）与测试期望 -8192 失配；`test/provider/provider.test.ts` 的「plugin config enabled and disabled providers are honored」挂死（90s 超时，与 L3/WIP 均无关，疑与插件 host 子进程有关）。另：InstanceState 3 个用例全量负载下超时、单跑全过（负载抖动）。

## 待定

- ACP 是否恢复（默认否）。
- 上游跟踪分支 `upstream-sync` 的建立与周期性同步节奏（建议每层开始时 re-fetch 一次）。
- F 线（特性同步）已于 2026-09-04 完成全量分诊并纳入本计划（见「上游特性同步（F 线）」章节 + `UPSTREAM_FEATURE_TRIAGE.md`）；周期同步节奏建议以 F 批次为锚：每批开工前 re-fetch 上游做增量关键词筛。

---

## F2 完成记录（2026-09-17，builder 执行+parent 亲验裁决）

7 commits：`44bafa40c`(SDK 1.29.0+629 行 patch，逐字节对账)→`20d162b51`(catalog.ts 新建=15 条 fix 收敛点+roots/logs/cwd/callbackPort)→`408ccbd64`(instructions 注入 system prompt)→`ccd6ee63b`(debug CLI 三件)→`5a805bb70`(resource templates+读工具×3+READ_TOOLS)→`988015435`(SDK 重生成，携带 F1/L4 provider 字段滞后产物——生成物原子性)→`0d6964d2d`(session-recovery 可执行测试)。另 parent 小修：mcp debug token 打印掩码（前 20 字符→slice(0,4)***slice(-4)，对齐上游收敛）+删 src/mcp/index.ts 的 Installation 死导入（基线遗留）。

**对分诊/规格的两处修正（镜像 git show 实锤，防后续批次重拾）**：
1. `921b1c6a34`“SDK v2 升级”已被上游 `982a9044c5` 于 13h 后**整体回滚**——真实终态=`@modelcontextprotocol/sdk@1.29.0`+629 行 patch（非 client@2.x）；本批按终态移植。
2. `a131811cdc`“mcp__ 命名约定”已被上游 `947e0017f5` 于 11h 后**回滚**——上游 HEAD 与 fork 现状逐字相同（`<server>_<tool>`）。**该条从待办删除**；若强行落地会静默破坏用户既有 permission 规则（实测影响面 6 处）。

方法论沉淀：MCP 面移植以**上游 HEAD 终态**为基准（catalog.ts 收敛点），不重放 8 feat+29 fix 中间态。

29 条 fix 对账：修复 26 / 已等价 1 / 不适用 2（总和=29 ✓，逐条表见 builder 报告）。验证：typecheck clean×6、MCP lane 43/0、聚焦 385/0、新增 8 测试全绿；收口全量 24~31 fail 逐条归因全部落基线家族/flaky/他 lane（双跑自相差+隔离复跑证据），零新增归因本批。锁文件：anpm=0；语义化 diff=版本变更恰 1 条+21 条空 URL 归一化（sha512 不变）；**本机 bun install 必须显式 --registry=https://registry.npmmirror.com**（已固化 env.md）。

**Parent 裁决**：①三个 MCP 资源工具不进 explore allowlist（维持 MCP 面对受限 agent 全隐的一致性；resource 读取可能有 server 定义副作用；上游亦未加）②code-mode 接线=拍板池 #6 继续等用户③token 掩码=已修④死导入=已删⑤lifecycle.test 迁真 server harness=独立测试基建项入队。刻意保留 fork 形态（Bus/defaultLayer/open 直调/内联 OAuth 页/Chimera 品牌）未引入上游后期架构。

---

## claims（edit-intent）P1/P2/L2 完成记录（2026-09-17，builder 执行+parent 亲验裁决）

6 commits：`feac452dd`（存储：chimera_edit_intent_claim/waiter 两表，extension migration **v5 additive**，已应用迁移零触碰+全套 CRUD：惰性 TTL 过期/waiter upsert 去重/事务性 take）→`d3fffb00b`（门禁：claims 检查内嵌 requirePredesignForMutation——**edit/write/apply_patch 三工具零改动全覆盖**（重核新发现 apply_patch.ts:204 同调该门禁）；FCFS 队列公平：晚到 claim 永不锁死早持有者，同毫秒按 id 定序；degrade-open：claims 故障永不阻断变更）→`5739ed24a`（predesign 登记 stage+回执 CONFLICT 行限 3 条+教学面：predesign.txt/chimera.txt 协调节）→`eac6f211a`（take 幂等：条件 UPDATE changes 计数为原子点，3 路并发竞争实测恰一次）→`c55f5a8e2`（**L2 落地**：每实例 watcher（InstanceState+forkScoped，prompt() 首跑 arm）；session.idle→release+drain→injectSynthetic 唤醒；session.remove→release+自建 tree-world 事件广播（sync 的 session.deleted 在测试 harness 分裂世界不可靠，实测选型））→`9db0f8aa2`（L1 pull：prompt-context「Edit Intent Claims」块，零 claims 零字节）

五锚点重核：store.ts:222（v5 落点）/provenance.ts:801→**:908**/prompt-context renderContext:357/edit.ts:262→**:296**/write.ts:55→**:58**；新发现 apply_patch.ts:204。

验证：claims 家族 12 文件 **213/213**（含真实双 fiber 同抢+3 路 take 竞争，零 mock）；E2E 三场景全过（idle 释放唤醒自动续跑/busy-at-release 走自身 idle drain/remove 释放唤醒）；全量 **5267 pass/25 fail** 逐条对账全落已知基线，零新增归因；typecheck 全树 0 错；parent 抽测 32/32。

**Parent 裁决（八项拍板清单）**：①释放语义确认现状（会话 idle=run 完成即批次收口释放+remove=dispose 释放，符合 memory L83'closeout 挂钩'语义）②TTL 2h+60s 钳制确认，不加 config 旋钮（degrade-open+TTL+idle 释放三重兜底；出现真实误伤案例再小件加 kill-switch）③门禁全 agent 覆盖确认（协调与仪式正交，不依赖 predesign 可用性）④子代理唤醒不限会话类型（与 F4 通知语义一致，自动续跑是设计目标；token 成本=预期内，保持观察）⑤队列位次与 park 交互接受现状（advisory 公平；备选'pending waiter 保活 claim'会引入 park 期死锁风险，违背'晚到永不锁死早持有'原则）⑥广播式唤醒确认（符合计划书原文'先完成方释放广播唤醒另一等待 thread'，先编辑者赢其余重排）⑦**跨进程 poll→inject 桥批准立项**（按 builder 提案：waiter 行增 host_pid+host_boot_id 防抢醒、仅存在 pending waiter 时轮询 2-5s、惰性 stale-boot 清理；**migration v6**；~1-1.5 人日；排期=G1 之后、K-v2 主力前；真跨进程 E2E 留 CI——本机 EDR 红线）⑧F4-P1.5 配额陷阱与本批无交集，无动作。

遗留：~~跨进程桥（⑦已批待排）~~ → **⑦已落地（2026-09-17 批⑦，4 commits，见下节完成记录）**；文档回写本节即 claims 计划面收口（计划书 L246-252 的解冻条款全部兑现）。

---

## claims 批⑦ 跨进程 poll→inject 桥 完成记录（2026-09-17，builder 执行+parent 亲验）

4 commits：`e27a6b611`（存储：migration **v6 additive**——waiter 行增 host_pid+host_boot_id（`boot_<进程启动ms>_<pid>`，`Date.now()-performance.now()` 取真实进程起点）；登记默认盖本进程戳（被阻会话在自己进程内登记，天然准确），upsert 重登记即重盖章=重启修复路径；v5 零触碰走 extension 版本守卫；`CHIMERA_STORAGE_EXTENSION` 导出供测试构造 v5 世系；pin 5→6+升级幂等专测：旧行完整保留/新行盖戳/再开不重跑）→`265c920f4`（归属过滤 take：takeWoken/readWaiters 增可选 hostBootID 过滤，**releaseForSession/drainForSession/poll 三处调用全带 self 过滤**——他进程释放只翻 claim 行、绝不 flip 外来 waiter（丢醒修复核心）；NULL 行（pre-v6）不匹配任何过滤，仅 legacy 无过滤 take 或孤儿清扫可消费；条件轮询 3s：`pendingPollRoots` 内存 hint，零 waiter 零 DB 开销）→`be701d90b`（poll 纤维挂既有 editIntentWatch（InstanceState+forkScoped），poll/inject 故障 log 不杀纤维；fiber 级双 host E2E 测试）→`b125041c5`（真双进程集成：`Bun.spawn(process.execPath, worker.ts)` TS 源码允许道（abort-leak.test 先例姿势，零新鲜可执行物）——归属 take 偷不动+跨进程释放自 poll 唤醒（exit 0+WOKEN+行保留子进程 boot id）+**真死进程** boot-id 清扫，4/4 稳定）。

stale-boot 惰性清理：`sweepStaleHosts` 骑活跃 poll tick（与 claim TTL 同哲学）；判死=signal 0（ESRCH/EINVAL→死，EPERM→活，own-pid 永活），死判永久缓存（boot-id 含启动 ms，pid 复用不复活）；NULL-host pre-v6 行仅超 2h 宽限（=claim TTL）才清——混版老进程自醒路径保护。

exactly-once 论证：waiter 行按 host_boot_id 分区，每行只可能被宿主进程 flip（三处 take 全 self 过滤），跨进程双翻由构造排除；同进程并发沿用条件 UPDATE changes 守卫+SQLite 写锁串行化。丢醒闭环：他进程释放→本进程行保持 waiting→本进程 poll（≤3s）见 remaining=0→flip+本地 injectSynthetic。

验证：builder 聚焦 14 文件 **386/0**+typecheck×3 绿；parent 亲验复跑 4 文件批 34/34×2+依赖面（tool-metadata/edit/write gate）47/47+store 8/8。真跨进程 agent 级 E2E（双 server+真 parked 会话）=**CI-only**（端点红线，测试文件头已注明）。claims prompt-context flake（家族第一例）9 次探针未复现、与本批正交，仍记待修。

遗留（非阻塞）：pid namespace 局限（容器隔离 ns 共享项目卷可能互判误死——判死仅在 kill(0) 明确 ESRCH/EINVAL 时发生，注释在案）；混版窗口老进程 NULL waiter 2h 宽限后被清（宽限期内自醒完好）；poll limit 200/tick 病态多 tick 自愈；7 腿 prebuild 重 stage=K-v2 波次收口 parent 统一做。

**附带根因修复（parent，`34f745b1d`）——claims flake 家族第二例结案**：gate 测试「queues a later predesign…」负载下 ~30% 失败（blockedBy=predesign）。行级证据：DB inode/mtime 未变、无 jsonl fallback、raw sqlite 见 `chimera_predesign_run` 恰 1 行且属 ses_b——`recordPredesignRun` 的 id=sha256(createdAt:payload) **不含 sessionID**，两会话同毫秒+同 payload（测试均 `{}`）→同 id→`INSERT OR REPLACE` 静默顶掉 ses_a 证据行。归因=**origin/main 既有**（批⑤门禁批引入，非桥引入）。修复：predesign id 哈希入 sessionID；同类 `recordAuditRun` 哈希入 source+provenanceID（auto 审计 payload `{auto,status,changeFacts}` 无会话区分，swarm 并发同毫秒会顶掉 audit 证据行）；oracle id 哈希全量富载荷不动（碰撞即语义重复）。幂等保留（同会话/同突变同毫秒重录仍 REPLACE）。修后单文件 ×15 全绿（修前 ~1/3 失败）。

---

## L4 细分计划（草案 2026-09-20，待 parent 审定）

侦察基线：上游只读镜像 HEAD `9f69463f1d`（禁 fetch，分诊口径 v1.14.40 基线不变）；fork HEAD `b202b4e23`。所有锚点已按当前 fork HEAD 重取（09-08 后 F1/F2/claims/K-v2/R1 约 200 commits，旧锚点全部作废）。前置事实：fork 无 packages/llm、无 packages/client/httpapi-codegen/http-recorder、packages/core 无 integration/credential runtime、无 native-runtime；双方 effect catalog 同为 4.0.0-beta.83（llm 包版本兼容）；fork 根 workspaces glob `packages/*`（新包免改根清单）。§11 增量项中 timeout 默认（c548422ed/33ba2d52c）、bedrock deepseek id（afcfef7dc）、codex 版本过滤（599b94684）、SSE cancel（d7dc3080b）已在 09-17 批落地，L4 剩余 §11 项=SDK bump 六条+bedrock patch+gitlab variants+dev conditions（55c54d14b8 顺手件）；~~blockBinding 三连~~=拍板#12 否决（2026-09-20，不移植）。

关键词筛结论（§7 方法学要求的 L4 开工前独立筛）：`crash|hang|loss|corrupt|race|leak` × `llm|provider|model|sdk` 全窗命中 5 条——`0ee7cfa1fe` models 缓存损坏恢复：**fork 已等价**（fork `src/provider/models.ts:264-267` loadFromDisk catch→undefined→snapshot/fetch 兜底且 fetchAndWrite 覆写坏文件，殊途同归）；`a3825286cf` 为其 test-only 跟进（无关）；`87e9e700cd` google sdk tool-call-id 回滚（净零，L4.4 取 HEAD 终态自然满足）；`1f707f1b52` opencode-go provider URL（上游专属服务，无关）；`c9e2a38bf4` CI 模型名（无关）。**无 P1 级漏网**，变体组合（fix-scope 前缀/llm|provider scope 扩展词 deadlock|stuck|retry|timeout）复核零新增命中。

20 条并入项复评（llm 族 15 + sdk/client 5，对照 fork 当前 HEAD）：**仍适用 13 / 已消解 1 / 需重判 6**。
- 仍适用（随对应子批吸收）：llm 包 8 条（`77e6c0d329`/`942630eb4a`/`d5980b47e9`/`5f61d21487`(拍板#9，fork `src/session/codex-responses.ts:1150` strict:false 确认仍在)/`48fc9e3cc3`/`1fd8bf526d`(与 L4.3 交叉，以配置化为准)/`08c5a2a5e8`/`18466b8020`→L4.2 整包）；`dac0dd5309` connector auth、`cf80b5c470`+`c556bddda3` integration（拍板#7）、`4898263dec` 映射→L4.4（schema 层 integration/credential/connection 已 vendor 于 packages/schema，runtime 树缺）；`03afae5b95` v2-compat→L4.0。
- 已消解 1：`42bb793574` generate model variants——fork 数据驱动实现已覆盖且更强（`transform.ts:655-661` reasoning_efforts 直生 variants + `variants():1064` ultra 普适档 + `config/provider.ts:37/91` reasoning_efforts/variants 可配），上游硬编码 glm-5.2 形态无需移植；L4.2 vendor 时反向以 fork 数据表接 llm catalog transform。
- 需重判 6：`6618e2bce2` native-llm（落点 `session/llm/native-runtime.ts` fork 不存在，且**不在 packages/llm 包内**——原判"随 L4 整包吸收"不成立，是否引入 native runtime 归 L4.4/L5 重判）；sdk/client 5 条（`42e6b7db32`/`ef5c9f4931`/`f44423609b`/`cdd67cf30f`/`65210f2d97`——落点全在上游 packages/client+httpapi-codegen+core v2 session 树，fork 三表面皆无；L4 范围不含 client/codegen vendor，升级条款不触发，**顺延 L5 开工时复评**）。

`03afae5b95` 打头阵就绪核查：**切口成立**。证据：①`v2-compat.ts`(449 行)自诞生零漂移（`03afae5b95..HEAD` 无后续提交）；②其 4 个 import 在 fork 全有等价物——`core/schema` 的 PositiveInt/NonNegativeInt→fork `src/util/schema.ts:7,12`、ConfigAttachmentV1→`src/config/attachment.ts`、ConfigLSPV1→`src/config/lsp.ts`、InvalidError→`src/config/error.ts:14`（**修正分诊原注**："schema 依赖已 vendor"不准确——fork `packages/schema/src/v1/` 只有 legacy-event/permission/question/session，上游 `core/src/v1/config/*` 17 文件未 vendor；适配=import 重指 fork 自有 config 模块，语义同源）；③fork `config/config.ts`(1009 行) 插入点全在：`normalizeLoadedConfig:67`、decode 路径 `:507`、`updateGlobal:391`、`patchJsonc:415`、`loadGlobal:526`，上游 diff +32 行形态可直接适配；④66 文件中 60 个为测试 fixture，可原样搬。

共享文件串行矩阵（子批边界按文件交集≈零切分）：`config/config.ts`→仅 L4.0；根/chimera `package.json`+`bun.lock`→L4.1 与 L4.2 **强制串行**（L4.1 先）；`provider/transform.ts`→L4.1(gitlab +4 行)/L4.3/L4.5 **强制串行**；`provider/provider.ts`+`config/provider.ts`→L4.3/L4.4 串行。可并行对：仅 L4.0 ∥ L4.1。

### L4.0 — v2-compat 打头阵（`03afae5b95`，防用户 v2 配置在 chimera 下丢失）

- [ ] 搬 `v2-compat.ts` → `packages/chimera/src/config/v2-compat.ts`，import 重指 fork 等价物（见上）；品牌字段核对（v2 config 文件名 opencode.json→chimera 双读策略实现时定）
- [ ] `config/config.ts` 四处适配：decodeConfig 包装（normalizeLoadedConfig→ConfigV2Compat.lower→diagnostics warn→ConfigParse.schema）、loadFile 解码点 `:507`、updateGlobal 保留 v2 键合并语义（original-record merge）、patchJsonc 路径
- [ ] 搬测试：`test/config/v2-compat.test.ts`(400 行) + 60 fixture 文件 + `config.test.ts` 增量 + snapshot.ts
- [ ] 验收：typecheck 绿；v2-compat 测试全过；**纯 v1 配置读取字节不变**（diagnostics 零输出断言）；updateGlobal 回写不吞 v2 键
- [ ] 回退：单 commit revert（纯新增+config.ts 局部）

### L4.1 — SDK bump 批次（拍板#15，L4 provider 面开工前置，锁文件独占批）

- [ ] 六 bump 一次做完：openai 3.0.53→3.0.88（`23ec4f55c8`）、azure 3.0.49→3.0.93（`bec9ee41af`）、bedrock 4.0.112→4.0.166（`4502ee568e`）、gitlab 6.6.0→6.15.0（`0b082b065d`+`8d1f8916d3` 合并）、gateway 3.0.104→3.0.191（`199a4cdbea`，连带 provider 3.0.8→3.0.16/provider-utils 4.0.23→4.0.51，**批内最后统一回归**）
- [ ] bump 后两件：`1542195217` bedrock none-effort patch（patches/ + 根 patchedDependencies）；`7c2199d84a` gitlab reasoning variants（transform.ts +4 行）
- [ ] 重点回归：fork 自有 `src/provider/sdk/copilot/*` vendor 与 `codex-responses.ts` 路径（gateway/provider-utils 公共底座兼容性=分诊 §11.6 待深查项）
- [ ] 验收：typecheck 绿；test/provider+test/session 聚焦全绿；bun.lock 语义化 diff 审查（内网镜像 URL 脱敏协议，pitfalls #33）
- [ ] 回退：单 commit revert（lock+package.json 原子）

### L4.2 — packages/llm 整包 vendor（零接线，codemode L0.3 先例；吸收 llm 族 8 条）

- [ ] 整包搬入 152 文件（src 56 + test 86 + 配置/文档 10）→ `packages/llm`，包名 `@coding-chimera/llm` private；deps：@opencode-ai/schema workspace ✓、aws4fetch/@smithy 两件新增（触 bun.lock，故排 L4.1 后）、effect catalog: ✓ 同 beta.83
- [ ] http-recorder 决策（分诊 §3④ 升级条款）：recorded 测试族（~30 fixture）依赖 `@opencode-ai/http-recorder`（fork 无）——二选一：连带 vendor http-recorder（小工具包）或 recorded 测试降级 skip；**建议连带 vendor**（llm/core fix backlog 18+ 条的回归安全网价值高）
- [ ] 适配点最小化：包名/import 前缀替换；`@opencode-ai/schema` 指向 fork packages/schema（导出面差异实现时核对）；不做任何 v1 runtime 接线
- [ ] 验收：包内 typecheck 绿 + 非 recorded 测试全过；根全树 typecheck 绿；`chimera run` 行为字节不变（零消费者）
- [ ] 回退：删目录 + revert lock

### L4.3 — 模型能力配置化（三层合并：models.dev < provider 配置 < 全局 model_capabilities）

- [ ] Model schema 扩展（`config/provider.ts`，基于既有 reasoning_efforts:37/variants:91）：`sampling.{temperature,top_p,top_k}`、`reasoning_protocol`、`default_variant`、`default_effort`
- [ ] 硬编码提取为内置默认数据表（行为不变、可被配置覆盖）：`transform.ts` 温度/topP/topK/族检测（`:647-680` id 匹配链）/baseVariants+variants（`:1064`）；`models.ts:176` inferReasoningProtocol；`codex-model.ts` profiles
- [ ] 合并落点：`provider.ts:1437` fromModelsDevProvider + `:1229`/`:1664` reasoning_efforts 透传链——三层优先级在此收敛；`1fd8bf526d` model defaults/compatibility data 以配置化数据表形态吸收（勿照搬 llm 包内 precedence 实现）
- [ ] 验收：typecheck 绿；**默认路径行为不变断言测试**（提取前后 variants/transform 输出逐字节等价）；配置覆盖 E2E（chimera.jsonc 自定义 model 的 sampling/variants 生效）；test/provider 全绿
- [ ] 回退：单 commit revert

### L4.4 — provider 逐个迁移试点（DeepSeek 先，绞杀 flag 门控）+ 并入项吸收

- [ ] 迁移 seam：fork v1 `session/llm.ts:491` streamText 调用点为唯一收口——按 provider 逐个把 transport 切到 llm 包 route/executor（flag `experimental.llm_runtime` 默认关，关时字节不变，照抄 F4 门控手法）；DeepSeek（openai-compatible-chat 协议）首个试点，核对 models.dev 快照 npm 字段
- [x] ~~并入项吸收~~：`5f61d21487` strict 透传按拍板#9 未决保持 fork `strict:false` 现状（**关键新事实 2026-09-22**：上游 `5f61d21487` 已自行收敛为 strict:false 硬编码——分歧由上游消解，拍板#9 可按'已吸收'勾销）；`dac0dd5309` connector auth + `cf80b5c470`/`c556bddda3`/`4898263dec` integration 三件**保留（拍板#7）但移出 L4.4**——builder 取证：runtime 树缺口=core 的 State/EventV2/Database 整个 trunk（integration.ts 520 行 import 闭包依赖），vendor 它=L5 规模；**重规划为 L5 先导批**（core trunk vendor + integration/credential runtime + zen provider integration 化，server/sdk/tui 消费面随 L5 v2 表面推进）。schema 层已在 packages/schema 与上游字节一致
- [x] `6618e2bce2` native-llm 重判：**已答=要**（2026-09-22 builder 结论）——L4.4 落地的 NativeLLMGating 与上游该提交结构同构，表面已存在；Anthropic API-key 转 pilot #2 backlog（Anthropic 路径有 cache_control/interleaved-thinking 深度定制，需独立 parity 对账批，绞杀纪律=一个试点验证后再扩）
- [ ] 验收：flag 关全量测试字节不变；flag 开 DeepSeek 试点 E2E（真实额度冒烟）+ recorded 测试族绿；两路径成本/usage 统计一致性对账
- [ ] 回退：flag 关闭即回退；代码单 commit revert

### ~~L4.5 — blockBinding 三连整包~~ **已取消（拍板#12 否决，2026-09-20 用户裁决）**

不移植理由：Anthropic 远端自带 system prompt，前缀含客户端不可见/不可控内容，客户端侧 thinking 签名绑定没有正确且优雅的适配落点。涉及条目 3f39a329c3/68abdce1a0/9a71624d2d 全部改判 ④（决策性排除，见 UPSTREAM_FEATURE_TRIAGE.md §13.5）。风险姿态：fork 不启用 Claude 5.x + adaptive thinking 的前缀绑定组合，风险面不激活；Anthropic 若未来开放前缀可控面需重新拍板。

### L4 完成验收

1. 全部相关包 `bun typecheck` 绿 + `bun test --timeout 30000` 聚焦族全绿（预存失败按既有对账表归因）
2. flag 全关时 `chimera run` 真实任务行为与 L4 前一致（字节不变断言 + 真机冒烟）
3. `model_capabilities`/provider 配置三层覆盖在真实 chimera.jsonc 生效（用户可验证变化=总体大纲 L4 行承诺）
4. llm 包测试族（含 recorded，若 L4.2 决策 vendor http-recorder）作为常驻回归网入 CI
5. 分诊文档 20 条并入项状态回写勾销；拍板#7/#9/#12/#15 决议记录归档

执行顺序：**L4.0 ∥ L4.1 → L4.2 → L4.3 → L4.4**（L4.5 已随拍板#12 否决取消；唯一并行对=L4.0∥L4.1；其余因 bun.lock/transform.ts/provider.ts 共享面强制串行）。`55c54d14b8` dev conditions 任意批次顺手件。工期估算：L4.0 ~1 天、L4.1 ~1-2 天、L4.2 ~1-2 天、L4.3 ~3-4 天、L4.4 ~3-5 天（试点），合计 ~9-13 天。

L4 风险 top5（含 F1/F2/K-v2 新交互面）：①**gateway/provider-utils 公共底座 bump × fork copilot/codex-responses vendor**（F1 计费改造后 fork 自有面加深，§11.6 待深查，L4.1 最大回归面）；②**配置化提取 × K-v2 后的 transform 热路径**（R1 hotspot 批已动指令装配缓存，L4.3 数据表化不得破坏 memo/缓存假设）；③**llm 包迁移 × F4 后台子代理/F2 MCP 引擎新表面**（注入续跑轮与 remote-compaction 走 llm 新 transport 时上游零验证，L4.4 flag 矩阵必须覆盖）；④~~blockBinding patch 体系 × bun.lock 脱敏~~（已随拍板#12 否决消解）；⑤~~integration/connector auth 品牌拍板悬置~~（已随拍板#7 三层全保留消解，L4.4 范围确定）。

## L5 细分计划（2026-09-23 定稿，parent 依 scout ses_f33e40b59 侦察裁决）

**L5.0 决策闸（parent 已裁，终报可覆议）**：①seam 选型=**最小 seam**（event.ts 的 Location 依赖降为 ~10 行本地 shim，不 import location.ts/project.ts，省 ~2k 行闭包）②DB 隔离=**独立 `chimera-v2.db`**（上游 TS 迁移绝不应用于生产 chimera.db——lineage 已分叉：fork 缺 20260611_credential、有专有 20260903_session_context_epoch/20260918_background_job；integration 凭证与 fork 会话分库是 pilot 期显式代价）③**L5.4 正式关闭**：sdk/client 5 条全堵在 v2 server/client/codegen/core-session 树（fork 皆无），维持 ④，schema 部分已随 fork schema 同步自动吸收、core/event 部分随 L5.1；v2 服务面立专项批属 L6 级另议。

**关键前提修正（scout 实锤）**：a) fork 非白纸——自有 `@/sync` 事件轨（SyncEvent+event/event_sequence 表+projector）+`@/v2/event.ts` shim+SQL-dir 迁移 lineage 与上游分叉；b) **上游 core/background-job 不接 State**（纯进程内 SynchronizedRef，注释明写 not durable）——fork 引擎（752 行，durable 表+delivery 状态机）是其超集，"调度适配"与 State 零耦合，L5.3 可全程并行；c) `76ee87ead8`=215 文件 v2 session runtime 整包，不是 background-job 单件；d) schema/protocol/effect-drizzle-sqlite/app-node/layer-node 与上游**逐字节一致**。

**L5.1 core trunk vendor（Lane A 关键路径，~4-5 人日）**：vendor 清单=state.ts(128)/event.ts(638,Location shim 化)/event/sql.ts/database/{database.ts,schema.sql.ts,path.ts(+core/schema.ts),migration.ts,migration.gen.ts,schema.gen.ts,migration/×38,sqlite.ts,sqlite.bun.ts,sqlite.node.ts}；packages/core package.json 补 `#sqlite` 条件映射（bun/node/default）；database.ts path() 硬编码 opencode.db→改 chimera-v2.db；drizzle-orm 版本面复验（fork catalog beta.19 vs effect-drizzle-sqlite 声明 rc.2）；bun 变体全验、node 变体仅编译通过；**迁移只落 chimera-v2.db**。

**L5.2 integration/credential runtime（Lane A 串行后段，~3-4 人日）**：credential.ts(138)+credential/sql.ts→integration/connection.ts→integration.ts(520，用 makeLocationNode 不需 project 树)；补迁移 20260611035744_credential（落 chimera-v2.db）；拍板#7 品牌纪律沿用（opencode 标识不动）。**connector auth+provider↔integration 映射后段（~5-8 人日）依赖 catalog/provider/session-runner v2 树，拆为独立后续批，不在 L5.2**。

**L5.3 F4-P2（Lane B 并行，~2-4 人日，与 Lane A 文件零交集）**：fork 引擎上的纯整合——swarm 后台化/预算策略/dispose 矩阵/closeout 协议；若将来引入 core/background-job 原语=双轨并行非替换，fork 引擎保持权威。

**L5.5 双轨成文**：上游 core/database 只服务 integration/credential/event v2 服务；统一到 core/database 的「替换」属 L6 级独立迁移批（fork 全部自有迁移 lineage 收敛），不在 L5。

**L5 完成记录（2026-09-23，全部推送）**：

- **L5.1**（6 笔）：trunk vendor（state/event/database 38 迁移）+Location 17 行 shim+#sqlite 映射+chimera-v2.db 隔离+drizzle rc.2 字面 pin（追认）；trunk 12/12；P0 三重实证（迁移无路径触 chimera.db）。
- **L5.2**（4 笔）：credential/integration/connection/integration.ts 字节一致；shim 零扩展；trunk 4/4（迁移落隔离库）。
- **L5.3 F4-P2**（3 笔）：swarm worker 注册为引擎前台 job（双层豁免 background_concurrent，AGENTS.md 已回写）；预算一致性纯测试锁定；**真实缺口修复：引擎 teardown finalizer**（实例 dispose 杀 running job，矩阵三腿测试）+closeout 五条协议成文。862/0。
- **L5.4a**（7 笔）：wildcard/policy/provider/model/catalog/session-schema/runner-model 字节一致（唯一 seam=5 行 llm import 说明符）；**4898263dec 映射随 vendor 自然到位**；trunk 21/21 含 Bearer roundtrip。
- **L5.4b**（5 笔）：plugin provider opencode.ts 及其 v1/config 闭包 17 文件字节一致+Plain<T> seam+plugin host seam（catalog+integration adapter，其余 hook=响亮 die 桩）；connector auth 后端=上游 30aec297d8 已并入 integration/credential 树（L5.2 已 vendor）故新增=fork server 消费面：**httpapi v2 integration/credential 9 端点双 parity**+**首个接线层 src/server/v2-integration.ts**（AppNodeBuilder 编译 core trunk，DB 恒替换 chimera-v2.db，Location 绑 server cwd pilot 限制）；SDK regen；品牌测试钉死拍板#7（opencode integration ID/client_id/console 标签原样）；test/server 288+新 4/4+bridge 36/36。
- **L5.4 正式关闭**（sdk/client 5 条维持④，v2 服务面属 L6）。
- **L5 遗留入 L6 清单**：Location 多点绑定/PluginHost 全树 vendor/ui-server Screens 决策/v2 server+client+codegen 整包/connector auth oauth page 消费面/cross-spawn 环境失败归因。


## L4.0/L4.1 完成记录（2026-09-21，builder 执行+parent 联合验收裁决）

- **L4.0** `a7f28e473`：v2-compat 移植（68 文件 +1843/−15）。品牌双读=chimera.json[c] 优先+opencode.json[c] 回退（全局目录与项目 walk-up 同规）。裁决两个 follow-up：`subagent_depth` 接受-only 暂不映射（L4.3 再议）；`experimental.policies` 静默丢弃=安全相关，排小修=存在却被丢弃时 diagnostics warn（勿静默，随 L4.3 批）。
- **L4.1** `e17343242`+`45e114039`+`81175a2ff`：SDK bump 六条（openai 3.0.88/azure 3.0.93/bedrock 4.0.166+patch/gitlab 6.15.0/gateway 3.0.191+provider 3.0.16+provider-utils 4.0.51）+bedrock none-effort patch（**仅取 none 枚举，blockBinding hunks 已按拍板#12 剥离**）+gitlab reasoning variants（fork 适配超上游：发现层 family 派生使动态 workflow 模型也拿 variants）。commit 原子性=三笔各自可 frozen-install。
- **§11.6 风险实锤并已处置**：openai 3.0.88 嵌套 provider 3.0.14 的 `unique symbol` 品牌与顶层 3.0.16 名义分裂→fork 自有 hosted-web-search 两处带注释 scoped cast（`Symbol.for` 全局注册实证 runtime 安全）。
- **联合验收**：typecheck 绿；config+provider 族 713/0；session 族 542/0；全量套件 5452 tests/**26 fail=重述基线精确命中**（环境16+httpapi-config8+SDK2，零负载池零新增）；bun.lock anpm=0；推前五类审计零命中；同波推送（K-v2 原子先例）=origin `81175a2ff`。
- pitfall 沉淀：#41 pgrep -f 模式自匹配（bench 守卫改可执行名/PID 文件）。
