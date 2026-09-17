# WebUI 性能修复规划

日期：2026-09-17
状态：已评审（parent 代用户评审通过 2026-09-17；P1/P2 即日开工，P3 门控=W2 合入；开放问题 2-3 授权实施期自裁；**内存预算已用户拍板：默认 1024MB、可接受上限 2048MB**——开放问题 1 关闭）
触发问题：跨项目多会话时会话列表反复同步刷新；多活跃项目间切换会话时 subagent 列表加载很慢。

## 1. 根因摘要（侦查结论）

瓶颈不是单一侧，而是「server 制造触发源 × WebUI 放大成风暴」的正反馈环：

```
活跃项目 > 4 → 实例 LRU 驱逐 → 广播 server.instance.disposed
→ WebUI 全量 resync（对所有已保存项目发 3×N 请求）
→ 请求又把刚驱逐的实例 boot 回来 → 挤出别的实例 → 再次 disposed → 循环
```

关键证据：

- 驱逐误判：`packages/chimera/src/project/instance-store.ts:208-229` 的驱逐只数请求 lease（`active`），**进行中的流式会话、SSE 订阅都不算消费者**；数量上限默认 4（`:48`），且每次 load/release 都触发 sweep（`:303,349`）。
- 全局事件无差别扇出：`src/bus/global.ts:11-22` 进程级 EventEmitter 不做项目过滤；逐 token 广播 `message.part.delta`（`src/session/message-v2.ts:719-728`）；全局 SSE 队列 1024 drop-oldest，溢出补发 `server.event-gap`（`src/server/global-event-stream.ts:52-66`）→ 客户端再次全量 resync。
- WebUI 放大：每个展开项目一个独立 `useSessions` 订阅各自全量重拉（`newweb/src/hooks/useSessions.ts:205-267`）；`activeDirectories` 含所有已保存项目且按数组引用比较（`App.tsx:116-127` + `useGlobalEvents.ts:924-937`），任意切换/流式启停触发 3×N background 请求突发；`onSessionUpdated` 无条件重排列表（`useSessions.ts:239-252`）。
- subagent 慢的直接机制：`getSessionChildren` 是 background 优先级（`api/session.ts:301-308`），在 4 槽全局队列（`api/requestQueue.ts:11-33`）里排在风暴后面；且被侧边栏（`SessionChildrenSlot.tsx:49-72`）与消息区（`useChatSession.ts:500-512`）双路径无缓存重复拉取。
- server 底座：同步单连接 SQLite（`src/storage/db.ts:109-198`）；读路径藏同步写 `trimOversizedStoredSummaries`（`src/session/message-v2.ts:1120`，翻页每 50 条重复一次 → O(N²/50)）；大响应同步 `gzipSync`（`src/server/compression.ts:57`）；静态资源无缓存头每请求读盘+压缩（`src/server/shared/newweb-ui.ts:47-66`）。

服务端会话列表/children/消息 SQL 本身均有索引、批量、分页，不是热点。

## 2. 设计原则

1. **在用的资源永不驱逐**：衡量单位从「实例数量」换成「消费者信号 + 内存预算」。
2. **事件是通知不是命令**：客户端收到 disposed/event-gap 后做最小化标记，不再全量重拉。
3. **收敛放大器**：同源请求全局单飞（single-flight），订阅者共享结果而不是各自拉取。
4. **读路径不写、热路径不阻塞事件循环**。

## 3. 工作流

### W1：实例生命周期重做 —— 使用信号 + 内存预算（server）

**现状问题**：`collectIdleCandidates`（`instance-store.ts:208-229`）的 overflow 逻辑是 `ready.length - maxActiveInstances`，正在跑会话的项目可以被误驱逐；驱逐广播又引爆客户端 resync（环路由代码注释自证：`:250-253`）。

**设计**：

1. 消费者信号三类，任一存在即不可驱逐：
   - 请求 lease（现有 `active` 计数，保留）。
   - **流式会话 pin**：会话 run 生命周期内通过现有 `pin()`（`:356-366`，内部即 lease 计数）持有实例，`acquireUseRelease` 保证异常退出也释放。
   - **WebUI 在场心跳**：新增轻量端点（如 `POST /global/presence { directories }`，WebUI 每 30s 上报其 `activeDirectories`，TTL 90s），server 刷新对应实例的 `pinnedUntil`。
