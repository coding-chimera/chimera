# 控制面契约 · job family 取消与 quiescence

> 状态：契约阶段。`contract_rev = cr-2026-10-30-r1`。
> 机读清单：`packages/chimera/test/oracle/control/domains/job-family.json`；行为 fixture：`packages/chimera/test/oracle/control/fixtures/job-family/`。
> 本文只读引用生产实现；不启动真实任务、不触发 Effect scope dispose、不做超 256 成员的压测。

## 0. 结论先行

- **family** = 当前 session + 全部后代（`session.parent_id` 链）。遍历是 BFS + visited set，**最多 256 个成员**。证据：`src/session/activity.ts:49-70`；计划边界：`RUST_FULL_MIGRATION_PLAN.md:284`。
- **active** = 任一 family 成员状态非 `idle`，**或** family 拥有 `running` ∨ `delivery = "pending"` 的 background job。证据：`src/session/activity.ts:74-107`。
- **quiescence** = `isActive` 读 false；等待是事件驱动（SessionStatus 变化 + job settle/delivery deferred），2 秒 fallback 定时器只兜底。证据：`src/session/activity.ts:14`、`:113-150`。
- **取消** 按 family BFS 级联，父先于子；每个 job 最多取消一次，`onInterrupt` 恰好在 `running → cancelled` 转换时触发。证据：`src/session/run-state.ts:217-246`。
- **delivery** 是独立状态机：job settle 后到 `markDelivered` 之间仍是 active；`markDelivered` 带 generation，过期代次是 no-op。证据：`src/agent/background-job.ts:590-645`。

## 1. 状态与谓词

```text
SessionStatus: idle | busy | retrying | ...（非 idle 即活跃）
Job.status:   running | completed | error | cancelled
Job.delivery: pending | delivered
Job.generation: 每次 start() 在同一 id 上创建新 run 时 +1

active(family) =
  any(member.status != idle)
  OR any(job.owner ∈ family AND (job.status == running OR job.delivery == pending))
```

证据：`src/session/activity.ts:74-107`、`src/agent/background-job.ts:13-45`。

## 2. 行为断言

### J1 · family 遍历上限 256

- `familyIDs` 使用 `pending` 队列 + `visited` set；`while (pending.length > 0 && family.size < 256)`。
- 超过 256 的后代不会被纳入 family；这是当前实现的硬边界，不是产品级可扩展性证明。
- 证据：`src/session/activity.ts:49-70`。

### J2 · active 谓词

- `activeJobsIn(family)` 只统计 `ownerSessionId` 在 family 内、且 `status === "running"` 或 `delivery === "pending"` 的 job。
- `isActive` 先看 job，再看每个成员的 `SessionStatus`；任一非 idle 即 active。
- 证据：`src/session/activity.ts:74-107`。

### J3 · delivery-pending 计入活跃

- job settle 后，notify fiber 还要 `injectSynthetic` + `markDelivered`；这段时间 job 不是 running，但结果聚合 turn 即将开始。
- 如果只看 running，会在这个窗口误判 family 静默，导致 edit-intent claim 提前释放或 goal continuation 与唤醒 turn 竞争。
- 证据：`src/session/activity.ts:74-95`、`src/agent/background-job.ts:590-645`。

### J4 · waitOwnerQuiescent

- `waitOwnerQuiescent(ownerSessionId)` 等待该 owner 的所有 running/delivery-pending job 结束；`markDelivered` 完成 done Deferred。
- 子代理 dispatch 在 `runPreparedCore` 中 park 在 `waitOwnerQuiescent(child)`，再读取 child 最新 assistant 消息作为最终输出。
- 证据：`src/agent/background-job.ts:620-645`、`src/agent/subagent-dispatch.ts:388-400`。

### J5 · 取消级联

- `SessionRunState.cancel(sessionID)` 先 `cancelBackgroundJobs`，再取消 session 自己的 runner。
- `cancelBackgroundJobs` 从被取消 session 出发，按 job id 与 typed `ownerSessionId` 做 BFS；`cancelled` set 保证每个 job 最多取消一次。
- **限制**：fixture 的 `cancelOrder` 直接复用 family BFS 列表，与 family 成员顺序同源；它未独立观测真实取消轨迹，因此不独立证明“父先于子”或“每个 job 只取消一次”。`expect.must_not` 是文档字段，judge 不执行。独立顺序断言列为待补 fixture。
- 证据：`src/session/run-state.ts:175-246`。
- `task_cancel` 有 ownership guard：`info.ownerSessionId !== ctx.sessionID` 直接报错，不允许取消别的 session 的 job。证据：`src/tool/task-cancel.ts:51-55`。

