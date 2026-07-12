# Chimera Browser Automation 实施计划

> 本计划记录 Chimera coding agent 的首个内建浏览器自动化能力，包括 BrowserSnapshot、BrowserRuntime、Agent 窄工具、Scenario Runner，以及 NewWeb dogfood 场景。实现按阶段推进，完成状态和验证证据持续回填到本文。

## 目标

让 Chimera agent 能在不下载或打包浏览器的前提下，安全地连接远程 CDP 或启动本机 Chrome/Chromium，使用稳定、受预算约束的可访问性快照与窄动作工具完成 Web 页面操作，并让同一运行时支持可重复执行的声明式前端 smoke 场景。

首个端到端消费者是内嵌 NewWeb：启动真实 Chimera Web 服务，打开 NewWeb，完成至少一个用户可见 smoke 流程，并输出可诊断 artifacts 与 JUnit 结果。

## 用户可见契约

### Agent 工具

第一阶段工具采用“一工具一动作”，不提供带大型 `action` union 的万能工具：

- `browser_open`：打开 URL，必要时创建 session/context/tab。
- `browser_snapshot`：返回受预算约束、带稳定 ref 的页面快照。
- `browser_click`：点击当前可见 snapshot ref。
- `browser_type`：向当前可见 snapshot ref 输入文本。
- `browser_screenshot`：保存截图并以 `FilePart` attachment 返回。
- `browser_close`：关闭 tab 或整个 browser session。

后续仅在有明确用例和权限边界时增加 `browser_select`、`browser_press`、`browser_wait`、`browser_console` 或 `browser_evaluate`。其中脚本求值必须保持独立且默认更严格，不能作为首批基础动作的隐式后门。

### BrowserSnapshot

快照结果必须：

- 支持 `efficient` 预设：`interactive=true`、`compact=true`、`depth=6`、`maxChars=8000`。
- 支持显式 `interactive`、`compact`、`depth`、`maxChars` 覆盖。
- 普通 AI snapshot 默认上限为 40000 字符。
- 仅按完整行截断，并附加稳定、可识别的截断 marker。
- 从最终可见行重建 ref map；被深度、交互过滤或字符预算移除的节点不得保留为可执行 ref。
- 对重复 role/name 节点提供确定性、按源顺序的一基 `nth` 消歧。
- 默认过滤无名且无交互价值的结构节点。
- 标明页面文本是 untrusted external content，不把网页文本当作 agent 指令。
- 对密码、token、cookie、authorization 等已知敏感字段做防泄漏处理；不得把浏览器 profile、storage state 或原始认证头写入文本输出。

### BrowserRuntime

- 每个打开目录使用独立 `InstanceState`，不同目录不共享 browser process、context、session、tab 或 profile。
- 一个 instance 可管理一个本地 Playwright pipe browser 或一个远程 CDP browser connection。
- 每个 agent/session 使用独立 browser context；tab 归属明确并可按 session 清理，locale 固定在 context/session 层。
- instance disposal 必须关闭 page、context 和 browser connection；本地 `chromium.launch` 生命周期由 Playwright pipe 托管，不维护独立 CDP WebSocket 或手工 browser 子进程。
- 临时 profile 与 socket 放在临时目录；截图、trace、HAR、console 等可保留产物放在持久 artifact 目录。
- 浏览器能力未被调用时不得要求系统存在 Chrome，也不得影响普通 Chimera 启动。

### Scenario Runner

Scenario Runner 使用声明式场景而不是复制 agent/tool 调度逻辑。最小场景格式支持：

- 场景名称、base URL、browser 配置、步骤和 timeout。
- `open`、`snapshot`、`wait`、`click`、`type`、`assert`、`screenshot`、`close` 步骤。
- URL、可见文本、ref 存在、元素可交互等断言。
- 每步失败时保留 snapshot 与 screenshot；按场景保留结构化 JSON 结果。
- 输出 JUnit XML，便于 CI 收集。
- 支持由测试代码直接调用，不依赖模型或 agent loop。

## 范围

1. 在 `packages/chimera` 内实现浏览器核心能力，不创建独立 browser runtime package。
2. 直接依赖 `playwright-core`，连接远程 CDP 或发现/启动系统 Chrome 家族浏览器。
3. 建立纯逻辑 BrowserSnapshot、instance-scoped BrowserRuntime、artifact 管理与窄 Agent 工具。
4. 增加通用 Scenario Runner 和聚焦测试。
5. 使用真实 NewWeb 服务完成至少一个 smoke 场景。
6. 更新 Agent 工具描述、工作流指引、权限边界和发布/许可说明。

