# 控制面契约 · MCP 三 transport

> 状态：契约阶段。`contract_rev = cr-2026-10-30-r1`。
> 机读清单：`packages/chimera/test/oracle/control/domains/mcp-transports.json`；行为 fixture：`packages/chimera/test/oracle/control/fixtures/mcp-transports/`。
> 本文只读引用生产实现；不建立真实连接、不执行 OAuth、不启动 MCP server。

## 0. 结论先行

当前实现只有 **三种** MCP transport，按配置类型二选一：

| 配置 `type` | transport | 连接方式 | 证据 |
|---|---|---|---|
| `local` | `StdioClientTransport` | 启动子进程，JSON-RPC over stdio；stderr 进入日志 | `src/mcp/index.ts:364-393` |
| `remote` | `StreamableHTTPClientTransport` | 先尝试 Streamable HTTP | `src/mcp/index.ts:282-291` |
| `remote` | `SSEClientTransport` | Streamable HTTP 失败后回退 SSE | `src/mcp/index.ts:291-303` |

没有 WebSocket MCP transport；不要把“三 transport”理解成 stdio/SSE/WebSocket。

## 1. 连接状态机

```text
config entry
  ├─ enabled=false ──────────────► disabled（不建 transport）
  ├─ type=local ────────────────► stdio connect
  │                                 ├─ ok ──► connected
  │                                 └─ error ► failed
  └─ type=remote ───────────────► StreamableHTTP connect
                                    ├─ ok ─────────────► connected
                                    ├─ auth error ─────► needs_auth / needs_client_registration（停止回退）
                                    └─ other error ────► SSE connect
                                                          ├─ ok ──► connected
                                                          └─ error ► failed
```

状态枚举：`connected / disabled / failed / needs_auth / needs_client_registration`。证据：`src/mcp/index.ts:100-126`。

## 2. 行为断言

### M1 · local 固定 stdio

- `connectLocal` 只构造 `StdioClientTransport`；`command[0]` 为可执行文件，其余为参数。证据：`src/mcp/index.ts:364-377`。
- `cwd` 相对 instance directory 解析；`env` 继承进程环境并叠加配置 `environment`；当命令是 `chimera`/`opencode` 时设置 `BUN_BE_BUN=1`。证据：`src/mcp/index.ts:368-380`。
- stderr 以 `stderr: "pipe"` 接入日志，不混入 JSON-RPC。证据：`src/mcp/index.ts:371-385`。
- 连接超时默认 30 秒，可由配置 `timeout` 覆盖。证据：`src/mcp/index.ts:41`、`:386`。

### M2 · remote 先 StreamableHTTP 后 SSE

- `connectRemote` 的 transports 数组顺序固定为 `StreamableHTTP` → `SSE`；不允许先 SSE。证据：`src/mcp/index.ts:282-303`。
- 每个 transport 用 `connectTransport` 建立 client；失败时关闭 transport，成功时调用方拥有。证据：`src/mcp/index.ts:226-244`。
- 成功即返回，不再尝试后续 transport。证据：`src/mcp/index.ts:340-358`。

### M3 · auth 错误停止回退

- 如果错误是 `UnauthorizedError` 或 OAuth 相关，记录 `needs_auth`；若错误消息含 `registration`/`client_id`，记录 `needs_client_registration`。证据：`src/mcp/index.ts:306-338`。
- 一旦 `lastStatus` 为 `needs_auth`/`needs_client_registration`，循环 `break`，不尝试 SSE。证据：`src/mcp/index.ts:354-357`。
- OAuth 待完成 transport 存在 `pendingOAuthTransports`；`chimera mcp auth <name>` 完成后用同一 transport 调 `finishAuth`。证据：`src/mcp/index.ts:128-131`、`:856-880`、`:949`。

### M4 · disabled 与失败状态

