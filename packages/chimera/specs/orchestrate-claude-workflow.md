# Orchestrate vs Claude Code Workflow：基座能力对位记录

> 快照文档（2026-10-26），非活文档。Claude 侧证据来自 `@anthropic-ai/claude-code@2.1.310`（darwin-arm64 npm 二进制静态抽取，offset 级证据）；我方证据来自当时 checkout 源码（`src/orchestrate/{runtime,protocol,child-main,host-bindings}.ts`、`src/tool/orchestrate.{ts,txt}`、`src/agent/subagent-dispatch.ts`、`src/skill/*`）。两侧都在演进，引用前请重新核验。Claude 侧结论分三档：【代码确认】/【仅文档】/【已实现但禁用】。

## 能力矩阵

| 能力轴 | Claude Code Workflow（2.1.310） | Chimera orchestrate |
|---|---|---|
| 脚本引擎 | 进程内硬化 `node:vm` 沙箱（冻结内建原型、删危险全局、`codeGeneration:{strings:false,wasm:false}`）；acorn 源码重写穿越 VM 边界 | 独立 OS 子进程（`--orch-child` 重入），env 白名单 scrub，stdio JSON-lines 协议逐帧校验，SIGTERM→SIGKILL 兜底 |
| 确定性约束 | 禁 `Date.now`/`Math.random`/无参 `new Date()`（为 resume 服务） | 无限制（无 resume 即无需求） |
| 子 agent 实体 | 进程内查询循环，专用内置类型 `workflow-subagent`（`tools:["*"]`，禁 Agent/Workflow 即不可再委派）；结构化输出 5 次重试；prompt 来源框架防注入 | 真实持久化子会话（可见、可单独取消、按类型独立权限）；子 agent 在深度限制内可继续委派；json_schema 2 次重试 |
| 隔离 | `isolation:'worktree'` 真 git worktree（自动清理/保留）；`isolation:'remote'` CCR 云会话【已实现但禁用】 | 无 worktree；并行编辑靠 scope-disjoint 纪律 |
| Resume | 链式内容哈希 + journal.jsonl + 最长已结算前缀重放【代码确认】 | 无，每次全新执行 |
| 预算 | `budget` 全局（跨主循环+workflow 的 token 共享池，硬顶）——【代码确认但 total 硬编码 null，实际未生效】 | orchestrate 内无 token 预算；root session goal 层有 token 预算 |
| 后台/控制 | 本身是后台任务（task ID + 通知）；`/workflows` 阶段树；单 agent skip/retry；暂停+改脚本续跑 | 阻塞型工具调用（无默认时限）；进度投影 ToolPart.metadata；后台能力在 task/swarm 层 |
| 权限 | 启动审批 + 正常 canUseTool 管道 + auto 模式安全分类器 + per-agent disallowedTools/bashCommandClamp 收窄 | orchestrate 一次审批 + 每 agent 过类型 task 权限；无 per-agent 收窄（用只读 agent 类型近似） |
| 上限 | 并发 min(16, max(2, CPU-2)) 可 env 覆盖；1000 agent/run（缓存不占额）；4096 项/次调用 | 并发 16 固定 FIFO；maxTotalAgents 64/256；日志/结果字节帽 |
| 组合性 | args 参数化、scriptPath 落盘迭代、命名保存 workflow、一层嵌套 workflow() | 纯内联一次性 code；无参数化/保存/嵌套 |

## Claude 基座要点

### 脚本引擎：进程内硬化 `node:vm`【代码确认】
- `new vm.Script` + `runInContext`，`createContext` 带 `codeGeneration:{strings:false,wasm:false}`；冻结 Object/Array/Function/Promise/Map/Set/Intl 等及其原型；删除 ShadowRealm/WebAssembly/WeakRef/Atomics/SharedArrayBuffer/queueMicrotask 等；堵 thenable 逃逸。
- acorn 源码重写：每个 await / for-await / async 体经 `__wRg$*` 帮助函数穿越 VM 边界。
- `meta` 纯字面量双重校验：正则快速路径 + 手写递归下降字面量解析器（禁 `__proto__`/`constructor`/`prototype` 键），失败回退 acorn AST 纯度遍历，报错具体到 "spread not allowed in meta" 等级别。
- 确定性静态检查：禁 `Date.now()`/`Math.random()`/无参 `new Date()`。
- 依赖 Bun 的 node:vm 实现，非 Bun 运行时拒绝执行。

