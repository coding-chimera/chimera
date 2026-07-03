# Chimera 开源准备计划

> 本计划记录 `chimera/` 子模块公开为 `coding-chimera/chimera` 的准备工作、已确认决策和剩余阻塞项。

## 目标

将 `chimera/` 子模块仓库公开到 GitHub：`https://github.com/coding-chimera/chimera`。

## 约束

- 只处理 `chimera/` 子模块内部的开源准备工作。
- 根仓库、`DaatLocus/`、`OpenCodeUI/`、`kimi-code/`、`codex/` 不在本次范围内。
- `packages/newweb` 是独立子模块，其内容修改需单独提交到 `logic10492/chimeraUI.git`。

## 已确认决策

1. 目标 GitHub 仓库：`coding-chimera/chimera`。
2. 当前分支中不再保留 `opencode.ai` / `chimera.ai` 等遗留域名引用；旧链接保留在 legacy 分支中。
3. 暂无自有域名，先用 `https://coding-chimera.github.io/chimera/...` 作为占位地址。
4. `packages/newweb` 子模块 remote 使用 `git@github.com:logic10492/chimeraUI.git`。
5. 暂时移除 `SECURITY.md` 中的安全联系邮箱和 `CONTRIBUTING.md` 中的 Discord 链接。
6. 暂时移除 `.github/CODEOWNERS` 和 `.github/TEAM_MEMBERS`。

## 已完成

- [x] `LICENSE` 版权改为 `Coding Chimera contributors`
- [x] `package.json` repository URL 指向 `coding-chimera/chimera`
- [x] 清理 `packages/newweb` 中 `192.168.1.100:4096` 示例地址
- [x] 更新 `.github/workflows/publish.yml`：移除 beta 分支、替换仓库引用
- [x] 更新 `SECURITY.md` 和 `CONTRIBUTING.md` 的品牌与链接
- [x] 删除 `.github/CODEOWNERS` 和 `.github/TEAM_MEMBERS`
- [x] 更新 `.gitmodules` 中的 `packages/newweb` remote URL
- [x] 更新 `.github/workflows/stats.yml` 仓库 guard
- [x] 更新 `.github/workflows/test.yml`：触发分支改为 `main`，git identity 改为 `Chimera CI`
- [x] 替换核心源码/测试中的 `chimera.ai` / `opencode.ai` 占位域名（schema、docs、app i18n）
- [x] 通过 `bun typecheck` 和 `bun test --timeout 30000 test/config/config.test.ts`
- [x] 已推送到 `coding-chimera/chimera` 的 `main`

## 剩余阻塞项

### 1. CI secrets / 暂不工作的 workflow ✅

- [x] `.github/workflows/opencode.yml`：已删除。
- [x] `.github/workflows/stats.yml`：已删除。

> 两个 workflow 已从仓库中删除。等有自己的 AI agent action 和 analytics key 再加回。

### 2. 源码中功能性的 `opencode.ai` URL

以下位置的 `opencode.ai` 不是纯文档链接，修改可能影响功能：

- [x] `packages/chimera/src/provider/provider.ts`：HTTP Referer 头 → 已替换为 chimera 占位域名
- [x] `packages/chimera/src/installation/index.ts`：安装脚本下载地址 → 已移除 upgradeCurl，curl 升级不再支持
- [~] `packages/chimera/src/cli/cmd/providers.ts`：API key / Cloudflare docs 提示 → 保留，指向上游 opencode 实际服务
- [~] `packages/chimera/src/session/retry.ts`：`opencode.ai/go` 付费提示 → 保留，opencode 托管服务
- [x] `packages/chimera/src/mcp/oauth-provider.ts`：OAuth `client_uri` → 已改为 Chimera
- [x] `packages/chimera/src/cli/cmd/github.ts`：GitHub Agent 功能 → 已移除（含测试文件）
- [x] `packages/chimera/src/graph/installer/targets/opencode.ts`：上游 opencode MCP 安装器 → 已移除

**阻塞项 2 全部完成。**

### 3. `packages/newweb` 子模块可见性与许可证
- [x] 子模块：`logic10492/chimeraUI` 仓库已是公开，`git submodule update` 无问题。
- [x] 许可证：已在 README 中声明 newweb GPL-3.0 + chimera MIT 混合许可，注明引用 lehhair/OpenCodeUI。



当前用 `https://coding-chimera.github.io/chimera/...` 占位。购买/配置正式域名后需全局替换。

### 5. 最终检查

- [ ] 扫描内网 IP、私钥、token、DSN 等敏感信息
- [ ] 确认 README 中的安装/构建说明与当前仓库一致
- [ ] 发布一个测试 build 验证 with/without WebUI 流程
- [ ] 确认 GitHub release workflow 在 `coding-chimera/chimera` 上能正常运行

## 相关文件

- `LICENSE`
- `package.json`
- `README.md` / `README.zh.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `.gitmodules`
- `.github/workflows/*`
- `.github/CODEOWNERS`（已删除）
- `.github/TEAM_MEMBERS`（已删除）
- `packages/chimera/src/config/config.ts`
- `packages/chimera/src/cli/cmd/tui/config/tui-migrate.ts`
- `packages/chimera/test/**/*.ts`
- `packages/app/src/i18n/*`

## Read 工具实现位置

用户如需检查 Read 工具实现：

- 主要实现：`packages/chimera/src/tool/read.ts`
- 注册/调用：`packages/chimera/src/tool/registry.ts`
- prompt 集成：`packages/chimera/src/session/prompt.ts`