2. 驱逐规则：
   - 常态回收：仅「零消费者 且 空闲超 TTL（10min）」。
   - 压力回收：sweep 时检查 `process.memoryUsage().rss`，超过预算（env `CHIMERA_INSTANCE_MEMORY_BUDGET_MB` + `server.*` 配置，默认待定标定，建议 4096）才按 `lastUsedAt` 最冷顺序驱逐零消费者实例，降到水位（如 80% 预算）即停。
   - 压力回收：sweep 时检查 `process.memoryUsage().rss`，超过预算（env `CHIMERA_INSTANCE_MEMORY_BUDGET_MB` + `server.*` 配置，**默认 1024、用户可接受上限 2048**，2026-09-17 用户拍板：server 与多 agent 会话/编译等共享机器预算，实例层必须克制）才按 `lastUsedAt` 最冷顺序驱逐零消费者实例，降到水位（如 80% 预算）即停。**若 1024 预算装不下活跃项目面，优化方向=降单实例 RSS 占用（惰性加载/缓存释放/实例瘦身），不是抬预算**。
3. 保留：bootGrace、振荡 pin（`:294-300`）、防抖 sweep（`:250-280`）。
4. 防 pin 泄漏对账：sweep 时校验 pin 计数与 session status 存储的一致性，发现悬挂 pin 记 warning 并纠正。

**影响面**：`src/project/instance-store.ts`、`src/session/processor.ts`/`prompt.ts`（pin 配对）、`src/server/routes/global.ts`（presence 端点）、`newweb`（心跳上报，小改）、配置 schema、instance-store 测试。

**DoD**：8 个项目同时流式且 UI 在场时 0 驱逐；无在场信号的空闲项目 TTL 后回收；RSS 超预算时仅驱逐最冷零消费者实例；`bun typecheck` + focused instance-store 测试通过。

**风险与回滚**：pin 泄漏会导致实例常驻 → 对账机制兜底；行为回归可通过显式设置 `CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES` 恢复数量上限语义，代码按提交 revert。

### W2：WebUI resync 收敛（newweb，先行）

**设计**：

1. **按目录单飞**：会话列表/状态/权限拉取收敛为以 directory 为 key 的共享 in-flight promise，N 个 `useSessions`/订阅者共享一次结果，不再各自 `getSessionsPage`（替代实例级 `isFetchingRef` 去重，`useSessions.ts:78`）。
2. **`activeDirectories` 内容比较**：用排序后 join 的稳定 key 替代数组引用比较（`App.tsx:116-127`、`useGlobalEvents.ts:924-937`），内容没变不触发 refresh。
3. **`onSessionUpdated` 差异比较**：title/updatedTime 等排序相关字段真的变了才重排，否则只更新条目（`useSessions.ts:239-252`、`SessionContext.tsx:183-196`）。
4. **disposed 降级为 stale 标记**：`onServerInstanceDisposed` 只把目录写入 `serverDisposedDirectoryStore` 并停止相关订阅重拉，不 `resyncRuntime`；目录被用户再次激活时才惰性重拉（`useGlobalEvents.ts:446-470,879-905`）。
5. event-gap 保留全量 resync（这是唯一正确的兜底），但经第 1 条单飞后成本可控。

**影响面**：`newweb/src/api/events.ts`、`hooks/useGlobalEvents.ts`、`hooks/useSessions.ts`、`contexts/SessionContext.tsx`、`App.tsx` / `utils/activeScope.ts`。

**DoD**：切换会话/流式启停产生 0 次 3×N 突发；列表内容不变时不重排；收到 disposed 后 0 自动重拉；newweb 自身测试通过。

**风险与回滚**：纯前端行为变更，按提交 revert；注意 newweb 测试基线（localStorage polyfill、store mock、drift-guard，见其 AGENTS.md）。

### W3：subagent 加载 —— 缓存 + 请求合并（newweb）

**设计**（不动请求优先级）：

1. **childSessionStore 缓存**：按 `directory+parentID` 缓存 children 并带 hydrated 标记；失效事件：`session.created`（parentID 匹配）、`session.deleted`、`session.updated`（涉及 parent 字段时）。侧边栏（`SessionChildrenSlot.tsx`）与消息区（`SubtaskPartView.tsx` → `useChildSessions`）共享同一份缓存，切回秒开。
2. **API 层 in-flight 合并**：`api/sdk.ts` 请求包装层对 GET 类幂等请求按 `method+path+params` 做 in-flight 单飞，并发重复请求共享同一 promise——顺带消掉双路径拉取与 effect 双跑的重复请求。
3. **修 `useChatSession` 双跑**：`effectiveDirectory` 未就绪时 effect 跳过（或用 ref 记录已执行的 `routeSessionId+effectiveDirectory` 组合），消除跨项目切换时的重复权限/问题全量拉取（`useChatSession.ts:211,490-554`）。

**影响面**：`store/childSessionStore.ts`、`api/sdk.ts`、`hooks/useChatSession.ts`、`features/chat/sidebar/SessionChildrenSlot.tsx`。

**DoD**：冷切 1 次 `/children`，热切（缓存命中）0 次；侧边栏与消息区共享缓存；跨项目切换权限/问题只拉一遍；风暴期间不依赖优先级即可获得响应（W2 收敛后队列不再堵）。

