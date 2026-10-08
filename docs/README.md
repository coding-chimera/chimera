# docs/

本目录是 **Chimera 配置规范（configuration specification）的仓库内权威文档**：随代码库一起分发、离线可查，以当日 `packages/chimera` 源码为准。

> 这些文档不替代上游文档站，而是给出本 fork 的权威描述：主配置 schema、加载与合并顺序、环境变量，以及与 upstream opencode 的差异。

## 文档索引

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [configuration.md](./configuration.md) | Chimera 配置全量参考：主 schema 全部顶层键与嵌套字段、加载顺序、合并语义、环境变量、完整示例 | 持续维护，最后核对 2026-09-08 |
| [configuration-vs-opencode.md](./configuration-vs-opencode.md) | 本 fork 与 upstream opencode 的配置差异清单（fork 特有字段、行为差异、废弃键） | 持续维护 |

## 与相邻目录的关系与区分

| 位置 | 是什么 | 与本文档的关系 |
| --- | --- | --- |
| 本目录 `docs/` | Chimera 配置规范的仓库内权威文档（简体中文） | 配置事实的唯一权威来源 |
| `packages/web/src/content/docs/config.mdx` | 上游 opencode 文档站的配置页内容（Astro 站点，含多语言副本） | 它描述的是 upstream opencode 基线，**不含** `delegation`、`memories` 等 fork 扩展字段；需要 fork 差异时看本目录 |
| `packages/docs` | 休眠的旧内容站（Mintlify 骨架） | 无配置权威性，仅存档 |
| `packages/chimera/specs/effect/schema.md` 等 | 迁移过程与内部设计备忘 | 工程演进记录，非用户配置文档 |

## 维护约定

- **schema 源码位置**：`packages/chimera/src/config/`。`config.ts` 中的 `Info`（Effect `Schema.Struct`，标识 `"Config"`）是主 schema；分域字段在 `delegation.ts`（子代理委派）、`memory.ts`（跨会话记忆）、`provider.ts`（provider 与 model 覆盖）、`permission.ts`（权限）、`agent.ts`、`command.ts`、`mcp.ts`、`formatter.ts`、`lsp.ts`、`skills.ts`、`server.ts` 等模块中定义，再组合进 `config.ts`。
- 新增或修改任何配置字段，**必须同步更新** `configuration.md`（含类型、默认值、说明）。字段默认值应以 `config.ts` 与分域模块的 `.annotate({ description })` 及运行时常量（如 `delegation.ts` 顶部的 `DEFAULT_*`）为准；文档不写行号，行号会腐烂。
- fork 与 upstream 的差异发生变化时，更新 `configuration-vs-opencode.md`（新增 fork 特有字段、行为差异、废弃键）。
- **机器可读 JSON Schema**：由 `packages/chimera/script/schema.ts` 从 `Config.Info.zod` 生成（`additionalProperties: false`、JSONC 扩展 `allowComments`/`allowTrailingCommas`），发布地址为 `https://coding-chimera.github.io/chimera/schemas/config.json`——这与 `config.ts` 中自动注入的 `$schema` 默认值一致，也请同步维护 TUI schema（`script/schema.ts` 第二个输出参数）。
- 文档引用源码一律使用仓库相对路径，例如 `packages/chimera/src/config/delegation.ts`。

## 文档约定

- 正文使用简体中文；字段名、类型、默认值、JSON 代码一律用英文原样书写，避免翻译失真。
- 文中引用源码一律用仓库相对路径（如 `packages/chimera/src/config/config.ts`）。`configuration.md` 不写行号（行号会随代码演进腐烂）；`configuration-vs-opencode.md` 作为差异证据清单保留核对当日的行号锚点，以其顶部"最后核对"日期为基线，可能随代码演进漂移。
- 每个文档顶部标注"最后核对"日期；修改配置相关源码后必须复核并更新该日期。
- 默认值以 schema 注解（`.annotate({ description })`）与运行时常量（如 `delegation.ts` 的 `DEFAULT_*`）为准，不凭印象。

## 相关资源

除本文档外，以下位置可作为交叉核对来源：

- 上游配置基线：`packages/web/src/content/docs/config.mdx`（不含 fork 扩展字段）。
- 迁移与设计备忘：`packages/chimera/specs/effect/schema.md`、`packages/chimera/specs/effect/instance-context.md`。
- 配置解析行为测试：`packages/chimera/test/config/config.test.ts`、`delegation.test.ts`，内含 fork 特有字段的合法形态示例。
- TUI 配置：`packages/chimera/specs/tui-plugins.md` 与 `packages/chimera/src/cli/cmd/tui/config/tui.ts`。
- 子代理路由状态：`packages/chimera/src/config/subagent-routing.ts`（运行时维护，非用户配置）。