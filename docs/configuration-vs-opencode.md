# Chimera 配置与上游 opencode 差异清单

> 全量配置参考见 [./configuration.md](./configuration.md)；本文是 fork 相对 upstream opencode 的**差异**清单，只写两边不同的地方，相同部分不重复。

最后核对：2026-09-08，fork 侧以当日 `packages/chimera` 工作区源码为准，上游侧以当日上游检出内容为准。

## 目录

1. [背景与方法](#1-背景与方法)
2. [差异速览](#2-差异速览)
3. [List A：fork 新增的顶层键](#3-list-afork-新增的顶层键)
4. [List B：上游键内新增的嵌套字段](#4-list-b上游键内新增的嵌套字段)
5. [List C：命名与语义变化](#5-list-c命名与语义变化)
6. [List D：移除或收窄的上游键](#6-list-d移除或收窄的上游键)
7. [环境变量差异](#7-环境变量差异)
8. [从上游迁移注意事项](#8-从上游迁移注意事项)
9. [已知文档/运行时不一致](#9-已知文档运行时不一致)
10. [证据与置信度备注](#10-证据与置信度备注)

---

## 1. 背景与方法

本文所述 **upstream opencode / 上游** 指原 opencode 项目（Chimera 的 fork 起点），**fork** 指本仓库（Chimera fork 工作区）中的 Chimera 发行版（主包 `packages/chimera`）。Chimera 是 opencode 派生的 agent 运行时 + CodeGraph/audit 图子系统，配置层沿用了上游的整体结构但做了大量 fork 本地改造。

对照方法：以**双侧源码逐字段比对**为主，fork 侧 `packages/chimera/src/config/`，上游规范 schema 在 `packages/core/src/v1/config/`（`ConfigV1.Info` 及各域 schema），上游运行时 loader 在 `packages/opencode/src/config/`（引用 `ConfigV1.Info`，并透过 `v2-compat.ts` 做 v2→v1 降级）。fork 把上游"core 包 schema + opencode 包 loader"两层结构折叠为包内单一 `Schema.Struct`（`packages/chimera/src/config/config.ts` 的 `Info`）。文件名/环境变量/路径类差异另行核对了 `paths.ts`、`managed.ts`、`parse.ts`、`config.ts`（well-known URL）、`packages/core/src/flag/flag.ts`、`src/browser/runtime.ts`、`src/project/instance-store.ts`、`src/graph/directory.ts` 等。fork 的 git 历史（只读 `git log`）用于佐证各新增项的来源。

证据类型标记：

- `[module]`：整个模块上游不存在（或双侧位置完全不同）
- `[field]`：字段级差异（上游无此字段/类型不同）
- `[default]`：字段相同但默认值或语义不同
- `[name]`：改名（文件名、域名、路径、URL）
- `[env]`：环境变量新增/改名/别名
- `[git]`：有 fork 提交佐证（提交号+主题）

置信度：H = 双侧源码都实际核对过；M = 只核了一侧，或由命名/行为推断；L = 无直接证据。除特别标注外，本文条目均为 H。

一个必须提前说明的旁证问题：仓库内 `packages/web/src/content/docs/config.mdx` 是文档站内容，其中出现了 `compaction.remote` / `remote_protocol` 章节。经复核，这部分是 fork 本地文档、与 fork 源码一致（fork 源码确有远程 compaction 配置），**上游源码没有任何远程 compaction 配置**——因此 `config.mdx` 只可作 fork 侧旁证，不可作为上游行为的证据；文档站与上游源码"脱节"仅体现在它们描述的是不同代码版本。

## 2. 差异速览

| 类别 | 数量 | 代表条目 |
|---|---|---|
| 新增顶层键 | 5 | `delegation`、`memories`、`free_models`、`ultra_models`（已废弃）、`remote_compaction_models` |
| 上游键内新增嵌套字段 | 约 30 | `agent.<n>.top_k` 等采样五件套、`provider.*.wire_api`、`provider.*.remote_compaction`、`compaction.remote`、`experimental.system_context`、permission 11 个新键 |
| 命名/语义变化 | 约 15 | `chimera.json[c]` vs `opencode.json[c]`、`.chimera/` vs `.opencode/`、`$schema` URL、`.well-known/chimera`、上游未知键忽略→fork 拒绝、首启不预建全局配置 |
| 移除或收窄 | 13+ | `references`/`reference`、`attachment`、`subagent_depth`、`experimental.policies`、`command.<name>.variant`、`mcp.local.cwd`、`model.status="active"`、`interleaved` 取值收窄、`v2-compat` 层 |
| 环境变量差异 | 7 组 | `CHIMERA_BROWSER_*`、`CHIMERA_INSTANCE_*`、`CHIMERA_DATA_DIR`、`CHIMERA_ALLOW_UNSAFE_NODE`、`CHIMERA_SQLITE_*`、`CHIMERA_ALLOW_LEGACY_OPENCODE_ORIGIN`、`CHIMERA_OPENCODE_ENV_ALIASES` 别名机制 |

另有几项"上游本来就有、不是 fork 新增"的易误判条目：`skills.urls` 与 `enabled_providers`/`disabled_providers` 均同时存在于上游 schema（`packages/core/src/v1/config/skills.ts:9`、`config.ts:68,71`）；`provider.<id>.models.<m>.variants`（含 `disabled`）也与上游同形（`packages/core/src/v1/config/provider.ts:69-79`），Chimera 特有的只是 `ultra` 变体语义；`experimental.primary_tools` 同样上游已有（见第 4 节该行注记）。下文均不列入新增。

## 3. List A：fork 新增的顶层键

以下五个顶层键均不存在于上游 `ConfigV1.Info`（上游 `packages/core/src/v1/config/config.ts` 的 `Info` 结构已逐字段核对）。

### 3.1 `delegation` — 子代理模型委派

- 用途：子代理模型委派配置：命名模型档案（profile）、角色路由、成本感知调度（scheduling）、委派深度/并发上限、后台子代理开关。上游没有任何对应概念（上游只有已被移除的 `subagent_depth`，见第 6 节对应行）。
- 关键子字段速览（`packages/chimera/src/config/delegation.ts`）：
  - `model_profiles.<name>`：`{ model: ConfigModelID, variant?, description? }`
  - `routes.<role>`：角色 → profile/model 的字符串路由
  - `scheduling.enabled`、`scheduling.spend`（`subscription-first` | `metered-first`）、`scheduling.quotaFloorPercent`、`scheduling.quotaStrainPercent`、`scheduling.rlStrainThreshold`
  - `scheduling.archetypes.<workload>`：`minQuality`、`effortCap`、`maxSizeClass`/`minSizeClass`（S/M/L/XL）、`weights.{quality,speed,cost,size}`、`budgetUsdPerWorker`、**`excludeModels`**（精确 provider/model 路由、模型身份或 provider id 名单，被排除者永不作该 workload 的调度候选；声明的 dispatch 若使用被排除模型会直接失败）
  - `scheduling.capability_anchors.<modelIdentity>`：`{ score, tier?, uncertainty? }`，覆盖内置能力锚点
  - `scheduling.overrides.<provider>`：`{ billing }`
  - `scheduling.topTierDisabledMinSizeClass`：超过该尺寸级别时丢弃最高推理档
  - `max_depth`：含根会话在内的委派链深度上限，**默认 3**（`DEFAULT_MAX_DEPTH = 3`）
  - `max_concurrent`：全运行时并发预算，**默认 128**（`DEFAULT_MAX_CONCURRENT = 128`）
  - `background_subagents`：后台子代理总开关，**默认 true**（`DEFAULT_BACKGROUND_SUBAGENTS = true`，关掉即 kill-switch，回退为同步委派）
  - `background_concurrent`：后台任务独立并发上限，**默认 16**（`DEFAULT_BACKGROUND_CONCURRENT = 16`），达到上限直接报错不排队
- fork 源文件：`packages/chimera/src/config/delegation.ts`（整模块）；顶层字段在 `packages/chimera/src/config/config.ts:255`
- git 佐证：`17036937b feat(agent): model profile delegation and session permission slot injection`（已 `git log` 复核）；后续扩展 `28ad87ddd feat(agent): add cost-aware subagent scheduling`、`21345ac72`、`d55bb2f57`、`faf8a419d feat(agent): delegation usage telemetry, capability curve v2, archetype tuning`、`de0390767`、`a143b3c23`
- 证据/置信度：`[module]`（上游 `packages/core/src/v1/config/` 与 `packages/opencode/src/config/` 均无 `delegation.ts`）`[git]`，H

### 3.2 `memories` — 跨会话记忆

- 用途：跨会话持久记忆配置。默认关闭，须显式开启。
- 全部叶子字段（`packages/chimera/src/config/memory.ts`）：
  - `enabled`：开启跨会话记忆，默认 false
  - `use_memories`：开启时是否注入历史记忆，默认 true
  - `generate_memories`：是否允许 Chimera 生成/更新记忆，默认 true
  - `disable_on_external_context`：含外部上下文的会话跳过自动记忆生成，默认 true
  - `dedicated_tools`：暴露专属记忆工具（`memory_remember`/`memory_list`/`memory_forget`/`memory_read`），默认 false
  - `max_summary_chars`：注入记忆摘要的最大字符数，默认 12000
- fork 源文件：`packages/chimera/src/config/memory.ts`（整模块，含 `Defaults` 常量）；顶层字段在 `packages/chimera/src/config/config.ts:305`
- git 佐证：`3b79a0b32 feat(memory): implement file-backed cross-session memory subsystem`（已复核），后续扩展 `4b410c5acc`
- 证据/置信度：`[module]` `[git]`，H

### 3.3 `free_models` — 免费模型门控

- 用途：限制 provider 暴露无凭据的 $0 免费模型（目前指 opencode provider 的匿名免费档）。受限环境（如不允许外网免费模型的企业内网）可置 false：无凭据时整个 provider 不加载，有凭据时其 $0 模型被隐藏。默认 true。
- fork 源文件：`packages/chimera/src/config/config.ts:178`
- git 佐证：`c3411251e feat(provider): free_models config gate for the anonymous free tier`（已复核）
- 证据/置信度：`[field]` `[git]`，H

### 3.4 `ultra_models` — 已废弃

- 用途：已废弃的 ultra 档模型名单。现在 ultra 档在**每个**模型上都有（模型的最高推理 effort 值副本，或纯编排档案），该键不再影响行为，仅保留以便旧配置不报解析错，条目被忽略。schema 描述原文明确写了 "Deprecated: ultra is now advertised on every model... entries are ignored."，仓库 `AGENTS.md` 的 "Ultra tier semantics" 一节可佐证。
- fork 源文件：`packages/chimera/src/config/config.ts:182`
- git 佐证：`dcfb89d4b feat(provider): advertise ultra variant on all models with orchestrator discipline`（引入，已复核）；废弃状态由同一文件内描述标注
- 证据/置信度：`[field]` `[git]`，H

### 3.5 `remote_compaction_models` — 远程 compaction 模型名单

- 用途：允许远程 compaction（OpenAI Responses API compaction）的模型名白名单，按 `model.api.id` 精确匹配或版本化前缀（`<entry>-...`）匹配、大小写不敏感；**扩展**内置可信默认值。多层配置按 union 合并（`mergeConfigConcatArrays`）。
- fork 源文件：`packages/chimera/src/config/config.ts:186`（合并逻辑同文件 :60-62）
- git 佐证：`d6468197e feat(agent): make ultra and remote compaction config-driven`（已复核）
- 证据/置信度：`[field]`（上游无任何远程 compaction 配置）`[git]`，H

### 3.6 新增键之间的交互

这五个键不是孤立的，与既有键联动：`delegation.scheduling` 的尺寸/质量评估会用到 `provider.<id>.models.<m>.size_class`（显式尺寸档覆盖模型身份推断值，见第 4 节）与 `scheduling.capability_anchors`（用户侧能力锚点）；`remote_compaction_models` 与 `provider.<id>.remote_compaction`（provider 显式授权）、`compaction.remote`/`remote_protocol`（开关与协议选择）组成完整的远程 compaction 配置面；`ultra_models` 废弃后，`variant: "ultra"` 通过在 `agent.<name>.variant`/模型变体里显式选择（fork 在 `src/provider/transform.ts` 向所有模型通告 ultra，`AGENTS.md` "Ultra tier semantics" 一节有完整说明）。

## 4. List B：上游键内新增的嵌套字段

| 点路径 | 类型/取值 | 用途 | fork 源文件 |
|---|---|---|---|
| `agent.<name>.top_k` | number（Finite） | 采样参数：top-k | `packages/chimera/src/config/agent.ts:32` |
| `agent.<name>.min_p` | number（Finite） | 采样参数：min-p | 同上 :33 |
| `agent.<name>.presence_penalty` | number（Finite） | 采样参数：存在惩罚 | 同上 :34 |
| `agent.<name>.frequency_penalty` | number（Finite） | 采样参数：频率惩罚 | 同上 :35 |
| `agent.<name>.repetition_penalty` | number（Finite） | 采样参数：重复惩罚（上游 `ConfigAgentV1` 仅 `temperature`/`top_p`） | 同上 :36 |
| `command.<name>.model` | `ConfigModelID`（branded string，带 models.dev `$ref`） | 命令级默认模型；上游为普通 `Schema.String` | `packages/chimera/src/config/command.ts:22` + `model-id.ts:10` |
| `model` / `small_model` | `ConfigModelID`（同上） | 整体默认/小模型；上游为普通 `Schema.String`（`packages/core/src/v1/config/config.ts:74,77`） | `config.ts:190,193` + `model-id.ts` |
| `provider.<id>.wire_api` | `"chat"` \| `"responses"` | 传输协议，独立于 backend_semantics | `provider.ts:110` |
| `provider.<id>.remote_compaction` | `{ profile: "codex-responses", protocols: [v2/legacy 排列组合], auth: "provider-bearer" }` | 非 OpenAI provider 的远程 compaction 显式授权 | `provider.ts:113`（`RemoteCompaction` 定义 :8-16） |
| `provider.<id>.backend_semantics` | `"openai"` \| `"codex"` \| `"alibailian"` | 能力语义标注（Codex 中继、阿里百炼） | `provider.ts:116` |
| `provider.<id>.search_model` | string，默认 `qwen3.8-flash` | 阿里百炼语法时的统一 websearch 聚合模型 id | `provider.ts:120` |
| `provider.<id>.userAgent` | string | 覆盖请求 UA | `provider.ts:124` |
| `provider.<id>.models.<m>.wire_api` | `"chat"` \| `"responses"` | 模型级 wire 协议，优先于 provider 默认 | `provider.ts:22` |
| `provider.<id>.models.<m>.remote_compaction` | boolean | 模型级远程 compaction 显式开关 | `provider.ts:25` |
| `provider.<id>.models.<m>.backend_semantics` | `"openai"` \| `"codex"` \| `"alibailian"` | 模型级能力语义 | `provider.ts:28` |
| `provider.<id>.models.<m>.capability_model_id` | string | 能力查找用规范模型 id（不改发往线上的 model id） | `provider.ts:31` |
| `provider.<id>.models.<m>.size_class` | `"S"` \| `"M"` \| `"L"` \| `"XL"` | 子代理调度尺寸档（覆盖按模型身份推断值） | `provider.ts:34` |
| `provider.<id>.models.<m>.reasoning_efforts` | 字符串数组（`CodexModel.REASONING_EFFORTS` 子集） | 该模型支持的推理 effort 值 | `provider.ts:37` |
| `provider.<id>.models.<m>.interleaved`（收窄） | `true` \| `{ field: "reasoning_content" \| "reasoning_details" }` | 推理内容交错；上游接受 `Boolean \| "reasoning" \| "reasoning_content" \| "reasoning_text" \| string \| { field: … }`（`packages/core/src/v1/config/provider.ts:22`），fork 收窄了联合 | `provider.ts:47` |
| `provider.<id>.models.<m>.status`（收窄） | `"alpha" \| "beta" \| "deprecated"` | 模型状态；上游另允许 `"active"`（`ModelStatus`，`provider.ts:6`） | `provider.ts:85` |
| `server.maxActiveInstances` | 正整数，默认 4 | 服务端 LRU 保留的活动项目实例上限；可被 `CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES` 覆盖（后者优先） | `packages/chimera/src/config/server.ts:17` |
| `compaction.remote` | `"auto" \| "on" \| "off"` | 远程 compaction 开关（auto 自动用于受支持 OpenAI OAuth 会话或显式授权的 provider；on 不绕过 provider/model 能力 opt-in；off 禁止） | `config.ts:295` |
| `compaction.remote_protocol` | `"auto" \| "v2" \| "legacy"` | 远程 compaction 线上协议选择（v2=Responses v2，legacy=`/responses/compact`） | `config.ts:299` |
| `experimental.primary_tools` | 字符串数组 | 仅主 agent 可用的工具列表。**注意：上游已有此字段**（`packages/core/src/v1/config/config.ts:176`），非 fork 新增——Scout B 报告误判为 fork 新增，已修正，见第 10 节 | `config.ts:315` |
| `experimental.system_context` | boolean，默认关 | SystemContext 源追踪与上下文 epoch 持久化（首轮存基线、后续复用基线、源变更作为增量 system 消息注入）；关闭时装配与默认路径逐字节一致且不触碰 epoch 库 | `config.ts:324` |
| `permission` 已知键扩展（11 个） | `task_profile`、`task_model`、`subagent_model_prefer`、`subagent_model_suppress`（Rule）；`workbrief`、`memory_remember`、`memory_list`、`memory_forget`、`memory_read`、`chimera_oracle_recent`、`chimera_oracle_get`（Action） | 委派模型/记忆工具/oracle 工具的权限键；上游 `InputObject` 止于 `task`、`external_directory`、`todowrite`、`question`、`webfetch`、`websearch`、`lsp`、`doom_loop`、`skill`（`packages/core/src/v1/config/permission.ts:17-34`） | `packages/chimera/src/config/permission.ts:33-52` |

（备用核实项：`skills.urls` 双侧都存在（fork `skills.ts:9` / 上游 `skills.ts:9`），不属新增，未列入上表。）

## 5. List C：命名与语义变化

| 项目 | fork | upstream | 备注 |
|---|---|---|---|
| 配置文件名 | `chimera.json[c]`：`APP_CONFIG_NAME = "chimera"`（`paths.ts:10`），项目目录向上递归读 `chimera.jsonc`/`chimera.json` | 硬编码 `"opencode"`：`opencode.jsonc`/`opencode.json`（`packages/opencode/src/config/config.ts:141,273-274,421,440,532`，`paths.ts` 无常量） | `[name]`，H |
| 项目配置目录 | `APP_CONFIG_DIR = ".chimera"`（`paths.ts:11`，`config.ts:696`） | 硬编码 `".opencode"`（`packages/opencode/src/config/paths.ts:29,35`，`config.ts:439`） | `[name]`，H |
| `$schema` URL | 自动注入 `https://coding-chimera.github.io/chimera/schemas/config.json`（`config.ts:508-509,535,658`） | `https://opencode.ai/config.json`（`packages/opencode/src/config/config.ts:246-247,268,283,397`） | `[name]`，H |
| well-known 远程配置路径 | `${url}/.well-known/chimera`（`config.ts:631,644,659`） | `${url}/.well-known/opencode`（`config.ts:374`） | `[name]`，H |
| macOS MDM plist 域 | `ai.chimera.managed`（`managed.ts:12`） | `ai.opencode.managed`（`packages/opencode/src/config/managed.ts:8`） | `[name]`，H |
| managed 目录（三平台） | `/Library/Application Support/chimera`、`%ProgramData%\chimera`、`/etc/chimera`（`managed.ts:27,29,31`） | `/Library/Application Support/opencode`、`%ProgramData%\opencode`、`/etc/opencode`（`managed.ts:23,25,27`） | `[name]`，H |
| mDNS 默认域 | `chimera.local`（`server.ts:12` 描述） | `opencode.local`（`packages/core/src/v1/config/server.ts:13` 描述） | `[name]`，H |
| 未知顶层键 | **严格拒绝**：`topLevelExtraKeys` 检查并抛 `InvalidError`（`parse.ts:53,83-88`） | `onExcessProperty: "ignore"` 静默忽略（`packages/opencode/src/config/parse.ts:42`） | `[default]`，H。注意 fork 先做 `normalizeLoadedConfig` 再校验，`theme`/`keybinds`/`tui` 在到达严格校验前已被剥离，不会因这三键报错 |
| `username` 回退 | `if (!result.username) result.username = os.userInfo().username`，无 try/catch、无 `"user"` 回退（`config.ts:839`）；managed plist 同（`managed.ts:50`） | `os.userInfo().username \|\| "user"`，包在 try/catch 中，异常时回退 `"user"`（`config.ts:580-585`；`managed.ts:46-52`） | `[default]`，H |
| TUI/theme/keybinds 处理 | 主配置中剥离 `theme`/`keybinds`/`tui` 并打 deprecated 警告（`config.ts:66-76`）；TUI 配置模块在 `src/cli/cmd/tui/config/`（`tui.ts`、`tui-migrate.ts`，迁移目标是 `tui.json`，TUI schema URL `https://coding-chimera.github.io/chimera/schemas/tui.json`）；keybinds 有独立 schema `src/config/keybinds.ts`（127 行） | 主配置同样剥离这三键（`packages/opencode/src/config/config.ts:54-63`，静默无警告）；TUI 模块在 `src/config/`（`tui.ts`、`tui-migrate.ts`、`tui-cwd.ts`、`tui-host-attention.ts`），TUI schema URL `https://opencode.ai/tui.json` | 修正 Scout B 的表述：**剥离本身双侧一致**（上游也剥离），差异在 fork 多了警告、模块移了位置、schema URL 换名。H |
| 首启全局配置 | **不预建**全局配置文件（`config.ts:522-545` 仅合并与旧 TOML 迁移） | 缺省时预创建 `opencode.jsonc`（含 `$schema`），env 路由时跳过（`config.ts:260-271`） | `[default]`，H |
| merge 源类别追踪 | `SourceCategory = "default" \| "global" \| "project" \| "environment" \| "account" \| "managed"`，`recordSources` 记录每条路径的来源与 writeTarget，`Config.resolve` 返回 `{ value, inherited, source, inheritedSource, explicitAtWriteTarget, writeTarget }`（`config.ts:350,433-445,616,882-896`） | 无来源追踪、无 `resolve`/`remove` API（State 仅 `config/directories/deps/consoleState`，Interface 无这两方法） | `[field]`，H |
| `Interface.update` | 对 `chimera.json[c]` 做 **JSONC 感知原地补丁**（`patchJsonc`，保留注释/格式；非 jsonc 才走整文件序列化）（`config.ts:912-929`） | 只写 `config.json` 整文件序列化（`config.ts:638-650`） | `[default]`，H |
| `ConfigVariable.substitute` | 无 `env` 参数，永远读 `process.env`（`variable.ts:33-37`） | 可传 `env: Record<string,string>` 覆盖 `process.env`（`packages/opencode/src/config/variable.ts:34,37`） | `[default]`，H |
| `ConfigParse.effectSchema`/`schema` | 新增 `effectSchema`（Effect Schema 版）+ 顶层键严格检查 | 仅有 `schema`，`onExcessProperty: "ignore"` | `[field]`，H |
| `configEntryNameFromPath` | 在绝对路径中任意位置搜索 searchRoots（`entry-name.ts:3-12`） | 对已是相对路径的输入剥离前缀（`entry-name.ts:8-15`） | `[default]`，H |
| `ConfigMarkdown.parse` | 内联 gray-matter 解析 + 本地 `fallbackSanitization`（`markdown.ts:70`） | 委托 `ConfigMarkdownCore`（`@opencode-ai/core/config/markdown`）（`markdown.ts:20`） | `[field]`，H |
| `ConfigAgent.load` 扫描模式 | 匹配 `/{APP_CONFIG_DIR}/agent/` 与 `/agent/` 等模式（`agent.ts:140`） | 经相对路径匹配 `command/`、`commands/`（`packages/opencode/src/config/command.ts:24`） | `[default]`，H |
| `.chimera/plugin(s)` 自动发现 | 注释与逻辑均为 `.chimera/plugin(s)`（`config.ts:735`） | `.opencode/plugin(s)`（`config.ts:476`） | `[name]`，H |
| 旧 `config`（TOML）迁移 `$schema` | 迁移产物写 `https://coding-chimera.github.io/chimera/schemas/config.json`（`config.ts:535`） | 写 `https://opencode.ai/config.json`（`config.ts:283`） | `[name]`，H |
| `v2-compat` 降低层 | 无（fork 无 `v2-compat.ts`）；`Config.Info` 自包含，不 import `ConfigV1` | loader `decodeConfig` 先跑 `ConfigV2Compat.lower(normalizeLoadedConfig(input), source)` 再解析 `ConfigV1.Info`（`config.ts:188-199`）；`v2-compat.ts` 449 行 | `[module]`，H |

补充说明（配置文件的查找/写入顺序，双侧核对过）：

- fork 全局配置候选顺序 `chimera.jsonc` → `chimera.json` → `config.json`（旧版遗留，`config.ts:395-403`）；项目（实例）配置写入目标是 `chimera.jsonc`（存在时）否则 `chimera.json`（`config.ts:405-409`）。
- fork 项目加载顺序：先 `ConfigPaths.files("chimera", ...)` 从目录向上找，再对每个 `.chimera/` 目录依次读 `chimera.json`、`chimera.jsonc`（`config.ts:678,695-705`），另叠加 `OPENCODE_CONFIG`（env 指定文件）、`OPENCODE_CONFIG_CONTENT`（env 注入内容）、account 远程配置与 managed 配置层。

## 6. List D：移除或收窄的上游键

| 键/项目 | 上游位置 | fork 状态 | 说明/替代 |
|---|---|---|---|
| `references` / `reference` | `packages/core/src/v1/config/config.ts:45,48`（`ConfigReference.Info`） | 移除 | fork `Info` 无此字段 |
| `attachment` | `config.ts:130` + 整模块 `packages/core/src/v1/config/attachment.ts` | 移除 | fork 无 `attachment.ts`，`Info` 无此字段 |
| `subagent_depth`（顶层） | `config.ts:84`（NonNegativeInt，默认 1） | 移除 | 由 `delegation.max_depth` 取代（默认 3，含根会话的完整链深） |
| `experimental.policies` | `config.ts:185-187`（`ConfigExperimental.Policy` 数组） | 移除 | fork `experimental` 块无 `policies` |
| `command.<name>.variant` | `packages/core/src/v1/config/command.ts:10` | 移除 | fork `ConfigCommand.Info` 仅 `template/description/agent/model/subtask`（`command.ts:18-24`） |
| `provider.<id>.options.headerTimeout` | `packages/core/src/v1/config/provider.ts:108-116` | 移除 | fork `options` 结构（`provider.ts:127-154`）无 `headerTimeout`，保留 `timeout`/`chunkTimeout` |
| `mcp.local.cwd` | `packages/core/src/v1/config/mcp.ts:11-13` | 移除 | fork `mcp.Local`（`mcp.ts:5-22`）无 `cwd` |
| `mcp.oauth.callbackPort` | `packages/core/src/v1/config/mcp.ts:34-37` | 移除 | fork `mcp.OAuth`（`mcp.ts:24-38`）无 `callbackPort`，保留 `redirectUri` |
| `provider.<id>.models.<m>.status = "active"` | `packages/core/src/v1/config/provider.ts:6`（`ModelStatus` 含 `"active"`） | 收窄 | fork 仅 `alpha`/`beta`/`deprecated`（`provider.ts:85`） |
| `provider.<id>.models.<m>.interleaved` 通配分支 | `provider.ts:22`（`Boolean \| "reasoning" \| "reasoning_content" \| "reasoning_text" \| string \| { field }`） | 收窄 | fork 仅 `true \| { field: "reasoning_content" \| "reasoning_details" }`（`provider.ts:47`） |
| TUI 配置模块（4 个） | `packages/opencode/src/config/tui*.ts`（`tui.ts`、`tui-migrate.ts`、`tui-cwd.ts`、`tui-host-attention.ts`） | 移位置（非删除） | fork 中这些模块位于 `src/cli/cmd/tui/config/`，不在 `packages/chimera/src/config/`；`src/config/keybinds.ts` 为独立 keybinds schema。Scout B 原先写"absent from fork config dir"，字面上对，但易误读为整功能删除——实际是把 TUI 配置子系统迁到了 CLI 侧（见 5 表 TUI 行） |
| `v2-compat.ts`（v2→v1 降低层） | `packages/opencode/src/config/v2-compat.ts`（449 行） | 移除 | fork 无此文件；外层 `Info` 自包含，不接收 v2 schema 输入 |
| `ConfigV1` 依赖 | 上游 `Info = ConfigV1.Info & { plugin_origins? }`（`config.ts:112-116`） | 内联化 | fork 在 `packages/chimera/src/config/config.ts:135` 内联 `Schema.Struct({...})`，不再依赖 `@opencode-ai/core/v1/config/config` |

## 7. 环境变量差异

| 环境变量 | 说明 | 上游对应 | 源文件（fork） |
|---|---|---|---|
| `CHIMERA_BROWSER_EXECUTABLE_PATH` | 浏览器自动化：指定 Chrome/Chromium 可执行路径（未找到系统浏览器时的报错提示也会引用它） | 无（浏览器自动化是 fork 新增，`591907bc0 feat(browser)`） | `src/browser/runtime.ts:215`、`discovery.ts:105` |
| `CHIMERA_BROWSER_CDP_URL` | 浏览器自动化：连接 CDP 地址 | 无 | `src/browser/runtime.ts:207` |
| `CHIMERA_BROWSER_HEADLESS` | 浏览器自动化：`"false"` 以外均无头（`!== "false"`） | 无 | `src/browser/runtime.ts:225` |
| `CHIMERA_PLAYWRIGHT_CORE_ENTRY` | 浏览器自动化：playwright-core 入口覆盖 | 无 | `src/browser/runtime.ts:143` |
| `CHIMERA_INSTANCE_IDLE_TTL_MS` / `IDLE_SWEEP_MS` / `BOOT_GRACE_MS` / `SWEEP_DEBOUNCE_MS` / `OSCILLATION_WINDOW_MS` / `OSCILLATION_PIN_MS` / `MAX_ACTIVE_INSTANCES` | 项目实例生命周期与 LRU 上限（`MAX_ACTIVE_INSTANCES` 优先生效于 `server.maxActiveInstances`） | 前两个与 `MAX_ACTIVE_INSTANCES` 回退到 `OPENCODE_INSTANCE_*`；其余（BOOT_GRACE 等）仅 `CHIMERA_*` | `src/project/instance-store.ts:74-84` |
| `CHIMERA_DATA_DIR` | 图数据根目录；别名 `CODEGRAPH_DATA_DIR` | 无 | `src/graph/directory.ts:89` |
| `CHIMERA_ALLOW_UNSAFE_NODE=1` | 图 CLI Node 逃生口（危险命令强制启用）；别名 `CODEGRAPH_ALLOW_UNSAFE_NODE=1` | 无 | `src/graph/cli/chimera.ts:82` |
| `CHIMERA_SQLITE_CACHE_MB` / `CHIMERA_SQLITE_MMAP_MB` / `CHIMERA_SQLITE_TEMP_STORE` | 图库 SQLite pragma（默认 16MB cache、32MB mmap、TEMP_STORE=MEMORY 需显式置 MEMORY；索引构建可调大） | 无 | `src/graph/db/index.ts:65,66` |
| `CHIMERA_ALLOW_LEGACY_OPENCODE_ORIGIN=true` | 服务端 CORS 放行 legacy opencode origin | 无 | `src/server/cors.ts:20`（该项仅核了 fork 侧，M） |
| `CHIMERA_<KEY>` 别名机制（`CHIMERA_OPENCODE_ENV_ALIASES`） | 模块加载期统一别名：对别名清单里的每个 KEY，若设了 `CHIMERA_${KEY}` 则写回 `OPENCODE_${KEY}`（双侧同时设置且值不同时打警告 "CHIMERA_X overrides OPENCODE_X"） | 无（上游只有 `OPENCODE_*`） | `packages/core/src/flag/flag.ts:4-73` |
| 代表性别名（不必全量）： | `CHIMERA_AUTO_SHARE`、`CHIMERA_CONFIG`、`CHIMERA_CONFIG_CONTENT`、`CHIMERA_PERMISSION`、`CHIMERA_SERVER_PASSWORD`、`CHIMERA_SERVER_USERNAME`、`CHIMERA_CONFIG_DIR`、`CHIMERA_DISABLE_PROJECT_CONFIG`、`CHIMERA_TUI_CONFIG`、`CHIMERA_DISABLE_PRUNE`、`CHIMERA_DISABLE_AUTOCOMPACT`、`CHIMERA_DB`、`CHIMERA_MODELS_URL` 等（清单共 58 项，覆盖 AUTO_SHARE/CONFIG/CONFIG_CONTENT/PERMISSION/SERVER_PASSWORD/SERVER_USERNAME/CONFIG_DIR/DISABLE_PROJECT_CONFIG/TUI_CONFIG/DISABLE_PRUNE/DISABLE_AUTOCOMPACT/DB/MODELS_URL 等） | — | `flag.ts:4-62` 常量数组 |

说明：内部 flag 名仍为 `OPENCODE_*`，别名机制只是入口兼容层；运行时行为开关（truthy 解析、Config.boolean 等）仍在 `Flag` 对象上以 `OPENCODE_*` 读取。

## 8. 从上游迁移注意事项

面向持有 `opencode.json[c]` 的用户：

1. **文件与目录改名**：`opencode.json` → `chimera.json`，`opencode.jsonc` → `chimera.jsonc`，项目内 `.opencode/` → `.chimera/`（`command/`、`agent/`、`plugin/`、`skills/` 等子目录随父目录改名，全局配置目录内同理）。`.opencode/plugin(s)` 自动发现注释对应 `.chimera/plugin(s)`。mDNS 默认域换为 `chimera.local`；macOS MDM 域换为 `ai.chimera.managed`；managed 目录换为 `/Library/Application Support/chimera`、`%ProgramData%\chimera`、`/etc/chimera`。若重新生成/写入配置，`$schema` 会被自动注入为 `https://coding-chimera.github.io/chimera/schemas/config.json`（不必手改，fork 自动补写）。
2. **被移除键的替代**：`subagent_depth` → `delegation.max_depth`（语义变化：上游默认 1 且阻止子代理再派子代理，fork 默认 3 且含根会话）；`command.<name>.variant` 删掉（如需默认变体请用 `agent.<name>.variant`）；`provider.options.headerTimeout` 删掉或并入 `timeout`/`chunkTimeout`；`mcp.local.cwd` 删掉；`mcp.oauth.callbackPort` 改用 `redirectUri`；`models.<m>.status: "active"` 改为 `alpha`/`beta`/`deprecated` 或不写；`models.<m>.interleaved` 只接受 `true` 或 `{ "field": "reasoning_content" | "reasoning_details" }`，上游允许的 `"reasoning"`/`"reasoning_text"`/任意字符串需改写到 `{ "field": ... }` 两个取值之一；`references`/`reference`、`attachment`、`experimental.policies` 直接删除（fork 无对应实现）。
3. **未知顶层键会被拒绝，旧键必须清理**：fork 的 `ConfigParse.effectSchema` 会显式找出不在 `Info` 结构里的顶层键并抛 `InvalidError`（"Unrecognized key(s)"），而上游是静默忽略。所以任何仅上游认识、fork 不认识的顶层键（见第 6 节清单）若不删除，配置会直接加载失败。例外：`theme`/`keybinds`/`tui` 三个键在 `normalizeLoadedConfig`（`packages/chimera/src/config/config.ts:66-76`）里**先被剥离并输出一条 deprecated 警告**（"tui keys in opencode config are deprecated; move them to tui.json"），不会被拒绝——但也不会生效，需迁移到 `tui.json`（fork 的 TUI schema：`https://coding-chimera.github.io/chimera/schemas/tui.json`）。注意上游同样剥离这三键（静默），所以它们本来也已经失效。
4. **无 `opencode.json` 兼容读取**（复核结论）：fork 读取路径只有 `chimera.json[c]`、全局遗留 `config.json`、TUI 的 `tui.json`，**不读 `opencode.json`/`opencode.jsonc`，也不读 `.opencode/` 目录**，没有文件名兼容垫片。环境变量层的兼容仍然存在：`OPENCODE_CONFIG`（或别名 `CHIMERA_CONFIG`）、`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT`、`OPENCODE_PERMISSION` 等仍按上游语义生效（经 `Flag` 读取），旧 `OPENCODE_*` 变量不用改，`CHIMERA_*` 别名会自动写回（见第 7 节）。全局遗留 TOML `config` 文件仍会被读取并迁移为 `config.json`（fork `config.ts:528-542`，与上游机制一致）。
5. **远程配置路径**：若部署了 well-known 远程配置，路径由 `/.well-known/opencode` 换为 `/.well-known/chimera`；未指定时 `$schema` 会自动补写为 chimera 的 URL。
6. **行为差异提醒**：`compaction.prune` 按 schema 描述"默认 true"，但运行时行为是未设置即视为关（见第 9 节）；`compaction.tail_turns` fork 默认 2（上游无数字默认，语义是"只受保留 token 预算限制"），明确需要旧行为的话请显式配置。

改名清单速查表（fork ← upstream）：

| 项 | 上游 | fork |
|---|---|---|
| 配置文件 | `opencode.json[c]` | `chimera.json[c]` |
| 项目配置目录 | `.opencode/` | `.chimera/` |
| 自动注入 `$schema` | `https://opencode.ai/config.json` | `https://coding-chimera.github.io/chimera/schemas/config.json` |
| well-known 远程配置 | `/.well-known/opencode` | `/.well-known/chimera` |
| TUI schema | `https://opencode.ai/tui.json` | `https://coding-chimera.github.io/chimera/schemas/tui.json` |
| macOS MDM plist 域 | `ai.opencode.managed` | `ai.chimera.managed` |
| managed 目录（macOS/Windows/Linux） | `/Library/Application Support/opencode`、`%ProgramData%\opencode`、`/etc/opencode` | `/Library/Application Support/chimera`、`%ProgramData%\chimera`、`/etc/chimera` |
| mDNS 默认域 | `opencode.local` | `chimera.local` |

迁移后自检：改名后首次启动应无 "Unrecognized key(s)" 报错；若仍有旧键残留，报错信息会直接列出键名（例如 `Unrecognized key(s): references, attachment`），照单删掉即可。`theme`/`keybinds`/`tui` 不会报错，但启动日志会有一条 deprecated 警告，提示移到 `tui.json`——看到该警告即说明旧 TUI 键还在主配置里。

迁移后最小示例（JSONC 速览，字段形状以第 3/4 节源文件为准）：

```jsonc
{
  "$schema": "https://coding-chimera.github.io/chimera/schemas/config.json",
  "delegation": {
    "model_profiles": { "fast": { "model": "openai/gpt-4.1-mini" } },
    "routes": { "general": "fast" },
    "scheduling": {
      "archetypes": { "scout": { "maxSizeClass": "L" } }
    },
    "max_depth": 3,
    "max_concurrent": 128,
    "background_subagents": true,
    "background_concurrent": 16
  },
  "memories": {
    "enabled": true,
    "use_memories": true,
    "dedicated_tools": false,
    "max_summary_chars": 12000
  },
  "remote_compaction_models": ["gpt-5.6"],
  "permission": {
    "task_model": "deny",
    "chimera_oracle_recent": "allow"
  }
}
```

与第 6 节对应的清理动作示例：把 `subagent_depth` 换成 `delegation.max_depth`；`command.<name>.variant`、`references`、`attachment`、`experimental.policies`、`mcp.local.cwd`、`mcp.oauth.callbackPort`、`provider.options.headerTimeout` 直接删除；`models.<m>.status: "active"` 与非法 `interleaved` 取值按第 6 节改写。

## 9. 已知文档/运行时不一致

**`compaction.prune` 的 schema 描述与运行时行为不一致**（本条正是"怕以后忘记"要存档的典型）：

- schema 描述：fork `packages/chimera/src/config/config.ts:283` 写 "Enable pruning of old tool outputs (default: true)"；上游对应字段（`packages/core/src/v1/config/config.ts:155`）写 "(default: false)"。
- 运行时实际行为：`packages/chimera/src/session/compaction.ts:314` 的唯一判定点是 `if (!cfg.compaction?.prune) return`——即 `undefined` 和 `false` 一样视为不剪枝，**默认实际是关**，与 fork 的 schema 描述（default: true）矛盾，与上游描述（default: false）一致。另有 `OPENCODE_DISABLE_PRUNE`/`CHIMERA_DISABLE_PRUNE` flag 会把 `prune` 强制置 false（`config.ts:848-850`）。
- 处置建议：保留此文档记录；如需让描述与行为一致，应改 schema 描述为 "default: false"（或改运行时默认，但后者改变既有行为，风险更大）。当前（2026-09-08）行为是：未设置 = 不剪枝。

对照项（已核、无问题）：`compaction.tail_turns` 的 schema 描述 "default: 2"（`config.ts:286-287`）与运行时 `DEFAULT_TAIL_TURNS = 2`（`compaction.ts:43`，`input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS`，:264）一致，是一条正常条目；其差异在上游——上游 schema 无数字默认（"By default retention is limited only by the preserved token budget"）。两者不要混淆。

## 10. 证据与置信度备注

- **H（双侧源码都核过）**：第 3 节全部五键（含各自 git 提交号已 `git log` 复核：`17036937b`、`3b79a0b32`、`c3411251e`、`dcfb89d4b`、`d6468197e`）；第 4 节除 `experimental.primary_tools` 外全部条目（`agent` 采样五件套、`command.model`/`model`/`small_model` 的 ConfigModelID 改型、`provider.*` 及 `provider.models.*` 全部新字段、`interleaved`/`status` 收窄、`server.maxActiveInstances`、`compaction.remote`/`remote_protocol`、`experimental.system_context`、permission 11 键）；第 5 节全部条目（文件名/目录名/.well-known/MDM/mDNS/$schema/严格拒绝/username/首启不预建/merge 源追踪/update JSONC 补丁/variable env 参数/entry-name/markdown/TOML 迁移 URL/TUI 处理，双侧逐一比对）；第 6 节全部条目；第 7 节环境变量全部（flag.ts、browser、instance-store、graph 三文件、db、cors 均已 grep 源文件）；第 9 节 compaction.prune 不一致（schema 与运行时双侧核对）。
- **M（只核了一侧或推断）**：`CHIMERA_ALLOW_LEGACY_OPENCODE_ORIGIN`（仅核 fork 侧 `src/server/cors.ts:20`；上游无对应项，由浏览器/图类 fork 专属变量模式推断）。其余标注为 H 的条目均双侧可查。
- **相对 Scout B 报告的修正**（以源码为准）：
  1. `experimental.primary_tools`：Scout B 列入 List B（"absent upstream"），**实际上游已有**（`packages/core/src/v1/config/config.ts:176-178`，与 fork `config.ts:315-317` 同形同为）。真正 fork 新增的是 `experimental.system_context`。
  2. TUI/theme/keybinds：Scout B 的 List C/D 把"`theme`/`keybinds`/`tui` 从主配置剥离"描述为 fork 特有、并把 `tui.ts`/`tui-migrate.ts` 等写成 fork 缺失。复核结果：**上游的 `normalizeLoadedConfig`（`packages/opencode/src/config/config.ts:54-63`）同样剥离这三键**，只是不打警告；fork 的 TUI 配置模块不缺失，而是**位于 `src/cli/cmd/tui/config/`**（TUI schema URL 为 chimera 域名）。差异点是：fork 剥离时多一条 deprecated 警告；模块位置从 `src/config/` 移到 CLI 侧；schema URL 换名。
  3. 原任务清单里 hint 提过的 `skills.urls`、`enabled_providers`/`disabled_providers`：复核确认**上游 schema 都有**（`skills.ts:9`、`config.ts:68,71`），不是 fork 新增，未写入新增清单。
  4. 其余 Scout B 条目与源码一致（`delegation`/`memories`/`free_models`/`ultra_models`/`remote_compaction_models`、permission 键、`compaction.prune` 描述差异、`server.maxActiveInstances`、环境变量等均复核无出入）。
- **文档站旁证提醒**：`packages/web/src/content/docs/config.mdx` 含 `compaction.remote`/`remote_protocol` 文档，说明 fork 文档站与 fork 源码一致，但**不要把文档站内容当作上游行为的证据**——上游源码（2026-09-08 检出）没有任何远程 compaction 配置。本文所有差异定性以上游检出源码为准。
- **维护提醒**：上游持续演进，本文以 2026-09-08 双侧检出为基线；此后上游若新增/改名配置键，或 fork 引入新键，需重跑双侧 schema 比对并更新本文。特别是上游若自行引入"严格顶层键校验"或 "TUI 剥离"类改动，会与本文若干 `[default]` 条目重合，届时请按当日源码复核后修订。