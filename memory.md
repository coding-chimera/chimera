# Temporary Memory

This file is a temporary cross-session memory pad for this checkout.

Use it for short-lived notes that should survive context resets or handoffs while active work is still in progress. Prefer permanent documentation, issue trackers, or code comments for durable project knowledge.

Guidelines:

- Record only concise decisions, pending local context, and handoff notes.
- Remove stale entries once they are resolved or no longer useful.
- Do not store secrets, credentials, tokens, private keys, or long transcripts.

## Notes

### 发布面 kernel prebuild 批：8 腿矩阵本地 6 腿落地 + CI job，端点安全第二次触雷（2026-09-17）

- **交付**（commit b172de20d、679650bbe、7b4a98d64、922e2bc92 + 本批，全部未 push）：build-kernel.sh 多腿/zigbuild/glibc-2.28 钉版/musl crt-static opt-out（必须 CARGO_ENCODED_RUSTFLAGS，zigbuild 会掩掉普通 RUSTFLAGS）；build.ts copyKernelPrebuild 矩阵感知（kernelPrebuildPlatformDir，12 包→ 8 腿，baseline 共享产物）；publish.yml kernel-prebuild job（8 腿矩阵，continue-on-error，artifact 汇入 build-cli，kernel 永不闸发布）；loader 降级测试 +2（不可加载 catch 分支 + 假 triple 子进程探针）；选型实锤：zigbuild=linux 正解、cross 淘汰（无 docker）、cargo-xwin 拒装（红线）、win-gnu 被 napi-build libnode.dll 闸、**win-msvc 腿 napi-build 零额外输入（源码核实）= CI-only**；本地 6 腿 staged+格式验证（sha 清单/证据在 UPSTREAM_RUST_KERNEL_PLAN.md §2.3 增补）；typecheck ✓、46/46 相关单测 ✓、actionlint 零新增 ✓、--single 构建→tarball 静态验证 ✓（kernel sha 字节无损）
- **端点安全第二次触雷（用户投诉，纪律固化）**：npm 安装冒烟中执行 /tmp 新解包 bin/chimera 被 SIGKILL（exit 137；内容与 dist sha 一致——拦的是“新落盘可执行物被执行”模式）。本机硬纪律：① 任何新鲜构建/解包的可执行物一律不执行（含 /tmp、含全局路径）；二进制执行验证（安装冒烟、--version、graph 命令）= CI-only/待授权；② 安装流验证静态化：tar -tzf 清单 + tar -xzO 管道断言（零落盘）；③ zig 自托管子命令全家（objdump/ar/ranlib/dlltool/lib/rc）禁用，产物验证只用 file/shasum//usr/bin/objdump/otool/nm/strings；④ cargo zigbuild 编译+链接允许（全程零拦截）；交叉 .node 只验格式不执行；仓内 bun test（含加载 staged prebuild）既有允许不变。AGENTS.md 的 npm install 全局验证流程在受管机器上**不可执行**
- **待办**：CI 首跑（win32×2 msvc 腿产物 + kernel-prebuild 矩阵接线验证）；musl 实机 dlopen 验证（alpine）；Windows .node 是否纳入 Azure 签名清单（sign-cli-windows 只签 chimera.exe，parent 拍板）

### Rust kernel wave2：TS 开闸完成、微损归零、已推送（2026-09-16）

