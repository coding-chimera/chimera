# WebUI 聚焦化改造 — 详细设计

状态：设计已定稿，等待开工指令（用户 2026-10-14 拍板，本轮只出设计不动代码；同日二次修订：P2 入口改为右键/新标签，取消独立启动器）。

## 0. 已拍板决策

| 决策点 | 结论 |
|---|---|
| 状态搬家范围 | **几乎全搬**：用户数据 + 主题/布局/键位/声音等表现层设置全部同步 server；仅凭据、机器本地路径、音频 blob 留本地 |
| 入口交互 | ~~项目启动器~~ → **右键/hover「在新标签页打开」**（2026-10-14 修订）：无独立启动器，`#/` 保留现有多项目视图作选择态，单击=本标签聚焦 |
| 跨项目分屏 | **保留**：同一标签页 split 分屏可放任意项目会话，路由跟随聚焦 pane |
| 开工节奏 | 本轮只交付本文档；P0/P1/P2 分批实施，每批独立验收回滚 |

## 1. 现状诊断

### 1.1 病根

```
server 默认端口 0 = 每次启动随机 (src/cli/network.ts:10)
  → 每次重启 = 新 origin = 空 localStorage
  → serverStore 重新 bootstrap 'local' server (packages/newweb/src/store/serverStore.ts:82-135)
  → srv:local:opencode-saved-directories / opencode-recent-projects / last-directory 为空
  → 侧栏项目列表空 = "项目历史丢了"
```

数据本身从未丢失：会话/消息/项目表都在 server SQLite（客户端 `messageStore` 是纯内存，无本地缓存）。丢的是被错误放在浏览器 origin 里的 UI 层状态。默认随机端口意味着该问题在默认配置下**每次重启都触发**，不只是"换端口"。

### 1.2 可复用资产（实施时不必重查）

| 资产 | 位置 | 用途 |
|---|---|---|
| 服务端偏好存储范本 | `packages/chimera/src/server/webui-preferences.ts`（revision CAS + Storage.Service + GlobalBus 事件，135 行） | P0 直接照抄骨架 |
| 全局路由范式 | `packages/chimera/src/server/routes/global.ts:100-160`（describeRoute + validator + AppRuntime.runPromise） | P0 新路由照抄 |
| JSON KV 存储 | `packages/chimera/src/storage/storage.ts:60-66`（Interface: remove/read/update/write/list，键数组 → `Global.Path.data/storage/<key...>.json`） | P0 落盘 |
| HttpApi 对应面 | `httpapi/groups/global.ts` + `handlers/global.ts`（OpenAPI 生成源） | P0 双面 + SDK 生成 |
| SPA 回退 | `packages/chimera/src/server/shared/newweb-ui.ts:56-62`（非清单路径回退 index.html） | 路由无需服务端改动 |
| 客户端存储统一入口 | `packages/newweb/src/utils/perServerStorage.ts`（`srv:{serverId}:` 前缀，get/set/getJSON/setJSON 接口） | P1 换后端、接口不变 |
| context-menu 既有模式 | `packages/newweb/src/components/PanelContainer.tsx:121-244`（`{x,y}` state + onContextMenu + 点击外部关闭，终端标签在用） | P2 项目右键菜单照抄 |
| 项目注册表 | `packages/chimera/src/project/project.sql.ts`（project 表，`GET /project` 全量，`ProjectID` 为品牌化短字符串，git 派生，`"global"` 特殊） | P2 项目名/icon 元数据；服务器注册表语义（POST ensure）降为 P3 可选 |
| SDK 生成 | `./packages/sdk/js/script/build.ts` + newweb `bun run api:inventory:update` | P0 收尾步骤 |

## 2. 总体架构：状态三分法 + 同步策略

### 2.1 三类状态

| 类别 | 例子 | 归属 |
|---|---|---|
| 用户数据 | 项目列表、最近项目、上次目录、选中模型/项目、模型统计、置顶会话、自动批准、onboarding | server |
| 表现层设置 | 主题、布局尺寸、键位、声音设置、语言、通知设置 | server（用户拍板"几乎全搬"） |
| 本地例外 | server 注册表与凭据（`opencode-servers`）、Tauri 二进制路径等机器路径、自定义音频 blob（IndexedDB）、pane 内选中 agent（动态键空间） | 浏览器本地 |

