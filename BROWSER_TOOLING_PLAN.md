# Browser 工具改进计划（进程注册 / headed 模式 / 截图可见性）

> 本文记录三项 browser 工具增量的变更计划与实施状态。前置调查基于代码证据（见各节文件引用），完成后回填验证结果。
> 相关文档：BROWSER_AUTOMATION_PLAN.md（首个浏览器自动化能力的原始计划）。

## 用户确认的决策

1. browser 进程纳入 Session Processes 注册表。
2. headed 模式入口：`browser_open` 工具参数 + config 默认值（`browser.headless`），保留 `CHIMERA_BROWSER_HEADLESS` env 覆盖。
3. 截图可见性：目标是**用户在 WebUI (newweb) 中看到图片**。模型侧附件链路已完整存在，无需改动。
4. 扩展（3b）：不新增工具——模型直接在 markdown 输出里嵌入图片引用展示 UI 类工作结果；通过提示词引导 + 服务端 artifact 路由支撑。

## 现状证据摘要

- browser 工具：`src/tool/browser_*.ts` + `src/browser/runtime.ts`；playwright-core chromium，懒加载；per-directory 单例连接（`InstanceState`，runtime.ts:187-196），按 sessionID 分 `BrowserContext`。
- headed：`runtime.ts:225` 已支持 `launch.headless ?? env ?? true`，仅工具参数未暴露。
- 截图附件链路已存在：`browser_screenshot.ts:41` 返回 `attachments`（`artifact.ts:110-118` 生成 base64 data URL）→ `processor.ts:569-627` 经 `Image.normalize`（5MB / 2000px）→ `message-v2.ts:846-1098` 按 provider 分流（不支持 media-in-tool-result 的走合成 user 消息）。
- 进程注册表：`ProcessRegistry.register()`（`src/chimera/process-registry.ts:71`）公开可用，要求正整数 pid；per-project SQLite 跨 session 互见；liveness sweep + 24h TTL 兜底。
- newweb `MarkdownRenderer.tsx:641-646` 已渲染 markdown 图片，但 `isUnsafeImageSrcInline`（:765-769）屏蔽 `data:` URL；本地文件路径在浏览器中不可加载（`openLocalFilePath` 仅 Tauri，:180-183）。
- chimera server 无静态/artifact 文件服务路由；`file.ts` 路由面向项目文件搜索/内容。全局路由组存在于 `httpapi/groups/global.ts`。

---

## 改动 1：browser 进程纳入 Session Processes（packages/chimera）

1. `src/browser/runtime.ts`：
   - `Driver` 接口（:88-95）暴露本地浏览器进程 pid（playwright `browser.process()?.pid`）；**CDP 远程模式（`CHIMERA_BROWSER_CDP_URL`）返回 null，跳过注册**（pid 对远端无意义，liveness sweep 会误判）。
   - `ensureConnection`（:202-233）本地 launch 成功后 `ProcessRegistry.register({projectRoot, sessionID, pid, pgid: null, command: "chromium (chimera browser)"})`，entry.id 存入连接状态；`Effect.promise(...).pipe(Effect.catch(...))` 包装，degrade-open（照抄 `shell.ts:499-508` 模式，注册失败绝不影响启动）。
   - owner 归属：以触发 launch 的 sessionID 注册；连接跨 session 共享，后续 session 经 `getSession`（:235-248）获取连接时若原 entry 已 terminal/released 则以新 sessionID 重注册。允许保持简单，sweep+TTL 兜底。
2. 注销：`cleanupState`/`cleanupSession` finalizer（:167-196）调 `markExited`；监听 `browser.on("disconnected")`（headed 下用户可能直接关窗口）同样清理 + `markExited`。
3. 文案同步（不再是 bash-only）：
   - `src/session/prompt.ts:550`（"spawned ... via the bash tool"）
   - `src/tool/proc-notify.ts:48`、`src/tool/shell/shell.txt`、`src/tool/proc_notify.txt`
   - bash 工具描述中的 "Session process registry" 一节

测试：`test/tool/browser.test.ts` 用 fake driver 暴露假 pid 验证注册/注销/disconnect；更新 `test/session/session-processes-context.test.ts` 文案断言；必要时扩 `test/chimera/process-registry.test.ts`。

风险：低。注册/注销幂等、degrade-open。

## 改动 2：headed 模式（packages/chimera）

1. `src/tool/browser_open.ts`：`Parameters` 增加 `headless: z.boolean().optional()`，传入 `runtime.open({launch: {headless, timeout}})`。
2. config：新建 `src/config/browser.ts`（self-export 模式），schema 含 `headless?: boolean`。优先级：**工具参数 > config `browser.headless` > env `CHIMERA_BROWSER_HEADLESS` > 默认 headless**。只加 `headless`，不挪其他 env。
3. 描述同步：`browser_open.txt`（说明 headed 供用户介入）、`src/tool/tool_search.ts` 的 `DESC_BROWSER_OPEN`。按 AGENTS.md：工具变更与 agent 指导同改动提交。
4. disconnect 处理与改动 1 共用。

测试：`test/tool/browser.test.ts` 验证参数透传与 config/env 优先级。

风险：headed 在无显示环境 launch 失败——错误信息需提示改用 headless。

## 改动 3：WebUI 渲染 tool result 图片附件（packages/newweb，嵌套独立仓库）