- **扩展 bench 终判（2026-09-17）**：核心矩阵 12/12 满分保持（kernel 时代零回归；Scope check 12/12 触发、tb5-v2 三格点名 size-table.ts）；探索扫描初判 1/13 全为 harness 假阳性（footprint BASE 取 reflog 尾=clone 点，晚于其的 5 个 fixture commit 使 21 文件恒被判越界），考证历史本意后修为“BASE=最新 reset:/clone: reflog 条目”（防线不减），12 个 verify.sh 修补+tb5-v1 陈旧 pin 重写+tb1/tb2 空行 guard 同族假阳性修复，双向 oracle 13/13 重验后**扫描改判 11/13**（重放本格 agent 实解：tb3-v1 pin1 真失败、tb3-v2 真 footprint 越界（新建 resolution 辅助文件，维持严判——任务意图是扩展现有机制非另起炉灶），余 11 格实解全部 PASS）；备份 v3=cbench-20260917.tar.gz（321MiB，含 repo-g .git 全量=fixture commit 链唯一存续处）。**kernel 战役主体完成**；遗留工单：wasm 返回类型 ref 双发卫生修（需 kernel 镜像同批）、kotlin/scala/dart 对账、~~发布面 linux/musl/win prebuild+CI~~（✅ 2026-09-17 本地 6/8 腿落地 + CI job，见顶部条目；待 CI 首跑）、relaunch 姿态小修、tb4-v1 锚点统一（cosmetic）、dependabot 授权
### 第三波：G0+union 已推、Rust kernel 立项、bench 资产全恢复（2026-09-16）

已推 origin/main（..4354468b7 三笔）：G0 上游移植批（Swift regex hang 1043ms→0.03ms、tsconfig extends 丢边、name-lookup 索引 seek、git -uall、availableParallelism）、union 脱壳（initializedDb.close/find.focus 12 条全部翻正，实测 initdb_close 12→0）、UPSTREAM_RUST_KERNEL_PLAN.md（B 案绞杀者，P0-P3，待拍板 K1-K5）。

- **重索引假回归事故**：wave3 验证时 index -f 25min 不完（基线 79s），取证后确认=**环境 I/O 竞争**（bench 资产 builder 同期跑 bun install+1GB tar 备份同盘）；安静环境同二进制重跑 87s 正常。EXPLAIN 实锤 G0 的 lower() 形式 SEEK idx_nodes_lower_name（旧 COLLATE 形式全表 SCAN——fork 一直带着这个上游 bug）。教训：**索引计时类实测不得与重型 I/O 任务并发**
- bench 资产灾后全量恢复：17 任务×{prompt,verify} 齐备（字节级原物+双向回放 oracle）；repo-b 重建（shallow，HEAD 精确对齐，preload 修复）；repo-g 泄漏解答已清+status 空；备份 v2=489MB；遗留：repo-g 对象库 31 处 broken link（HEAD 树完好，runner 不受影响，可从主仓补对象；实验用 --depth 1）
- Rust kernel 双调研对表要点：kernel 同步调用设计→parse-pool 保留；值引用/接口成员/returnType 上游均有对应物（对账即可）；params_json 无对应物=唯一改 Rust 项（extraJson 补丁 tsjs 先行）；fork 无 EXTRACTION_VERSION 机制需 P0 新建；.node 旁挂有 @parcel/watcher+grammar wasm 双先例
- 主仓图终态：nodes 117457 / edges 241451 / refs 34332 / failed 195014

### 图召回+防御五路批次已推送（2026-09-15）

已推 origin/main（a84c65722..7b2969f01 五笔）：接口成员建节点、name-matcher await/type_alias/barrel、WAL valve+parse-pool 卡死防御、LSP typeDefinition+全操作 10s 超时、ProjectionMemo revision 键修复（后者根因：memo 仅按 node id 键，trackToolMutation before/after 跨 sync 复用陈旧冻结对象 → 语义 diff 自比恒空，自 9e1766eb6 起 MMS/MF/MCC 事实全部静默退化为 body；test/tool/chimera.test.ts signature-delta 用例即其回归锚）。

- 主仓重索引实测：114s 无卡死（WAL 防御生效实证，此前 763/2771 处挂死 8min+）；节点 117312、边 222764→240404（+7.9%）、references 29012→34150（+17.7%）、unresolved failed 207271→195608（−11663）、getNodesInFile 类失败 109→0
- 已知环境失败基线更新：**15**（MCP daemon×7/roots×3/initialize×2/Node26 refusal×2/node:sqlite×1）——pr19 pragma 已修（期望对齐 64MB/256MB 默认）
- 集成四目录（graph+chimera+tool+lsp）终态：1957 pass/15 fail，~7min
- 残量缺口状态（2026-09-16 更新）：同名类消歧 E2/E5 已做（三层保守排序）；db.* 大桶经逐站点分诊证实为不可救（外部 bun:sqlite 类型/无注解回调参数/union/ReturnType 别名）；真缺口 cg.* 簇已修（见下）；仍未做：for-of/构造器参数属性证据、union 脱壳（X | null）
- LSP 工具已转正（用户拍板，d5921900c 已推）：registry.ts 无条件注册 tool.lsp，core 旗标表条目保留减上游漂移；验证 typecheck+registry/parameters/lsp 104/104+prompt 79/79