## 非目标

- 不下载、缓存、安装或打包 Chromium。
- 不引入 Selenium、Puppeteer 或第二套 browser abstraction。
- 不实现完整 Playwright Test 替代品。
- 不在首批交付中提供任意 JavaScript 求值、任意文件上传/下载或绕过浏览器安全策略的能力。
- 不为浏览器工具新增 HTTP route；agent-only 能力直接使用 package service。若未来暴露 route，必须同步 legacy Hono、Effect HttpApi、OpenAPI/SDK 与 parity tests。
- 不改变 Chimera 产品身份、公共 bin 或 NewWeb 的服务端架构。

## 架构决策

### 1. 依赖与浏览器来源

采用 `playwright-core@1.59.1` 作为 `packages/chimera` 的直接 production dependency：

1. 显式 `cdpUrl`：使用 `chromium.connectOverCDP`。
2. 显式 `executablePath`：验证后启动。
3. 确定性的系统浏览器发现。
4. 未找到浏览器时返回可操作错误，说明 `cdpUrl` 与 `executablePath` 配置方式。

禁止新增 browser-download postinstall；发布 tarball 和编译二进制不得包含 Chromium/cache/profile。

系统发现顺序：

- macOS：Google Chrome、Chromium、Microsoft Edge、Brave 的 `/Applications` 与 `~/Applications` 标准路径。
- Linux：优先 `PATH` 中的 `google-chrome-stable`、`google-chrome`、`chromium`、`chromium-browser`、Edge、Brave，再检查标准 bin 路径。
- Windows：检查 `LOCALAPPDATA`、`PROGRAMFILES`、`PROGRAMFILES(X86)` 下的 Chrome、Edge、Brave 标准路径。

首版不依赖 Windows registry，也不自动调用系统包管理器。

### 2. Effect 服务和 instance 生命周期

建议模块：

```text
packages/chimera/src/browser/snapshot.ts
packages/chimera/src/browser/discovery.ts
packages/chimera/src/browser/artifact.ts
packages/chimera/src/browser/runtime.ts
packages/chimera/src/browser/scenario.ts
```

`src/browser/` 是多 sibling 目录，每个文件自导出，不增加 barrel `index.ts`。

`BrowserRuntime`：

- 使用 `Context.Service`、`Layer.effect` 和 `InstanceState`。
- 使用 `FileSystem.FileSystem` 与 `Path.Path` 管理 discovery/artifact；本地 browser process 由 Playwright `chromium.launch` 的 pipe transport 管理。
- 在 `InstanceState.make` closure 内创建状态和 finalizer，不增加额外 `started` flag。
- 使用 `Effect.acquireRelease` 或 `Effect.addFinalizer` 管理 browser/process/profile。
- 生产层加入 `src/effect/app-runtime.ts`；工具注册层自行提供 `BrowserRuntime.defaultLayer`，使工具 registry 聚焦测试可独立运行。

### 3. Snapshot 与 ref 治理

`BrowserSnapshot` 保持纯逻辑：输入规范化的 role tree，输出文本、可见 refs、截断信息和 trust metadata。Playwright 页面采集与纯逻辑渲染分离，便于无浏览器单元测试。

建议输出：

```ts
{
  text: string
  refs: ReadonlyMap<string, SnapshotTarget>
  truncated: boolean
  omittedLines: number
  trust: {
    source: "browser"
    untrusted: true
    url: string
    origin: string
  }
}
```

ref 只在同一 tab 的当前 snapshot generation 内有效。任何导航、刷新或新 snapshot 都使旧 generation 失效；动作工具必须拒绝 stale/unknown ref。

### 4. Artifact 目录

- 临时 profile/socket/staging：`Global.Path.tmp/browser/<project-hash>/<runtime-id>/`。
- 持久产物：`Global.Path.data/browser-artifacts/<project>/<session>/`。
- 文件名必须 sanitize，拒绝路径穿越。
- screenshot/trace/HAR 不进入 tool 文本；通过 attachment 或 artifact path 暴露。
- BrowserArtifact 单独管理保留策略，不复用只面向 tool overflow 的 7 天 `Truncate` 目录语义。

### 5. 权限和安全

每个 agent browser tool 必须显式调用 `ctx.ask`：

