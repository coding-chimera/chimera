# Upstream v2 底座迁移计划

状态：L0 + L1 + L2 + L3 已完成并推送（L3 落地 2026-09-04，五线程拆分 8 提交，origin/main 已同步；细分计划与验收见下文）——Effect beta.83、schema/protocol 包、插件 v2 host、codemode、grep 权限修复、LayerNode、effect-drizzle-sqlite、SystemContext 引擎/context epochs/提示词 Source 化/v2 事件契约收编均已落地。特性侧：fork 点以来上游全量 feat/安全 fix 分诊已完成，见「上游特性同步（F 线）」章节与 `UPSTREAM_FEATURE_TRIAGE.md`。
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
批次进度（2026-09-07）：**F0 ✅ 完成**（5 修复+测试落地，未 commit）；**F4-P1 ✅ 完成**（四阶段，见下方完成记录，未 commit）；F1/F2/claims P1P2 未启动。
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
- **新增开放问题（不阻塞 P1）**：跨进程唤醒——inject 限同进程会话；独立 CLI 进程里的 parked thread 无法被 inject 唤醒（WebUI 多 thread 同进程不受影响）。claims L2 需 poll→inject 桥（各进程轻量轮询项目 DB 的 claims 释放记录、唤醒本进程 parked 会话），列为 claims L2 设计点。

#### F4-P1 完成记录（2026-09-07，未 commit）

四阶段串行派工（builder=deepseek-v4-flash-0731 high，root 逐阶段 diff 复审+独立重跑）：

1. **阶段1 引擎**：`src/agent/background-job.ts`（382 行：list/get/start/extend/wait/cancel，done Deferred，tail 串行 extend，token 防 ABA，interrupt-only→cancelled，内存注册表有意不持久化，BackgroundJobLimitError 打满拒绝不排队）+ config `delegation.background_subagents`（默认 true，kill-switch）/`background_concurrent`（默认 16）。
2. **阶段2 task 接线**：`background` 参数（双 schema，kill-switch 关时 jsonSchema 换窄+description 字节不变，照抄上游手法）；后台派发=prepare 授权/路由/遥测照常→materialize 建子会话→jobs.start（fork run）→notify 纤维 wait 终态→injectSynthetic 注入父会话自动续跑（`<task_result>/<task_error>` fork 文案）；resume 撞 running→extend 串行。**会话可寻址 inject 原语**（prompt.ts injectSynthetic，claims L2 可直接复用）；dispatch 拆分 materialize/runPreparedCore/runPreparedBackground，同步路径 limiter 与行为零变化（task.test 66/66）。
3. **阶段3 cancel 表面+级联**：新工具 `task_cancel`（.ts+.txt，归属守卫=仅派发会话可取消、终态幂等、kill-switch 关清晰报错、可见性跟随 task 不进 explore allowlist）；run-state.cancel 入口 BFS 传递闭包（pending frontier+cancelled visited+running 过滤保终止，防环测试锁 onInterrupt 恰一次）+ 自然递归链核实成立（双保险）；session.remove 单层清理；BackgroundJob.defaultLayer 三处挂点凭层 memoization+InstanceState 同实例（测试实证）。
4. **阶段4 可见性+矩阵**：prompt-context `backgroundTasks` section（仅本会话 running job、三重门控、缺席零字节、参与 hash-diff）；容量预检前移 materialize 之前（超限不留孤儿会话）；injectSynthetic 类型化 NotFoundError+notify ignoreCause({log:true})（父会话已删时安静落空不杀纤维）；**矩阵A 注入×compaction 相撞=完整 E2E**（llm.hold 栅门，存储一致+三轮续跑+无重复消化）；**矩阵B ultra×后台**（显式 ultra 拒绝+父 ultra 剥离测试锁定）。

**与拍板记录的实现偏差（root 复审认可）**：后台 run 不经 DelegationLimiter——拍板⑤默认口径为"后台子终生占 permit+独立上限"，实现改为完全解耦（background_concurrent(16) 独辖后台，永不蚕食前台 max_concurrent(128)，总并发上界 128+16 仍有界）：解耦从根上消除"蚕食"问题，优于缓解方案，意图不变。

**验证**：F4 测试家族 113 pass/0 fail（7 文件）+ typecheck 绿 + test/session 495 pass（唯一失败=compaction abort 时序预存，memory.md beta.59 基线佐证）+ tool 目录仅预存 tool.chimera 1 条（stash 复核）。各阶段 predesign/audit 齐全（阶段4：predesign_215fa11fcf145101、audit_aaeab1fee6da4988 等），obligations 0。

**残余/非阻塞**：swarm 原生 first-wins 等 P2（P1 期用 N×task(background)+task_cancel 手动模式，task.txt 已教）；newweb `(background)` 专属渲染属 P3（metadata 已发布）；跨进程唤醒（claims L2 poll→inject 桥）仍开放；compaction 时序用例高负载偶败（预存）。
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