### 第二波：残量召回+Scope check 抑制修复，G 臂 12/12 满分（2026-09-16）

已推 origin/main（d5658fa01、a1050a08b、149c5564a）：

- **残量召回批次**（d5658fa01）：点号工厂证据（`x = [await] Class.m()`，主仓 cg.* 失败 291→5）、import type 默认导入+动态 import 补充（纯 ALLOW 向）、闭包外层参数行走、同名类三层保守消歧；unresolved 再 −868、references +142；重索引 79s
- **Scope check 抑制修复**（a1050a08b）：G 臂 recall-post 轮 tb5-v2 3/3→1/3 回归的根因——declared scope 把 predesign 全部模糊种子（searchNodes 文本命中含 import/stmt 节点）的文件都算已声明，召回富化后 `searchNodes("renderSize")` 命中 size-table.ts 的 import/stmt → 两跳隐藏面被吸收进 scope → 深度消费者提示静默消失。修复=declaredScopeFiles 只认定义类 kind+精确符号名/声明 nodeID。教训：**图富化会改变下游模糊匹配语义，enrichment 批次必须跟 bench 回归**
- **G 臂 n=3 终局 verdict：12/12 满分**（tb5-v2 回 3/3 且三格 Scope check 均点名 size-table.ts；tb6-b 保持 3/3；零噪声零拒改；results-recall-post3）
- **bench 资产事故与迁移**：用户自建 tmp 清理任务 03:42 吃掉 temp 里的 cbench（tasks 全清、repo-g .git 部分损毁）；已字节级恢复（verify.sh 从 session DB 找到创作会话 write 原文=原物，60 历史格回放 cmp 一致；repo-g 99 blob 以精确原 hash 重建，HEAD 7c4366f0 保留）。**cbench 永久家目录=/Volumes/workspace/cbench**（脚本 B= 路径已批量更新），备份 /Volumes/workspace/cbench-backup/cbench-20260916.tar.gz（1.0GB）。教训：临时区的东西被第二次引用就该搬家
- 遗留：repo-g 深层历史 14 commit 后断链（bench 不受影响，可从主仓回灌）；repo-b 未修（B 臂要用先修 node_modules）；13 个旧任务目录未重建（tb1-*~tb5-v1，session DB 有原文可按同法恢复）；Node 26.3.0 非 LTS 警告（索引成功，建议 bench 环境切 Node 22）；dependabot 14 漏洞待用户决定是否排批次

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
- 2026-09-04 用户谕示增补：qwen3.8-flash 仓库理解有严重缺陷，禁作 scout（scout 结论无下游复验），builder 保留（大模型收尾）。NL2Repo-Bench 无稳定长期指标获取办法，按配置化处理、不改评分锚点。机制=新增 archetype 级 `delegation.scheduling.archetypes.<workload>.excludeModels`（条目精确匹配完整路由 provider/modelID、identity 或 providerID；调度候选过滤 exclusionMatch/resolveSchedule + 显式派发 prepare 强制报错，resume 除外；不依赖 scheduling.enabled）。实现：src/config/delegation.ts、src/agent/subagent-model-scheduling.ts、src/agent/subagent-dispatch.ts + task.test.ts/scheduling.test.ts 用例；全局配置 ~/.config/chimera/chimera.jsonc 已写入 scout 排除 ["qwen3.8-flash"]（生效需跑新构建）。SDK v2 gen 的 DelegationScheduling 类型随既有“SDK/OpenAPI 重生成”待办一并更新，本次未单独跑。

### 工作区核对修复（2026-09-04，已提交）