语义：**一个 server 一份状态**。换端口、换浏览器、换机器（同 data root）打开完全一致；跨浏览器并发写按 key 级 last-writer-wins（CAS 重试）。注意一个语义变化：主题等表现层上 server 后**跟随 active server**（切到远程 server，外观随该 server），这符合"仅针对 server 保存"的心智。

### 2.2 同步策略（每键一个策略）

- `live`：SSE 更新即时应用到内存并广播订阅者（如 saved-directories、模型偏好）
- `boot`：SSE 只更新缓存，不广播（store 在构造时读一次，天然不受打扰；如 pane-layout、面板尺寸——避免跨标签实时打架）
- `local`：不进 server（凭据、机器路径、动态键）

策略表在客户端 hybrid 模块内声明；server 不感知策略，只存键值。

## 3. P0 — 服务端 webui-state 存储

量级：低-中（新增 ~500-700 行 + SDK 生成物，服务端 ~8 文件）。

### 3.1 数据模型

`packages/chimera/src/server/webui-state.ts`（新，照 webui-preferences.ts 骨架）：

```ts
const namespace = ["global", "webui_state"]   // → Global.Path.data/storage/global/webui_state/<key>.json

export class Key extends Schema.Class<Key>("WebUIStateKey")(
  Schema.String.pipe(Schema.filter((s) => /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,63}$/.test(s))),
) {}

export class Entry extends Schema.Class<Entry>("WebUIStateEntry")({
  schemaVersion: Schema.Literal(1),
  key: Key,
  revision: NonNegativeInt,
  value: Schema.Unknown,        // 任意 JSON
}) {}

export class Update extends Schema.Class<Update>("WebUIStateUpdate")({
  revision: NonNegativeInt,
  value: Schema.Unknown,
}) {}

export class RevisionConflictError extends Schema.ErrorClass<...>({...})   // 409，同 preferences
export class InvalidKeyError extends Schema.ErrorClass<...>({...})        // 400
export class ValueTooLargeError extends Schema.ErrorClass<...>({...})     // 400
```

接口：`list() / get(key) / update({key, revision, value}) / remove(key)`。写入用 `Semaphore` 串行化（同 preferences 模式）；每条目独立 revision（这是不用 preferences 单文档的原因：多个 store 独立写互不冲突）。

### 3.2 文件名 sanitize（Windows 必需）

`Storage.Service` 把 key 直接拼进文件名（`storage.ts:70-72`）。键含 `:`（如 `chimera:pane-layout`）在 Windows 是 NTFS 流分隔符，**必须编码**：service 内部对 key 做确定性转义（非 `[A-Za-z0-9._-]` 字符替换为 `%XX` 十六进制转义，可逆、无碰撞），文件名 = 转义结果 + `.json`。

### 3.3 护栏

- 单值 ≤ 256KB（`ValueTooLargeError`）
- 条目总数 ≤ 512（PUT 超限拒绝，DELETE 释放）
- key 正则见上（≤64 字符）

### 3.4 API 契约

Hono 面（`routes/global.ts` 追加，全部挂 `/global/webui-state`）：

```
GET    /global/webui-state            → { entries: Entry[] }        operationId: global.webui_state.list
GET    /global/webui-state/:key       → Entry（无此键 404）           global.webui_state.get
PUT    /global/webui-state/:key       body: Update{revision,value}   global.webui_state.update
                                          → Entry；revision 不符 409 {expectedRevision, actualRevision}
DELETE /global/webui-state/:key       → 204                          global.webui_state.remove
```

- PUT body 无 key 字段（key 取自 path，避免不一致）
- bulk list 实现：`storage.list(["global","webui_state"])` + 逐条 read（条目 ≤512，开销可忽略）
- SSE：`global.webui_state.updated`，payload `{ key, revision, value }`（带全量 value，客户端免回拉），事件注册进 `src/server/event.ts`，GlobalBus.emit 同 preferences（`webui-preferences.ts:113-119` 模式）

HttpApi 面（`httpapi/groups/global.ts` + `handlers/global.ts`）行为对齐，OpenAPI 由它生成。接线：`composition/app-runtime.ts`（`WebUIState.defaultLayer`，参照 :130 的 preferences 接线）+ `httpapi/server.ts`（参照 :209）。

### 3.5 文件清单