- `browser_open`：按规范化 origin/URL 请求导航权限。
- `browser_snapshot`、`browser_click`、`browser_type`、`browser_screenshot`：按当前页面 origin 请求权限。
- `browser_close`：按 browser session/tab 请求低风险清理权限。
- 未来的 evaluate、upload、download 使用独立且更严格的 permission。

安全规则：

- 页面内容一律作为 untrusted external content 包装。
- 不将网页中的“系统提示”“工具调用指令”提升为 agent 指令。
- 默认不持久化 storage state、cookie、localStorage 或认证头。
- screenshot/artifact path 只能位于受控目录。
- 不默认添加 `--no-sandbox`；容器/root 场景必须显式配置并由调用方承担风险。
- browser process 只监听 loopback 或使用 Playwright pipe；远程 CDP 由用户显式提供。

## 依赖、发布与许可

需要修改：

- 根 `package.json` catalog：新增 `playwright-core: 1.59.1`。
- `packages/chimera/package.json` production dependencies：新增 `playwright-core: catalog:`。
- 使用仓库规定的 Bun 版本重建 `bun.lock`，不手工编辑。

发布验证必须确认：

- Bun compile 可以包含 `playwright-core` 所需运行时代码；不能误 externalize 后造成平台包缺文件。
- 所有支持平台的包在没有 Chrome 时仍能启动，只有调用 browser 功能时才返回 missing-browser 错误。
- tarball/二进制尺寸变化可解释，且没有 Chromium、browser cache 或 profile。
- no-WebUI MIT 变体与 with-WebUI GPL 变体的现有边界不变。

若直接复制或实质改写 OpenClaw Browser 扩展代码表达：

- 保留其 MIT copyright/permission notice。
- 在对应文件保留简短 provenance。
- 新增第三方 notices，并确保 no-WebUI 与 with-WebUI 包均包含该 notice。

如果仅复用设计思想、重新实现算法，则在本文和变更说明中记录参考来源，不复制受版权保护的长段实现。

## 实施阶段

### Phase 0：计划和基线

- [x] 固定架构、依赖、权限、artifact 和发布决策。
- [x] 创建本计划文档。
- [x] 记录当前工作树与 NewWeb 测试基线；早期失败 snapshot/screenshot/server logs 已持久化，避免把既有或中间失败误归因于最终结果。

### Phase 1：BrowserSnapshot 纯逻辑

目标：先建立无需浏览器的 deterministic content/ref contract。

- [x] 定义 snapshot input/output、options、targets 和 trust metadata。
- [x] 实现 interactive、compact、depth、maxChars 与 efficient preset。
- [x] 实现完整行截断和 marker。
- [x] 从最终可见行重建 ref map。
- [x] 实现一基、按源顺序的重复 role/name `nth` 消歧与无价值结构节点过滤。
- [x] 增加敏感文本处理和 untrusted metadata。
- [x] 增加聚焦单元测试。

完成条件：纯逻辑测试覆盖预算边界、ref visibility、stale ref generation 所需元数据、重复节点和敏感内容。

### Phase 2：BrowserRuntime

目标：提供 lazy、instance-scoped、可清理的浏览器运行时。

- [x] 增加 `playwright-core` dependency 与 lockfile。
- [x] 实现显式 CDP、显式 executablePath 与系统 browser discovery。
- [x] 实现 Playwright pipe 本地启动、context/connection disposal 和失败 tab 清理。
- [x] 实现 per-session context、locale、tab 生命周期和 current tab 选择。
- [x] 实现 snapshot generation/ref lookup。
- [x] 实现临时 runtime 目录与 BrowserArtifact service。
- [x] 接入 AppLayer，并增加 instance disposal/lifecycle tests。

完成条件：无 Chrome 时普通 runtime 正常；fake/contract tests 覆盖 discovery；可用本机 Chrome 时 integration test 覆盖 launch/connect/navigate/cleanup。

### Phase 3：Agent 窄工具

目标：让 agent 通过低歧义、显式权限工具使用 BrowserRuntime。

- [x] 实现 `browser_open`。
- [x] 实现 `browser_snapshot`。
- [x] 实现 `browser_click`。
- [x] 实现 `browser_type`。
- [x] 实现 `browser_screenshot`。
- [x] 实现 `browser_close`。
- [x] 在 ToolRegistry 注册工具和 BrowserRuntime layer。
- [x] 增加 `.txt` 工具描述、browser workflow 高显著性指引和 permission defaults。
- [x] 测试 schema、按 origin permission pattern、stale ref、attachments、truncation 与 registry 可见性。

