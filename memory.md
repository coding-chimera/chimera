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

### 工具自愈改造（2026-09-02，已提交 e724db0f55 并推送）

- 针对'工具把机械恢复外包给模型'的系统性修复：chimera_search per-term 保底配额（mergePerTermCandidates + applyFinalWindowQuota，queries.ts）+ searchNodesDetailed 遥测（terms/total）；edit hashline 锚点唯一内容匹配自动重定位 + 报错事实化；write 输出自带 hashline 锚点块；chimera_impact 无 seed 时返回候选事实列表；4 个工具描述同步收窄。
- 既有失败与本改动无关（stash 验证）：chimera.test.ts 'preserves caller relation evidence for signature deltas'、node-sqlite-backend getBackend 断言。

### 上游 v2 底座迁移（进行中，2026-09-04）

- 计划书：`UPSTREAM_V2_MIGRATION_PLAN.md`（根目录）——背景、决策、各层细分计划、验收标准、预存失败清单都在里面
- 进度：L0 ✅（grep 权限修复+codemode）→ L1 ✅（Effect beta.83 + schema/protocol 包 + 插件 v2 host）→ L2 ✅（LayerNode 子集 + effect-drizzle-sqlite）；L3 ✅ 完成并已提交 608804036f（2026-09-04：SystemContext 引擎 + session_context_epoch 表/手写迁移 + 提示词装配 Source 化（config flag `experimental.system_context` 默认关，关时字节不变）+ v2 事件契约收编 @opencode-ai/schema），验收细节见计划书 L3 节。五线程工作区已拆分提交：2df4a79094 graph needsMigration 防线 / faf8a419df 调度二期+遥测 / c3411251ed free_models / bf2a2ceeb8 newweb bump / 4354ec94f9 vendored 脱敏 / 608804036f L3 / memory pad 收尾——共 11 个提交已全部推送（2026-09-04：root 至 825f155380，pre-push 全仓 typecheck 17/17 绿；newweb 子仓 12 个提交至 28db62cf 推 logic10492/chimeraUI origin）
- 下一步：SDK/OpenAPI 需重生成（v2 事件漂移，跑 `./packages/sdk/js/script/build.ts`）；newweb `bun run api:inventory:update` 待 root `bun dev generate` 验证自愈后补跑；L4+ 再评估上游 registry 全家桶；GitHub dependabot 报默认分支 11 个依赖漏洞（4 high，预存未处理）
- 硬约束：逐层绞杀、每层树常绿可回退；子代理调度按下方"子代理调度新规"（旧"实现子代理只用 kimi-k3"约定已废止）；探测用 swarm
- 关键坑：上游仓 /Volumes/workspace/opencode（只读）；app-node-builder 是注入式签名（与上游不同）；drizzle-orm 双版本并存是有意的（catalog beta.19=v1 存储，rc.2=effect-drizzle-sqlite 包内固定）；drizzle-kit generate 被 20260714 损坏 snapshot 卡死，迁移手写

### newweb 上游追平（OpenCodeUI v0.6.23→v0.6.45+，221 commits 已归 13 链，2026-09-01 起）