- 五线程工作区审查发现并修复三处编辑事故：processor.ts text-start case 外不可达死代码残留（删除）；revert.ts v2 事件块误带重复 sessions.setRevert（删除重复，保留原调用+新事件）；resolveSchedule 误删 suppressed/dormant 路由过滤（恢复+补回归测试 test/agent/subagent-model-scheduling.test.ts）。processor/revert 修复随 608804036f、调度过滤守护+回归测试随 faf8a419df 提交

### 上游特性同步 F 线：分诊完成（2026-09-04，文档未提交）

- 388 feat（v1.14.40..9f69463f1d）全量五分类：①可直搬 12 / ②需适配 66 / ③fork 已等价 11 / ④无关 288 / ⑤已同步 11；安全关键词 fix 43 条横切审计：无 P0、fork 需修 5 条——**P1 `08faeb3893` #43675 run 模式子代理权限应答被 sessionID 过滤丢弃→run 挂死**（run.ts:570-590，~10 行，headless/CI 高危）；P2×4 a9c810cbbc（$ARGUMENTS 双重注入）/c035c35eba（坏 JSON 崩启动）/dc978cb889（id 校验）/3a4c253969（textVerbosity 中继注入）。另高优 `ae92f3158f` Copilot token 计费（上游 API 已切换、fork models.ts 旧 schema，现网风险）
- 落地文件：`UPSTREAM_FEATURE_TRIAGE.md`（新增，逐条明细/落点/适配点/排除证据/11 项产品决策清单/fix backlog 方法学）+ `UPSTREAM_V2_MIGRATION_PLAN.md` 新增「上游特性同步（F 线）」章节（F0~F3 批次+L4/L5 并入项），状态行已同步修正为已推送
- 建议顺序：F0（~1 天）→ F1（3-5 天，Copilot 计费提到最前）→ 产品拍板 11 项 → F2 MCP 专项（~1 周，8 条一次做完防反复冲突，含 a131811cdc 命名契约变更须同批）→ L4（llm 族 15 条随整包吸收；03afae5b95 v2-compat 打头阵）→ F3 TUI（~1 周，路径映射 packages/tui/src↔src/cli/cmd/tui，优先 fix 主题 C/B/G）→ L5
- fix backlog ~910 未逐条：无关表面 ~427 封板；core 相关 ≈374 随批次消化 + L4 开工前关键词筛（crash/hang/loss/leak/corrupt/race）防漏 P1
- TUI 同源判定：fork TUI 与上游同源但结构性分叉（@tui/* 别名+专有模块；上游独有 diff-viewer/command-palette 等）→ feat(tui) ②17/④10，无①直搬项；desktop 39 全④（7 条壳级基建可复议）；app/ui/i18n 125 + stats/go/console/web/nix 53 + acp 12 全④（acp=既有拍板）
- 分诊来源：6 个 swarm 代理（reviewer=qwen3.8-max medium ×3 一次成功；scout 首派 muse-spark 区域不可用失败，重派 deepseek-v4-flash low ×3 成功）；报告全文在本会话 tool-output（会话级存储），结论已全部落入两份文档
- F4 后台子代理决策简报完成（2026-09-04，reviewer qwen3.8-max + 2 深读子代理，锚点已复核）：**关键修正=task_status 轮询已被上游删除（dabf2dc013），终态=task(background=true)+注入驱动自动续跑；全链 12 提交非 3 条**。提案：P1 最小闭环 ~3-5 人日（引擎子集+task 参数+config flag 默认关+级联取消，无新表无新事件，与 F2 并行）/P2 并入 L5 或排后（swarm 状态通道被 prompt.ts:684 门挡、预算借用前提冲突）/P3 与 F3 合并（promotion+claims L2，**claims L2 仅依赖 P1**：inject=挂起设计 L1 pull 注入缺的 push 通道）。九拍板点见 TRIAGE §10.5/计划书 F4 节；简报全文=会话 tool-output ses_f8597876bffe4nWvyOGOp2V9Ot
- F4 拍板（2026-09-07 用户谕示）：**做、默认打开（kill-switch，有问题就修）**；④锁死自动续跑；⑤background_concurrent 上限随 P1 落地、级联取消=是；⑧claims 解冻（P1/P2 与 F4-P1 并行，L2 等 inject）；②③⑥⑦⑨按建议。用户用例新增两条 P1 需求：**面向模型的 cancel 表面**（first-wins：N 路探查任一早回即取消其余）+ **会话可寻址 inject**（跨 thread claims 释放广播唤醒；跨进程唤醒=claims L2 开放问题，需 poll→inject 桥）。flag 命名建议 delegation.background_subagents 默认 true。拍板记录全文=计划书 F4 节/TRIAGE §10.8；日期勘误：分诊与简报实为 09-07（文档误标 09-04 已修）。下一步待用户发令：F0（5 修复）+ F4-P1（按拍板 spec）派 builder
- **F4-P1 完成（2026-09-07，未 commit）**：四阶段串行 builder（deepseek-v4-flash high）+root 逐阶段复验。落地：background-job 引擎（内存注册表/limit 拒绝不排队）、task background 参数（kill-switch 关时 schema 换窄字节不变）、会话可寻址 injectSynthetic（claims L2 可直接复用：SessionPrompt.Service.injectSynthetic({sessionID,text})）、task_cancel 工具（归属守卫+幂等）、run-state BFS 级联+session.remove 清理、backgroundTasks prompt-context section（无 job 零字节）。**偏差已认可**：后台 run 不经 DelegationLimiter（background_concurrent=16 独辖，不蚕食前台 128）。验证：F4 家族 113 全绿+typecheck 绿+session 495 pass（唯一失败=预存 compaction 时序）；矩阵 A 注入×compaction 完整 E2E、矩阵 B ultra 剥离锁定。工作区共 35 文件未 commit（3 文档+F0 7 源+测试+F4 四阶段）；建议提交拆分：F0 一批、F4-P1 按四阶段或合一、文档一批。下一步：F1/F2/claims P1P2 未启动；P2 等 L5；P3 等 F3
- F4-P1 阶段 4（收尾）✅ 已完成（2026-09-08，未提交）：prompt-context "Background Tasks" runtime-context section（prompt.ts runtimeContextSections 新 key `backgroundTasks`，kill-switch 开 && 本会话有 running job 才发射，serviceOption(BackgroundJob.Service)）；task.ts freshStart 容量预检移到 materialize 之前（超限不留孤儿会话）；injectSynthetic 会话不存在改类型化 NotFoundError（不再 Effect.orDie），task.ts notify 三处 Effect.ignore→Effect.ignoreCause({log:true})（beta.83 无 ignoreLogged）；run-state/session 尾部空行清理（cosmetic）。新增测试：test/session/background-tasks-context.test.ts（发射/不发射/kill-switch 字节稳定）、inject-synthetic.removed 会话 typed-not-found + notify 吞 defect、inject-synthetic 注入×compaction 边界两侧 E2E（llm.hold 栅门）、task-background 超限不建会话 + ultra 显式拒绝 + parent-ultra 剥离。验证：typecheck 绿；F4 全家族 107 pass；test/session 495 pass/1 fail（compaction 'stops quickly when aborted during retry backoff'=memory 已记录的 beta.59 基线既有时序敏感失败，A/B interleave 证实两树同败）；test/chimera 33 pass；tool.chimera 1 条预存失败照 old 清单。predesign_215fa11fcf145101 / audit_b3c0733a6940b5db、audit_66411680ae9b73f6、audit_aaeab1fee6da4988。下一接力：阶段 5（如有）或提交（不 commit 约束已解除待用户发令）

### F1 批次完成（2026-09-08，本地 8 commit **未 push**——用户指令禁 push）

- 8 commit：7dd57693a 图片缩放+seeding / 5571bb670 headerTimeout / 9fd39ccb9 HTTP 压缩 / aaddd6fbb CLI 双件 / 0efb73724 插件三件套 / 3c396f636 mantle+Cohere / 8674add7f Copilot 计费+tiers / b6a42ec70 SDK v2 重生成（L3/F0 既有漂移一并结清）
- 拍板：worktree 命名 9b7b6cb30f N/A 跳过；M10（f1407e41c4 copilot itemId 键改名）转独立 backlog；Cohere citation_options 随上游 db9391e8a6 回退同步删除；headerTimeout ResponsesTransport 不透传；tiers subagent 仅类型透传；small_model hook 完整移植；Modal 不预置模板
- 验证：typecheck 0（chimera+plugin 双包）；集成门禁 session+provider+agent 48 文件 1217 pass/1 fail（对账表预存 compaction abort flake）；各波聚焦测试全绿；终态 build --single --no-webui ✓（**未运行新二进制**，photon wasm 运行冒烟留给用户）
- 事故与清理（已沉淀 pitfalls #30-33 + #1 第二实例）：I1 手动中止留半编辑态→同 task_id 续派完成；edit 锚点事故吞 env 行→mcp-add 子进程一度污染真实 ~/.config/chimera/chimera.jsonc（mcp.github/local）→已精确清理复核；bun.lock 内网镜像 URL→空串槽脱敏协议；progress.md 已勘误 patch1（旧记录 patch2 不准）
- 权威记录：计划书「F1 完成记录」节 + skill progress.md（已全量刷新）；（上方 F4-P1 两条的“未提交”标记已过期，a143b3c23 已推送）
- 下一接力：F2 MCP 专项（8 条一次做完）∥ claims P1/P2（5 锚点需重核，F1 后 prompt/processor/config 均大改必漂）

### 方向③ codegraph 分诊完成（2026-09-09，文档已入库）

- `UPSTREAM_GRAPH_TRIAGE.md`（仓库根）：a5a8942..6a056ec5（as-of 08-26，禁 fetch）179 条全量五分类 ①8/②68/④101/⑤2，对账平衡；7 代理 swarm（5 reviewer + 2 scout），组报告路径在文档 §8
- P1×8：340d4b0 Swift regex hang（1 行）/474f051 tsconfig extends/02c0e2c WAL 泄漏/8c1e821+ca88d3b#1 valve file-cap/d8f2eea spread crash/03893b0 edge drift（chimera_impact 直接消费污染边）/f2a5df3 stale-slice/c74e8b0 debounce
- 关键结构事实：fork wasm-only 无 kernel/无 resolver-pool（④101 条根因）；双消费面（agent chimera_* + MCP tools.ts）；基线前缺口账本立账（function-ref #807/c-fnptr #954/#825/#1292 等）
- **待用户：16 项拍板一轮过**（文档 §5，每项带建议；核心：A grammar pin 采纳/B union 采纳/D resolver-pool 暂不/E kernel 不移植/F function-ref 独立战役/G C-deferral 缓议/P explore 史诗后排）；拍板后 G0（~1 天）可立即先行
- 批次轮廓：G0 小修→G1 WAL+收敛战役→G7 perf；G2 watcher/G3 检索质量/G5 generated 检测/G8 CLI 小件独立；G4 语法精度（等拍板 A/B）；G6 explore CG 史诗最后（~1-2 周）

### F4-P1.5 嵌套后台孤儿化修复（2026-09-10，未 commit）

- bug：子代理（mid）派后台 leaf 后回合结束，前台 dispatch 立即把"等待中"文本返 root → leaf 结果孤儿化（用户实测 mid-out 缺失）；run 模式对 root 自有 job 同样零等待（F12 根因）。scout 证实上游同样无保护（task.test.ts:897 明确断言不等待）——fork 自研分歧面，F 线同步注意冲突
- 用户拍板：owner 迁移+双写兜底（AGENTS.md:47 契约）/ park 无超时但定时提示 main / run 聚合结果事件流自然流出 / 复用 background_subagents kill-switch / 三阶段串行 builder（deepseek-v4-flash-0731 high）+root 逐阶段复验
- ①引擎：typed ownerSessionId + delivery(pending|delivered) 状态机 + markDelivered/waitOwnerQuiescent + engine 单写者投影；4 消费点迁 typed（prompt backgroundTasks/task-cancel/run-state BFS/session.remove）②dispatch：runPreparedCore park-until-quiescent + 重读最新 assistant 消息 + onParkProgress→ctx.metadata(30s) + BACKGROUND_DESCRIPTION 补句 + 同步路径 pre-materialize（等价）③run：GET /session/:id/background/quiescence 长轮询（clamp 1-120s）+ drainBackgroundJobs + SDK 重生成（backgroundQuiescence）+ loop() idle break 改 drainFinished 门控
- root 复验抓两 bug：waitOwnerQuiescent 热自旋（settled job await 已 resolve done → 改按状态选唯一未决信号 running→done/settled→deliveryDone）；run loop() break 永不触发（末尾 idle 恒先于 drainFinished → attach SSE socket 挂进程 → subscribe 传 AbortController signal + drain finally 1s unref 宽限定时器兜底强关）
- 验证：typecheck 绿（chimera+sdk/js）；终验 464 pass/0 fail（F4 家族+三阶段 22 文件）+ test/session 521 pass/0 fail（compaction flake 未现）；窗口用例（settle 但 delivery pending 仍阻塞）+drift-guard 已锁
- 待办：用户真机复跑原场景（root→mid→leafA/B + run 模式，断言 mid-out/root-out）；contract phase（拆投影）等下个 F 线同步批次后确认（session.ts 已迁，fork 读者已清零）；未 commit 待用户发令

### 工具爆发 bench（2026-09-14，harness 已入库未 commit）

- 落点：`packages/chimera/script/bench/`（burst.ts 主入口 + env/sse/plugin/metrics）；跑法 `cd packages/chimera && bun run script/bench/burst.ts --scenario s1,s2,s3,s4 --sizes 1,5,10,25,50 --repeat 3 --out <json>`
- 机制：TestLLMServer raw chunks 一次响应发 N 个并行 tool_calls（distinct index）→ 真实 streamText 无界并发执行；采样=.chimera/plugin 采样插件（tool.execute.before/after → globalThis）+ part 持久化 time.start/end 事后重建
- 结论：50 调用爆发零错误零超时，无崩溃悬崖；但单 fiber + 每调用 ~7 次同步 SQLite tx 导致 exec 膨胀 ~6x（glob p50 69ms→428ms@n=50），吞吐 ~30-50 calls/s（只读）/161/s（write）；round 间 gap p50 ~20ms 健康
- 优化候选（按 ROI）：①part 状态写批量化/去重 ②processor.ts:476 doom-loop 检查每 tool-call 全量 SELECT parts 的 O(N²) ③注意 bench 用 :memory: sqlite，生产 file-backed WAL 写放大更重
- 局限：s4 write 爆发在未初始化 graph 的 tmpdir 跳过了审计/图同步开销；插件 event 钩子只见到少量事件类型（下限计数）

### relay 非标错误包恢复（TypeValidationError 信封）（2026-09-14，已 commit e5f6a287d，未 push）

- 症状：子代理派发偶发失败，报 "Type validation failed … invalid_union (choices|error)"，真实后端 message（如 "Backend buffer overflow."）丢失且不重试。
- 根因：内部中转 provider 流式返回非 OpenAI 形状错误包 {code,message,request_id} → @ai-sdk/openai-compatible chunk union 校验失败抛 TypeValidationError → MessageV2.fromError 归 Unknown、SessionRetry 不重试。
- 修复：provider/error.ts 新增 parseValidationError（还原 message/code/requestId/responseBody，retryLimit=3）+ safeStringify；message-v2.ts fromError 新增 TypeValidationError 分支（信封→可重试 APIError；非信封→Unknown 行为不变）。
- 验证：bun test message-v2+retry 78 pass/0 fail（父级独立复跑）；bun typecheck 干净。
- 文件：packages/chimera/src/provider/error.ts、src/session/message-v2.ts、test/session/message-v2.test.ts、test/session/retry.test.ts；predesign_e6de1b931263ed92；audit_1cbc14d080b66a7b。
- 待办：relay 侧错误包归一化由用户另会话处理；提交前内网审计（ali-internal-audit）已通过。