| 文件 | 改动 |
|---|---|
| `src/server/webui-state.ts` | 新增（~180 行） |
| `src/server/routes/global.ts` | +4 路由（~150 行） |
| `src/server/routes/instance/httpapi/groups/global.ts` | +端点声明 |
| `src/server/routes/instance/httpapi/handlers/global.ts` | +handlers |
| `src/server/event.ts` | +事件类型 |
| `src/composition/app-runtime.ts` | +layer 接线 |
| `src/server/httpapi/server.ts` | +handler 接线 |
| `test/server/webui-state.test.ts` | 新增（见 3.6） |
| SDK `gen/sdk.gen.ts` 等 | `./packages/sdk/js/script/build.ts` 重新生成 |
| newweb `api-call-inventory.json` | `bun run api:inventory:update`（禁止手改） |

### 3.6 测试计划与 DoD

`test/server/webui-state.test.ts` + global 路由测试（镜像 httpapi-ui.test.ts 风格）：
- CAS 正常路径 / 409 冲突路径
- 键校验（非法字符、超长）/ 值超限 400
- DELETE 后 bulk list 不含
- SSE 事件 payload 断言
- Windows 键转义单测（`chimera:pane-layout` → 文件名含 `%3A`）

DoD：`bun typecheck` 绿 + 上述聚焦测试绿 + SDK 重新生成成功 + newweb `bun run test:run` 绿（含更新后的 drift-guard 基线）。

## 4. P1 — newweb hybrid 存储后端（状态搬家）

分两批：P1a（per-server 键，零消费方改动）、P1b（全局键 facade + 各 store 机械替换，需与在途重构协调）。量级：P1a 中；P1b 中（面广但机械）。

### 4.1 模块架构

```
                    ┌──────────────────────────────────────┐
消费方(不变) ──▶ │ perServerStorage / appStorage (同一内核) │
DirectoryContext   │  内存 Map<key,{revision,raw}>          │
useProject         │  写穿: 内存 + localStorage缓存 + 防抖PUT│
themeStore(P1b)    │  SSE: global.webui_state.updated      │
...                │  一次性迁移: 本地旧值 → server        │
                    │  离线: 降级本地读写, 重连补推 dirty    │
                    └──────────────────────────────────────┘
```

- `src/utils/perServerStorage.ts` 重写：导出接口（get/set/remove/getJSON/setJSON/backup 导入导出）**不变**，加 `subscribe(key, cb)`；底层换 hybrid。所有走 `serverStorage` 的消费方一行不改完成搬家（P1a）
- `src/utils/appStorage.ts`（新）：同内核的无前缀 facade，服务目前直接读 localStorage 的全局键 store（P1b）
- `src/api/webuiState.ts`（新）：SDK 封装（list/get/put/remove + 类型化 409 错误类，参照 `src/api/preferences.ts` 写法）
- `src/main.tsx`：bootstrap() 在渲染前 `await hydrateServerState({ timeoutMs: 3000 })`；超时/失败 → 降级模式（本地读写 + 后台重试水合），**不阻塞渲染超过 3s**

### 4.2 写路径

1. 同步写内存 + localStorage（缓存留作离线回退与下次快速启动）
2. 防抖 ~500ms 后 `PUT {revision, value}`；409 → GET 最新 → 按键合并策略重放（默认 LWW 重试一次；计数类键如 `model-usage-stats` 留 per-key merge hook 扩展点，P1 先 LWW，记为已知限制）
3. server 确认后更新本地 revision

### 4.3 SSE 同步

`api/events.ts` 已订阅全局 SSE，新增 `global.webui_state.updated` 分发：更新内存 + localStorage 缓存；`live` 键广播订阅者（DirectoryContext 等可即时刷新侧栏）；`boot` 键只更新缓存（多数 store 构造时读一次，天然免疫实时打扰）。

### 4.4 完整键迁移表（server key = 本地键名原样）

**per-server 键（P1a，走 serverStorage）**