**风险与回滚**：缓存失效遗漏导致子会话列表陈旧 → 失效规则覆盖 create/delete/update 并保留手动刷新；按提交 revert。

### W4：事件流瘦身（server）

**设计**：

1. **delta 按连接合并**：`global-event-stream.ts` 对每个 SSE 连接设 30–50ms 合并缓冲，按 `(sessionID, messageID, partID, field)` 累加拼接 `message.part.delta`；写出任何非 delta 事件前先 flush  pending deltas 以保证因果序。消费端契约不变（`newweb/src/store/messageStore.ts:602` 照常收到合并后的 delta），事件数降 1–2 个数量级。注意：只改全局流，不动按实例的 `/event`（TUI 路径），实施时确认 TUI 消费面。
2. **移除每事件日志**：`src/bus/index.ts:91` 的 `log.info("publishing")` 删除或降为 debug 采样。
3. **投影读缓存**：`src/server/projectors.ts:11-24` 对 `session.updated` 的每事件 DB SELECT 改为短 TTL 缓存或由 sync 事件携带必要字段。
4. 队列容量/gap 策略：待第 1 条落地后复评，暂不扩 1024。

**影响面**：`src/server/global-event-stream.ts`、`src/bus/index.ts`、`src/server/projectors.ts`；对应测试。

**DoD**：流式期间全局 SSE 事件/秒降一个数量级以上；`server.event-gap` 在多项目流式下不再出现；流式渲染无可见卡顿；focused 测试通过。

**风险与回滚**：首 token 延迟增加 ≤50ms（不可感知）；按提交 revert。

### W5：server 底座（server）

**设计**：

1. **`trimOversizedStoredSummaries` 移出读路径**：裁剪把关挪到 summary/diff 写入侧（实施时确认写点），读路径（`message-v2.ts:1120,1187`）不再每次翻页跑全表 UPDATE；存量数据用每会话一次性惰性迁移（带完成标记），不做全库启动迁移。
2. **静态资源缓存**：`/assets/*`（文件名带内容 hash）设 `Cache-Control: immutable, max-age=1y`；`index.html` 设 `no-cache` + ETag/304；文件内容与 gzip 结果按文件缓存，不再每请求 `readFile + gzipSync`（`shared/newweb-ui.ts:47-66`）。

**影响面**：`src/session/message-v2.ts`、summary 写入侧、`src/server/shared/newweb-ui.ts`；对应测试。

**DoD**：长会话任意翻页 0 次 UPDATE；静态资源二次加载 304/immutable 命中；focused 测试通过。

**风险与回滚**：裁剪写点遗漏 → 保留读路径兜底一个 release 周期（仅对已标记会话跳过）；缓存头错误 → 版本发布即换 hash 文件名，天然失效。

## 4. 阶段与依赖

| 阶段 | 内容 | 依赖 | 并行性 |
|---|---|---|---|
| P1 | W2（resync 收敛）→ W3（subagent 缓存） | 无 | 同 newweb 仓库内按文件分工可并行，注意 `events.ts`/`sdk.ts` 边界 |
| P2 | W4（事件流瘦身）+ W5（server 底座） | 无 | 与 P1 并行；W4/W5 文件不相交 |
| P3 | W1（实例生命周期重做） | **依赖 W2 先行合入**（客户端不再放大 disposed，避免过渡期风暴） | 含 newweb 心跳小改 |

newweb 是嵌套独立 git 仓库：其改动在 newweb 内单独提交（用户要求时才提交），测试用 newweb 自己的命令。

## 5. 验证策略

1. `packages/chimera`：`bun typecheck` + focused `bun test --timeout 30000`（instance-store、message-v2、global-event-stream、projectors、newweb-ui）。
2. newweb：按其 AGENTS.md 跑对应测试（注意 localStorage polyfill / store mock / drift-guard 基线）。
3. 实测对比（实施前后各一次）：起 server，模拟多项目多会话流式，抓 `/global/event` 统计 `server.instance.disposed` 与 `server.event-gap` 到达频率；测量跨项目切换会话的冷/热耗时。
4. 回归锚点：流式渲染平滑、会话列表顺序正确、子会话树正确、空闲实例正常回收。

## 6. 开放问题

1. ~~内存预算默认值需要实测标定~~ **已拍板（2026-09-17）：默认 1024MB、上限 2048MB，暴露配置**。遗留的标定工作变为：实测每项目实例 RSS 占用，验证 1024 预算下可容纳的活跃实例数；不足时列单实例瘦身项（W1 实施期出数据）。
2. TUI 对 `/global/event` 的消费面需实施时确认（delta 合并只动全局流的前提）。
3. `session.updated` 投影读的确切缓存粒度在 W4 实施时按 projectors 现状定。
