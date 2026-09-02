# Temporary Memory

This file is a temporary cross-session memory pad for this checkout.

Use it for short-lived notes that should survive context resets or handoffs while active work is still in progress. Prefer permanent documentation, issue trackers, or code comments for durable project knowledge.

Guidelines:

- Record only concise decisions, pending local context, and handoff notes.
- Remove stale entries once they are resolved or no longer useful.
- Do not store secrets, credentials, tokens, private keys, or long transcripts.

## Notes

### P0 plan: aijws/grok-4.5 thinking intensity (DONE)

Status: implemented and verified 2026-07-14.

Changes:
- `chimera/packages/chimera/src/provider/transform.ts`
  - `grokReasoningEfforts` / `isGrok45Family` / `grokEffortOptions`
  - variants: grok-4.5 family → low/medium/high
  - options default high for grok-4.5
  - discovery without reasoning still allowed for grok effort models
- `chimera/packages/chimera/test/provider/transform.test.ts` aijws/xai/openrouter coverage

Verify:
- `bun test --timeout 30000 test/provider/transform.test.ts` → 173 pass
- `bun typecheck` → pass

Out of scope (P1 later): Ultra multi-agent, llm.ts codex decoupling.

### Parked: 多会话编辑冲突感知（edit intent claims）

Status: 设计 v2 已完成并获用户认可（2026-08-31），**挂起等待用户完成上游同步**，用户说"我完成了来告诉你"。

核心决策：
- 基于 chimera_predesign 做文件级 edit-intent claim（advisory，非硬锁），存项目级 codegraph.db 作为 CHIMERA_STORAGE_EXTENSION migration v5
- claim 必须有显式释放信号（closeout 挂钩 + 会话 dispose），TTL 只作崩溃兜底
- 等待模式 L0：agent 完成无冲突批次后 park 并报告阻塞点，由用户消息驱动继续；L1 释放通知走 prompt-context.ts 注入；L2 依赖上游 background subagent 模式（当前 checkout 无此实现）
- 分期：P1 核心闭环 + P2 呈现/教学（纯 fork 文件，零上游冲突）可先行；upstream-derived 文件的 advisory 和 L2 等 sync 后

回来时注意：sync 后行号锚点会漂移，需重新核实集成点（store.ts / provenance.ts:801 门禁 / prompt-context.ts / edit.ts:262 / write.ts:55），再出 P1 实现计划。

### 全量测试耗时基线（2026-09-01 实测）

loop 挂起修复前的对比基线（本机 macOS, bun 1.4.0, `bun test --timeout 30000` @ packages/chimera）：
- 325 文件 / 4606 用例 = 2888s（~48min），90 fail + 15 errors；失败用例烧时 1240s（43%），通过用例 1142s
- 大头：session 1303s（prompt.test.ts 698s/33fail + processor-effect.test.ts 463s/16fail，loop 挂起每个烧满 30s）；server 310s；snapshot 266s（0 fail，固有）；project 245s；graph 226s
- 独立故障簇：graph/mcp-daemon.test.ts 7/7 挂 ×10s=73s（待查环境性/真回归）；prompt.test.ts 另有断言漂移——运行时上下文注入完整生产模型目录而非测试 fixture 的 test-model（subagent routing 系列提交后测试未更新）
- junit 原始数据：<tmp>/chimera/junit.xml
- loop 修复落地后重跑一次全量对比；若仍 >25min，剩余大头是 snapshot/project/file 等固有集成成本（真实 git/HTTP server），可考虑分片

### effect beta.83 升级挂起已修复（2026-09-01）

- 根因：升级只 bump 了 effect，漏了 catalog 里的 @effect/platform-node / @effect/opentelemetry（停 beta.57）；beta.57 的 NodeHttpIncomingMessage.text 调用已在 beta.83 移除的 MaxBodySize.asEffect()，测试 LLM server req.json 同步抛 TypeError → 框架 500 → 客户端 5xx 无限重试 → 测试 30s 超时。
- 修复：根 package.json catalog 三件套对齐 beta.83（platform-node、opentelemetry，并新增 platform-node-shared=beta.83 + overrides 钉住，防止 ^range 漂到 4.0.0-rc.112），bun install 更新 lockfile。与上游 opencode 版本组合一致。
- 验证：prompt.test.ts 75/75（基线一致）；test/session 465 pass / 1 fail（唯一失败 compaction 'stops quickly when aborted during retry backoff' 在 beta.59 基线同样失败，既有时序敏感问题）；bun typecheck 通过。
- 待办：基线节提到的'修复后全量对比'尚未重跑（session 目录已从 ~1300s 降到 ~300s）。

### 断言漂移调查（2026-09-02 已解决）

根因：`test/provider/amazon-bedrock.test.ts` 的 bearer-token 用例把 bedrock api key 写入共享 auth.json；bedrock loader（provider.ts，有 TODO 自认 hack）在 list() 读路径把 `process.env.AWS_BEARER_TOKEN_BEDROCK` 永久写进进程且从不删除 → 后续所有测试文件的 Provider 状态从 process.env 拷贝 → bedrock 全量 fixture 模型进入 subagent 目录 → 4000 字符预算截断 test-model → prompt.test.ts 两个断言漂移。修复=该测试 finally 恢复/删除该环境变量（全套件漂移已归零）。
同日修复：43135ac3f 手写迁移 share_url 对 fresh DB 报 duplicate column → db.ts 改为导出 `Database.applyMigrations` 两段式（主链 + 按需 repair），json-migration.test.ts 已切换到共享函数；db.test.ts 加了 fresh-DB 迁移回归用例。
最终全量（2026-09-02）：4624 用例/326 文件 = 1651s（~27.5min），30 fail（剩余为既有簇：graph/mcp-daemon 7、mcp-roots 3、httpapi-config 8 等；tool/chimera 1 与并发进行的工具自愈改造相关）。
遗留：bedrock loader 生产侧仍写 process.env（建议改 providerOptions 传递）；漂移测试固有脆弱（providerCfg 含 openai，mergeProvider 附加语义拉入全量 fixture 模型，fixture 变大可能再超 4000 字符预算）。



### 工具自愈改造（2026-09-02，本会话 swarm 完成，未提交）

- 针对'工具把机械恢复外包给模型'的系统性修复：chimera_search per-term 保底配额（mergePerTermCandidates + applyFinalWindowQuota，queries.ts）+ searchNodesDetailed 遥测（terms/total）；edit hashline 锚点唯一内容匹配自动重定位 + 报错事实化；write 输出自带 hashline 锚点块；chimera_impact 无 seed 时返回候选事实列表；4 个工具描述同步收窄。
- 工作区混有外来改动（storage/db.ts 迁移修复、amazon-bedrock.test.ts 环境恢复、newweb 子模块），提交时务必分开。
- 既有失败与本改动无关（stash 验证）：chimera.test.ts 'preserves caller relation evidence for signature deltas'、node-sqlite-backend getBackend 断言。