| 本地键 | server 键 | 策略 | 备注 |
|---|---|---|---|
| `opencode-saved-directories` | 同名 | live | 项目列表 |
| `opencode-recent-projects` | 同名 | live | recents map |
| `last-directory` | 同名 | live | 聚焦化后弱化为"新标签建议" |
| `selected-project-id` | 同名 | live | |
| `selected-model-key` | 同名 | live | |
| `hidden-model-keys` | 同名 | live | |
| `model-usage-stats` / `model-variant-prefs` / `model-pinned` / `session-model-selection` | 同名 | live | JSON map 单键；usage 计数留 merge hook |
| `opencode-auto-approve-enabled` / `opencode-approve-pending-on-full-auto` | 同名 | live | |
| `onboarding:provider-dismissed` | 同名 | live | |
| `opencode:notifications` | `notifications-history` | live | 容量截断 ~100 条 |
| `chimera:pane-layout:v1:{server}` | `pane-layout` | boot | 不实时广播 |
| `chimera:followup-queue:v1:{server}:{dir}:{session}`（动态多键） | `followup-drafts` | live | **合并为单 key map + LRU cap 50 会话** |
| `selected-agent:{paneId}`（动态键空间） | 不迁 | local | pane 是每标签运行态 |
| `opencode-path-mode` / `opencode-detected-path-style` | 不迁 | local | 可重算缓存 |

**全局键（P1b，走 appStorage）**

| 本地键 | 策略 | 备注 |
|---|---|---|
| `theme-preset`、`theme-mode`、`theme-custom-css`、`theme-custom-css-snippets`、`theme-active-custom-css-snippet-id`、`code-block-theme-light/dark`、渲染偏好键（`font-scale`、`code-font-scale`、`code-word-wrap`、`chat-wide-mode`、`diff-style`、`descriptive-tool-steps`、`inline-tool-requests`、`tool-card-style`、`immersive-mode`、`compact-inline-permission`、`glass-effect`、`step-finish-display`、`completed-at-format`、`queue-followup-messages`、`manual-terminal-titles`、`external-file-drop-mode`、`outline-current-highlight`） | live | 自定义 CSS 受 256KB 上限约束 |
| `opencode-sidebar-*`、`sidebar-width`、`opencode-right-panel-width`、`opencode-bottom-panel-height`、`opencode-panel-layout`、`opencode-terminal-layout`、`opencode-terminal-copy-on-select`、`opencode-terminal-right-click-paste`、`opencode-wake-lock` | boot | 尺寸/拖拽类防跨标签打架 |
| `collapse-user-messages`、`render-user-markdown`、`reasoning-display-mode` | 不迁（暂留本地） | **与 `/global/preferences` 的 chat 字段双轨重叠，P3 统一合并** |
| `opencode-keybindings` | live | |
| `opencode:sound-settings`、`notifications-enabled`、`opencode:toast-enabled`、`opencode:notification-event-settings` | live | 音频 blob 本体留 IndexedDB |
| `opencode-pinned-sessions` | live | |
| `i18nextLng` | live + late-apply | 启动先读本地缓存，水合后 `changeLanguage` |
| `opencode-servers` / `opencode-active-server` | 不迁 | **凭据安全边界**；active-server 本就是 per-tab sessionStorage 语义 |
| `chimera-binary-path`、`chimera-auto-start-service`、`chimera-service-env-vars` | 不迁 | 机器本地路径，跨机器无意义 |
| `chimera:update-check` | 不迁 | 琐碎 |

### 4.5 一次性迁移算法

```
for key in 迁移表:
  if server 无该键 && 本地 localStorage 有旧值:
    PUT {revision: 0, value: 旧值}      # 409 = 另一浏览器先写了 → 拉取 server 值为准
幂等、可重入；旧 localStorage 键保留不删（降级回滚安全），P3 再清理
```

### 4.6 其他改动

- `src/utils/settingsBackup.ts`：备份导出 = bulk GET server 状态 + 本地例外键；导入 = 全量 PUT + 本地键写回
- 测试坑（newweb AGENTS.md）：localStorage polyfill 必须完整（`length`/`key(i)`）；spy 打在 `localStorage` 实例而非 `Storage.prototype`；mock serverStore 必须含 `getActiveServerId`/`onServerChange`（import 期初始化）

### 4.7 测试计划与 DoD

`src/utils/perServerStorage.test.ts`（重写）+ `appStorage.test.ts` + 迁移/SSE 用例：
- 水合成功/超时降级/后台重试
- 写穿与防抖、CAS 409 重试、LWW
- SSE 更新 live 广播 / boot 静默
- 迁移幂等（二次运行不重复推）、并发首写竞态
- followup-drafts 合并与 LRU 截断
- 服务器切换（`onServerChange`）时重新水合并清内存

DoD：newweb `bun run test:run` + `bun run typecheck` 绿；**手工验收脚本**：改端口重启 server、换浏览器 profile 打开，项目列表/主题/模型偏好一致。

