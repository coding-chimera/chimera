# Upstream v2 底座迁移计划

状态：L0 + L1 已完成（2026-09-01）——Effect beta.83、schema/protocol 包、插件 v2 host、codemode、grep 权限修复均已落地并提交
制定：2026-08-28，基于对上游 opencode（`refs/remotes/upstream/dev` = `755ebdb94`，v1.18.25）与本 fork（fork 点 `98e091796`，2026-05-07，opencode v1.14.40）的 swarm 探测 + 跨仓图精读（上游克隆仓 `/Volumes/workspace/opencode`，图已索引）。

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

- **LayerNode 最小子集**：`packages/core/src/effect/` 下 5 文件 + 3 测试；核心 `layer-node.ts`（333 行，含编译期依赖检查）。坑：`location-services.ts:92-96` replacements 必须在 hoist 期应用；`runtime.ts` 硬编码上游 Observability（搬运时参数化）；勿搬 `dfdf` 垃圾文件。
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
| L2 | LayerNode 最小子集 + effect-drizzle-sqlite + 日志 shim | ~3-4 天 | 无感知 |
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

Model schema 扩展字段：`sampling.{temperature,top_p,top_k}`、`reasoning_protocol`、`variants`、`default_variant`、`default_effort`。现有硬编码（`src/provider/transform.ts` 的温度/topP/topK/族检测/variants、`src/provider/models.ts` 的 `inferReasoningProtocol`、`src/provider/codex-model.ts` 的 profiles、`src/provider/ultra.ts` 的默认列表）提取为内置默认数据表，行为不变、可被配置覆盖。

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

## L2 细分计划

目标：搬入新底座骨架（LayerNode 服务组装机制 + effect-drizzle-sqlite），**不接任何现有代码**，为 L3 Session V2 打地基。行为零变化。

### L2.1 — LayerNode 最小子集

从上游 `packages/core/src/effect/` 搬入（`/Volumes/workspace/opencode` 只读参考）：

- [ ] 搬入文件：`layer-node.ts`（333 行核心：Node 声明 + 编译期依赖检查）、`app-node.ts`、`app-node-builder.ts`、`app-node-platform.ts`、`service-use.ts`、`memo-map.ts`、`keyed-mutex.ts`、`runtime.ts`
- [ ] **不搬**：`dfdf`（上游垃圾文件）
- [ ] 适配点：`runtime.ts` 硬编码了上游 Observability——搬入时参数化，不绑定上游实现
- [ ] 注意 hoist 约束：replacements 必须在 hoist 期应用（上游 location-services 注释），搬运时保留该顺序约定
- [ ] 落点：packages/chimera 内新增（与现有 `src/effect/run-service.ts` 的 makeRuntime/InstanceState 体系并存，不动旧代码）
- [ ] 搬入上游对应测试：`test/effect/layer-node/` + `keyed-mutex.test.ts`（observability.test.ts 视是否搬 observability 模块而定）
- [ ] 验证：新测试全过 + `bun typecheck` 绿

### L2.2 — effect-drizzle-sqlite 包

- [ ] 从上游 `packages/effect-drizzle-sqlite/` 整包搬入（src/ 含 effect-sqlite、sqlite-core、up-migrations、internal；test/、examples/ 视情况）
- [ ] 包名按本仓惯例保留 `@opencode-ai/effect-drizzle-sqlite`，private
- [ ] 依赖核对：effect catalog:（已 beta.83）、drizzle-orm 版本对齐（上游已升 1.0.0-rc.2，本仓现状需核对）
- [ ] 不从 `src/storage/db.ts` 迁移任何东西——现有存储层不动
- [ ] 验证：包内 `bun typecheck` + `bun test` 全过

### L2.3 — 日志 shim（并存保证）

- [ ] 确认现有 `@opencode-ai/core/util/log` 在 beta.83 下继续工作（L1 已验证 typecheck 绿，此项多为确认）
- [ ] 若 LayerNode 落地需要上游 observability/logging，则以独立模块搬入，**不改** 84 处现有 `util/log` 调用点

### L2 完成验收

1. 全部相关包 `bun typecheck` 绿
2. LayerNode 与 effect-drizzle-sqlite 自带测试全过
3. `chimera run` 行为与 L1 构建完全一致（无感）

## 顺带发现的本仓问题（独立于迁移）

- `chimera graph status` 不支持 `-p/--projectPath`（`query` 有、`status` 没有，帮助文案与实际 flag 不符）。
- Node 26 下只读 graph 子命令被 tree-sitter 版本安全闸硬拦截，需 `CODEGRAPH_ALLOW_UNSAFE_NODE=1` 绕过——只读命令不应触发该闸。
- `drizzle-kit generate` 当前不可用：`migration/20260714000000_memory_system/snapshot.json` 格式与 drizzle-kit 不兼容（malformed）；最新两个迁移目录（model_telemetry 系列）已只有 migration.sql 无 snapshot.json。已手写 `20260901000000_add_session_share_url` 修复存量库缺列问题（`43135ac3f`）。
- Effect 升级后复测确认以下测试失败为预存问题，与升级无关：MCP daemon/handshake 9 个（MCP 已非 CodeGraph 接入面）、httpapi-config 8 个、httpapi-sdk 2 个、tool.chimera 1 个、cross-spawn cwd 1 个（macOS /var 软链）、compaction abort 时序 1 个。建议后续专项清理。

## 待定

- ACP 是否恢复（默认否）。
- 上游跟踪分支 `upstream-sync` 的建立与周期性同步节奏（建议每层开始时 re-fetch 一次）。