1. `packages/newweb/src/features/message/parts/ToolPartView.tsx:56-75`：attachments 已在 lazy state 中，增加渲染——`mime.startsWith("image/")` 的直接 `<img src={attachment.url}>`（data URL 可渲染）缩略图 + 点击放大；非图片附件渲染文件芯片。通用覆盖所有工具的图片附件。
2. 测试遵循 newweb AGENTS.md（localStorage polyfill、store mocks、drift-guard）。验证：`bun run test:run`、`bun run typecheck`；若动了 API 调用面跑 `bun run api:inventory:update`。
3. 模型侧零改动，用现有 `test/tool/browser.test.ts:190` 用例 + 实测确认。

风险：低，纯展示层；注意大 data URL 的渲染性能（懒加载已存在）。

## 改动 3b：模型 markdown 图片引用（packages/chimera）

模型在正文输出 `![...](url)` 展示截图等工作结果，不新增工具。

1. **新增全局 artifact 路由**：如 `GET /global/browser-artifact/<projectHash>/<sessionHash>/<filename>`（或等价 query 形式），从 `<data>/browser-artifacts/` 下解析并校验路径不越界（防 traversal），按扩展名给 content-type。走全局路由组（`httpapi/groups/global.ts` 先例），**不做 instance 中间件**——`<img>` 标签无法带 `x-chimera-directory` 头，artifact 路径本身已含 project/session hash 定位。
2. **`browser_screenshot` 输出内嵌可复制的 markdown 片段**：output 文本中附带形如 `![screenshot](/global/browser-artifact/<projectHash>/<sessionHash>/<file>)` 的相对 URL（嵌入同 origin WebUI 直接可渲染）。
3. **提示词引导**：`src/session/prompt/browser.txt` 增加说明——截图等 artifact 可通过 markdown 图片语法引用该 URL，WebUI 中会内联渲染，用于向用户展示 UI 类工作结果。`browser_screenshot.txt` 同步。

已知限制：newweb 连接**远程** chimera server 时相对 URL 解析到页面 origin 而非远端，图片不可达；v1 接受（主部署形态是二进制内嵌同 origin）。data: URL 被 markdown 安全策略屏蔽，故不可让模型内联 base64。

## 实施顺序

- 阶段一（packages/chimera，一次提交）：改动 1 + 2 + 3b + 文案。验证：`bun typecheck` + 聚焦测试（browser / process-registry / session-processes-context / tool-search / config）。
- 阶段二（packages/newweb，独立提交）：改动 3。验证：`bun run test:run`、`bun run typecheck`。

## 验证回填（2026-10-14，已完成）

阶段一（packages/chimera，未提交）：
- 进程注册：Driver 新增 `pid()`/`onDisconnected`；`ensureConnection` 本地 launch 后 register（degrade-open），cleanup/disconnect 时 markExited，跨 session 复用时 owner 失效会重注册；CDP 模式 pid 为 null 自动跳过。文案同步 prompt.ts:550、proc-notify.ts、proc_notify.txt、shell.txt、process-registry.ts 模块 doc。
- headed：`browser_open` 新增 `headless` 参数；新增 `config/browser.ts`（`browser.headless`），优先级 工具参数 > config > env > 默认 headless。
- 3b：双轨路由 `GET /browser-artifact/:projectHash/:sessionHash/:filename`（Hono `routes/global.ts` + HttpApi `groups/handlers/global.ts`，无 instance 中间件，traversal/扩展名白名单校验）；`browser_screenshot` 输出附 `![screenshot](<url>)` markdown 片段；browser.txt 提示词已加。
- 验证：`bun typecheck` 零错误；聚焦测试 30 pass/0 fail（browser、browser-artifact、session-processes-context、process-registry，父级复跑确认）；builder 侧另跑 61+93+284 全绿（含 httpapi parity）。audit:audit_5b48b357a605b1cb 无遗留 actionable 项。

阶段二（packages/newweb，未提交）：
- 新增 `ToolAttachments.tsx`（图片缩略图 + 点击放大复用 AttachmentDetailModal lightbox，非图片渲染文件芯片），接入 ToolPartView，覆盖 state.attachments 与懒加载两来源。
- 验证：`bun run test:run` 全量 868 测试通过、ToolPartView 聚焦 8/8（父级复跑确认）、`bun run typecheck` 零错误。

遗留风险：headed 在无显示环境 launch 失败透出 playwright 原始错误；newweb 连远端 server 时 markdown 相对 URL 图片不可达（v1 接受）；disconnect 清理为 best-effort。

## 追加修复：headed 复用缺口（2026-10-16）

问题：`ensureConnection` 复用分支不看 `launch.headless`——已有无头连接时传 `headless: false` 被静默忽略（用户会话实测复现；该会话另受 npm 全局旧版无此参数影响）。
修复：`Connection` 记录 headless 模式；显式参数与现有 local 连接模式不一致时走 cleanupState 全量清理后以新模式重启（时序安全：close 前置空 connection 使 disconnected 回调 no-op，markExited 幂等）；`getSession` 短路同步修正（同会话二次 open 也要过 ensureConnection）；`browser_open` 输出注明 relaunch 及旧 tab 关闭；CDP 模式不参与判断；未显式传参维持复用。验证：typecheck 零错误 + browser 三测试文件 27 pass/0 fail（父级复跑）。