完成条件：agent 可通过 open → snapshot → click/type → screenshot → close 完成受控流程，且未知/stale ref 不会执行。

### Phase 4：Scenario Runner

目标：复用 BrowserRuntime 实现不依赖模型的可重复 smoke 流程。

- [x] 定义场景 schema 与解析错误。
- [x] 实现步骤执行、语义 wait、timeout 和断言。
- [x] 实现 cleanup 前失败 snapshot/screenshot 与结构化 result。
- [x] 实现 JUnit XML 输出。
- [x] 增加成功、断言失败、wait timeout、scenario timeout、cleanup 和 artifact tests。
- [x] 首版保持 library/test API，不增加 CLI。

完成条件：同一声明式场景可在本地和 CI 运行，失败时有足够 artifact 诊断。

### Phase 5：NewWeb dogfood

目标：用真实 Chimera Web + NewWeb 验证通用能力，而不是为测试写特例。

首个 smoke 场景：

1. 启动带嵌入 NewWeb assets 的 Chimera Web 服务。
2. 打开根页面并等待应用 shell。
3. 采集 efficient snapshot，断言 NewWeb 的稳定可见标识。
4. 通过 ref 执行至少一个无破坏交互，例如打开/关闭稳定的设置或导航入口。
5. 断言交互后的可见状态。
6. 保存成功截图；失败时保存 snapshot、screenshot 和 server/browser logs。
7. 关闭 tab/context/browser 和 server。

- [x] 调查并记录 NewWeb 当前基线和中间失败。
- [x] 添加真实 smoke scenario/fixture。
- [x] 修复 collector descendant accessible name、NewWeb trigger label、locale 与 SPA semantic wait 稳定性问题。
- [x] 对既有无关失败保留准确 evidence；最终真实 smoke 未使用 skip 或弱断言。

完成条件：至少一个真实 NewWeb smoke 场景通过，产出 JUnit/artifacts，且不依赖打包 Chromium。

### Phase 6：验证和发布风险收口

- [x] 运行每批修改后的 Chimera propagation audit。
- [x] 运行所有 browser 聚焦测试。
- [x] 从 `packages/chimera` 运行 `bun typecheck`。
- [x] 运行相关 ToolRegistry、InstanceState、agent/session prompt 回归测试。
- [x] 运行 NewWeb typecheck/build 与真实 smoke。
- [x] 通过 discovery/runtime tests 验证 missing-browser lazy failure，并由编译 binary `--version` 验证普通启动；no-WebUI release-matrix 构建与全局安装验证不在本次前端自动化交付范围内。
- [x] 构建当前平台 with-WebUI 产物并运行 NewWeb smoke。
- [x] 检查 tarball 内容与尺寸，确认无 Chromium/cache/profile。
- [x] 回填本文完成状态与验证命令。

## 风险

1. **Bun compile 与 Playwright Core 动态加载**：可能在开发模式正常但编译二进制缺少运行时资源。必须执行平台包 smoke。
2. **系统浏览器差异**：Chrome/Chromium/Edge/Brave 的版本和 flags 不完全一致。首版收敛到 Chromium CDP 能力并提供明确错误。
3. **进程泄漏**：instance/session disposal 与测试 timeout 必须覆盖 browser、context、page、profile、server 的清理。
4. **stale ref 误操作**：每次导航或 snapshot generation 变化后必须拒绝旧 ref。
5. **prompt injection 与秘密泄漏**：页面内容必须标记 untrusted；snapshot 需要敏感字段处理；认证状态默认不持久化。
6. **artifact 膨胀**：需要可配置保留策略和失败优先策略，不能无限保存 trace/HAR。
7. **用户工作树重叠**：当前已有 session/message/prompt/NewWeb 等本地修改；实现时优先新增文件和修改干净入口，重叠处先重新读取并保留用户变更。
8. **NewWeb 基线失败**：先记录既有失败，再判断是否由本任务触发，不能将无关失败包装为本任务通过。
9. **许可边界**：OpenClaw 参考实现为 MIT；复制表达时必须携带 notice，且 notice 必须进入 no-WebUI 包。

## 预期文件

新增：

