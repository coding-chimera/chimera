# 上游 opencode 特性同步分诊明细（F 线附件）

制定：2026-09-04。方法：6 个并行只读分诊代理（3 reviewer + 3 scout）+ root 汇总对账。
范围：上游 `/Volumes/workspace/opencode`（只读，HEAD=`9f69463f1d`，2026-08-31）`v1.14.40..HEAD`，共 3299 commits（fork 点口径 3273）；**388 feat 全量五分类** + **安全/权限关键词 fix 全量 43 条** + **fix(tui) 91 条主题级归纳**。其余 ~910 fix 的处置方法见 §7。
版本分桶（feat）：v1.15=32 / v1.16=87 / v1.17=31 / v1.18=169 / v1.18.0..HEAD=69。

五分类口径：
- **①直接可移植**：fork 缺此能力，上游实现可基本原样搬
- **②需适配**：值得搬但要改造（路径映射/依赖缺失/与 fork 自有实现合并）
- **③fork 已等价或更优**：给 fork 证据路径
- **④无关**：表面在 fork 不存在、已刻意分叉、或既有拍板排除
- **⑤已同步**：已被 L0~L3 整包/整文件 vendor 吸收，或已 cherry-pick

注意：§2 的 43 条是按安全关键词横切的集合，与 §3~§6 的 scope 分组**有交集**（如 yolo、location-permission 同时出现在两边）；同一提交两边结论已核对一致，"fork 需修"结论以 §2 为准。

## 1. 总览与对账

| 组 | scope 覆盖 | 总数 | ① | ② | ③ | ④ | ⑤ |
|---|---|---|---|---|---|---|---|
| R1 v2 底座侧 | core44 llm8 server4 codemode3 http-recorder2 session-ui/native-llm/effect-drizzle/compaction/client/httpapi 各1 | 67 | 2 | 20 | 7 | 32 | 6 |
| R2 v1 运行时侧 | opencode17 mcp7 sdk4 plugin4 data4 skill2 scout2 cli2 worktree/websearch/provider/project/openai/oauth/api/feat异常 各1 无scope15 | 65 | 10 | 29 | 4 | 17 | 5 |
| S1 UI 表面 | app120 ui3 i18n2 | 125 | 0 | 0 | 0 | 125 | 0 |
| S2 desktop+tui | desktop39 tui27 | 66 | 0 | 17 | 0 | 49 | 0 |
| S3 无关表面 | stats36 go9 console6 acp6 acp-next6 web1 nix1 | 65 | 0 | 0 | 0 | 65 | 0 |
| **合计** | | **388** | **12** | **66** | **11** | **288** | **11** |

对账：各组分类之和 = 枚举总数 ✓（R2 含 1 条异常 scope `feat(feat)`，任务单口径差已在组内说明）。

## 2. 安全/权限横切审计（43 条全覆盖）——F0 批次来源

**结论：无 P0。** 子代理权限、Plan Mode 绕过、denied-stop、home 路径展开、worktree 相对路径、TUI directory 路由六大安全面 fork 均已有等价或更严防护。但 **5 条 fork 需修**：