## 5. P2 — 单项目聚焦工作区（右键/新标签入口）

量级：中（纯客户端 ~10-12 文件，**server 零改动**——原 launcher 方案的 `POST /project`、SDK 重新生成、newweb inventory 基线更新全部省去）。

### 5.1 交互模型（用户 2026-10-14 修订：无独立启动器）

```
每个标签 = 一个聚焦项目（浏览器/编辑器心智）
#/（或"← 所有项目"返回后） = 选择态：现有多项目视图（侧栏全项目 + 主区）
单击项目/会话              = 本标签切换聚焦（保持现状习惯，路由升级为 /p/ 形态）
右键项目 / hover 图标按钮   = 「在新标签页中打开」→ window.open('#/p/...')
⌘K palette                 = 项目跳转（条目支持"在新标签打开"）
移动端                      = 长按项目（右键等价物）
```

- 右键是隐藏交互，必须配可见 affordance：项目组头 hover 显示「在新标签页打开」图标按钮；palette 条目带 ⌘ modifier = 新标签
- context menu 复用 `src/components/PanelContainer.tsx:121-244` 的既有模式（`{x,y}` state + `onContextMenu` + 点击外部关闭），项目版菜单项：在新标签页打开 / 在当前标签打开
- 挂载面 ×3：SidePanel 项目组头（FolderRecentList group）、`src/features/sessions/ProjectSelector` 条目、CommandPalette 项目结果
- 选择态就是"项目启动器"的低成本形态：入口已有（现侧栏），不需要新建 `features/launcher/`；后续如需卡片/搜索/统计再做渐进瘦身（P3 #9）

### 5.2 路由语法（hash 路由扩展，`src/hooks/useRouter.ts`）

```
#/                                    → 选择态（现有多项目视图）
#/p/{encodedWorktree}                 → 聚焦工作区（项目首页）
#/p/{encodedWorktree}/s/{sessionId}   → 聚焦工作区 + 聚焦会话
#/session/{sessionId}?dir={dir}       → 旧格式：解析后 replaceState 重定向（兼容历史书签）
```

- **URL 键 = encodeURIComponent(worktree)**（修订：原方案用 projectId）。理由：侧栏分组本就以 dir 为键；未开过会话的 tracked 目录也能直接路由（无需 id↔dir 索引与 POST /project ensure）；项目行存在时用其 name/icon 渲染标题
- `RouteState` 扩展为 `{ view: 'select' | 'project', directory, sessionId }`
- `parseHash` 加 `^#\/p\/([^/]+)(?:\/s\/(.+))?$`；`buildHash` 镜像；移动端 replaceState 逻辑原样保留
- **focus-follows-pane**：沿用"聚焦 pane 的 session 反映进 URL"（`App.tsx:186-202`），扩展为携带其 dir——点跨项目 pane 即整标签聚焦切换，侧栏跟随
- `document.title` = 项目名（fallback 目录名）+ Chimera
- 新标签打开 = `window.open(<origin> + '#/p/...')`；每 tab 本就是独立 JS runtime（独立 SSE/messageStore），现状模型天然支持

### 5.3 视图结构

```
App
├─ view === 'select'  → 现有布局原样（选择态）：侧栏全项目组 + 主区
└─ view === 'project' → 聚焦工作区：Sidebar + SplitContainer + BottomPanel + RightPanel
     ├─ SidePanel 聚焦化：只渲染当前项目 SessionList（保留按天分组/子会话/busy 树）
     │   + 项目组头挂 context menu / hover 新标签按钮（select 态复用同一入口组件）
     ├─ 侧栏 header：当前项目名 + "← 所有项目"（navigateHome 升级为回选择态）+ palette 切换
     └─ 跨项目 pane：保留；叶子 header 显示所属项目 chip
```

### 5.4 文件清单

| 文件 | 改动 |
|---|---|
| newweb `src/hooks/useRouter.ts` | 路由模型 + 旧格式重定向 + navigateToProject |
| newweb `src/App.tsx` | select/project 双态 + focus-follows-pane 扩展 + title |
| newweb `src/components/ProjectContextMenu.tsx`（新） | 复用 PanelContainer context-menu 模式 |
| newweb `src/features/chat/sidebar/SidePanel.tsx` | 聚焦化 + 项目组头挂菜单/hover 按钮（**与在途 batch ④/⑤ 协调**） |
| newweb `src/features/sessions/ProjectSelector.tsx` | 条目挂菜单 |
| newweb CommandPalette | 项目结果 + 在新标签打开（⌘ modifier） |
| newweb `src/contexts/DirectoryContext.tsx` | 选中逻辑改为路由驱动 |
| newweb `src/locales/{en,zh-CN}/*.json` | 文案 |
| 测试 | router 解析/重定向、context menu、SidePanel 聚焦、跨项目 pane |