### J6 · generation 安全的 markDelivered

- `start()` 在同一 id 上创建新 run 时 `generation + 1`；durable generation 跨重启继续递增。
- `markDelivered(id, generation)` 只在当前 entry 的 generation 与参数一致时生效；旧 notify fiber 的过期 mark 是 no-op。
- 证据：`src/agent/background-job.ts:485-530`、`:590-618`。

### J7 · dispose finalizer

- 实例 scope 关闭时，registry finalizer 对每个 running job 做终态迁移：`status = "cancelled"`、完成 done Deferred、触发 `onInterrupt`；**不回调 `cancel()`**。
- 目的：不留下孤儿 subagent run 继续烧 token/permit；`cancel()` 会走用户取消路径，finalizer 需要 finalizer-safe 原语。
- 证据：`src/agent/background-job.ts:730-786`。

### J8 · run 模式 quiescence drain

- `chimera run` 在 prompt 返回后调用 `GET /session/:id/background/quiescence` 的 `drainBackgroundJobs`，并 grace abort SSE，避免 `--attach` socket 挂住进程。
- 证据：`src/cli/cmd/run.ts:241,758`、`src/server/routes/instance/httpapi/groups/session.ts:113-163`。

### J9 · 可见性与取消权

- `## Background Tasks` runtime-context 段只列 `ownerSessionId === input.sessionID` 的 job。
- `task_cancel` 只允许取消自己启动的 job。
- 证据：`src/session/prompt.ts:606-620`、`src/tool/task-cancel.ts:51-55`。

### J10 · quota 作用域（已知陷阱）

- `BackgroundJob` quota 是 **instance-scoped**（按目录），不是 process-global，也不是 session-scoped。
- 一个进程打开 N 个项目目录 → N 个独立池；池满错误只告诉模型“complete or cancel”，但模型可能看不到/不能取消占用池的外部 job。
- 证据：`src/agent/background-job.ts:327-340`、`src/effect/instance-state.ts:36-65`、`src/config/delegation.ts:10`。
- 本契约只记录该陷阱，不修改 quota 作用域或错误文案；修复需要产品决策。

## 3. 负例与不变量

| 编号 | 不变量 | fixture |
|---|---|---|
| N1 | `delivery = "pending"` 必须计入 active，markDelivered 后才可静默 | `job-family/delivery-pending-active` |
| N2 | 取消顺序为 family BFS（root → child → grandchild）；这是成员顺序，不是独立取消轨迹 | `job-family/cancel-cascade` |
| N3 | 过期 generation 的 markDelivered 不得把新 run 标成 delivered | `job-family/cancel-cascade` |
| N4 | 父取消必须先于子取消；同一 job 只取消一次；当前 fixture 未独立验证（cancelOrder 与 BFS 同源） | `CP-JOB-004`（代码级 + fixture 顺序）；独立顺序断言待补 |
| N5 | 外部 session 的 job 不可见、不可取消 | `CP-JOB-007`（待补） |

## 4. 与 mutation 链 / goal 的衔接

- **mutation 链**：edit-intent claim 的 idle-release 与 recheck 走 `SessionActivity.isActive`；delivery-pending 计入 active 防止 claim 提前释放。证据：`src/chimera/edit-intent.ts`、`src/session/prompt.ts`。
- **goal**：`kickGoalContinuation` 的 loop-exit gate 也走 `SessionActivity.isActive`；family 仍活跃时不注入新的 continuation。证据：`src/session/goal.ts`、`src/session/prompt.ts`。
- **v2 session.wait**：`waitQuiescent` 是唯一权威入口，不允许消费方自己重组 root-only 状态。证据：`src/v2/session.ts`。

## 5. 已知限制

- fixture 不启动真实任务、不触发 scope dispose；dispose finalizer 与 quota 作用域仍是待补点。
- 取消 fixture 的 `cancelOrder` 与 family BFS 同源，未独立验证 parent-before-child / cancel-once；`must_not` 仅为文档字段，judge 不执行。独立的取消顺序断言列为待补 fixture（`CP-JOB-008`）。
- `BackgroundJob` 的 durable 行（`background_job` 表）与 live registry 的恢复关系由 WP-05 矩阵描述；本契约只覆盖 live 语义。
- 取消语义是“host 不再观察/不再等待”，不声称底层子进程一定已停止；stdio MCP 的 SIGTERM 清理见 `mcp-transports.md`。