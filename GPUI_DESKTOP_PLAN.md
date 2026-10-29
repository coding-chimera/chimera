# GPUI Desktop App 计划

状态：**技术选型已拍板（2026-10-27），实施暂缓**。
启动前置条件：Chimera 完全 Rust 化（chimera-host / RUST_HOST_MIGRATION_PLAN.md 线）落地之后再开工。本文件只锁定选型与蓝图，不代表已动工。

## 1. 决策（最终确定）

| 项 | 决定 |
|---|---|
| UI 框架 | **GPUI**（Zed 开源的 Rust GPU 加速 UI 框架，Apache-2.0） |
| 组件底座 | **longbridge/gpui-kit**（Apache-2.0；原 gpui-component 改名并入；钉住社区快照 gpui-pre） |
| 集成架构 | 一期 = thin client over HTTP/SSE，`packages/sdk/openapi.json` 为唯一契约 |
| Rust 客户端参考 | `packages/newweb/src-tauri`（Tauri 2 的 reqwest + SSE 桥连接层，可照搬，去掉 webview） |

明确排除（有实证，不再复议）：

- **git-dep Zed monorepo**：`editor`/`markdown`/`language`/`git_ui` 均未发布、GPL-3.0-or-later、高耦合（`editor` 有 ~60 个 Zed 内部依赖）。zed 仓仅 `gpui` crate 本身是发布的 Apache-2.0。
- **Tauri / Electron webview 路线**：与 Rust 化同语言栈的目标冲突，GPUI 全面取代（`packages/desktop` Electron 壳随之退役）。
- **mac Swift / Linux Qt 双栈**（战线④旧方向，2026-10-10 拍板）：被本决策取代，单 Rust 栈覆盖三平台。

## 2. 选型依据（2026-10-27 三路调研结论）

### 为什么 Zed 的功能拿不出来

Zed 编辑器确实自带 markdown 渲染、代码高亮、diff 视图、编辑器，但它们全部位于 Zed app crates（未发布 + GPL-3.0 + 深度耦合 settings/theme/workspace/collab），链入专有 app 会触发 GPL 传染。社区无任何第三方成功复用 zed `editor` crate 的先例。

### gpui-kit 已覆盖全部 chat 刚需

- **流式 markdown**：`TextViewState::markdown()` + `push_str()` 增量尾重解析（`ParseMode::Compatible`），为 LLM 流式输出设计，有 `examples/stream-markdown`
- **代码高亮**：syntect + two-face（~200 语言）或 tree-sitter，feature-gated
- **diff 视图**：`gpui-component::diff`（基于 `similar`，虚拟化、unified+split、行选/折叠）
- **IME 输入**：`EntityInputHandler`，中文 preedit 已确认支持
- **聊天原语**：`MessageGroup` / `Bubble` / `MessageScroller`（tail-follow + jump-to-bottom）/ `Attachment` / `Shimmer`
- **主题**：21 套内置 + Light/Dark/system 跟随
- 维护状况：Longbridge 维护（huacnlee 主力），Longbridge Pro 商业产品生产验证，周更节奏

### 需自建的缺口（任何库都不提供）

tool-call 卡片、permission 审批对话框（allow-once/always/deny）、reasoning 折叠展示、消息↔diff 绑定、会话模型 + SSE transport glue、代码块复制按钮。

最佳参考应用：**zeron**（MIT，GPUI 写的 Claude Code/Codex agent 控制台）——可读可抄（MIT）。GPL/AGPL 的 GPUI 应用（waku/diri/oxideterm）只读参考、不抄代码。

### Chimera 侧集成面（已测绘）

- SSE：`GET /event`（实例）+ `GET /global/event`（`{directory, payload}` 信封），`data: <JSON>` 帧
- 关键事件：`message.part.delta` / `permission.asked` / `question.asked` / `session.status/idle`
- 发消息模式：`POST /session/:id/prompt_async`（204）+ SSE 订阅，非同步等响应
- OpenAPI 3.1：`packages/sdk/openapi.json`（127 operations，仓内跟踪）→ 可生成 Rust client
- 认证/端口：Basic auth（`OPENCODE_SERVER_PASSWORD`），默认 `127.0.0.1:4096`（port 0 → 4096 → ephemeral）

## 3. 目标架构

```
┌─ chimera-desktop (GPUI app, gpui-kit) ───────────────┐
│  ui/        聊天流、tool-call 卡、permission 对话框（自建缺口） │
│  session/   会话/消息 store（Entity + notify 响应式模型）       │
├─ chimera-api (crate) ────────────────────────────────┤
│  OpenAPI 生成的 REST client + 手写 SSE 事件流               │
│  事件类型与 TS 侧 src/bus/bus-event.ts 对齐（契约测试守护）    │
├─ transport ───────────────────────────────────────────┤
│  一期: reqwest + eventsource 直连 127.0.0.1:4096              │
│  二期: Rust 化落地后可切换内嵌/IPC（切换面限制在 chimera-api 内）│
└───────────────────────────────────────────────────────┘
```

## 4. 里程碑（启动后的依赖顺序，成本为相对量级）

1. **M0 技术验证**（低）：cargo workspace + gpui-kit hello window + 连本地 server 拉 `GET /session` 列表。**必须在 macOS/Linux/Windows 三平台同时验证 hello window**（GPUI 跨平台后端成熟度不均，macOS 最成熟）
2. **M1 聊天主链路**（中）：`prompt_async` + SSE → `message.part.delta` → `TextViewState` 流式 markdown + `MessageScroller` 消息流
3. **M2 agent 交互面**（中，主要自建量集中于此）：tool-call 卡片、`permission.asked`/`question.asked` 审批对话框、edit 类 tool 绑定 `Diff` 视图
4. **M3 桌面壳**（低-中）：窗口几何持久化、server 进程托管（搬 src-tauri 的 spawn/health-check 逻辑）、deep link、自动更新、凭证走系统钥匙串（不硬编码）
5. **M4 与 Rust 化汇合**（取决于 Rust 化落地形态）：transport 从 HTTP/SSE 评估切换内嵌/IPC；因一期严格以 OpenAPI 为契约，切换面限制在 chimera-api crate 内部

## 5. 风险与纪律

- **pre-1.0 生态波动**：gpui-pre 周更 breaking，gpui-kit 钉死特定快照；升级只能跟随 gpui-kit 发版，精确钉版本，不追新
- **GPL 纪律**：Zed 仓及 GPL/AGPL GPUI 应用（waku/diri/oxideterm）只读参考，代码零拷贝；可抄来源仅 Apache/MIT（gpui-kit、zeron）
- **凭证安全**：`OPENCODE_SERVER_PASSWORD` 走系统钥匙串，不落盘、不进代码
- **启动时再评估**（届时必做）：gpui-kit/gpui-pre 最新版本现状复查（周更生态，拍板时的 0.8.1/0.3.10 必然已变）；Rust 化后的传输层终态选择（HTTP vs 内嵌 vs IPC）；openapi.json 是否仍覆盖全部所需端点

## 6. 与 Rust 化工作的接口约定

- desktop 侧唯一接口假设 = HTTP/SSE + OpenAPI 契约；Rust 化侧需保证事件形状稳定、`openapi.json` 始终可再生成
- SSE 事件类型（`src/bus/bus-event.ts` 的 `{id,type,properties}` 信封）是跨进程契约，变更属 breaking change
- 两侧完全解耦、可并行推进；desktop 实施在 Rust 化完成后启动，启动时按第 5 节重新复查生态版本