### 注入全局【代码确认】
`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/`workflow`，外加文档未写的 `console`（冻结五方法）与 `setTimeout`/`clearTimeout`（VM 内自有计时器）。无 process/require/fetch/fs/eval。

### 子 agent：专用 workflow-subagent 类型【代码确认】
- 每个 `agent()` 是完整进程内子查询循环，注册为内置类型 `workflow-subagent`：`tools:["*"]`，`disallowedTools:["SendUserMessage","Agent","Workflow"]`（不能再嵌套派发）。
- 自有系统提示（"最终文本逐字返回"）；schema 模式追加 StructuredOutput 尾声（5 次重试）。
- prompt 来源框架：`[Workflow harness — computed task]` / `[user request]` / `[assistant context]` / `[automated trigger]`，防提示注入（flag 门控）。
- MCP 工具经 ToolSearch 按需加载；transcript 落 `subagents/workflows/<runId>/agent-<id>.jsonl`。

### Remote：CCR 云会话【已实现但禁用】
- `remote_agent` 任务类型 = 云端会话（对推送分支的新 clone 运行，进度在会话 URL 可见）；`agent({isolation:'remote'})` 实现完整但派发层硬禁（"not available in this build"）。
- 远程 workflow 启动路径：CCR 会话收 `workflow_launch` 系统事件（filestore 指针 + sha256 校验 + 版本化二进制帧），每会话至多一次、最多 2 次尝试。

### Resume：链式内容哈希【代码确认】
- key = `"v2:" + sha256(prevKey ‖ "\0" ‖ prompt ‖ "\0" ‖ canonicalJSON(opts))`，沿调用序链式推进；parallel/pipeline 按车道 fork/join，重排仅失效受影响后缀。
- journal.jsonl 记录 launched/started/result/failed + restoring/restored/resumed 标记与撕裂尾部修复。
- 语义：命中 results → 返回缓存；有 started 无结果（进程死亡时在飞）→ 该点之后全部禁缓存实跑（"最长已结算前缀"）；failed 重跑；replaced agent 触发链分叉。
- 限制：仅同会话；旧任务 running/paused 时拒绝；隐藏脚本只能同 sha256 续跑；journal 有不可读行即拒绝。

### 预算：API 完整但天花板未接线【代码确认未生效】
- `budget={total, spent(), remaining()}`；spent = 本轮跨主循环+所有 workflow 的输出 token 共享池；硬顶在每次 `agent()` 前检查，超限抛 `WorkflowBudgetExceededError`，parallel/pipeline 按槽位落 null。
- 但常规启动路径 `total` 硬编码为 `null` → `remaining()=Infinity`、检查不可达。为 "+500k" 式指令预留的管道。

### 后台 / UI / 控制【代码确认】
- 后台任务（taskId `local_workflow_<8字符>`，runId `wf_<12位>`），返回 `async_launched` + task ID；状态机 pending/running/completed/failed/killed/paused。
- `/workflows` 阶段树：每 agent 行带 model/agentType/isolation/"from resume journal"/"attempt N (stalled|throttled|user retry)" 徽标；快捷键 enter/x/esc/方向键，ctrl+x ctrl+k 全停。
- 运行中干预：单 agent skip/retry（按 agentControllers 逐个 abort，原因 user-skip/user-retry）、全部停止、暂停 + 改脚本续跑。
- "向运行中的 agent 注入新指令" 仅存在于禁用的 v2 引擎。

### worktree 隔离【代码确认】
- `isolation:'worktree'`：共享 agent-worktree 管理器 + 单槽信号量；`git worktree add --detach` 到 `.claude/worktrees/`；名称 `<runId>-<index>`。
- 清理：HEAD 未变 → 自动删（多重防护：必须在 .claude/worktrees 直下、拒绝网络路径/符号链接祖先等）；有改动 → unlock 并保留待审。

### 权限与安全【代码确认】
- workflow 启动本身是权限审批点（"Review dynamic workflow before running"，`Workflow(<name>)` 规则）。
- agent 走调用方的 canUseTool 管道，无 workflow 专属放行。
- auto 权限模式下 prompt+schema 先过安全分类器，拦截则 `blocked:true` 不生成。
- per-agent 收窄：`disallowedTools`（精确名/MCP 通配校验）与 `bashCommandClamp`（必须是 Bash 规则；附加权限层并禁 `mcp__*`），非法配置直接拒生。

### 上限【代码确认】
- 并发 `min(16, max(2, availableParallelism()-2))`，env `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 可覆盖。
- 1000 agent/run（缓存命中不占额）；4096 项/次 parallel|pipeline（VM 数组边界）；停滞重试 5 次；StructuredOutput 重试 5 次；日志保留 1000 行；预览 400 字符。

