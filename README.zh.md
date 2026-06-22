# Chimera

[English](README.md) | [简体中文](README.zh.md)

Chimera 是一个 AI 编程 Agent 发行版：它包含源自 upstream opencode 的交互式 CLI，以及内置的 Chimera/CodeGraph 图谱和传播审计运行时。

公开的包名和命令名都是 `chimera`。图谱/运行时命令属于同一个 CLI；这个发行版不提供公开的 `opencode` 或 `codegraph` bin。

## 包身份

- 完整 Agent 包源码：[`packages/chimera`](packages/chimera)
- npm 包名：`chimera`
- 公开 CLI 命令：`chimera`
- 图谱命令入口：`chimera graph ...` 和 `chimera --graph ...`

当本仓库提到原始项目时，会明确使用 **upstream opencode** 或 **original opencode**。

## 设计来源与引用

Chimera 这个名字是有意为之：它像“奇美拉”一样，把多个 agent 和图谱运行时系统的长处组合进同一个发行版，同时保持公开包名和命令名都是 `chimera`。

Chimera 明确致谢并引用这些设计来源：

- [upstream opencode][upstream-opencode] 提供交互式 coding agent 底座和 CLI runtime 血统。
- [Kimi Code][kimi-code] 为 Kimi 模型相关优化提供参考，包括针对 Kimi 模型的 provider prompt、工具、搜索和认证路径设计。
- [Codex][codex] 为 OpenAI/Codex/GPT 模型路径提供参考，包括上下文纪律、Responses 直连和 OAuth 集成模式。
- [CodeGraph][codegraph] 提供仓库图谱和语义证据底座，是 Chimera 影响面分析与传播审计方向的基础参考。

这些引用说明的是架构血统和实现参考。Chimera 不自称 upstream opencode、Kimi Code、Codex 或 CodeGraph；它是在这些系统基础和启发上组合出的 Chimera 发行版。

## 安装和运行

在包发布后，可以这样安装：

```bash
npm install -g chimera
chimera
```

在 CLI 内使用 `/help` 查看交互式帮助。

本地开发构建请参见[构建和打包](#构建和打包)。

## 图谱运行时

Chimera 包含项目图谱索引、符号搜索、影响面发现和传播审计工作流。

常用命令：

```bash
chimera graph status
chimera graph init <project>
chimera graph query <symbol> --path <project>
chimera --graph status
```

项目本地的图谱数据应位于 `.chimera/`。旧的 `.codegraph/` 数据仅用于兼容；请通过 Chimera 图谱迁移命令显式迁移，不要手动移动或删除。

只读图谱入口，例如 status 和 query，应报告当前数据根目录状态，而不创建图谱数据。

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

请从包目录运行 typecheck 和测试，不要从仓库根目录运行：

```bash
cd packages/chimera
bun typecheck
bun test --timeout 30000
```

根目录的 `test` 脚本会有意阻止从根目录运行测试。

## 构建和打包

从 `packages/chimera` 构建当前平台包：

```bash
bun run build --single --skip-install --skip-embed-web-ui
```

为主包和当前平台包创建本地 npm tarball：

```bash
bun run pack:local
```

tarball 会写入：

```text
dist/npm-tarballs/
```

可以用临时 npm prefix 对本地打包结果做 smoke test：

```bash
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" dist/npm-tarballs/chimera-*.tgz
"$prefix/bin/chimera" --version
"$prefix/bin/chimera" --graph --help
```

## 仓库结构

- `packages/chimera` - 完整 Chimera Agent 包和 CLI 运行时
- `packages/app` - Web 应用
- `packages/console/app` - Console UI 资源和应用
- `packages/desktop` - 桌面应用
- `packages/sdk/js` - JavaScript SDK 包
- `packages/docs` - 文档包

## 贡献

提交变更前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

当变更面向 Agent 的工具、提示词、图谱命令、安装器行为或包身份时，请在同一次变更中同步更新对应的用户文档和 Agent 指引。

## 许可证

MIT

[upstream-opencode]: https://github.com/anomalyco/opencode
[kimi-code]: https://github.com/MoonshotAI/kimi-code
[codex]: https://github.com/coding-chimera/codex
[codegraph]: https://github.com/colbymchenry/codegraph