（server 端：无改动。项目名/icon 走现有 `GET /project`；添加项目保持现有 ProjectDialog 流程，tracked dirs 已在 P1 server 化。）

### 5.5 DoD

newweb `bun run test:run` + `typecheck` 绿；一次 with-webui 构建冒烟（`OPENCODE_CHANNEL=latest bun run build --single --skip-install`）确认嵌入资产完好；手工验收：右键/hover 新标签打开不同项目并行使用、单击本标签聚焦、旧书签重定向、palette 跨项目跳转、移动端长按。

## 6. P3 — 打磨项（可选，按需立项）

1. `/global/health` 加 `instanceId`（多 server UI 标注身份）
2. `GET /project/summary` 聚合端点（会话数/最近活动，选择态/项目总览免客户端 join）
3. 主题键与 `/global/preferences` 双轨合并（`collapse-user-messages` 等 4 键归一）
4. history-mode 路由（路径型 URL，server 回退已支持）
5. 端口稳定化：首次随机端口持久化到全局配置，重启复用，占用回退随机
6. 旧 `srv:*` localStorage 键清理
7. `model-usage-stats` 计数合并 hook（替代 LWW）
8. `POST /project` ensure（服务器侧项目注册表语义，需要 TUI/原生 GUI 共享注册表时再做）
9. 选择态主区渐进瘦身（空会话时显示项目总览，即"轻量启动器"演化路径）

## 7. 风险登记簿

| # | 风险 | 缓解 |
|---|---|---|
| 1 | newweb 在途重构（layoutStore 切片 batch ④/⑤、SidePanel 组件抽取）与 P1b/P2 撞文件 | 开工前查 `packages/newweb` git status；P1b 的 layoutStore 部分等 batch 收口后在切片结构上做；newweb 独立 repo 单独提交，外层指针另行提交 |
| 2 | Windows 键转义遗漏 | P0 单测钉死（3.2） |
| 3 | 跨标签实时打架（布局拖拽） | boot 策略键不广播 |
| 4 | LWW 丢更新（usage 统计类） | P1 记为已知限制，P3 merge hook |
| 5 | 离线队列复杂度膨胀 | 简化为"重连后 dirty 键补推"，不做完整 CRDT |
| 6 | 双浏览器并发首写竞态 | 迁移算法 409 回拉幂等（4.5） |
| 7 | server 端键数膨胀 | 512 条上限 + followup-drafts 单 key 化 |
| 8 | 外层仓库在途脏改 | 不 stage 不 revert 外层无关文件（root AGENTS.md 纪律） |
| 9 | 右键菜单是隐藏交互，新用户发现不了 | 三重可见 affordance：hover 图标按钮、palette 条目、移动端长按（5.1） |

## 8. 实施顺序

```
P0（server 存储） → P1a（per-server 键搬家） → P1b（全局键，协调在途重构） → P2（聚焦工作区 + 新标签入口） → P3（可选）
```

每批独立验收、独立回滚；P2 的路由部分与 P1 无强依赖但按序做可避免两次动 SidePanel。

## 9. 验证矩阵（每批收尾必跑）

- `packages/chimera`：`bun typecheck`；聚焦 `bun test --timeout 30000 test/server/webui-state.test.ts`（P0）
- `packages/newweb`：`bun run test:run`；`bun run typecheck`；动 API 面后 `bun run api:inventory:update`
- SDK：`./packages/sdk/js/script/build.ts`（P0 后）
- P2 后：with-webui 构建冒烟
- 手工验收脚本：P1 后换端口/换浏览器验证状态一致；P2 后右键/hover 新标签并行多项目、旧书签重定向

## 附：立即止血（零代码，今天可做）

在配置固定端口（`server.port`，`src/config/server.ts:5-9`，或 `--port`）——origin 不再漂，书签与历史立刻稳定。非根治（换浏览器仍丢），待 P1 落地后彻底解决。