- 上游 = lehhair/OpenCodeUI；packages/newweb 已配 upstream remote 并 fetch 全部历史/tag（`git show upstream/main:<path>` 读上游文件；分叉无共享历史，不可常规 merge）
- A 层 ✅ 已提交（dc0373cb..1aa61ccc 共 4 个，在 main 并已推 origin）；B 层 ✅ 已提交（2026-09-03）：b13e4972 请求风暴（87cfc67f+59be1a8d，isSameBusySessions + missingSessionsKey/inflight/failed refs）；09996a7d 链8 折叠阈值（--fs-base 替代 parseFloat(lineHeight)）+ useDisclosureScrollLock/scrollUtils；df07061a messageStore dirtyParts（d7fbb16b+3619a014+90e2b4d1，与上游终态逐字节一致）；28e191b4 链4 流式性能包（b86fd0a8 删同步高亮 / 3f689a5e+cd67ebf6 SmoothHeight rAF+contain-layout-style / 26b5c149+b1aae0e4 overlayScrollbar / 395830b6 DiffViewer/InputBox/CSS 收窄）
- C 层 ✅ 已提交（2026-09-03 第二批，main 到 4be35bf6）：8c501086 设置搜索（913d949e+fd1de693+dba66d9a 部分，catalog 已覆盖本地 compaction/providers tab）；880ac926 文件内容搜索+拖拽@mention（601df2c7+0d9e04c1，find.text 走本地 ApiScope）；8b4c5e70 MCP resources（cd0b7473，SDK 1.14.41 实际路径是 experimental.resource.list）；4be35bf6 useAutoRefresh（b5fccbac，接本地 registerSessionConsumer 事件总线）。注意 components.json/FileExplorer.tsx 是共享文件：mcp locale 键与 consumerId 行随 880ac926 提交
- 验证基线（C 层后）：typecheck ✓；eslint 0 err/9 warn（全既有）；test:run 609/610——唯一失败 openapi-inventory 是环境性：root 仓 v2 迁移 WIP 使 `bun dev generate` 在 graph/errors.ts:150 解析崩溃（干净树 stash 复现确认），root 修复后自愈。server-workflow-closure 的 find.text claim 已按 AGENTS.md 规则 flip 为 true（C2 上线了该调用）
- **api:inventory:update 当前不可用**：写模式校验 resource.list 不在内嵌 OpenAPI 快照里（快照过旧），而刷新快照依赖 root 仓 `bun dev generate`（WIP 损坏）→ 等 root 修复后统一跑 `bun run api:inventory:update` 把 searchText/resource.list 收进 api-call-inventory.json
- D1 ✅ 已提交（1e6cb7f6）：markdown 管线整换到 a9e77077 终态 + b1aae0e4 回补；依赖 +marked 18.0.5/+morphdom 2.7.8/+dompurify 3.4.11/+@types/dompurify 3.0.5，-streamdown/-@streamdown/math；双锁文件已手工同步；vite/vitest define+worker es 已配；测试重写 3+新增 2。D5 ✅（1e0e75eb）：HTML 沙箱预览 9 提交链，安全模型逐字核对，acc1b7c9 artifact 测试 hunk 已回补；刻意排除 c885c606/87eac61d/HtmlFilePreviewFrame（文件管理器 HTML 预览）。D6 ✅（28db62cf）：shiki 主题用户化，亮/暗独立，settings search 目录已补，备份兼容；bedb7695/e1303d93 判定正交未带。另 c639f8b3 = AGENTS.md 坑位文档。D3 ❌ 不追（多服务器，链6 随之搁置）——D 层拍板至此全部落地
- D2 ❌ 不追（2026-09-03 拍板：机制对比后留自研页块架构——性能够用且零黑箱可测，上游虚拟化 v5 仍有 revert 史+私有字段强转；代价=上游滚动修复以后手工移植；D4 随之搁置）。机制对比结论与 D1 采纳点（a9e77077）在 scouting 报告，关键数字：A 测试 705 行 vs B 1402 行
- 验证基线（全部完成后，main=28db62cf）：typecheck ✓；eslint 0 err/7 warn（全既有，比 B 层时还少 2）；test:run 703/704——唯一失败 openapi-inventory 环境性（root WIP 使 bun dev generate 崩，root 修复后自愈，且自愈后需跑 `bun run api:inventory:update` 把 searchText/resource.list 收进 baseline）
- **root 仓待办** ✅ 已落地：newweb 指针 bump（1aa61ccc→28db62cf）+ bun.lock markdown hunk = bf2a2ceeb8；schema lock 行随 L3 提交 608804036f
- 剩余可摘（Wave E 候选，未批准）：markdown 管线对齐 upstream/main 的 post-D1 perf 链（bedb7695/e1303d93/79458770/b647f5dd/10d07ce7/6aad61d3/9fb2d094/43a0b7e4/5602e384）；c885c606 fenced 语言预览；87eac61d 交互式 SVG+主题变量；HtmlFilePreviewFrame 文件管理器 HTML 预览；c9441219 已随 D2 不追而废
- 移植注意（下轮接管用）：SidePanel/activeSessionStore/MessageRenderer 本地已非 v0.6.23 基线，适配勿整替；`git diff v0.6.23 -- <path>` 查本地定制；markdown 管线文件现在的对齐点是 a9e77077+D5+D6 精选集，查差异用 `git diff <那个组合> -- <path>` 而不是 upstream/main
- 明确不采纳：链6 单独、7c7a47ef（本地方案不同）、Tauri/Docker 本地已分叉、上游默认值调整
- 遗留：scrollUtils.ts 未含 scrollItemIntoView（C1 在 SettingsSearch 内联了私有副本，若移植 eca03f24 需合并）；allowStreamingLayoutAnimation 全链默认 false 是上游 intended，视觉回归需人工过一眼；D6 主题切换建议浏览器冒烟（worker lazy-load 在真实环境未验）
- 并行 worker 教训：共享文件（FileExplorer/components.json）会撞车——C2/C4 撞出语法错误（已修）、C2 移植丢了 search({createPanel}) 接线被 CodePreview 测试抓住（已恢复）。派波次时共享文件要并组或显式点名
- 坑：① newweb 里 `npm install` 必崩（node_modules 是 bun symlink，npm 11 arborist edgesOut bug）→ 锁文件手工补丁 + bun 管安装；② 交接前必须 `bun run typecheck` + `bun run test:run`（drift 环境性失败见上）；③ chimera server 面变更后要 `bun run api:inventory:update`；④ 本地依赖全部锁精确版本

### 子代理调度新规（2026-09-03 用户谕示，覆盖此前所有约定）

- subagent 全面禁用 kimi-k3（root 会话是 kimi-k3，子代理一律改用别的）
- builder 选型原则：大模型（L/XL）用低档思考（variant low）；小模型（flash 级）用高档思考（variant high）；显式传 model+variant，不让调度器自动补
- scout/探测：workload=scout 让调度器选（当前 pick deepseek-v4-flash low），仍可用 swarm
- 旧约"实现子代理只用 kimi-k3 且必须显式 variant: high"（上游 v2 迁移条目，2026-09-03 早些时候）自此废止
- 根 AGENTS.md 调度行已按本新规改写（2026-09-04，随 faf8a419df 提交）

### 工作区核对修复（2026-09-04，已提交）

- 五线程工作区审查发现并修复三处编辑事故：processor.ts text-start case 外不可达死代码残留（删除）；revert.ts v2 事件块误带重复 sessions.setRevert（删除重复，保留原调用+新事件）；resolveSchedule 误删 suppressed/dormant 路由过滤（恢复+补回归测试 test/agent/subagent-model-scheduling.test.ts）。processor/revert 修复随 608804036f、调度过滤守护+回归测试随 faf8a419df 提交
