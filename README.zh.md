<p align="center">
  <img src="assets/logo.png" alt="Chimera logo" width="240">
</p>

# Chimera

[English](README.md) | [简体中文](README.zh.md)

Chimera 是一个 AI 编程 Agent 发行版：一个 opencode-derived 的交互式 CLI，加上内置的 Chimera/CodeGraph 图谱与传播审计运行时。

公开的包名和命令名都是 `chimera`。图谱/运行时命令归属于同一个 CLI；本发行版不提供公开的 `opencode` 或 `codegraph` bin。

## 包身份

- 完整 Agent 包源码：[`packages/chimera`](packages/chimera)
- npm 包名：`chimera`
- 公开 CLI 命令：`chimera`
- 图谱命令入口：`chimera graph ...` 和 `chimera --graph ...`

当本仓库提及原始项目时，会明确使用 **upstream opencode** 或 **original opencode**。

## 设计渊源与参考

Chimera 这个名字是有意而为之：这个项目将多套 agent 与图谱运行时系统的优势融合进一个发行版，同时保持公开包名和命令名均为 `chimera`。

Chimera 致谢并引用以下设计参考：

- [upstream opencode][upstream-opencode] 提供交互式 coding-agent 底座和 CLI runtime 血统。
- [Kimi Code][kimi-code] 为 Kimi 导向行为提供参考，包括针对 Kimi 模型的 provider 专用 prompt、工具、搜索与认证考量。
- [Codex][codex] 为 OpenAI/Codex/GPT 导向行为提供参考，包括上下文纪律和直接 Responses/OAuth 集成模式。
- [CodeGraph][codegraph] 提供仓库图谱和语义证据底座，支撑 Chimera 的影响分析与传播审计方向。
- [OpenCodeUI][opencode-ui] 提供基于 Web 的用户界面（`packages/newweb`），该组件以 GPL-3.0 许可发布。

这些引用描述的是架构血统和实现影响。Chimera 不自称为 upstream opencode、Kimi Code、Codex 或 CodeGraph；它是在这些系统基础之上构建并受其启发的 Chimera 发行版。

## 安装与运行

在包已发布后，按以下方式安装：

```bash
npm install -g chimera
chimera
```

在 CLI 内使用 `/help` 获取交互式帮助。

本地开发构建请参见[构建与打包](#构建与打包)。

## 图谱运行时

Chimera 包含项目图谱索引、符号搜索、影响面发现和传播审计工作流。

常用命令：

```bash
chimera graph status
chimera graph init <project>
chimera graph query <symbol> --path <project>
chimera --graph status
```

项目本地图谱数据存放于 `.chimera/` 目录。旧版 `.codegraph/` 数据仅用于兼容；请通过 Chimera 图谱迁移命令显式迁移，不要手动移动或删除。

只读图谱入口（如 status 和 query）应报告当前 data-root 状态而不创建图谱数据。

## 开发

本仓库使用 Bun。从 `chimera/` 工作区根目录安装依赖：

```bash
bun install
```

从包目录运行 Agent：

```bash
cd packages/chimera
bun run --conditions=browser src/index.ts
```

从包目录运行 typecheck 和测试，不要从仓库根目录运行：

```bash
cd packages/chimera
bun typecheck
bun test --timeout 30000
```

根目录的 `test` 脚本会有意阻止从根目录运行测试。

## 构建与打包

从 `packages/chimera` 构建默认的当前平台 no-WebUI 包：

```bash
bun run build --single --skip-install
```

默认包有意不嵌入 GPL 许可的 NewWeb/OpenCodeUI 衍生资源。如需为 release asset 额外生成明确分离的 with-WebUI 变体，再运行第二次构建：

```bash
bun run build --single --skip-install --with-webui --preserve-npm-tarballs
```

tarball 写入：

```text
dist/npm-tarballs/
```

no-WebUI tarball 名称形如 `chimera-no-webui-<version>.tgz`；with-WebUI tarball 在相同位置使用 `with-webui` 命名。

可以用临时 npm prefix 对本地打包结果做 smoke test，每次只安装一个变体：

```bash
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" dist/npm-tarballs/chimera-darwin-arm64-no-webui-*.tgz dist/npm-tarballs/chimera-no-webui-*.tgz
"$prefix/bin/chimera" --version
"$prefix/bin/chimera" --graph --help
```

## 仓库结构

- `packages/chimera` — 完整 Chimera Agent 包与 CLI 运行时
- `packages/app` — Web 应用
- `packages/console/app` — Console UI 资源与应用
- `packages/desktop` — 桌面应用
- `packages/sdk/js` — JavaScript SDK 包
- `packages/docs` — 文档包

## 贡献

提交变更前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

当变更涉及面向 Agent 的工具、prompt、图谱命令、安装器行为或包身份时，请在同一变更中同步更新对应的用户文档和 Agent 指引。

## 许可证

Chimera 核心发行版（含 CLI、图谱运行时和 Agent 包）以 MIT 许可发布。

WebUI 组件（`packages/newweb`）以 GPL-3.0 许可发布，源自 [OpenCodeUI][opencode-ui]。使用 `--with-webui` 构建的版本会嵌入该组件，受两种许可条款约束。

MIT

[upstream-opencode]: https://github.com/anomalyco/opencode
[kimi-code]: https://github.com/MoonshotAI/kimi-code
[codex]: https://github.com/coding-chimera/codex
[codegraph]: https://github.com/colbymchenry/codegraph
[opencode-ui]: https://github.com/lehhair/OpenCodeUI
