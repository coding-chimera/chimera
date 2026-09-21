# Chimera 配置参考（configuration.md）

> 本文档描述 `@coding-chimera/chimera`（CLI 命令 `chimera`）的配置系统，以当日 `packages/chimera` 源码为准。
>
> **最后核对：2026-09-08，以当日 packages/chimera 源码为准。**
>
> 与 upstream opencode 的完整差异清单见 [configuration-vs-opencode.md](./configuration-vs-opencode.md)。本文中对已确认的 fork 特有字段标注"（Chimera 扩展）"；标注依据为 fork 维护记录，如有出入以差异清单文档为准。

## 目录

1. [概述](#1-概述)
2. [配置文件与加载顺序](#2-配置文件与加载顺序)
3. [字段全量参考](#3-字段全量参考)
4. [主 schema 之外的配置面](#4-主-schema-之外的配置面)
5. [环境变量参考](#5-环境变量参考)
6. [完整示例](#6-完整示例)

---

## 1. 概述

Chimera 使用一个统一的 JSON/JSONC 配置对象控制运行时行为：默认模型、provider 与 model 覆盖、agent 定义、权限、子代理委派、MCP 服务器、工具输出截断、压缩（compaction）、跨会话记忆与实验开关等。

- **主 schema 源文件**：`packages/chimera/src/config/config.ts` 中的 `Info`（Effect `Schema.Struct`，标识 `"Config"`）。所有顶层键均为可选的（除合并语义外不存在必填顶层键），除非另有注明。
- **分域模块**：`delegation.ts`、`memory.ts`、`provider.ts`、`permission.ts`、`agent.ts`、`command.ts`、`mcp.ts`、`formatter.ts`、`lsp.ts`、`skills.ts`、`server.ts`、`layout.ts`、`parse.ts`、`paths.ts`、`variable.ts`、`managed.ts`、`model-id.ts` 等，均位于 `packages/chimera/src/config/`。
- **JSON Schema**：机器可读 schema 由 `packages/chimera/script/schema.ts` 从 `Config.Info.zod` 生成（并强制 `additionalProperties: false`，附带 JSONC 扩展 `allowComments: true`、`allowTrailingCommas: true`），发布地址为：
  `https://coding-chimera.github.io/chimera/schemas/config.json`
- **`$schema` 字段**：顶层 `$schema: string` 用于 JSON 编辑器校验提示。首次加载项目配置文件时若缺失，会**自动把该 URL 写入文件**（`config.ts` 的 loadConfig；全局与 well-known 远程配置同样会补上）。

---

## 2. 配置文件与加载顺序

### 2.1 文件名与格式

- 主配置文件名（`ConfigPaths.APP_CONFIG_NAME`）：`chimera`。
- 支持的扩展名（`ConfigPaths.APP_CONFIG_FILES`）：`chimera.json`、`chimera.jsonc`，两者均按 JSONC 解析。
- 项目内目录名（`ConfigPaths.APP_CONFIG_DIR`）：`.chimera`。
- 格式为 JSON/JSONC：支持注释、尾逗号（见 [2.7](#27-严格校验与-jsonc)）。

### 2.2 配置文件位置与查找

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 全局配置 | `~/.config/chimera/`（`Global.Path.config`，XDG 约定，macOS 同样适用）下的 `config.json`、`chimera.json`、`chimera.jsonc`，按此顺序依次读取合并 | 旧版 TOML `config` 文件会自动迁移到 `config.json` 后删除 |
| 自定义配置 | `OPENCODE_CONFIG` 指向的文件 | category：environment |
| 项目配置 | 从当前目录向上查找到 worktree 根：每层目录下 `chimera.jsonc` / `chimera.json`，两层都读 | 受 `OPENCODE_DISABLE_PROJECT_CONFIG` 控制 |
| `.chimera/` 配置目录 | 每个找到的 `.chimera/` 目录内读取 `chimera.json` + `chimera.jsonc` | 目录候选：全局配置目录、项目向上各层 `.chimera`、`~/.chimera`、`OPENCODE_CONFIG_DIR` |
| 内联配置 | `OPENCODE_CONFIG_CONTENT`（JSON/JSONC 字符串） | category：environment |
| well-known 远程 | 认证条目中 `type: "wellknown"` 者，`${url}/.well-known/chimera`，可选 `remote_config` 链 | category：managed |
| 账户/组织远程 | 活动组织的 `${url}/api/config` | category：account |
| 系统 managed 目录 | 平台特定目录（见下） | category：managed |
| macOS MDM plist | `/Library/Managed Preferences/<user>/ai.chimera.managed.plist` 与 `/Library/Managed Preferences/ai.chimera.managed.plist` | 最高优先级覆盖 |

### 2.3 完整合并顺序

加载器为 `packages/chimera/src/config/config.ts` 的 `loadInstanceState`。**后加载的覆盖先加载的**，完整顺序：

1. **well-known 远程配置**：遍历认证条目中 `type: "wellknown"` 的账号，向其 `${url}/.well-known/chimera` 发请求；响应可含 `config` 与可选 `remote_config`（后者是带 `url`/`headers` 的二级配置 URL，URL 与 headers 支持 `{env:...}`/`{file:...}` 替换）。顺序为合并 `config` 后再合并拉取的 `remote_config`。
2. **全局配置**：`~/.config/chimera/` 下按 `config.json` → `chimera.json` → `chimera.jsonc` 顺序依次加载合并。若存在 TOML 旧文件 `config`，迁移为 `config.json`（`provider`+`model` 合并成 `model`，写入 `$schema`，删除旧文件）。
3. **`OPENCODE_CONFIG` 自定义文件**。
4. **项目配置文件**：`ConfigPaths.files` 从当前目录向上查到 worktree 根，返回顺序为**根优先、最近者最后**，因此**离当前目录最近的 `chimera.jsonc`/`chimera.json` 最后合并、生效优先级最高**；同一目录内 `chimera.jsonc` 在 `chimera.json` 之后合并。`OPENCODE_DISABLE_PROJECT_CONFIG=1` 时跳过此步与后续 `.chimera` 目录的向上查找。
5. **`.chimera/` 配置目录**：目录候选顺序固定为——`~/.config/chimera/` → 从当前目录向上到 worktree 的各级 `.chimera`（近者在前）→ `~/.chimera` → `OPENCODE_CONFIG_DIR`。对每个目录，按 `chimera.json` → `chimera.jsonc` 依次加载。注意此步骤中**后出现的目录覆盖先出现的目录**（与第 4 步项目文件"最近者优先"的方向相反）。
6. **sidecar 文件**：对每个配置目录加载 `command*/**/*.md`、`agent*/**/*.md`、`mode*/**/*.md`、`plugin*/*.{ts,js}`（详见 [4.3](#43-chimera-sidecar-目录)）。同时每个目录会后台安装 `@opencode-ai/plugin` 依赖。
7. **`OPENCODE_CONFIG_CONTENT`**：内联 JSON/JSONC 字符串，category 为 environment。
8. **账户/组织远程配置**：存在活动组织（`active_org_id`）时请求 `${url}/api/config`，并将其中的 providers 记为 "console managed providers"。失败仅记日志（不影响启动）。此时 `OPENCODE_CONSOLE_TOKEN` 被注入环境。
9. **系统 managed 配置目录**：macOS `/Library/Application Support/chimera`；Windows `%ProgramData%\chimera`；其他平台 `/etc/chimera`（`OPENCODE_TEST_MANAGED_CONFIG_DIR` 可覆盖，仅测试用）。目录内的 `chimera.json`/`chimera.jsonc` 全部加载。
10. **macOS MDM managed plist**：`.mobileconfig`（MDM 部署）写入的 `ai.chimera.managed.plist`，用 `plutil -convert json` 解析（剥离 `Payload*` 元键），**覆盖一切其他来源**。

### 2.4 合并语义

- **深合并**：`mergeDeep`（remeda），嵌套对象逐层合并，普通数组**整体替换**（后加载者覆盖）。
- **两个数组字段特殊拼接**：`instructions` 与 `remote_compaction_models` 在合并时按 `Set` 去重后拼接（先加载的在前）。
- **plugin 特批语义**：plugin spec（`string` 或 `[name, options]`）不会逐项深合并，而是按加载身份去重（npm 包名或本地文件 URL），**最后一个声明同一 plugin 的来源胜出**，并保留来源/作用域元数据（`plugin_origins`）。
- 合并完成后 `$schema` 若非缺失则保留每个来源自己的值。

### 2.5 合并后的规范化

`loadInstanceState` 返回前执行以下后处理（按此顺序）：

1. **`mode` → `agent` 提升**：`mode` 下每个条目合并进 `agent`（同名键），并强制 `mode: "primary"`。`mode` 键本身已废弃（`@deprecated Use 'agent' field instead`）。
2. **`OPENCODE_PERMISSION` 覆盖**：若设置，其 JSON 值深合并进 `permission`（文件配置之上）。
3. **`tools` → `permission` 翻译**：`tools: { name: boolean }` 中 `true` → `allow`、`false` → `deny`；`write`/`edit`/`patch` 三个键合并进 `permission.edit`，其余按原键名翻译。翻译结果作为 `permission` 的基础层（`mergeDeep(perms, 已有 permission)`）。
4. **`username` 默认值**：未设置时为 `os.userInfo().username`。
5. **`autoshare: true` → `share: "auto"`**：仅在 `share` 未设置时生效（`autoshare` 已废弃，`@deprecated Use 'share' field instead`）。
6. **环境变量覆盖**：`OPENCODE_DISABLE_AUTOCOMPACT=1` 强制 `compaction.auto = false`；`OPENCODE_DISABLE_PRUNE=1` 强制 `compaction.prune = false`。

### 2.6 变量替换 `{env:...}` 与 `{file:...}`

配置文本在解析前会做变量替换（`packages/chimera/src/config/variable.ts`，所有来源生效，包括 well-known 远程的 URL/headers）：

- `{env:VAR}`：替换为 `process.env.VAR`；未设置时替换为空字符串。
- `{file:path}`：读取文件内容（去除首尾空白）后作为 JSON 字符串字面量嵌入；`~/` 展开为家目录，相对路径**相对于该配置文件所在目录**解析；文件缺失默认报错（`InvalidError`）。若 `{file:...}` 所在行以 `//` 注释开头，则该 token 原样保留（不读取）。
- TUI 配置（`tui.json`）使用 `missing: "empty"` 模式（缺失时替换为空），主配置默认 `missing: "error"`。

### 2.7 严格校验与 JSONC

- 解析使用 `jsonc-parser`，`allowTrailingComma: true`，因此支持注释（`//`、`/* */`）与尾逗号（`packages/chimera/src/config/parse.ts`）。
- 语法错误抛 `JsonError`；schema 校验失败抛 `InvalidError`（路径 + zod 兼容 issues）。
- **未知顶层键会被严格拒绝**：`Config.Info` 没有索引签名，`effectSchema` 会先检查顶层多余键并抛出 `unrecognized_keys` 错误（`parse.ts` 的 `topLevelExtraKeys`）。这不是警告，配置会加载失败。请注意：`theme`/`keybinds`/`tui` 三个旧键例外——它们在解析前被 `normalizeLoadedConfig` 剥离并打警告（提示迁移到 `tui.json`），因此不会导致失败。

### 2.8 配置写回目标

运行时通过 TUI/桌面端/API 修改配置时：

- **项目级写回**：写当前项目目录下的 `chimera.jsonc`（若存在）否则 `chimera.json`；两者都不存在时新建 `chimera.json`。`.jsonc` 文件用 `jsonc-parser` 的 `modify`/`applyEdits` 原位打补丁，**保留注释与格式**。
- **全局写回**：`~/.config/chimera/` 下按 `chimera.jsonc` → `chimera.json` → `config.json` 取第一个存在的文件；都不存在则默认写入 `chimera.jsonc`。
- 首次加载无 `$schema` 的项目文件时，会在文件头部自动注入 `$schema` 字段（见 [1. 概述](#1-概述)）。

### 2.9 关于 `.opencode/` 与 upstream 布局（兼容性裁定）

**本 fork 的配置加载器不读取 `.opencode/` 目录，也不读取 `opencode.json`/`opencode.jsonc`。** 已逐一核对 `packages/chimera/src/config/config.ts` 的 `loadInstanceState`、`paths.ts`（`APP_CONFIG_NAME = "chimera"`、`APP_CONFIG_DIR = ".chimera"`）以及 `agent.ts`/`command.ts`/`plugin.ts` 的 `load()`（只扫描传入配置目录下的 `agent*/`、`command*/`、`plugin*` 子目录），并全局检索确认没有任何 `.opencode/opencode.json` 兼容回退路径。

因此仓库根部遗留的 `.opencode/`（含 `opencode.jsonc`、`agent/`、`command/`、`plugins/`、`tool/` 等）属于 upstream 布局内容，**不会被本 fork 的配置加载器当作运行时配置读取**；想要生效，请把内容迁移到 `chimera.json`/`chimera.jsonc` 或 `.chimera/` 下的对应目录。上游配置 `config.mdx` 描述的 `.opencode` 加载层（见 `packages/web/src/content/docs/config.mdx` 的 Locations 一节）在本 fork 中不存在。

---

## 3. 字段全量参考

> 说明：以下各节列出的默认值来自 schema 注解（`.annotate({ description })`）、运行时常量（如 `delegation.ts` 的 `DEFAULT_*`）与既有测试；未标注默认值即为未设置/由运行时自主决定。标注"（Chimera 扩展）"的字段为 fork 特有，与 upstream opencode 的完整差异见 [configuration-vs-opencode.md](./configuration-vs-opencode.md)。

### 3.1 顶层键总览

| 顶层键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `$schema` | `string` | 自动注入 `https://coding-chimera.github.io/chimera/schemas/config.json` | JSON Schema 引用 |
| `shell` | `string` | — | terminal/bash 工具的默认 shell |
| `logLevel` | `"DEBUG" \| "INFO" \| "WARN" \| "ERROR"` | — | 日志级别 |
| `server` | `object` | — | `chimera serve`/`web` 的服务器配置（见 3.3） |
| `command` | `Record<string, object>` | — | 命名命令（见 3.4） |
| `skills` | `object` | — | 技能目录/URL（见 3.5） |
| `watcher` | `{ ignore?: string[] }` | — | 文件监听忽略（见 3.6） |
| `snapshot` | `boolean` | `true` | 快照跟踪（undo/redo）开关（见 3.6） |
| `plugin` | `(string \| [string, object])[]` | `[]` | 插件规格（npm 名或路径，见 3.7） |
| `share` | `"manual" \| "auto" \| "disabled"` | — | 分享行为（见 3.8） |
| `autoshare` | `boolean` | — | `@deprecated` → `share`（见 3.8） |
| `autoupdate` | `boolean \| "notify"` | — | 自动更新行为（见 3.8） |
| `disabled_providers` | `string[]` | — | 跳过自动加载的 provider（见 3.9） |
| `enabled_providers` | `string[]` | — | 设置后仅这些 provider 生效（见 3.9） |
| `free_models` | `boolean` | `true` | 允许无凭据免费模型（Chimera 扩展，见 3.9） |
| `ultra_models` | `string[]` | — | `@deprecated`，仅解析不生效（Chimera 扩展，见 3.9） |
| `remote_compaction_models` | `string[]` | — | 远程压缩白名单扩展（Chimera 扩展，见 3.9） |
| `model` | `string`（`provider/model`） | — | 默认模型（见 3.10） |
| `small_model` | `string`（`provider/model`） | — | 标题生成等小任务模型（见 3.10） |
| `default_agent` | `string` | `"build"` | 默认主 agent（见 3.10） |
| `username` | `string` | `os.userInfo().username` | 会话显示用户名（见 3.10） |
| `mode` | `Record<string, object>` | `{}` | `@deprecated` → `agent`（见 3.11） |
| `agent` | `Record<string, object>` | `{}` | agent 配置（见 3.11） |
| `provider` | `Record<string, object>` | — | provider 覆盖（见 3.12） |
| `mcp` | `Record<string, object>` | — | MCP 服务器（见 3.13） |
| `formatter` | `boolean \| Record<string, object>` | — | 格式化器配置（见 3.14） |
| `lsp` | `boolean \| Record<string, object>` | — | LSP 服务器配置（见 3.15） |
| `instructions` | `string[]` | — | 附加指令文件/模式，跨来源拼接（见 3.16） |
| `layout` | `"auto" \| "stretch"` | — | `@deprecated`，恒为 stretch（见 3.16） |
| `permission` | `"ask" \| "allow" \| "deny"` 或 `object` | — | 权限规则（见 3.17） |
| `delegation` | `object` | — | 子代理委派（Chimera 扩展，见 3.18） |
| `tools` | `Record<string, boolean>` | — | `@deprecated` → `permission`（见 3.17） |
| `enterprise` | `{ url?: string }` | — | 企业 URL（见 3.19） |
| `tool_output` | `{ max_lines?, max_bytes? }` | `2000` / `51200` | 工具输出截断阈值（见 3.19） |
| `compaction` | `object` | — | 上下文压缩（见 3.20） |
| `memories` | `object` | 默认关闭 | 跨会话记忆（Chimera 扩展，见 3.21） |
| `experimental` | `object` | — | 实验开关（见 3.22） |

### 3.2 `$schema` / `shell` / `logLevel`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `$schema` | `string` | `https://coding-chimera.github.io/chimera/schemas/config.json` | JSON Schema 引用；缺失时自动注入 |
| `shell` | `string` | — | terminal 与 bash 工具使用的默认 shell |
| `logLevel` | `"DEBUG" \| "INFO" \| "WARN" \| "ERROR"` | — | 日志级别 |

### 3.3 `server`

模块：`packages/chimera/src/config/server.ts`。`chimera serve`/`web` 服务器配置。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `server.port` | `PositiveInt` | — | 监听端口 |
| `server.hostname` | `string` | — | 监听主机名 |
| `server.mdns` | `boolean` | — | 启用 mDNS 服务发现 |
| `server.mdnsDomain` | `string` | `chimera.local` | mDNS 自定义域名 |
| `server.cors` | `string[]` | — | 额外允许的 CORS 域名 |
| `server.maxActiveInstances` | `PositiveInt` | `4` | 服务器 LRU 保留的最大同时活动项目实例数；也可用 `CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES`（或其 OPENCODE 别名）设置，**环境变量优先**（Chimera 扩展） |

### 3.4 `command`

模块：`packages/chimera/src/config/command.ts`。键为命令名，值 `CommandInfo`。除配置文件外，`<配置目录>/command*/**/*.md`（frontmatter + 正文）也会加载（见 [4.3](#43-chimera-sidecar-目录)）。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `command.<name>.template` | `string`（必填） | — | 命令模板体（markdown 内容） |
| `command.<name>.description` | `string` | — | 帮助文本 |
| `command.<name>.agent` | `string` | — | 运行该命令的 agent 覆盖 |
| `command.<name>.model` | `string`（`provider/model`） | — | 模型覆盖 |
| `command.<name>.subtask` | `boolean` | — | 作为 subtask 运行 |

### 3.5 `skills`

模块：`packages/chimera/src/config/skills.ts`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `skills.paths` | `string[]` | — | 附加技能文件夹路径 |
| `skills.urls` | `string[]` | — | 从 URL 拉取技能的地址（如 `https://example.com/.well-known/skills/`）。此键上游已有，**不是** Chimera 扩展 |

### 3.6 `watcher` / `snapshot`

模块：主 schema（`config.ts`）。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `watcher.ignore` | `string[]` | — | 文件监听忽略的 glob 模式 |
| `snapshot` | `boolean` | `true` | 文件系统快照跟踪（undo/redo）。`false` 时不记录快照，撤销/还原无法回滚文件改动 |

### 3.7 `plugin`

模块：`packages/chimera/src/config/plugin.ts`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `plugin` | `(string \| [string, Options])[]` | `[]` | 插件列表。字符串为 npm 包名或路径（含 `file:` URL）；元组为 `[包名/路径, Options]`，Options 为任意键值对传给插件。路径型 spec 相对其声明所在的配置文件解析；`<配置目录>/plugin*/` 下自动发现的 `.ts/.js` 也会加入。合并时按加载身份去重，最后声明者胜出 |

### 3.8 `share` / `autoshare` / `autoupdate`

模块：主 schema。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `share` | `"manual" \| "auto" \| "disabled"` | — | `manual` 允许手动分享，`auto` 自动分享，`disabled` 关闭分享 |
| `autoshare` | `boolean` | — | `@deprecated` → 用 `share`。`autoshare: true` 且未设置 `share` 时等价于 `share: "auto"` |
| `autoupdate` | `boolean \| "notify"` | — | `true` 自动更新；`false` 关闭；`"notify"` 仅提示更新（另受 `OPENCODE_DISABLE_AUTOUPDATE`、`OPENCODE_ALWAYS_NOTIFY_UPDATE` 影响） |

### 3.9 provider 筛选与模型策略：`disabled_providers` / `enabled_providers` / `free_models` / `ultra_models` / `remote_compaction_models`

模块：主 schema。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `disabled_providers` | `string[]` | — | 自动加载时跳过这些 provider。此键上游已有，**不是** Chimera 扩展 |
| `enabled_providers` | `string[]` | — | 设置后**仅**这些 provider 启用，其余忽略。此键上游已有，**不是** Chimera 扩展 |
| `free_models` | `boolean` | `true` | 允许 provider 暴露无凭据的免费模型（当前为 opencode provider 的匿名免费层）。受限环境（如企业内网）可置 `false`：无凭据时该 provider 完全不加载，有凭据时隐藏其 $0 模型（Chimera 扩展） |
| `ultra_models` | `string[]` | — | `@deprecated`：ultra 现已对每个模型广播，此键不再影响行为，仅保留以让旧配置可解析；条目被忽略（Chimera 扩展） |
| `remote_compaction_models` | `string[]` | — | 有资格使用远程压缩（OpenAI Responses API compaction）的模型名；按模型 `api.id` 精确或版本化前缀（`"<entry>-..."`）大小写不敏感匹配，**扩展**内建受信默认列表（`packages/chimera/src/session/remote-compaction-registry.ts` 的 `DEFAULT_REMOTE_COMPACTION_MODELS`），跨来源按并集去重合并（Chimera 扩展） |

### 3.10 `model` / `small_model` / `default_agent` / `username`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `model` | `string` | — | 默认模型，格式 `provider/model`，如 `anthropic/claude-2` |
| `small_model` | `string` | — | 小任务（如标题生成）模型，格式 `provider/model` |
| `default_agent` | `string` | `"build"` | 未指定时的默认主 agent；必须是 primary agent，未设置或非法时回退 `"build"` |
| `username` | `string` | `os.userInfo().username` | 会话中显示的用户名（替代系统用户名） |

### 3.11 `mode` / `agent`

`mode`：`@deprecated` → 用 `agent`。`mode` 下的条目会被提升进同名的 `agent`，并强制 `mode: "primary"`。

`agent`：`Record<string, AgentInfo>`。内置已知键：`plan`（primary）、`build`（primary）、`general`（subagent）、`explore`（subagent）、`title`、`summary`、`compaction`（specialized）；其余任意名称均可（`Schema.StructWithRest`）。模块：`packages/chimera/src/config/agent.ts`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `agent.<name>.model` | `string`（`provider/model`） | — | 该 agent 使用的模型 |
| `agent.<name>.variant` | `string` | — | 使用该 agent 配置模型时的默认模型变体 |
| `agent.<name>.temperature` | `number` | — | 采样温度 |
| `agent.<name>.top_p` | `number` | — | 核采样 |
| `agent.<name>.top_k` | `number` | — | top-k 采样（Chimera 扩展） |
| `agent.<name>.min_p` | `number` | — | min-p 采样（Chimera 扩展） |
| `agent.<name>.presence_penalty` | `number` | — | 存在惩罚（Chimera 扩展） |
| `agent.<name>.frequency_penalty` | `number` | — | 频率惩罚（Chimera 扩展） |
| `agent.<name>.repetition_penalty` | `number` | — | 重复惩罚（Chimera 扩展） |
| `agent.<name>.prompt` | `string` | — | 覆盖系统提示（`agent*/**/*.md` sidecar 的正文即 prompt） |
| `agent.<name>.tools` | `Record<string, boolean>` | — | `@deprecated` → 用 `permission`。`true`→`allow`、`false`→`deny`；`write`/`edit`/`patch` 合并进 `permission.edit` |
| `agent.<name>.disable` | `boolean` | — | 禁用该 agent |
| `agent.<name>.description` | `string` | — | 何时使用该 agent 的说明 |
| `agent.<name>.mode` | `"subagent" \| "primary" \| "all"` | — | agent 角色 |
| `agent.<name>.hidden` | `boolean` | `false` | 从 `@` 自动补全菜单隐藏（仅对 `mode: subagent` 生效） |
| `agent.<name>.options` | `Record<string, any>` | — | 透传给 agent 的扩展选项；未知键会归一化进此处 |
| `agent.<name>.color` | hex（`#RRGGBB`）或主题色名 | — | `primary`/`secondary`/`accent`/`success`/`warning`/`error`/`info` 之一或十六进制色 |
| `agent.<name>.steps` | `PositiveInt` | — | 强制纯文本响应前的最大 agent 迭代次数 |
| `agent.<name>.maxSteps` | `PositiveInt` | — | `@deprecated` → 用 `steps`。归一化时 `steps ?? maxSteps` |
| `agent.<name>.permission` | `PermissionInfo` | — | 该 agent 的权限覆盖（见 3.17） |

### 3.12 `provider`

模块：`packages/chimera/src/config/provider.ts`。键为 provider id，值为 `ProviderInfo`；模型维度在 `provider.<id>.models.<m>`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `provider.<id>.api` | `string` | — | API 类型标识 |
| `provider.<id>.name` | `string` | — | 显示名 |
| `provider.<id>.id` | `string` | — | provider ID |
| `provider.<id>.npm` | `string` | — | 承载该 provider 的 npm 包名 |
| `provider.<id>.env` | `string[]` | — | 该 provider 需要的环境变量名列表 |
| `provider.<id>.wire_api` | `"chat" \| "responses"` | — | 请求线协议，独立于 backend_semantics（Chimera 扩展） |
| `provider.<id>.remote_compaction` | `object` | — | 远程压缩的显式 provider 授权：`profile: "codex-responses"`、`protocols: ["v2","legacy"]`（或反之）、`auth: "provider-bearer"`。非 OpenAI provider 需要此授权（Chimera 扩展） |
| `provider.<id>.backend_semantics` | `"openai" \| "codex" \| "alibailian"` | — | 独立于传输层的"能力语义"；`"codex"` 用于 Codex 后端 relay，`"alibailian"` 用于阿里百炼（Model Studio）端点/relay；模型级值覆盖此默认（Chimera 扩展） |
| `provider.<id>.search_model` | `string` | `qwen3.8-flash` | `backend_semantics` 为 `"alibailian"` 时用于统一 websearch 聚合的模型 ID（Chimera 扩展） |
| `provider.<id>.userAgent` | `string` | — | 请求 User-Agent 覆盖（Chimera 扩展） |
| `provider.<id>.whitelist` | `string[]` | — | 模型白名单 |
| `provider.<id>.blacklist` | `string[]` | — | 模型黑名单 |
| `provider.<id>.options` | `object` | — | 见下 |
| `provider.<id>.models` | `Record<string, Model>` | — | 模型覆盖（见下） |

`provider.<id>.options`：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `options.apiKey` | `string` | — | API 密钥（建议用 `{env:XXX_API_KEY}` 引用） |
| `options.baseURL` | `string` | — | 自定义 base URL |
| `options.enterpriseUrl` | `string` | — | GitHub Enterprise URL（copilot 认证用） |
| `options.setCacheKey` | `boolean` | `false` | 为该 provider 启用 promptCacheKey |
| `options.timeout` | `PositiveInt \| false` | `300000`（5 分钟） | 请求超时毫秒；`false` 关闭超时 |
| `options.chunkTimeout` | `PositiveInt` | — | SSE 流式块间超时毫秒，超时中止请求 |
| `options.*`（其余） | `any` | — | 透传任意 provider 选项（`StructWithRest`） |

`provider.<id>.models.<m>`（`Model`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `models.<m>.id` | `string` | — | 模型 API ID |
| `models.<m>.name` | `string` | — | 显示名 |
| `models.<m>.family` | `string` | — | 模型家族 |
| `models.<m>.wire_api` | `"chat" \| "responses"` | — | 该模型的线协议，优先于 provider 默认（Chimera 扩展） |
| `models.<m>.remote_compaction` | `boolean` | — | 显式启用/禁用该模型的 provider 远程压缩（Chimera 扩展） |
| `models.<m>.backend_semantics` | `"openai" \| "codex" \| "alibailian"` | — | 独立于配置传输层的能力语义（Chimera 扩展） |
| `models.<m>.capability_model_id` | `string` | — | 能力查找用规范模型 ID（不改变请求模型 ID）（Chimera 扩展） |
| `models.<m>.size_class` | `"S" \| "M" \| "L" \| "XL"` | — | 子代理调度用的模型尺寸类，覆盖从模型身份推断的结果（Chimera 扩展） |
| `models.<m>.reasoning_efforts` | `string[]` | — | 该模型支持的推理档位值列表（Chimera 扩展） |
| `models.<m>.release_date` | `string` | — | 发布日期 |
| `models.<m>.attachment` | `boolean` | — | 是否支持附件 |
| `models.<m>.reasoning` | `boolean` | — | 是否支持推理 |
| `models.<m>.temperature` | `boolean` | — | 是否支持温度 |
| `models.<m>.tool_call` | `boolean` | — | 是否支持工具调用 |
| `models.<m>.interleaved` | `true \| { field: "reasoning_content" \| "reasoning_details" }` | — | 与文本交织的推理内容字段 |
| `models.<m>.cost` | `object` | — | `{ input, output, cache_read?, cache_write?, context_over_200k? }`（`context_over_200k` 同构） |
| `models.<m>.limit` | `object` | — | `{ context, input?, output }` |
| `models.<m>.modalities` | `object` | — | `{ input: [...], output: [...] }`，元素为 `text`/`audio`/`image`/`video`/`pdf` |
| `models.<m>.experimental` | `boolean` | — | 实验模型标记 |
| `models.<m>.status` | `"alpha" \| "beta" \| "deprecated"` | — | 模型状态 |
| `models.<m>.provider` | `object` | — | `{ npm?, api? }` |
| `models.<m>.options` | `Record<string, any>` | — | 透传选项 |
| `models.<m>.headers` | `Record<string, string>` | — | 附加请求头 |
| `models.<m>.variants` | `Record<string, object>` | — | 变体级配置（字段与上游同形，非 Chimera 扩展）：每个变体名下为 `{ disabled?: boolean, ...任意扩展键 }`。`ultra` 是 Chimera 产品级变体，`variants.ultra.disabled: true` 可禁用该模型的 ultra 变体；在已禁用模型上选择 ultra 会失败 |

#### 3.12.1 Responses wire 保真选项（Chimera 扩展）

以下选项仅在 `wire_api: "responses"`（或 Codex/OpenAI Responses 语义后端）下有意义。它们沿 `provider.<id>.options` → `models.<m>.options` → agent 选项 → 变体（variant）选项的合并链透传，最终由 `ProviderTransform.providerOptions` 归入 SDK 的 `providerOptions.openai` 命名空间。合并顺序为 **base（内置默认）< `models.<m>.options` < agent 选项 < 变体选项**，后合并者覆盖先合并者（普通对象深合并，数组整体替换）。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `options.store` | `boolean` | `false` | Responses 后端是否持久化该响应（`store`）。Chimera 对 `@ai-sdk/openai` 及 OpenAI 语义 provider 默认注入 `false`；可在 `provider.<id>.options.store` 或 `models.<m>.options.store` 覆盖为 `true`（模型级优先，变体级再优先）。仅 responses wire 有意义 |
| `options.hosted_web_search` | `boolean` | 按 provider 能力推断 | 是否注入 provider 托管的 web search 工具（Responses 的 `web_search`）。provider 级与模型级均可设置，模型级优先 |
| `options.replay_compensation` | `"auto" \| "always" \| "never"` | `"auto"` | Responses 流重放补偿策略。`"auto"`：仅对非 OpenAI 的 responses provider 自动补偿；`"always"`：始终补偿；`"never"`：关闭补偿 |
| `options.forceReasoning` | `boolean` | — | 强制把该模型按推理模型处理（透传为 `providerOptions.openai.forceReasoning`），用于模型 ID 未被 SDK 识别的"隐身"推理模型。副作用见下 |
| `options.reasoningEffort` | `string` | — | 推理档位，经同一合并链进入 `providerOptions.openai.reasoningEffort` |

> **`forceReasoning` 的副作用（重要）**：开启后，`@ai-sdk/openai`（本仓库锁定 `3.0.88`）会把该模型判定为推理模型，并从请求体中**剥除 `temperature` 与 `top_p`**（同时在 `warnings` 中报告 `unsupported: temperature` / `unsupported: topP`）。因此推荐把采样参数与 `forceReasoning` 拆到不同变体：
>
> - 默认变体保留采样参数（不设 `forceReasoning`）；
> - 单独的 thinking 变体带 `forceReasoning: true` + `reasoningEffort`。
>
> 若某后端必须同时保留采样参数与推理，且 `forceReasoning` 无法满足，可改用 custom fetch 在顶层 body 注入 `enable_thinking`（**备选方案**，仅在上述配方不够用时才使用）。

```jsonc
{
  "provider": {
    "myrelay": {
      "options": {
        "store": false,
        "hosted_web_search": true,
        "replay_compensation": "auto"
      },
      "models": {
        "some-model": {
          "options": {
            "forceReasoning": true,
            "reasoningEffort": "high"
          },
          "variants": {
            "thinking": {
              "forceReasoning": true,
              "reasoningEffort": "high"
            }
          }
        }
      }
    }
  }
}
```

#### 3.12.2 会话缓存请求头（Chimera 扩展，零代码）

部分内部中转 provider 通过请求头开启会话级前缀缓存。无需新增代码，直接经现有 `models.<m>.headers` 注入即可（provider 级无独立 `headers` 字段，如需 provider 级默认请写在该 provider 每个模型的 `headers`，或借助 agent/模型配置层）。

```jsonc
{
  "provider": {
    "myrelay": {
      "models": {
        "some-model": {
          "headers": { "x-dashscope-session-cache": "enable" }
        }
      }
    }
  }
}
```

头部按 provider → 模型 → agent 顺序合并；模型级同名头覆盖 provider 级。`x-dashscope-session-cache: enable` 是百炼（Model Studio）语义端点的公开示例头，具体头名以所用中转端点文档为准。

### 3.13 `mcp`

模块：`packages/chimera/src/config/mcp.ts`。键为服务器名，值为 `Local` 或 `Remote`（以 `type` 判别），另兼容旧的 `{ enabled: false }` 形式用于禁用某个已内置服务器。

`Local`（`type: "local"`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mcp.<name>.type` | `"local"` | — | 连接类型 |
| `mcp.<name>.command` | `string[]`（必填） | — | 启动 MCP 服务器的命令与参数 |
| `mcp.<name>.environment` | `Record<string, string>` | — | 运行服务器时设置的环境变量 |
| `mcp.<name>.enabled` | `boolean` | — | 启动时是否启用该服务器 |
| `mcp.<name>.timeout` | `PositiveInt` | `5000` | MCP 请求超时毫秒 |

`Remote`（`type: "remote"`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mcp.<name>.type` | `"remote"` | — | 连接类型 |
| `mcp.<name>.url` | `string`（必填） | — | 远程 MCP 服务器 URL |
| `mcp.<name>.enabled` | `boolean` | — | 启动时是否启用 |
| `mcp.<name>.headers` | `Record<string, string>` | — | 随请求发送的头 |
| `mcp.<name>.oauth` | `OAuth \| false` | — | OAuth 配置；`false` 关闭 OAuth 自动检测 |
| `mcp.<name>.timeout` | `PositiveInt` | `5000` | MCP 请求超时毫秒 |

`OAuth`：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `oauth.clientId` | `string` | — | OAuth client ID；不提供时尝试动态客户端注册（RFC 7591） |
| `oauth.clientSecret` | `string` | — | OAuth client secret（授权服务器要求时） |
| `oauth.scope` | `string` | — | 授权请求的 scopes |
| `oauth.redirectUri` | `string` | `http://127.0.0.1:19876/mcp/oauth/callback` | OAuth 回调 URI |

### 3.14 `formatter`

模块：`packages/chimera/src/config/formatter.ts`。`boolean | Record<string, Entry>`：`false`/省略关闭，`true` 启用内建格式化器，对象则在内建基础上覆盖。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `formatter.<name>.disabled` | `boolean` | — | 禁用该格式化器 |
| `formatter.<name>.command` | `string[]` | — | 格式化命令与参数 |
| `formatter.<name>.environment` | `Record<string, string>` | — | 运行命令的环境变量 |
| `formatter.<name>.extensions` | `string[]` | — | 关联的文件扩展名 |

### 3.15 `lsp`

模块：`packages/chimera/src/config/lsp.ts`。`boolean | Record<string, Entry>`：语义同 `formatter`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `lsp.<name>.disabled` | `boolean` | — | 禁用该服务器；`{ disabled: true }` 是独立合法形态 |
| `lsp.<name>.command` | `string[]`（非禁用时必填） | — | 启动命令与参数 |
| `lsp.<name>.extensions` | `string[]` | — | 关联文件扩展名。**自定义（非内建）服务器必须提供**，否则校验失败；内建服务器 id 与显式禁用的条目豁免 |
| `lsp.<name>.env` | `Record<string, string>` | — | 运行环境变量 |
| `lsp.<name>.initialization` | `Record<string, unknown>` | — | 初始化选项 |

### 3.16 `instructions` / `layout`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `instructions` | `string[]` | — | 附加指令文件或 glob 模式；跨配置来源按去重集合**拼接**而非替换 |
| `layout` | `"auto" \| "stretch"` | — | `@deprecated`：恒使用 stretch 布局 |

### 3.17 `permission` / `tools`

模块：`packages/chimera/src/config/permission.ts`。`permission` 可以是一个简写字符串 `"ask" | "allow" | "deny"`（等价于 `{ "*": action }`），也可以是对象。对象的值有两种形态（`Rule`）：

- `Action` 字符串：`"ask"`（询问）、`"allow"`（放行）、`"deny"`（拒绝）。
- 对象 `Record<string, Action>`：对特定目标（如路径、工具参数模式）的细粒度规则。

已知键（其余任意工具名落入 `Record<string, Rule>` 通配槽位；运行时保留键的书写顺序用于判定优先级）：

| 键 | 值形态 | 说明 |
| --- | --- | --- |
| `permission.*` | `Action` | `"*"` 通配默认（简写字符串自动变成它） |
| `permission.read` / `edit` / `glob` / `grep` / `list` / `bash` | `Rule` | 文件读、写、glob、grep、list、bash 工具 |
| `permission.task` / `task_profile` / `task_model` | `Rule` | 子代理委派相关工具（`task_profile`、`task_model` 为 Chimera 扩展） |
| `permission.subagent_model_prefer` / `subagent_model_suppress` | `Rule` | 子代理模型偏好/抑制（Chimera 扩展） |
| `permission.external_directory` | `Rule` | 外部目录访问 |
| `permission.lsp` | `Rule` | LSP 相关工具 |
| `permission.skill` | `Rule` | 技能加载 |
| `permission.todowrite` | `Action` | TODO 写入工具 |
| `permission.workbrief` | `Action` | workbrief 工具（Chimera 扩展） |
| `permission.memory_remember` / `memory_list` / `memory_forget` / `memory_read` | `Action` | 记忆工具（Chimera 扩展） |
| `permission.question` | `Action` | 提问工具 |
| `permission.webfetch` / `websearch` | `Action` | 网络工具 |
| `permission.doom_loop` | `Action` | 死循环检测 |
| `permission.chimera_oracle_recent` / `chimera_oracle_get` | `Action` | Chimera oracle 工具（Chimera 扩展） |

`tools`：`Record<string, boolean>`，`@deprecated` → 翻译进 `permission`（`true`→`allow`、`false`→`deny`；`write`/`edit`/`patch` → `permission.edit`）。

### 3.18 `delegation`（Chimera 扩展）

模块：`packages/chimera/src/config/delegation.ts`。子代理调度与委派配置。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `delegation.model_profiles` | `Record<string, ModelProfile>` | — | 命名模型档案（见下） |
| `delegation.routes` | `Record<string, string>` | — | 角色（agent 名）到 model_profile 的映射 |
| `delegation.scheduling` | `object` | — | 调度器行为（见下） |
| `delegation.max_depth` | `PositiveInt` | `3` | 委派链最大深度（含根会话，3 = 根 → 子 → 孙）；达到上限的会话不能再派生子代理 |
| `delegation.max_concurrent` | `PositiveInt` | `128` | 运行时的并发子代理总预算；耗尽后新派发排队等待，等待自己孩子的子代理不占用预算 |
| `delegation.background_subagents` | `boolean` | `true` | 启用后台子代理；关闭是 kill-switch，后台派发退化为同步委派 |
| `delegation.background_concurrent` | `PositiveInt` | `16` | 并发后台任务独立上限；达上限直接报错拒绝（不排队），防止后台任务挤占 `max_concurrent` 预算 |

`delegation.model_profiles.<name>`（`ModelProfile`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `model` | `string`（`provider/model`，必填） | — | 该档案使用的模型 |
| `variant` | `string` | — | 模型变体 |
| `description` | `string` | — | 档案说明 |

`delegation.scheduling`：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `scheduling.enabled` | `boolean` | — | 调度器开关 |
| `scheduling.spend` | `"subscription-first" \| "metered-first"` | — | 计费偏好 |
| `scheduling.quotaFloorPercent` | `number` | — | 配额下限百分比 |
| `scheduling.quotaStrainPercent` | `number` | — | 配额压力百分比 |
| `scheduling.rlStrainThreshold` | `number` | — | 限流压力阈值 |
| `scheduling.archetypes` | `Record<string, SchedulingArchetype>` | — | 工作负载档案（`<workload>` 如 `builder`/`scout`/`swarm`），见下 |
| `scheduling.overrides` | `Record<string, { billing?: "metered" \| "subscription" \| "free" \| "unknown" }>` | — | 按模型的计费覆盖 |
| `scheduling.topTierDisabledMinSizeClass` | `"S" \| "M" \| "L" \| "XL"` | — | 达到该尺寸类的路由放弃最高推理档（默认配置为 XL） |
| `scheduling.capability_anchors` | `Record<string, { score: number, tier?: string, uncertainty?: number }>` | — | 用户提供的调度能力锚点，按模型身份键控；`score` 为 0..1 质量分（默认档位 `"max"`）；身份精确匹配或按版本化 dash 前缀匹配；优先于内建锚点，使新模型无需改代码即可被调度 |

`delegation.scheduling.archetypes.<workload>`（`SchedulingArchetype`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `description` | `string` | — | 该工作负载档案的说明 |
| `minQuality` | `number` | — | 该工作负载的最低质量门槛 |
| `effortCap` | `string` | — | 推理档位上限 |
| `maxSizeClass` | `"S" \| "M" \| "L" \| "XL"` | — | 最大允许的模型尺寸类 |
| `minSizeClass` | `"S" \| "M" \| "L" \| "XL"` | — | 最小允许的模型尺寸类 |
| `weights` | `{ quality: number, speed: number, cost: number, size?: number }` | — | 调度打分权重 |
| `budgetUsdPerWorker` | `number` | — | 每 worker 的美元预算上限 |
| `excludeModels` | `string[]` | — | 从该工作负载中排除的模型路由（`provider/modelID`）、模型身份或 provider ID；被排除的路由永远不是该工作负载的候选，声明该工作负载的派发若选中被排除模型会失败（resume 除外）。其他工作负载不受影响 |

### 3.19 `enterprise` / `tool_output`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enterprise.url` | `string` | — | 企业 URL |
| `tool_output.max_lines` | `PositiveInt` | `2000` | 工具输出超过该行数即截断并落盘，返回预览 |
| `tool_output.max_bytes` | `PositiveInt` | `51200` | 工具输出超过该字节数即截断并落盘，返回预览 |

### 3.20 `compaction`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `compaction.auto` | `boolean` | `true` | 上下文满时自动压缩 |
| `compaction.prune` | `boolean` | `true` | 修剪旧的工具输出 |
| `compaction.tail_turns` | `NonNegativeInt` | `2` | 压缩时逐字保留的最近用户轮次（含其后的 assistant/工具响应）数 |
| `compaction.preserve_recent_tokens` | `NonNegativeInt` | — | 压缩后逐字保留的最近轮次 token 上限 |
| `compaction.reserved` | `NonNegativeInt` | — | 压缩 token 缓冲，避免压缩过程溢出 |
| `compaction.remote` | `"auto" \| "on" \| "off"` | — | 对受支持的 OpenAI OAuth 会话或显式声明能力的 provider 使用远程压缩；`on` 不会绕过 provider/model 能力 opt-in，`off` 阻止未来远程压缩（Chimera 扩展） |
| `compaction.remote_protocol` | `"auto" \| "v2" \| "legacy"` | — | 远程压缩线协议：`auto` 用显式授权的 provider 协议顺序，`v2` 仅用 Responses compaction v2，`legacy` 仅用 `/responses/compact`（Chimera 扩展） |

### 3.21 `memories`（Chimera 扩展）

模块：`packages/chimera/src/config/memory.ts`。跨会话记忆，**默认关闭**（`enabled` 才启用）。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `memories.enabled` | `boolean` | `false` | 启用跨会话记忆 |
| `memories.use_memories` | `boolean` | `true` | 启用后向会话注入记忆 |
| `memories.generate_memories` | `boolean` | `true` | 允许 Chimera 生成/更新记忆 |
| `memories.disable_on_external_context` | `boolean` | `true` | 含外部上下文的会话跳过自动生成记忆 |
| `memories.dedicated_tools` | `boolean` | `false` | 启用记忆工具（`memory_remember`/`memory_list`/`memory_forget`/`memory_read`）暴露给 agent |
| `memories.max_summary_chars` | `PositiveInt` | `12000` | 注入记忆摘要的字符上限 |

### 3.22 `experimental`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `experimental.disable_paste_summary` | `boolean` | — | 关闭粘贴摘要 |
| `experimental.batch_tool` | `boolean` | — | 启用 batch 工具 |
| `experimental.openTelemetry` | `boolean` | — | 为 AI SDK 调用启用 OpenTelemetry spans（`experimental_telemetry` 标志） |
| `experimental.primary_tools` | `string[]` | — | 仅主 agent 可用的工具列表（上游已有，非 Chimera 扩展） |
| `experimental.continue_loop_on_deny` | `boolean` | — | 工具调用被拒后继续 agent 循环 |
| `experimental.mcp_timeout` | `PositiveInt` | — | MCP 请求超时毫秒 |
| `experimental.system_context` | `boolean` | `false` | 启用 SystemContext 源跟踪与上下文纪元持久化：首轮保存组装好的基线，后续轮次复用基线，源变化作为额外系统消息注入而不是重建；关闭时组装与默认路径逐字节一致且不访问纪元数据库（Chimera 扩展） |

---

## 4. 主 schema 之外的配置面

### 4.1 `codegraph.json`（graph 项目配置）

模块：`packages/chimera/src/graph/config.ts`。项目根的可提交 `codegraph.json`（普通 JSON，**不支持 JSONC**），供团队通过版本控制共享。目前只有一个字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `includeIgnored` | `string[]` | `[]` | gitignore 风格的 pattern，指名**被 gitignore 但内含 git 仓库、仍要索引**的目录（显式覆盖 `.gitignore` 的嵌套仓库发现，对应上游 #622/#699）。缺省/非法文件 = 零配置默认（完全尊重 `.gitignore`）；非法条目警告并跳过，绝不致命。加载按项目根 mtime 缓存 |

### 4.2 `tui.json`（TUI 配置独立文件）

- TUI 配置独立于主配置，文件名为 `tui.json` / `tui.jsonc`，schema 生成代码在 `packages/chimera/script/schema.ts` 的第二个输出参数。
- 加载代码：`packages/chimera/src/cli/cmd/tui/config/tui.ts`。顺序：`~/.config/chimera/` 下 `tui.json` → `tui.jsonc`（后者覆盖）→ `OPENCODE_TUI_CONFIG` 指定文件 → 项目向上 `tui.jsonc`/`tui.json`（根优先，最近者胜）→ 各 `.chimera/` 目录与 `OPENCODE_CONFIG_DIR` 下的 `tui.json`/`tui.jsonc`。支持 `{env:...}`/`{file:...}` 替换（缺失用 `empty` 模式）。`tui.json` 内嵌套的 `tui` 键会被拍平到顶层以兼容旧 `chimera.json` 形态。
- **主配置中的 `theme`/`keybinds`/`tui` 三个键会被剥离并警告**（`normalizeLoadedConfig`，见主 schema 的 `packages/chimera/src/config/config.ts`）——请迁移到 `tui.json`。
- 内容见 TUI 独立 schema（`plugin`、`keybinds`、`themes` 等），不在本文档范围内；历史 TUI 配置会自动迁移（`tui-migrate`）。

### 4.3 `.chimera/` sidecar 目录

每个**配置目录**（`~/.config/chimera/`、项目内各级 `.chimera/`、`~/.chimera/`、`OPENCODE_CONFIG_DIR`）都会做 sidecar 扫描，与 `chimera.json` 合并：

| sidecar | 扫描模式 | 合并语义 | 源码 |
| --- | --- | --- | --- |
| agent | `agent/**/*.md`、`agents/**/*.md` | frontmatter 作为 `AgentInfo` 字段，正文作为 `prompt`；`mode/**/*.md`、`modes/**/*.md` 加载为 `mode: "primary"` 的 agent | `packages/chimera/src/config/agent.ts` |
| command | `command/**/*.md`、`commands/**/*.md` | frontmatter 作为 `CommandInfo` 字段，正文作为 `template` | `packages/chimera/src/config/command.ts` |
| plugin | `plugin/*.{ts,js}`、`plugins/*.{ts,js}` | 每个文件作为插件 spec（`file:` URL） | `packages/chimera/src/config/plugin.ts` |

sidecar 的名字取自路径（strip `.chimera/`、`agent(s)`、`command(s)` 与扩展名）。与合并规则一致：越靠后的目录覆盖越靠前的目录（`~/.chimera` 与 `OPENCODE_CONFIG_DIR` 最后）。

### 4.4 运行时状态文件（非用户配置）

| 文件 | 位置 | 说明 |
| --- | --- | --- |
| `subagent-routing.json` | `~/.local/state/chimera/`（`Global.Path.state`） | 子代理模型偏好（`subagent_model_prefer`/`subagent_model_suppress` 写入）的**运行时维护**分数，非用户编辑配置（`packages/chimera/src/config/subagent-routing.ts`） |
| `model.json` | `~/.local/state/chimera/` | 会话级模型选择状态（`model`/`recent`/`favorite`/`variant`），运行时维护（`packages/chimera/src/config/model-selection.ts`、`packages/chimera/src/provider/provider.ts`） |

### 4.5 graph 数据根 `.chimera/` 与 `.codegraph/`

- 当前 graph 数据根为项目内 **`.chimera/`**（含 `codegraph.db`、`index-job.json` 等）；`.codegraph/` 是 legacy 兼容数据（只读探测与显式迁移）。
- 数据根状态：`uninitialized` / `current` / `legacy` / `mixed` / `custom`。只读工具（status/query/搜索）绝不创建或迁移数据；只有 `chimera graph init`/`index`/`sync`/`migrate-data` 等显式写流程可以创建/迁移。
- 环境变量 `CHIMERA_DATA_DIR` 或 `CODEGRAPH_DATA_DIR` 可把数据根指向别处（绝对路径或相对项目根解析），此时状态为 `custom`。
- 相关源码：`packages/chimera/src/graph/directory.ts`。

---

## 5. 环境变量参考

### 5.1 `CHIMERA_*` 别名机制

- **OPENCODE 别名**（`packages/core/src/flag/flag.ts` 的 `CHIMERA_OPENCODE_ENV_ALIASES`）：对清单内的每个键 `X`，若 `CHIMERA_X` 已设置，则写入 `OPENCODE_X`——若两者都已设置且值不同，打印警告 `CHIMERA_X overrides OPENCODE_X`。清单包括 `CONFIG`、`CONFIG_CONTENT`、`CONFIG_DIR`、`PERMISSION`、`DISABLE_AUTOCOMPACT`、`DISABLE_PRUNE`、`DISABLE_PROJECT_CONFIG`、`SERVER_PASSWORD`、`SERVER_USERNAME`、`SERVER_HONO`、`AUTO_SHARE`、`MODELS_URL`、`MODELS_PATH`、`DB`、`DISABLE_AUTOUPDATE`、`ALWAYS_NOTIFY_UPDATE`、`DISABLE_MODELS_FETCH`、`ENABLE_EXPERIMENTAL_MODELS`、`DISABLE_CLAUDE_CODE*`、`DISABLE_EXTERNAL_SKILLS`、`DISABLE_LSP_DOWNLOAD`、`DISABLE_EMBEDDED_WEB_UI`、`WORKSPACE_ID`、`TUI_CONFIG`、`CLIENT`、`PURE` 等。凡命中的 `OPENCODE_*` 变量都有 `CHIMERA_*` 别名。
- **CODEGRAPH 别名**（`packages/chimera/src/graph/env.ts` 的 `CHIMERA_CODEGRAPH_ENV_ALIASES`）：graph 模块同理，`CHIMERA_X` 覆盖 `CODEGRAPH_X`（`ALLOW_UNSAFE_NODE`、`NO_WATCH`、`FORCE_WATCH`、`NO_DAEMON`、`DAEMON_INTERNAL`、`MCP_DEBUG`、`MCP_TOOLS`、`PPID_POLL_MS`、`WATCH_DEBOUNCE_MS`、`DAEMON_IDLE_TIMEOUT_MS`、`WASM_RELAUNCHED`、`HOST_PPID`、`NO_RELAUNCH`、`RESOLVER_CACHE_SIZE`、`EXPLORE_LINENUMS`、`ADAPTIVE_EXPLORE`、`DEBUG`、`ASCII`、`UNICODE`、`AMBIGUOUS_NAME_CEILING`、`CATCHUP_GATE_TIMEOUT_MS`）。
- `CHIMERA_INSTANCE_*` 不做别名转发，而是由实例存储代码显式读取 `CHIMERA_`/`OPENCODE_` 双名（部分键只有 `CHIMERA_` 形式，见下）。

### 5.2 配置加载类

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_CONFIG`（别名 `CHIMERA_CONFIG`） | 指向一个自定义配置文件的路径，按 environment 来源加载 |
| `OPENCODE_CONFIG_CONTENT`（别名 `CHIMERA_CONFIG_CONTENT`） | 内联 JSON/JSONC 配置字符串，按 environment 来源加载 |
| `OPENCODE_CONFIG_DIR`（别名 `CHIMERA_CONFIG_DIR`） | 额外配置目录；其下 `chimera.json`/`chimera.jsonc` 与 sidecar 均加载，最后合并；同时作为全局配置目录覆盖（`packages/core/src/global.ts`） |
| `OPENCODE_DISABLE_PROJECT_CONFIG`（别名 `CHIMERA_DISABLE_PROJECT_CONFIG`） | 值为 truthy 时禁用项目配置文件中向上查找与 `.chimera/` 向上查找 |
| `OPENCODE_PERMISSION`（别名 `CHIMERA_PERMISSION`） | JSON 权限对象，深合并到文件配置的 `permission` 之上；JSON 非法时警告并跳过 |
| `OPENCODE_DISABLE_AUTOCOMPACT`（别名 `CHIMERA_DISABLE_AUTOCOMPACT`） | 强制 `compaction.auto = false` |
| `OPENCODE_DISABLE_PRUNE`（别名 `CHIMERA_DISABLE_PRUNE`） | 强制 `compaction.prune = false` |
| `OPENCODE_TUI_CONFIG`（别名 `CHIMERA_TUI_CONFIG`） | TUI 配置文件路径覆盖 |
| `OPENCODE_CONSOLE_TOKEN` | 内部使用：从账户 token 设置并注入环境（console 管理 provider 流程） |
| `OPENCODE_TEST_MANAGED_CONFIG_DIR` | 仅测试：覆盖系统 managed 配置目录 |

### 5.3 服务器 / 实例类

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD`（别名 `CHIMERA_SERVER_PASSWORD`） | `chimera serve`/`web` 的 Basic Auth 密码 |
| `OPENCODE_SERVER_USERNAME`（别名 `CHIMERA_SERVER_USERNAME`） | Basic Auth 用户名（默认 `chimera`） |
| `OPENCODE_SERVER_HONO`（别名 `CHIMERA_SERVER_HONO`） | 临时逃生舱：强制使用旧 Hono 服务端后端 |
| `CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES` / `OPENCODE_INSTANCE_MAX_ACTIVE_INSTANCES` | 覆盖 `server.maxActiveInstances`（LRU 活跃实例上限，默认 4），显式环境变量优先于配置 |
| `CHIMERA_INSTANCE_IDLE_TTL_MS` / `OPENCODE_INSTANCE_IDLE_TTL_MS` | 实例空闲 TTL（默认 600000） |
| `CHIMERA_INSTANCE_IDLE_SWEEP_MS` / `OPENCODE_INSTANCE_IDLE_SWEEP_MS` | 空闲清扫间隔（默认 60000） |
| `CHIMERA_INSTANCE_BOOT_GRACE_MS` | 引导宽限期（默认 60000，仅 CHIMERA 形式） |
| `CHIMERA_INSTANCE_SWEEP_DEBOUNCE_MS` | 清扫防抖（默认 5000，仅 CHIMERA 形式） |
| `CHIMERA_INSTANCE_OSCILLATION_WINDOW_MS` | 振荡窗口（默认 30000，仅 CHIMERA 形式） |
| `CHIMERA_INSTANCE_OSCILLATION_PIN_MS` | 振荡固定时长（默认 120000，仅 CHIMERA 形式） |
| `OPENCODE_INSTANCE_DISPOSER_TIMEOUT_MS` | 实例 dispose 超时（默认 4000） |

### 5.4 浏览器类

| 变量 | 作用 |
| --- | --- |
| `CHIMERA_BROWSER_CDP_URL` | 浏览器自动化的 CDP 连接 URL |
| `CHIMERA_BROWSER_EXECUTABLE_PATH` | Chrome/Chromium 可执行文件路径 |
| `CHIMERA_BROWSER_HEADLESS` | 设为 `false` 关闭 headless 模式（默认 headless） |

源码：`packages/chimera/src/browser/runtime.ts`、`browser/discovery.ts`。

### 5.5 Graph / CodeGraph 类

| 变量 | 作用 |
| --- | --- |
| `CHIMERA_DATA_DIR` / `CODEGRAPH_DATA_DIR` | 覆盖项目本地 graph 数据根（绝对或相对项目根）；状态变为 `custom` |
| `CHIMERA_ALLOW_UNSAFE_NODE` / `CODEGRAPH_ALLOW_UNSAFE_NODE` | 允许在不支持的 Node 版本上运行 graph CLI |
| `CODEGRAPH_NO_WATCH` / `CODEGRAPH_FORCE_WATCH` | 关闭/强制 graph 文件监听 |
| `CODEGRAPH_NO_WAL_DEFER` | 关闭 WAL 延迟合并 |
| `CODEGRAPH_WAL_VALVE_MB` | WAL 阀值软上限（MB） |
| `CODEGRAPH_NO_DAEMON` | 关闭 MCP daemon |
| `CODEGRAPH_DAEMON_INTERNAL` | 分离 daemon 的标记 |
| `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` | daemon 空闲超时 |
| `CODEGRAPH_PPID_POLL_MS` | 父进程轮询间隔 |
| `CODEGRAPH_WATCH_DEBOUNCE_MS` | 监听防抖间隔 |
| `CODEGRAPH_NO_RELAUNCH` / `CODEGRAPH_HOST_PPID` / `CODEGRAPH_WASM_RELAUNCHED` | WASM 解析进程 relaunch 控制（host ppid 与禁用 relaunch） |
| `CODEGRAPH_RESOLVER_CACHE_SIZE` | 引用解析器缓存大小 |
| `CODEGRAPH_AMBIGUOUS_NAME_CEILING` | 歧义名称上限 |
| `CODEGRAPH_PARSE_WORKERS` | 解析 worker 池大小 |
| `CODEGRAPH_PARSE_TIMEOUT_MS` | 单次解析超时 |
| `CODEGRAPH_EXPLORE_LINENUMS` / `CODEGRAPH_ADAPTIVE_EXPLORE` | MCP explore 工具行为开关（默认开） |
| `CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS` | catchup 门超时 |
| `CODEGRAPH_MCP_TOOLS` | 暴露的 MCP 工具白名单 |
| `CODEGRAPH_MCP_DEBUG` | MCP 调试日志 |
| `CODEGRAPH_ASCII` / `CODEGRAPH_UNICODE` | 强制图形字符集 |
| `CODEGRAPH_DEBUG` | graph 调试日志 |
| `CHIMERA_PARSE_WORKER_PATH` | 解析 worker 路径覆盖（构建期） |

源码：`packages/chimera/src/graph/`（`directory.ts`、`db/index.ts`、`db/wal-valve.ts`、`sync/watch-policy.ts`、`mcp/*`、`index.ts`、`resolution/*`、`extraction/*`、`errors.ts`、`ui/glyphs.ts`）。

### 5.6 SQLite 类

| 变量 | 作用 |
| --- | --- |
| `CHIMERA_SQLITE_CACHE_MB` | SQLite 页缓存大小（默认 64 MB） |
| `CHIMERA_SQLITE_MMAP_MB` | SQLite mmap 大小（默认 256 MB） |
| `CHIMERA_SQLITE_TEMP_STORE` | 设为 `MEMORY` 强制内存临时存储（默认 `FILE`） |

源码：`packages/chimera/src/graph/db/index.ts`。

### 5.7 模型 / DB / 杂项 `OPENCODE_*`

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_AUTH_CONTENT` | 内联 JSON 认证数据（workspace/无头场景注入，`packages/chimera/src/auth/index.ts` 等） |
| `OPENCODE_WORKSPACE_ID`（别名 `CHIMERA_WORKSPACE_ID`） | 强制 workspace ID |
| `OPENCODE_AUTO_SHARE`（别名 `CHIMERA_AUTO_SHARE`） | 自动分享会话 |
| `OPENCODE_DISABLE_SHARE` | 关闭分享功能 |
| `OPENCODE_DISABLE_AUTOUPDATE`（别名 `CHIMERA_DISABLE_AUTOUPDATE`） | 关闭自动更新 |
| `OPENCODE_ALWAYS_NOTIFY_UPDATE`（别名 `CHIMERA_ALWAYS_NOTIFY_UPDATE`） | 总是提示更新 |
| `OPENCODE_MODELS_URL` / `OPENCODE_MODELS_PATH`（别名 `CHIMERA_MODELS_URL`/`CHIMERA_MODELS_PATH`） | 模型端点覆盖（远程 URL 或本地路径） |
| `OPENCODE_DISABLE_MODELS_FETCH`（别名 `CHIMERA_DISABLE_MODELS_FETCH`） | 关闭远程模型列表拉取 |
| `OPENCODE_ENABLE_EXPERIMENTAL_MODELS`（别名 `CHIMERA_ENABLE_EXPERIMENTAL_MODELS`） | 显示 alpha 实验模型 |
| `OPENCODE_DB`（别名 `CHIMERA_DB`） | DB 路径覆盖 |
| `OPENCODE_DISABLE_CHANNEL_DB` / `OPENCODE_SKIP_MIGRATIONS`（别名同构） | DB 通道/迁移行为 |
| `OPENCODE_DISABLE_CLAUDE_CODE` / `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`（别名 `CHIMERA_*`） | 关闭 Claude Code 兼容层（prompt/skills） |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS`（别名 `CHIMERA_DISABLE_EXTERNAL_SKILLS`） | 关闭外部技能目录 |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS`（别名 `CHIMERA_DISABLE_DEFAULT_PLUGINS`） | 关闭默认插件 |
| `OPENCODE_DISABLE_LSP_DOWNLOAD`（别名 `CHIMERA_DISABLE_LSP_DOWNLOAD`） | 关闭 LSP 自动下载 |
| `OPENCODE_ENABLE_QUESTION_TOOL`（别名 `CHIMERA_ENABLE_QUESTION_TOOL`） | 启用提问工具 |
| `OPENCODE_EXPERIMENTAL`（别名 `CHIMERA_EXPERIMENTAL`） | 总实验开关 |
| `OPENCODE_EXPERIMENTAL_FILEWATCHER` / `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` 等 `OPENCODE_EXPERIMENTAL_*` 系列（别名 `CHIMERA_*`） | 各实验特性开关（文件监听、icon 发现、copy-on-select、oxfmt、LSP_TY、LSP 工具、plan mode、markdown、httpapi、workspaces、event system、bash 默认超时、输出 token 上限 等） |
| `OPENCODE_FAKE_VCS`（别名 `CHIMERA_FAKE_VCS`） | 测试用假 VCS |
| `OPENCODE_GIT_BASH_PATH`（别名 `CHIMERA_GIT_BASH_PATH`） | Windows git bash 路径 |
| `OPENCODE_PURE`（别名 `CHIMERA_PURE`） | 纯模式 |
| `OPENCODE_CLIENT`（别名 `CHIMERA_CLIENT`） | 客户端类型（`cli`/`app`/`desktop`，默认 `cli`） |
| `OPENCODE_STRICT_CONFIG_DEPS`、`OPENCODE_PLUGIN_META_FILE`、`OPENCODE_DISABLE_TERMINAL_TITLE`、`OPENCODE_SHOW_TTFD` 等 | 行为微调开关（见 `packages/core/src/flag/flag.ts` 全量清单） |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | OpenTelemetry 导出端点/头 |

---

## 6. 完整示例

一个真实可用的 `chimera.jsonc`（内容均为占位，不含任何真实密钥或内部端点；密钥一律用 `{env:XXX_API_KEY}` 风格）：

```jsonc
{
  // 编辑器校验用；缺失时会自动注入
  "$schema": "https://coding-chimera.github.io/chimera/schemas/config.json",

  "model": "anthropic/claude-sonnet-4-20250514",
  "small_model": "openai/gpt-4.1-mini",

  "username": "dev",
  "logLevel": "INFO",

  "shell": "zsh",
  "snapshot": true,

  "permission": {
    "bash": "ask",
    "edit": "allow",
    "webfetch": "allow",
    "subagent_model_suppress": "allow",
    "chimera_oracle_recent": "allow"
  },

  "delegation": {
    "model_profiles": {
      "fast": { "model": "openai/gpt-4.1-mini", "description": "便宜快速的探索档案" },
      "coder": { "model": "anthropic/claude-sonnet-4-20250514", "variant": "high" }
    },
    "routes": {
      "explore": "fast",
      "general": "coder"
    },
    "scheduling": {
      "enabled": true,
      "archetypes": {
        "scout": {
          "description": "只读探索，便宜优先",
          "minQuality": 0.3,
          "effortCap": "minimal",
          "maxSizeClass": "L",
          "weights": { "quality": 0.3, "speed": 0.4, "cost": 0.3 },
          "budgetUsdPerWorker": 0.05,
          "excludeModels": ["openai/gpt-4.1-mini"]
        },
        "builder": {
          "minSizeClass": "L",
          "weights": { "quality": 0.6, "speed": 0.2, "cost": 0.2 }
        }
      },
      "capability_anchors": {
        "my-model-2026": { "score": 0.72, "tier": "max", "uncertainty": 0.05 }
      },
      "overrides": { "openai": { "billing": "metered" } }
    },
    "max_depth": 3,
    "max_concurrent": 128,
    "background_subagents": true,
    "background_concurrent": 16
  },

  "memories": {
    "enabled": false,
    "max_summary_chars": 12000
  },

  "provider": {
    "myrelay": {
      "api": "openai",
      "backend_semantics": "openai",
      "options": {
        "baseURL": "https://relay.example.com/v1",
        "apiKey": "{env:MYRELAY_API_KEY}",
        "timeout": 300000
      },
      "models": {
        "some-model": {
          "name": "Some Model",
          "attachment": true,
          "reasoning": true,
          "size_class": "L",
          "variants": { "ultra": { "disabled": false } }
        }
      }
    }
  },

  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true
    },
    "remote-demo": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "oauth": { "scope": "read" }
    }
  },

  "agent": {
    "plan": { "model": "anthropic/claude-sonnet-4-20250514", "steps": 20 },
    "my-subagent": {
      "mode": "subagent",
      "model": "openai/gpt-4.1-mini",
      "description": "自定义子代理示例",
      "permission": { "bash": "deny" }
    }
  },

  "compaction": {
    "auto": true,
    "tail_turns": 2
  },

  "tool_output": {
    "max_lines": 2000,
    "max_bytes": 51200
  },

  "experimental": {
    "system_context": false
  }
}
```

要点回顾：

- 占位符风格：`{env:XXX_API_KEY}` 在解析前替换为对应环境变量。
- `permission` 可按工具名展开（`Record<string, "ask"|"allow"|"deny">`）或写简写字符串。
- `delegation`、`memories`、`provider.*.backend_semantics`、`size_class`、`experimental.system_context` 等为 fork 特有（Chimera 扩展）；`models.<m>.variants` 字段本身上游已有，仅 `ultra` 变体语义为 Chimera 特有——见差异清单文档。
- 未知顶层键会导致加载失败（严格校验）；`theme`/`keybinds`/`tui` 例外（被剥离并警告，迁移到 `tui.json`）。