| 优先级 | commit | 标题 | fork 落点与现状 | 规模 |
|---|---|---|---|---|
| **P1** | `08faeb3893` | answer subagent permissions in run (#43675) | `src/cli/cmd/run.ts:572` 仍为修前形态：run 模式下子代理会话的 permission.asked 被 `sessionID !== sessionID` 过滤丢弃 → 子代理永久挂起 → 整个 run 卡死（`--dangerously-skip-permissions` 下同样挂）。fork 重子代理工作流（task/swarm）直接命中，headless/CI 场景高危。fork `CreatedEventSchema` 含 `info.parentID`，与上游补丁兼容 | ~10 行 |
| P2 | `a9c810cbbc` | double file content injection $ARGUMENTS (#31245) | `src/session/prompt.ts:2355-2368` 与修前同形：`/cmd @file` + `$ARGUMENTS` 时文件内容双重注入（token 翻倍、重复指令干扰）。fork TUI 确实随命令传 parts（`tui/component/prompt/index.tsx:976-984`） | 小补丁 + `fileURLToPath` import |
| P2 | `c035c35eba` | tolerate invalid OPENCODE_PERMISSION JSON (#28388) | `src/config/config.ts:818-819` 裸 `JSON.parse` 无守卫 → env 坏 JSON 直接启动崩溃 | try/catch+warn 3 行 |
| P2 | `dc978cb889` | validate permission and question ids (#26456) | `src/permission/schema.ts` PermissionID/QuestionID 仍是裸 `Schema.String`；畸形 id 静默 no-op（输入硬化） | 两处 one-liner |
| P2 | `3a4c253969` | guard textVerbosity injection (#43915) | `src/provider/transform.ts:1172-1181` 按 `gpt-5.` id 匹配注入 textVerbosity；fork 中继生态（free_models 及内部中转 provider 等）挂 gpt-5.x 系 id 即注入不支持参数 → 请求失败。fork 已有 `model.api.npm` 字段可直搬门控 | 小补丁 |

其余 38 条：
- **②特性 1**：`0a5bed2bc2` yolo permission mode (#33279)——TUI 交互式自动放行；fork run 已有 `--dangerously-skip-permissions`，TUI 侧需按 fork permission context 重实现（上游补丁目标是 fork 没有的 packages/tui）。优先级产品定（建议 P-low）。
- **③fork 已等价/更优 10**：`fd9ee435ec` home-relative 展开（fork `permission/index.ts:283-303` 已覆盖）、`709af58612` declined-stop（fork `processor.ts:311-313,832,889` 即上游目标态+配置开关）、`3ad6923c61`+`c4e676b8a0`+`b8ca71d309` 子代理权限族（fork `subagent-permissions.ts:12` 全量 deny 继承，**比上游更严**，Plan Mode 绕过被封死）、`0050134d9e` per-call 规则合并（fork slot 级过滤更细）、`ba9e4b67ed` worktree 相对路径（fork `read.ts:629` 等四处已在）、`3cf1cef7fe` TUI 权限回复 directory 路由（fork 已完整吸收）、`797359fbf0` gcp-metadata 泄漏（fork 锁 8.1.3 已原生修复，实测 tarball 验证）、`53849bd866` sync bus（fork 不同实现同等保证）。
- **⑤已同步 1**：`1a28924ed8` grep external directory（L0.1 已移植，fork `grep.ts:7` 验证在位）。
- **④无需操作 26**：纯 test/docs 7、上游专属服务（zen×2/stats/http-recorder/desktop 通知等）7、ACP 4（既有拍板）、app legacy 2、v2 表面 3（`9b815bcbd2` location-permission、`4814ab3a3d` v2 tool 强制、`7f40aeab21` server 端点——归 L4/L5）、chore/refactor/成对回滚净零 3。
- **newweb 侧复核项（非上游移植范围）**：`e7e7a97648`（app per-server permission state）提示的问题在 newweb 有同构架构（serverStore servers[] + perServerStorage），切服务器时 pending 权限/自动批准是否串台**未逐路径审计**，建议在 newweb 单独立项复核。

## 3. R1 明细：v2 底座侧 feat（67 条）

### ①直接可移植（2）
| commit | 标题 | 依据 |
|---|---|---|
| `ffea6c7974` | HTTP API 响应压缩 (#26440) | 自包含中间件（gzip/deflate+1KB 阈值+SSE 跳过）；fork httpapi 同构（`src/server/routes/instance/httpapi/server.ts:161`）、Effect beta.83 已就位、无 compress；适配仅路径映射+provide 插入 |
| `9b7b6cb30f` | worktree 命名去重 (#26368) | fork `worktree/index.ts:473` 与上游修前同构；~6 行+测试原样搬 |

### ②需适配（20）
| commit | 标题 | 适配点/去向 |
|---|---|---|
| `ae92f3158f` | **Copilot token-based billing (#30181)** | **高优——现网风险**：上游 Copilot API 已切 token 计费，fork `models.ts` 仍旧 schema（limits 必填、无 billing/token_prices）→ 解析/计费失配。plugin 两文件近原样搬；`copilot_usage.total_nano_aiu` 提取折入 fork `src/session/llm.ts` |
| `2d0d3d596e` | compaction tail 序列化 (#26830) | fork compaction 与上游修前逐字同源；需同步 fork 特有 `tail_start_id` 持久化与 remote-compaction 体系 |
| `ddc30cd151` | session metadata (#23068) | v1 落点全部同源；迁移需手写重编号（drizzle-kit generate 不可用）+ SDK 重生成 |
| `f428755851` | MCP timeout 拆分 (#33977) | fork 单旋钮（`src/mcp/index.ts:320`）；config schema 拆分保持 number 向后兼容 |
| `c818c9dcb6` | external workspace creation (#26212) | 兄弟提交 #26190 fork 已 pick（`92c779e5a4`）；迁移重编号+TUI 差异+SDK 重生成 |
| `2859ce6e73` | Snowflake Cortex provider (#29901) | 决策#2 可搬；按 fork v1 plugin provider 形态重写（azure/cloudflare 先例） |
| `77e6c0d329` `942630eb4a` `d5980b47e9` `5f61d21487` `48fc9e3cc3` `1fd8bf526d` `08c5a2a5e8` `18466b8020` | llm 包 8 条（cache hint/policy、Gemini 媒体、Codex strict、reducer、model defaults、precedence、tool schema projections） | **随 L4 整包 vendor 自然吸收，勿单独 cherry-pick**。⚠️ `5f61d21487` strict 透传与 fork `codex-responses.ts:1150` 显式 `strict:false` 方向相反，L4 时拍板；`1fd8bf526d` 与 L4 配置化三层合并交叉，以配置化为准 |
| `6618e2bce2` | native-llm：Anthropic API-key 走 native runtime (#28271) | 随 L4 整包吸收 |
| `dac0dd5309` | connector authentication (#31837) | 随 L4 provider/integration 迁移（依赖 v2 credential 服务树） |
| `cf80b5c470` `c556bddda3` | opencode integration (#33555/#33560) | 随 L4；plugin/src/v2 落点已 vendor 在位；**opencode 品牌 integration 是否保留待拍板** |
| `4898263dec` | provider↔integration 映射 (#33562) | 随 L4 |
| `42bb793574` | generate model variants | **L4 配置化指定落点**（计划书已点名）：上游硬编码 glm-5.2，fork 届时改造为数据驱动，不照抄 |

### ③fork 已等价（7）
`40d5ea1cf1` scout agent（fork explore 子代理+Chimera graph 工具族+scout archetype 更优）、`a57fb32d95` 会话中换模型（fork TUI dialog-model 已有）、`a9094fd059` tool 输出限界（fork `shell.ts:579` 截断+落盘、`read.ts:16` 上限）、`d2204e0ff5` 默认会话模型（fork `config.ts:193`）、`12e38866ed` 中断执行（fork abort 链路齐全）、`9bb5370205` v2 snapshot/revert（L3 侦察#4 拍板不重建，fork `src/snapshot/`+`revert.ts` 完整）、`35b3fc85d0` session switching（fork TUI dialog-agent 已有）。

### ⑤已同步（6）
codemode 3 条（`2409c7a3d5`/`a8983bd2c7`/`d5aa79c73a`，L0.3 整包）、`5381795844` effect-drizzle-sqlite（L2.2 整包）、`1af8dafd3e` context epochs（即 L3.1/L3.2 吸收对象）、`3c4b4d5faf` warp copy changes（fork 已 cherry-pick `92c779e5a4`）。

### ④无关（32，组级归纳）
全部属"不搬的 v2 服务树"口径：location 栈（filesystem/permission/config）、v2 public API、v2 project-copy（`147c6c4d51`/`c2e6b18076`/`ba1b660d57`）、command registry+packages/cli、skill registry、repository-cache（配套上游 repo 研究产品面）、v2 tool 树、v2 runner/runtime 基建（`76ee87ead8` 278 文件等）、reference/guidance（L3.1 已拍板不搬）、fff 开关（fork 搜索面=ripgrep+graph）、http-recorder×2、session-ui、client/codegen、v2 public error schemas（单搬即死代码）。
**升级条款**：`76ee87ead8`/`93159bccbf`/`beae7290f3` 等 v2 runner 族若 L5 实际引入 v2 session runtime 整包 → 升②随整包吸收（L5 开工前复核）；`8feb4a31c7` background job service 若 fork 要"后台异步子代理"产品面 → 升②（与 R2 `22de34c4de` 同一决策）；http-recorder 若 L4 保留 llm 包 recorded 测试 → 作为测试依赖重评。

## 4. R2 明细：v1 运行时侧 feat（65 条）

### ①直接可移植（10）
| commit | 标题 | 依据 |
|---|---|---|
| `f965db9e13` | **headerTimeout 配置 (#29484)** | 四落点文件全在且无 headerTimeout；**fork 生态以中继+长推理为主，首包超时可配防长挂起，最高性价比**；SDK 部分走 fork 再生成管道 |
| `341c64cc97` | Modal 模型动态发现 (#39066) | 自包含新 provider 插件（4 文件 +350 行），依赖 fork 全有 |
| `b32debb8a3` | xAI Grok OAuth device-code (#28557) | HEAD 版 xai.ts 自包含；注意取 HEAD 态（含 e8fea9e63a 后续统一） |
| `519d344470` | plugin dispose hook (#29493) | 两落点在且无 dispose，15 行 |
| `f55a931f59` | MCP client roots (#32230) | fork index.ts 与基线同形，自包含小 diff（归 F2 MCP 专项） |
| `07b983e82f` | MCP server log notifications (#31752) | 同上 +29 行（归 F2） |
| `ba57718b05` | 非交互 mcp add (#31054) | fork cli/cmd/mcp.ts 补 flag 跳过 confirm |
| `3f0ef9b71c` | auth logout 模糊搜索 (#31053) | fork providers.ts:498 小改 |
| `487575773d` | 无配置时创建全局 jsonc (#26992) | fork config.ts loadGlobal 同形，插 seeding 块；品牌改 chimera.jsonc |
| `0bb677cef9` | Cohere North 模型配置 (#31536) | fork transform.ts:980 已有 cohere case，补 North 段；价值小众 |

### ②需适配（29，按主题聚合）
- **MCP 专项（6，建议一次做完→F2）**：`921b1c6a34` SDK v2 升级（大：fork 钉 1.27.1，上游 1.29.0+patch+v2 client API；拆步：依赖升级+OAuth/session-recovery 先行，code-mode 后置）、`e8e83afbce` server instructions 注入上下文（中高价值，接线清晰）、`c6cc13e183` resource templates、`3f3f120825` resource 读工具+权限门控、`a131811cdc` `mcp__server__tool` 命名约定（**契约变更**：波及 permission 通配/prompt 引用/TUI 显示，须同批全量改）、`7e7ad37736` 本地 MCP server cwd。
- **provider/auth 族（6）**：`790fb5b86f` Azure CLI auth（依赖面已齐，本质整文件替换）、`e8fea9e63a` 统一 OAuth 回调页（`core/src/oauth/page.ts` 单文件带入，是 DO/xai/snowflake 的前置）、`159964b172` DigitalOcean OAuth、`3f174531b9` Snowflake OAuth（低优）、`d34a0194ec` NVIDIA origin header（13 行；**头值 OpenCode vs Chimera 需拍板**）、`9f42bd4a85` bedrock mantle 加载侧补齐（fork transform 已认 mantle 但 provider 注册缺失=认得出跑不了，小工作量闭环）。
- **高价值运行时（4）**：`85ce6a5f95` 图片自动缩放+尺寸约束（**fork 现状大图直通上下文，free/中继模型爆仓风险**；新依赖 photon-node+patch+接线已分叉处）、`c2b1ebd9dc` 定价 tiers（**fork subagent_model_schedule 以 $/task 消费定价，直接受益**；与 fork models.ts 自有扩展合并）、`7d3d80f840` fff 搜索后端（grep/glob/read 提速；**必须保留 fork external-directory 守卫与 symlink 安全修复**）、`62da1e7682` OpenAI Responses WebSocket 传输（Codex OAuth 流式延迟/稳定性；适配面中偏大）。
- **v2 铺垫（3）**：`03afae5b95` v1 加载 v2 config（**L4/L5 启动时第一批做**，避免用户 v2 配置在 chimera 下丢失；schema 依赖已 vendor）、`5937e606df` fs/location v2 路由（并入 L4/L5）、`a9ef5a0fae` remote-backed project identity（中低优）。
- **产品决策项（6）**：`ed6dc879be`+`abaab29cb3` codemode v1 接线（包已 vendor 但运行时零引用，**vendor 意图需澄清**）、`22de34c4de` 后台子代理（fork 真实缺失"父不阻塞的后台执行"；**修正：task_status 轮询已被上游上线 11 天后删除（dabf2dc013），HEAD 终态=注入驱动自动续跑**；完整链 12 提交与重设计提案见 §10）、`7f2b5ee8c2` run split-footer 交互架构（55 文件，要么整搬要么不搬）、`5cf9abe743`+`4bae84c8b0` scout/reference 物化仓库体系（与 fork 跨项目 graph 查询互补而非等价；"先物化再 graph init"是潜在组合技）。
- **低优（4）**：`df386bd651`+`10ea59066f` builtin skill 机制（机制可移植、内容须 chimera 品牌重写）、`b4665a8bf8` meta muse 提示词、`80c0b06980` X-Session-Id 头（对 fork 中继收益不确定）。

### ③fork 已等价（4）
`20a3a2138e` kimi effort 自适应（fork `transform.ts:475-489` 等更强矩阵，kimi-k3 是 fork 根模型）、`22cc758b1a` GLM-5.2 variants（fork `transform.ts:616-657` 数据驱动覆盖 high/max，非上游硬编码）、`a43d3e0e1e` websearch 灰度（fork 自研多后端选择器 `tool/websearch.ts:11-26` 更贴合生态，Exa 路线已弃用）、`ab701d20eb` vLLM interleaved（fork `provider.ts:991-997` 对象式更丰富）。

### ⑤已同步（5）
`cba6b5f2f7` Cloudflare AI Gateway（**L0 已摘取**，fork cloudflare.ts 与上游逐段一致）、`07e5ea9367` typed layer graph（core/src/effect 6 文件已 vendor；其 op 侧 50 文件 Effect 化为④性质，fork 走自有实例层）、`909a1a6d78`+`c780d7cee7` plugin v2 host（16 文件已 vendor）、`cb93114424` codemode 创建（整包已 vendor；v1 接线另见②决策项）。

### ④无关（17，组级归纳）
sdk/client v2 表面 5 条（`42e6b7db32`/`ef5c9f4931`/`f44423609b`/`cdd67cf30f`/`65210f2d97`——**L4/L5 启动 vendor client/server/codegen 时升②复评**）、stats/data 4、packages/cli 2、worktree Rust 托管克隆 1、`5c860d4142` feat(feat) 异常条（落点 app/ui/session-ui）1、desktop WSL 1、referral/datalake 2、ACP 现代化 1。

## 5. S2 明细：desktop（39）+ TUI（27 feat / 91 fix）

### TUI 同源判定（先于分类）
fork TUI（`packages/chimera/src/cli/cmd/tui`）与上游（原 `packages/opencode/src/cli/cmd/tui`，现独立 `packages/tui`）**同源但已结构性分叉**：目录骨架一致（app.tsx/component/context/routes/session/ui/util/config/feature-plugins）；fork 有 `@tui/*` 别名、专有模块（win32/variant ultra 切换/sound/worker/thread/remote-compaction/memory-settings/sync-v2/keybind context）；上游有 fork 缺失的 diff-viewer 系列、command-palette、dialog-debug/move-session/workspace-list、context/thinking、parsers-config 等。
→ 分类规则：落 fork 已有表面=②（路径映射 `packages/tui/src/X` ↔ `packages/chimera/src/cli/cmd/tui/X`）；落缺失表面=④。无①（结构分叉不允许直搬）。

### feat(tui) ②17 条（F3 批次候选）
`8bf5062b89` cursor style 配置、`888c4cb504` up arrow 退出子代理菜单（映射推断，落地时定位 fork footer）、`34e5809059` idle 会话目录显示、`39c6dd1c32` code-mode execute 子调用渲染、`0a5bed2bc2` yolo 模式（同 §2②）、`b8cfd69acf` crash screen 重设计（最接近直迁）、`ffcb45d7c9` 会话列表显示 project copy（触 sdk 生成类型）、`f591bf5f93` move dialog 删工作副本（依赖 server project-copy+sdk）、`3003867c25` backgrounding 同步子代理（跨 core/background-job+task+server，**依赖后台子代理决策**）、`6d4f3b4ab2`+`8f8b161cae` 会话切换器插件族、`28a06e52fc` workspace 管理对话框、`0de5f1ff36` prompt 尺寸可配（②中较简单）、`51da3483a9` palette 复制 worktree 路径、`f060874b29` thinking 点击展开、`f33b4455a1`+`12583b18f0` pinned 会话切换族（建议合并移植，fork 已有部分关联功能需比对去重）。
其中 `ffcb45d7c9`/`f591bf5f93`/`3003867c25` 三条依赖 fork 不存在的后端能力（project-copy server/background-job），**若后端不引入则降④**。

### feat(tui) ④10 条
diff-viewer 族 7（`17d66ee4fe`/`ee008923f3`/`05f335ce62`/`7a4d18390a`/`6eec98371a`/`d0779d2aca`/`58143c4b07`——fork 无此子系统，是否引入=产品决策）、`b039702e8c` 高亮新增 7 语言（parsers-config fork 无；纯资源追加，需要可复议①）、`3adfb970bf` debug 信息对话框（新增能力可复议②）、`01a5c69244` ServerAuth 外部 served TUI（fork TUI 内嵌运行无此表面）。

### feat(desktop) 39 条全④
落点全部为上游 `packages/app` UI 层或 `packages/desktop` Electron 壳；fork desktop 为 legacy 低活跃。**可复议子集（7 条壳级通用基建，若重启 desktop 维护升②）**：`54a78c9224` server 迁 utilityProcess、`b8799be3c8` silent install/user-wide scope、`4aaece29d9` Linux AppStream MetaInfo、`73cdba959b` 菜单栏自动隐藏、`bea3ca5b05` 日志导出、`2caac055ef` pinch zoom、`9b4d5b0395` 更新器持久化。

### fix(tui) 91 条主题级归纳（F3 随批消化）
| 主题 | 条数 | fork 处置 |
|---|---|---|
| A diff-viewer 系列 | 7 | 随 feat ④ 忽略 |
| B thinking/推理标签+spinner | 6 | fork session-v2/thinking 渲染存在，需适配 |
| C 子代理/工具行渲染·重试·缩进 | 10 | **重点移植族**（fork 子代理密度高） |
| D 自动补全/@mention/斜杠 | 5 | fork 补全表面存在 |
| E keybind/可绑定命令 | 4 | fork 键位在 context/keybind.tsx（上游 config/keybind.ts）需映射 |
| F 内联错误渲染/启动配置错误 | 5 | fork 表面存在 |
| G 事件流/同步/消息顺序 | 8 | 适配要点=fork 事件/sync 差异 |
| H 会话列表/切换器/hydration | 5 | fork 表面存在 |
| I 提示输入/历史/草稿/并发提交 | 5 | 含宽字符粘贴防损坏等实用项 |
| J 问题/确认对话框 | 3 | fork question.tsx 存在 |
| K move/working-copy/目录路由 | 6 | 部分依赖 workspace/copy 后端（同②三条的降级条款） |
| L 编辑器打开/cwd | 4 | fork context/editor 存在 |
| M provider/模型/connect 排序 | 5 | fork 表面存在 |
| N 剪贴板/粘贴/ssh | 2 | fork clipboard 已重写，需适配 |
| O worker/线程/id 健壮性 | 4 | fork 独立 worker.ts/thread.ts，映射重做 |
| R 杂项 | 8 | 单点适配 |
| 安全邻接（单列） | 4 | `a9c810cbbc`（→F0）、`3cf1cef7fe`（fork 已吸收）、`f4851e3bd9` question 按目录路由（**建议随 F0 核查**）、`251177d56c` worker 环境转发 |

## 6. S1/S3 批量排除记录（④190 条）

- **S1 app120+ui3+i18n2=125 全④**：全量落点审计（--name-only）确认无一条触及 server/core/schema/protocol/newweb/chimera；命中文件全在 packages/app（legacy）、session-ui（fork 无）、ui/src/v2（fork ui 无 v2 目录，血统不同源）。疑似例外 10 条（涉 SDK/路由/权限标题）逐条 show 核实后维持④。
- **S3 stats36+go9+console6+web1+nix1=53 全④**：每 scope 抽样落点证据（stats→独立统计站；go→console i18n+routes/go；web 实落 console 页头；nix→flake/nix legacy）；均无 packages/{opencode,core,schema,protocol} 耦合。例外核实 `b32f071502` go referral（含 console DB 迁移）仍在 console 内。
- **S3 acp6+acp-next6=12 全④-既有拍板**（计划书决策#4：ACP 默认不恢复；fork 无 src/acp）。

## 7. fix backlog 方法学（1044 fix 总口径）

- 已覆盖：安全关键词 43（§2 全量逐条）+ fix(tui) 91（§5 主题级）。
- 无关表面直接封板（~427）：app227 / stats84 / desktop33 / console27 / ui21 / acp19 / data16。
- **core 相关 backlog ≈374**（opencode111 + core77 + provider39 + mcp29 + session20 + server24 + llm18 + httpapi18 + cli10 + openai7 + plugin6 + tool5 + config5 + sdk5 等）处置原则：
  1. **随特性批次消化**：MCP fix 随 F2、provider/openai fix 随 F1 provider 族与 L4、llm/core fix 随 L4 整包、tui fix 随 F3、session/compaction fix 随对应 F1 项。
  2. **L4 开工前跑一次独立关键词筛**（crash/hang/loss/leak/corrupt/race 类），防止漏掉 P1 级——F0 的 P1（#43675）证明关键词筛有效。
  3. 其余不单独展开：v2 树内 fix 对 fork 无表面，随 L4-L6 绞杀自然失效。

## 8. 产品决策待定清单（阻塞对应批次，需拍板）

| # | 决策 | 影响范围 |
|---|---|---|
| 1 | desktop 是否重启维护 | S2 壳级基建 7 条 ④→② |
| 2 | TUI diff-viewer 子系统是否引入 | feat 8 条 + fix 主题 A 7 条 |
| 3 | run split-footer 交互架构（55 文件）是否整搬 | `7f2b5ee8c2` |
| 4 | scout/reference 物化仓库体系 vs fork 跨项目 graph（可组合：先物化再 graph init） | `5cf9abe743`+`4bae84c8b0` |
| 5 | 后台异步子代理是否按 fork 调度架构重设计引入（task_status 轮询已被上游删除，终态=注入驱动自动续跑） | `22de34c4de`+`8feb4a31c7`+`3003867c25` 及全链 12 提交；**决策简报已完成：九个拍板点见 §10，F4 提案草案在计划书**；关联 memory.md 挂起的 edit-intent claims L2（仅依赖 F4-P1） |
| 6 | codemode v1 接线是否启用（vendor 意图澄清） | `ed6dc879be`+`abaab29cb3` |
| 7 | opencode 品牌 integration/zen provider 是否保留 | `cf80b5c470`/`c556bddda3`（L4 内） |
| 8 | NVIDIA X-BILLING-INVOKE-ORIGIN 值：OpenCode vs Chimera | `d34a0194ec` |
| 9 | Codex strict 策略：fork `strict:false` vs 上游 strict 透传 | `5f61d21487`（L4 内） |
| 10 | TUI yolo permission mode 是否要 | `0a5bed2bc2` |
| 11 | newweb 多服务器权限状态串台复核（独立立项，非上游移植） | §2 newweb 复核项 |

## 9. 来源

6 个分诊代理完整报告（本机 tool-output，会话级存储，重要结论已全部收入本文档）：R1=`tool_07a179568001lL1QjCM0LBtHzY`、R2=`tool_07a1ddea3003SoFVocofThg53K`、R3=`tool_07a0f0d95001Nrbi7BL2Sgl6v9`、S1=`tool_07a20d791001KCrrM4iMg05eC4`、S2=`tool_07a236280003nRakTVUZv7pVCt`、S3=`tool_07a1ff5aa0015m8p6EEDs8Asrv`。
首次调度尝试中 scout 组因 `opencode/muse-spark-1.2-contributor-free` 区域不可用失败，重派 `deepseek-v4-flash-0731`(low) 成功；reviewer 组 `qwen3.8-max`(medium) 一次成功。

## 10. 决策简报：后台异步子代理（决策项 #5 展开，2026-09-04）

来源：reviewer 决策简报（qwen3.8-max medium，含 2 个深读子代理，全部承重锚点经逐条 read/grep 复核；全文在本会话 tool-output，task_id `ses_f8597876bffe4nWvyOGOp2V9Ot`）。

**一句话建议：做，但按上游 HEAD 终态做，不按分诊时的 5 月中间态做**——P1 最小闭环（~3-5 人日，config flag 默认关，拍板后与 F2 并行）→ P2（swarm/预算/dispose，并入 L5 或排 L5 后）→ P3（TUI/WebUI 表面 + claims L2，与 F3 合并）。

### 10.1 对分诊的关键修正

- **task_status 轮询工具已被上游整体删除**（`dabf2dc013`，2026-05-25，上线仅 11 天，-431 行）：终态协议 = `task(background=true)` 立即返回 + Deferred 驱动**合成消息注入自动续跑父循环**（不带 noReply，prompt 自带 loop），配套 "DO NOT sleep, poll" 反轮询指导。本文档 §4/§8 原"+task_status 轮询"表述已修正，不应作为引入目标。
- **完整能力链 = 12 核心提交 + 3 TUI 边缘 fix**（非分诊锁定的 3 条）：`8feb4a31c7`（job 引擎）→ `22de34c4de`（能力成型）→ `68af95390d`（prompt 收敛）→ **`dabf2dc013`（协议重构：去轮询）** → `70cd4bf0ce`（extend 串行续跑）→ `ee74dd83f5`/`730ea6d2e3`（variant 保留/创建即归因）→ `76ee87ead8`（引擎下沉 core/background-job.ts 284 行完整版）→ `70bb710715`/`cc9b73b0bd`/`b9131aa69c`（prompt 定型）→ `3003867c25`（ctrl+b promotion）；边缘 `6072a68d6b`/`0543fd29c8`/`2892e97c57`（标记保留/spinner/capabilities 门控）。
- **上游 flag 未毕业**：`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` 至 HEAD 仍默认关——上游自己也认为未稳，fork 应同样默认关灰度。

### 10.2 上游 HEAD 终态要点（已逐行核验）

- 引擎（core/background-job.ts）：八方法 list/get/start/extend/wait/waitForPromotion/promote/cancel；**有意不持久化**（L113-119 官方注释：进程重启即丢、中断在飞工作）；无 Bus 事件、无 TTL；job id = 子会话 SessionID（三合一，metadata 携 parentSessionId/model/background）。
- 完成通知：notify fork `background.wait`（done Deferred）→ 向父会话注入 synthetic user part（不带 noReply）→ 父循环自动续跑（HEAD task.ts L227-265）；输出协议 XML `<task id state>` + `<summary>` + `<task_result>/<task_error>`。
- promotion（`3003867c25`）：**不中断不重启纤维**，只置 metadata.background=true + succeed promoted Deferred 唤醒 raceFirst 竞速者（core L302-333）；TUI ctrl+b（keybind `session_background`）+ `POST /experimental/session/:id/background` + capabilities 门控（`{backgroundSubagents: flag}`）。
- 级联取消：run cancel 先 BFS 传递闭包取消后台子孙（按 job.id/metadata.sessionId/parentSessionId 匹配）；session.remove 单层清理；job 纤维与子会话 prompt run 中断双向绑定（onInterrupt）。
- 门控手法：flag 关时 jsonSchema 换窄（不含 background 参数）+ description 拼接（task.ts L362-366）——"关时字节不变"值得照抄。
- 另：上游 task 自带 `subagent_depth ?? 1` 守卫与 fork `max_depth ?? 3` 是两套体系，fork 无需跟进。

### 10.3 fork 侧集成面（关键事实，均带锚点）

- **机制层已具备后台化前提**：fork 子代理 work fiber 本就 fork 在 instance scope、等待方只 `Deferred.await`（runner.ts:80-136，ensureRunning 去重支持重新 attach）；现状子会话被杀全靠策略层显式 cancel（dispatch onAbort/release-on-interrupt/swarm cancelChildren）。
- **合成消息原语全数现成**：synthetic 标记（message-v2.ts:125,563）+ prompt→createUserMessage→loop（prompt.ts:1884-1908）；另有生产未用的 noReply 原语（prompt.ts:1906）。
- **task_model 授权/路由/遥测全部前置在 prepare**（subagent-dispatch.ts:206-208）——后台化=派发点立即 fork，授权面零改动；前提是不做"排队延迟启动"（会破坏授权 freshness，P1 明确不做）。
- **预算冲突**：delegation-limiter 借用机制前提="父阻塞等待子"（L38-40）；后台子从池取 permit 并终生持有至完成——长后台任务蚕食 max_concurrent(128)；"借出方先消失"路径已能自愈（L61-63）。拍板点：是否加 `delegation.background_concurrent` 独立上限（config/delegation.ts:77-92 自然落点）。
- **swarm 结构性障碍**：父阻塞=`Effect.forEach {concurrency}`（swarm.ts:644-719）；且 prompt.ts:684 的 metadata 通道有 running/pending 门——工具 part 终态后 childRuns 更新失效，后台 swarm 状态流必须换通道（三选一：每子合成消息注入 / 新 Bus 事件+SDK 重生成 / runtime-context job 列表，各 ~1 人日级差异）。
- **closeout 责任**：子在终态前完成本会话自收尾（现状已如此）；父在注入触发的续跑轮做 audit/oracle/obligation 汇总——注入机制天然制造该轮；系统提示词 closeout 章节需同步。
- **resume 语义合并**：fork resume 隐含"子已完成"；后台化后 resume 撞 running 任务需 extend 串行追加语义 + already-running 守卫；fork 输出文案 `(for resuming…)` 与 job id=子会话 id 三合一设计直接兼容。
- **claims L2 依赖仅落在 P1**：挂起设计的 L1 释放通知走 prompt-context.ts 注入，但那是纯 pull（hash-diff 只在新一轮生效，parked 代理没有下一轮）；P1 的 inject 原语正是缺失的 **push 通道**：释放钩子→注入合成消息→父循环自动重启。claims 自身 P1/P2（纯 fork 文件）可独立先行。
- **先例可复用**：memory_job 持久化后台任务全套（memory.sql.ts:67-89 表 + worker lease + Effect.repeat fork 进 instance scope）——将来要 durable job 模板现成；`experimental.system_context` 已验证"config flag 默认关、关时字节不变"模式。
- fork 无 effect/runtime-flags（env 驱动），不移植——用 config `experimental.background_subagents`。

### 10.4 分期提案

| 期 | 内容 | 工作量 | 时机 |
|---|---|---|---|
| **P1 最小闭环** | 新建 `src/agent/background-job.ts`（引擎子集 list/get/start/extend/wait/cancel + done Deferred + interrupt-only→cancelled + 同 id 去重 + 快照隔离；promote 留 P3）；task.ts 加 background 参数 + jsonSchema 换窄门控；config flag 默认关；级联取消挂 run-state.ts:88-96 + session.ts:711-734；task.txt + 系统提示词同改；可选 prompt-context "Background tasks" section。**无新表无新事件**（内存注册表+既有 message.* SSE；崩溃后从持久化子会话降级重建，上游 inspect 三级降级是先例）。验收：flag 关=全量 task/swarm 测试+typecheck 字节不变；flag 开 E2E（派发即返回→父继续→完成注入→自动续跑→abort 级联→resume-extend 串行）+ 注入轮撞 compaction 用例 | ~3-5 人日 | 拍板后与 F2 并行（F2 全 MCP 面文件，交集≈零；与 L4 亦零冲突） |
| **P2 swarm/预算/dispose** | 预算策略落地（background_concurrent 视拍板）；swarm 后台化（forEach→fork+句柄登记，状态通道按拍板点 3 选型，cancelChildren 改绑持久句柄）；closeout 协议成文；dispose 矩阵测试（instance dispose 全杀现状 run-state.ts:38-46 / 父会话 remove / 孤儿后台子） | ~2-4 人日（L5 前做则 4-6 且另计返工） | **并入 L5 或排 L5 后**（P2 是 dispatch-heavy，避免做两遍） |
| **P3 表面 + claims L2** | 引擎补 promote/waitForPromotion + task raceFirst；TUI ctrl+b（fork 键位在 context/keybind.tsx，上游 diff 作参照非 cherry-pick）；server experimental 端点 legacy+httpapi 双 parity + SDK 重生成 + newweb TaskRenderer `(background)` 标记 + capabilities 门控；claims L2 接线（前置=claims P1/P2 落地 + 漂移锚点重核 + 用户解冻）。**与 F3 去重：`3003867c25` 已在 F3 清单，P3 批准即在 F3 标记吸收，勿双重移植** | ~3-5 人日（claims 侧另计） | 与 F3 合并 |

L5 seam 条款：P1 把后台语义隔离在"引擎服务 + task 工具分支"两个 seam 内（工具分支调 `job.start(fork(runPrepared))` 而非内联）；若 L5 整包引入 v2 runtime，则换用上游 core/background-job.ts 引擎（`76ee87ead8` 随包免费到位）、协议不动，吸收成本 ~0.5-1 人日——两条路线兼容。"等 L5 白嫖"路径的代价：L5 排在 L4+F 批次之后数月，产品面与 claims L2 全程阻塞，且以"L5 真整包引入 v2 runtime"为前提（目前仅是升级条款未拍板）。

### 10.5 拍板点（九项）

| # | 决策 | 选项与建议 |
|---|---|---|
| 1 | 做不做 | **建议做**：真实缺口（父不阻塞的后台执行）+ claims L2 硬依赖 + fork 原语全数现成，性价比高 |
| 2 | 工具形态 | **建议 task 加 `background` 布尔参数**（上游 HEAD 形态，flag 关时 jsonSchema 换窄保字节稳定）vs 独立 task_background（需复制 12 个选择器参数） |
| 3 | 查询面 | **建议不复活 task_status**（上游 11 天即删）：完成感知=通知注入；可见性=prompt-context "Background tasks" section（fork 原生零新工具）；备选轻量只读查询工具 |
| 4 | 注入语义 | 自动续跑（不带 noReply，及时但多烧 token，上游 HEAD 形态）vs 仅落消息（noReply:true 省 token，父到下一自然轮才消化；fork 原语现成且生产未用）；可 config 项默认自动续跑 |
| 5 | 预算语义 | 后台子终生占 permit（默认零代码）；是否加 `background_concurrent` 独立上限；父 cancel 级联取消后台子孙（上游=是，**建议=是**） |
| 6 | P2 时机 | **建议并入 L5 或排 L5 后**（省 ~2 人日返工）vs L5 前做完 |
| 7 | 持久化 | **建议 P1 内存 + 崩溃降级重建**（与上游一致，官方注释明示有意取舍）vs 首日 durable（memory_job 模板现成，+~2 人日） |
| 8 | claims 联动 | 批准 P1 即备齐 L2 前置；是否同时解冻挂起的 claims 设计（挂起条件"用户完成上游同步"——F 线分诊已完成是否算数需用户确认）；claims P1/P2（纯 fork 文件）是否独立先行 |
| 9 | L5 换引擎条款 | 建议接受：seam 隔离 + 条件换引擎（~0.5-1 人日换两条路线兼容） |

### 10.6 残余风险

① 上游自身至 HEAD 仍锁实验 flag（默认关）——fork 同样默认关灰度；② 注入自动续跑 × fork 特有路径（remote-compaction、runtime-context hash-diff、ultra 多代理策略）上游未验证过——P1 测试需覆盖"注入轮撞 compaction"；③ swarm 后台化状态通道（拍板点 3/6 关联）是 P2 最大不确定项，三选项各 ~1 人日级差异。

### 10.7 分诊升级记录

- `8feb4a31c7`（原 R1 ④带升级条款）→ 随决策项 #5 批准升②，与 `22de34c4de`/`3003867c25` 及全链 12 提交统一进 F4 批次。
- `3003867c25`（原 S2 feat(tui) ②17 之一）→ F4-P3 吸收，F3 清单中标记去重。