- `enabled=false` 直接返回 `{ status: { status: "disabled" } }`，不建 transport。证据：`src/mcp/index.ts:402-410`。
- local 启动失败返回 `failed` 并记录错误消息；不抛出到实例启动。证据：`src/mcp/index.ts:386-400`。
- remote 所有 transport 失败时返回最后一个 `failed` 状态。证据：`src/mcp/index.ts:340-358`。

### M5 · tool catalog 与 instructions

- 只有 server 声明 `tools` capability 时才调用 `McpCatalog.defs` 拉取工具定义；否则 `defs` 为空。证据：`src/mcp/index.ts:424-440`。
- `instructions` 取 server 的 `getInstructions()` 并 trim；空值不存储。证据：`src/mcp/index.ts:424-440`、`:552-570`。
- system prompt 的 `<mcp_instructions>` 段只在相关工具仍可见时注入；全部工具被 permission 禁用时省略该 server。证据：`src/session/system.ts:247-265`。

### M6 · finalizer 清理

- 实例 finalizer 遍历所有 client：
  - 对 `StdioClientTransport`，先枚举后代 pid 并 `SIGTERM`，再 `client.close()`；
  - 非 stdio client 直接 `close()`；
  - 最后清空 `pendingOAuthTransports`。
  证据：`src/mcp/index.ts:558-584`。
- 清理失败用 `Effect.ignore` 吞掉，不阻断实例 dispose。证据：`src/mcp/index.ts:571-583`。

### M7 · 配置发现与并发

- `init` 对 `config.mcp` 的每个条目并发执行 `create`；`enabled=false` 只写 status。证据：`src/mcp/index.ts:540-570`。
- 每个成功 client 启动 `watch` 监听 tools list 变化；变化通过 `ToolsChanged` 事件发布。证据：`src/mcp/index.ts:570`、`src/mcp/index.ts:76-82`。
- 同一 key 的旧 client 在 `storeClient` 中先关闭再替换。证据：`src/mcp/index.ts:600-620`。

### M8 · 失败安全

- `create` 的 `catchCause` 对 interrupt-only 重新 interrupt，其他错误返回 `failed`，不撕裂实例启动。证据：`src/mcp/index.ts:436-450`。
- 远程 server 的 OAuth redirect 只记录日志并发布 toast，不自动打开浏览器。证据：`src/mcp/index.ts:266-280`。

## 3. 负例与不变量

| 编号 | 不变量 | fixture |
|---|---|---|
| N1 | remote 先 StreamableHTTP，失败后才 SSE | `mcp-transports/streamable-then-sse` |
| N2 | 首个 transport auth 错误后不得继续 SSE | `mcp-transports/auth-stops-fallback` |
| N3 | local 不得走 remote transport，remote 不得 spawn 本地进程 | `mcp-transports/streamable-then-sse` 的 `must_not` |
| N4 | `enabled=false` 不得建立 transport | `CP-MCP-004`（待补） |
| N5 | finalizer 不得留下 stdio 后代进程 | `CP-MCP-005`（待补） |

## 4. 与 WP-09 / WP-04 的衔接

- **WP-09**：MCP server 的 instructions 与 tool catalog 是 hook `tool.definition` 的输入之一；hook 轨迹只记录最终工具定义，不记录 MCP transport 细节。证据：`specs/rust-host/plugin/hook-matrix.md`。
- **WP-04**：MCP OAuth 回调与 HTTP endpoint 的 OpenAPI 形状由 WP-04 冻结；本契约只定义 client 侧 transport 选择。证据：`specs/rust-host/http/openapi-freeze.md`。

## 5. 已知限制

- fixture 不建立真实连接、不执行 OAuth、不启动子进程；transport 选择以合成 attempts 表达。
- finalizer 的 SIGTERM 后代清理、instructions 的 permission 门控仍是待补点。
- 远程 transport 的重连/退避不在本契约范围；当前实现只在 `create` 时尝试一次顺序回退。
- 没有 WebSocket transport；若未来新增，必须扩展本契约的 transport 枚举与 fixture。