### 隐藏的 v2 反应式引擎【已实现但禁用】
- 反应式事实世界：行 `{addr,kind,fact,by,in,at,status}` + `on` 规则 + 撤回传播 + runaway 检测与 kill。
- 脚本全局扩展 `put/read/on/retract`；宿主运行操作（put/retract/read/script）即 `workflow_steer` 事件来源；可向运行中的 run 热注入新脚本（`beginScript`）；独立 world journal。
- 2.1.310 完全不可达（工具侧 v2 surface 是空函数）。信号意义：从静态脚本 DAG 走向可 steering 的活运行。

## Chimera 基座要点

### 进程级敌我隔离
- 每次调用派生独立 OS 子进程（打包态 `--orch-child` 重入 / 源码态 `bun entry.ts --orch-child`），env 白名单全替换（仅 PATH/HOME/TMPDIR/LANG/LC_*，剥离 Bun/Node 注入项与凭据）。
- stdio JSON-lines 协议：帧大小上限、严格递增 call id、参数/返回值双向 lossless-JSON 校验、maxPending 在飞上限、日志/结果字节帽、SIGTERM→SIGKILL 终止。
- 模型代码从不在主进程执行；子进程崩溃收敛为 `worker-exit` 错误而非宿主事故。

### 真实子会话派发
- `orche.agent` 经 SubagentDispatch 创建持久化子会话：UI 可见、可单独取消、按 agent 类型独立权限、模型路由（workload 调度/profile/variant 在 task 层）。
- 子 agent 在 delegation 深度（默认 3）内可继续委派；嵌套后台 park（waitOwnerQuiescent）+ generation 安全投递。
- 审批分层：orchestrate 一次 + 每个 `orche.agent` 过 agent 类型的 task 权限。

### 无 resume / 无预算 / 无 worktree
- 每次调用全新执行；因此无确定性限制（`Date.now`/`Math.random` 可用）。
- 无脚本内 token 预算（root 的 session goal 有 token 预算）。
- 并行编辑靠 scope-disjoint 提示纪律 + swarm scope 警告。

### 外围平台
- 后台 job 引擎（task/swarm `background:true`，逐 worker 完成通知注入父会话）；DelegationLimiter 前台 128 / 后台池 16。
- workload 成本感知调度（scout/builder/reviewer 路由推荐与归因）。
- 图/审计/oracle/obligation 证据链环绕 fan-out 的收尾。

## 差距与优势

我们缺的（按价值排序）：
1. Resume/检查点（链式哈希 + journal，工程量大但路径已被验证）
2. 并行编辑的 worktree 隔离
3. orchestrate 后台化 + 运行中单 agent skip/retry
4. 脚本内 token 预算感知
5. per-agent 工具收窄（disallowedTools/bashCommandClamp 式）
6. 命名保存的 workflow + args 参数化 + 一层嵌套

我们独有的：
1. 进程级隔离强度（无 VM 逃逸面，对比 JS 级沙箱）
2. 子 agent 是真实会话：可见、持久、可再委派（他们的 workflow-subagent 被禁 Agent/Workflow）
3. 嵌套后台 park + generation 安全投递
4. workload 成本感知模型调度
5. 图/审计/oracle 收尾闭环

## 已落地的对齐项

- 2026-10-26：内置 skill 机制（`src/skill/builtin.ts` 注册表，文件系统同名 skill 可覆盖内置）+ 首个内置 skill `orchestrate-authoring`（`src/skill/builtin/orchestrate-authoring/SKILL.md`）+ `orchestrate.txt`/`ultra.txt` 加载指引。对位 Claude 的 workflow-authoring skill 加载路径。

## 后续候选方向（按建议优先级）

1. orchestrate 后台化（接 BackgroundJob 引擎，补单 worker 完成通知）
2. `orche.agent` 结果缓存 + resume（可参考链式哈希设计）
3. scriptPath/args 参数化与迭代
4. worktree 隔离选项
5. per-agent 工具收窄
6. 脚本内预算感知（接 session goal 预算）