```text
packages/chimera/src/browser/snapshot.ts
packages/chimera/src/browser/discovery.ts
packages/chimera/src/browser/artifact.ts
packages/chimera/src/browser/runtime.ts
packages/chimera/src/browser/scenario.ts
packages/chimera/src/tool/browser_open.ts
packages/chimera/src/tool/browser_open.txt
packages/chimera/src/tool/browser_snapshot.ts
packages/chimera/src/tool/browser_snapshot.txt
packages/chimera/src/tool/browser_click.ts
packages/chimera/src/tool/browser_click.txt
packages/chimera/src/tool/browser_type.ts
packages/chimera/src/tool/browser_type.txt
packages/chimera/src/tool/browser_screenshot.ts
packages/chimera/src/tool/browser_screenshot.txt
packages/chimera/src/tool/browser_close.ts
packages/chimera/src/tool/browser_close.txt
packages/chimera/test/browser/*.test.ts
```

可能修改：

```text
package.json
bun.lock
packages/chimera/package.json
packages/chimera/src/effect/app-runtime.ts
packages/chimera/src/tool/registry.ts
packages/chimera/src/agent/agent.ts
packages/chimera/src/session/prompt/chimera.txt
packages/chimera/src/session/prompt/workflow.txt
packages/chimera/script/build.ts
packages/chimera/script/package-variant.ts
packages/newweb/<smoke scenario or fixture>
```

不计划修改 HTTP route；如实际需求迫使新增 route，先更新本文并执行 Hono/Effect HttpApi/OpenAPI/SDK/NewWeb parity 流程。

## 验证命令

从 `packages/chimera` 运行：

```bash
bun test --timeout 30000 test/browser/snapshot.test.ts
bun test --timeout 30000 test/browser/discovery.test.ts
bun test --timeout 30000 test/browser/artifact.test.ts
bun test --timeout 30000 test/browser/runtime.test.ts
bun test --timeout 30000 test/browser/scenario.test.ts
bun test --timeout 30000 test/tool/browser.test.ts
bun test --timeout 30000 test/tool/registry.test.ts test/agent/agent.test.ts test/session/prompt.test.ts
bun test --timeout 30000 test/project/instance.test.ts test/effect/runner.test.ts
bun typecheck
```

真实 NewWeb smoke 和本任务的 with-WebUI 打包风险验证从 `packages/chimera` 运行：

```bash
OPENCODE_CHANNEL=latest bun run build --single --skip-install --with-webui
CHIMERA_NEWWEB_SMOKE_BIN="./dist/chimera-darwin-arm64/bin/chimera" bun test --timeout 120000 test/browser/newweb-smoke.test.ts
```

本任务不执行全局安装、发布、commit 或 push，除非用户另行明确授权。

## 2026-07-12 验证结果

- Browser focused suite：33 pass、1 opt-in skip、0 fail；skip 是未设置 `CHIMERA_NEWWEB_SMOKE_BIN` 时的真实 smoke，随后显式运行该 smoke 为 1 pass。
- Agent integration regressions：ToolRegistry、agent defaults、workflow prompt、InstanceState 与 Effect runner 共 151 pass、0 fail。
- `bun typecheck` 通过。
- `OPENCODE_CHANNEL=latest bun run build --single --skip-install --with-webui` 通过；编译 binary `--version` 为 `0.0.6-patch1`，NewWeb `tsc -b && vite build` 通过。
- 真实 NewWeb settings smoke 通过 11 个步骤；持久 JSON、JUnit、screenshot 和 server logs 位于 `packages/chimera/dist/browser-smoke/newweb/1783853334394-14372/`。
- 持久 JSON/JUnit 均引用同目录 durable screenshot，测试进程退出后文件仍存在。
- `dist/package-variant.json` 为 `with-webui`，legacy WebUI 与 NewWeb 均嵌入。
- 平台 tarball 为 45,827,210 bytes / 45 entries，wrapper tarball 为 17,253 bytes / 7 entries；未发现 Chromium、Chrome、cache、profile 或 Playwright browser bundle 路径。
- 关键 audit：`audit_4caddde975c2e94e`（browser/tool/prompt/NewWeb 显式范围）与 `audit_0c332ff9837ce555`（一基 nth regression）。

## 完成清单

- [x] 计划文档进入工作树并回填最终 evidence。
- [x] BrowserSnapshot 完成并通过聚焦测试。
- [x] BrowserRuntime 完成并通过生命周期测试。
- [x] Agent 窄工具、权限和指引完成。
- [x] Scenario Runner、JUnit 和 artifacts 完成。
- [x] NewWeb 真实 smoke 场景通过。
- [x] Chimera audit、browser tests 和 `bun typecheck` 通过。
- [x] NewWeb typecheck/build 与真实交互验证通过。
- [x] 当前 with-WebUI 构建与包内容风险完成验证；no-WebUI release-matrix 未执行，留待完整发布流程验证。
