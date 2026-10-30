# A0 门记录：首批范围与最少决策

> 状态：**待用户确认**。本文件是 WP-01 归档的 A0（parent 门）记录，不构成 D1–D8 已拍板。
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §2 决策摘要、§6 W0、§8 首批工作包、§9 work manifest、§13 拍板事项、§15.4/§15.6、§16 首批顺序。
> 基线：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`（工作树含未提交修订，含本计划）。A0 只读，不写迁移源码、不创建产物路径。

## 0. A0 摘要

| 字段 | 值 |
|---|---|
| work_id | A0（parent 门，不是工作包） |
| scope | 首批范围与最少决策；不含实现 |
| owner | parent |
| role | parent |
| owned_files | 无；A0 记录由 WP-01 归档，文件归属 WP-01 |
| base_hash | `9600ee7f49ddcb065a33511f21f570d2b2d13a19` |
| contract_rev | `cr-2026-10-30-r1`（由 WP-01 锁定） |
| dependencies | 无（用户开工授权） |
| model / variant | 不适用（parent 会话） |
| oracle_commands | 无；A0 出口 = 用户确认 + WP-01 机检 |
| status | 待用户确认 |
| attempt | 1 |
| result_refs | 本文件 |
| approved_delta | 无 |

## 1. 范围（Scope）

### 1.1 本批覆盖

首批 = **契约 / oracle / fixture / harness + 隔离 provider 验证 + T1 门禁定义**，不是 W1–W6 实施波次。WP-02..WP-10 可在 WP-01 后并行起草，但共享 contract/CI 集成单写者。

| 包 | 覆盖内容 | 出口 / 边界 |
|---|---|---|
| WP-01 | 范围/base 指纹、共享契约约定、work manifest 与分区表 | manifest 含 `contract_rev/owner/owned_files/base_hash` 四字段且可机检；`owned_files` 两两交集为空；分区表覆盖 WP-02..WP-10 |
| WP-02 | W0 recorder/harness：tool result、DB、SSE、prompt 分段 | 同输入 TS 双臂零 diff；两臂隔离目录/DB；完整记录可重放；确定性层与因果层各有 ≥1 组 golden + 1 组负例 |
| WP-03 | W0 比较器、故障分类与统计门定义 | fault matrix 覆盖丢失/乱序/重复/中断/部分写/超时/取消/重放 8 类；比较器在故意注入下必须报错（meta-test）；给出同环境重复基线与噪声带 |
| WP-04 | live OpenAPI/inventory 冻结与 SDK 漂移验证 | 正式生成链可复验；116/54 覆盖差距逐项有 owner；96 候选按真实依赖重新分诊，产出 host-first/依赖 session 二分清单；**只分诊，不接路由** |
| WP-05 | 库/表权威、schema/migrator、ACK/回退/保留契约 | 每表一行含 owner/migrator/reader/writer/可重建性/恢复/保留/换权协议 8 列；已应用迁移不改；跨库投影恢复演练 ≥1 次 |
| WP-06 | graph 资产清点、core/NAPI 拆层设计与 parity fixture | extraction/store/resolution/query/traversal/pattern 六面各有 golden + 负例；52 个 NAPI 函数逐个映射或标注保留；**不实现生产 core** |
| WP-07 | runtime/router/boot-path-capability/launcher 与平台契约 | H1/H2 能力表逐项标 已实现/未接线/未实现；关闭/重启、IPC trust、Windows、两变体安装各 ≥1 条可执行验收向量；**不实现生产 runtime** |
| WP-08 | 首个 provider profile 的协议/请求/流/auth fixture 与 genai 准入规格 | profile 表至少列 Chat/API-key、Responses/API-key、Responses/OAuth、WS、native tool_search、compaction 六项；**只出规格，不实现生产 transport** |
| WP-09 | hook IPC/JS 兼容拓扑与调用轨迹 fixture | config/bootstrap、tool.definition、chat.params/headers、tool.before/after、auth refresh 六类各列顺序、可变性、取消、失败策略；≥1 条完整轨迹 replay；**不实现生产 sidecar** |
| WP-10 | 控制面、mutation/MCP/job-family/retention 行为 fixture | 343/343 语义点每个有 owner + fixture（已有/待补/不适用），不允许空 owner；覆盖 config/bootstrap/skills/instructions/workbrief/goal/prompt assembly/tool_search/compaction/mutation 链/MCP 三 transport/job family/retention；新增能力与已知差异单列 |
| GP-0 | profile 与 oracle：固化版本、实际路由/model/auth/options、受支持与兼容清单 | 执行 WP-08 规格并回填结果；复用 `packages/llm` 的 recorded-golden/recorded-scenarios |
| GP-1 | 隔离 SDK adapter/harness | 单请求→流式工具调用→测试 caller 执行工具→结果回放→下一轮响应；SDK 不自行循环；独立目录，不依赖 T1、不接生产 host |
| T1 门禁 | **T1 门禁条件，不是 T1 实施** | 仅当 G0 通过（WP-01–WP-10 出口 + W0 oracle）后才允许开 T1 Rust 基础；本批只确认门禁与出口 |

### 1.2 明确非目标

- **不写生产迁移代码**：W0 oracle 未通过前，只允许写契约、fixture、harness、隔离 PoC；W1–W6 换权/扩面不在本批。
- **不在本受管端点编译/运行新可执行体**：不跑 cargo build/test、不跑 genai PoC、不集成/编译 `codex-api`、不调用真实 provider；GP-0/GP-1 与 T1 的编译/运行须另择环境并经用户显式批准。既有 TS 测试与只读检查不在此限。
- **不提交、不推送**：A0 与首批产物保持工作树未提交，除非用户另行发令。
- **不接 96 条会话依赖路由**：首批不接 W2 的 96 条依赖 TS session 语义的路由；WP-04 只产出 host-first/依赖 session 二分清单。
- **不实现生产面**：不实现生产 runtime/core/launcher、provider transport、hook sidecar、graph core、控制面、HTTP/UI；不做 schema 迁移、writer 翻转、单写者换权、发布/CI hard gate 启用、npm 两变体发布。
- **不引入生产依赖**：genai / codex crates 不进入主 workspace 锁文件；Codex vendoring/git pin 不在首批执行。
- **不创建 §8 建议产物路径**：`packages/chimera/specs/rust-host/<domain>/`、`packages/chimera/test/oracle/*` 等仅为规划落点；WP-01 只创建/维护自身三个契约文件，其余由对应包在进入 building 时创建。
- **不代替 §13 前两条拍板**：本计划立项（全量 Rust 承诺终点）与 provider 长尾取舍仍待用户拍板；开工授权不等于立项已拍板。

### 1.3 顺序与硬门

| 序 | 包 | 前置 | 出口 |
|---|---|---|---|
| 1 | WP-01 契约/manifest 冻结 | A0（本记录） | manifest 四字段齐全；`owned_files` 交集为空；`contract_rev` 锁定；WP-02..WP-10 均有 owner/产物/DoD |
| 2 | W0 oracle fixture 四层 | WP-01；WP-02/WP-03 先行 | 确定性/因果/fault matrix/统计四层各有 fixture 与判定；故意注入必报错；TS 双臂零 diff |
| 3 | GP-0/GP-1 隔离 genai 验证 | WP-08 profile 准入规格；不依赖 T1 | 固定 `=0.7.2`；单请求→流式工具调用→caller 执行→结果回放→下一轮；SDK 不自行循环；Codex 直连按 §15.6 同批评估 |
| 4 | T1 Rust 基础 | **G0 通过**（WP-01–WP-10 出口 + W0 oracle） | runtime/core/layout/launcher/IPC 安全基础可构建；不含业务迁移 |

**硬门**：W0 oracle 未通过前，不写任何生产迁移代码；只允许写契约、fixture、harness、隔离 PoC。W3 首条闭环还额外要求：至少一条经 oracle 验收的 LLM 通路（genai 或 Codex 直连）+ 最小真实 hook sidecar（plugin-only，不承载 session/agent loop）+ W0 因果层/fault matrix 就绪 + T1 与数据/运行时最小集可用。

## 2. 决策（Decisions）

### 2.1 D1–D8：暂定建议待用户确认

- **D1 首个 provider profile 与 genai PoC 准入**
  建议值：从实际使用的 OpenAI-compatible Chat/API-key 模型开始；Responses/OAuth/WS 分开验收，不按 provider 名字推断全部能力；PoC 固定 genai `=0.7.2`（§15.1、§16）。
  状态：**暂定建议待用户确认**。

- **D2 JS 兼容终态范围**
  建议值：计划未给单一取值；建议 plugin、长尾 provider、orchestrate sandbox 三个 JS 面分开评估，不默认合并、不默认全删；单 sidecar 还是双 sidecar、orchestrate 是否保留独立 Bun sandbox 均未定（§2、§13 D2）。
  状态：**暂定建议待用户确认**（兼容边界方向已定，拓扑未定）。

- **D3 Windows**
  建议值：计划未给取值；只给时点约束——host 传输与兜底策略（随包发布 / 延迟 / 不支持）在首个 host 能力发布前定（§13 D3）。
  状态：**暂定建议待用户确认**。

- **D4 图 writer 切换时点与 graph MCP daemon 归属**
  建议值：图 writer 切换前必须先把 graph MCP daemon 变薄代理或改归属；薄代理 vs 直接改 Rust 未定；切换时点随 W1/W3 单写者换权矩阵与 oracle 定（§8 WP-06）。
  状态：**暂定建议待用户确认**。

- **D5 发布门禁时点**
  建议值：首个用户可启用 host 能力的版本即启用 npm 两变体 + CI hard gate（§13 D5）。
  状态：**暂定建议待用户确认**。

- **D6 性能阈值**
  建议值：由开工时同环境重复基线签定，不预先写死（§13 D6）。
  状态：**暂定建议待用户确认**。

- **D7 共享 contract/CI 集成 owner 与业务域 owner 的边界**
  建议值：parent 签定；共享 contract/CI 单写者，业务域各自 owned paths（§13 D7）。本批已按此落成 manifest 与分区表，但边界本身仍待确认。
  状态：**暂定建议待用户确认**。

- **D8 Codex 特殊通路**
  建议值：直接复用 codex-rs wire crates（`codex-api`）而非逐行翻译 TS；依赖 vendoring/git pin、Apache-2.0 LICENSE+NOTICE 保留与上游同步策略；只复用 wire 层，不引入 `codex-core`（§15.6）。
  状态：**暂定建议待用户确认**（复用方向已定，依赖/许可/同步细节待确认）。

### 2.2 已拍板与方向已定

**已拍板**

| 项 | 状态 |
|---|---|
| 取消 Bun session worker 中间态；不新增线程或进程 session worker；任何 Bun 进程不得成为 session 执行体 | 已拍板（§13 已拍板记录） |
| 执行体直接落 Rust host；TS 侧调用接口异步化（Promise/RPC） | 已拍板（同上） |
| session 与图审计证据保留期均 30 天 | 已拍板（§13） |
| 遥测 DB 持久化移除；调度速度信号改进程内存态 | 已拍板（§13） |
| 止血包内容已随 `0.0.7-beta8-patch2` 落地 | 已拍板 / 已完成（§13） |

**方向已定**

| 项 | 状态 |
|---|---|
| JS 兼容边界：Bun 仅保留 plugin 生态、必要长尾 provider、可选 orchestrate sandbox；plugin-only hook sidecar 不承载 session/agent loop/工具执行循环 | 方向已定（§2、§7）；D2 拓扑仍待确认 |
| genai 候选 = `0.7.2`：作为主力 provider 候选，PoC 固定 `=0.7.2`；正式采用以 GP-0/GP-1 准入为准 | 方向已定（§15.1） |
| Codex crate 复用方向：直接复用 codex-rs wire crates（`codex-api`），不逐行翻译 TS，不引入 `codex-core` | 方向已定（§15.6）；D8 细节待确认 |

### 2.3 仍待用户确认的两项

1. **WP-10 新增依赖 WP-05/WP-09（关键路径）**
   §8 现记 WP-10 依赖 = WP-02、WP-05、WP-09（相对上一版新增 WP-05/WP-09）。WP-10 的 343/343 语义点映射需要 WP-05 的库/表权威矩阵与 WP-09 的 hook 轨迹 fixture，故 WP-05/WP-09 进入 G0 关键路径，WP-10 不能早于二者完成。
   待确认：是否接受该依赖扩张与关键路径延长；若不接受，需明确 WP-10 是否拆段或调整 G0 聚合范围。

2. **§16 首批顺序**
   现记为：WP-01 → W0 oracle 四层（WP-02/WP-03 先行）→ GP-0/GP-1 隔离 genai 验证 → T1（G0 通过后）。
   待确认：是否按此顺序；特别是 GP-0/GP-1 是否必须在 W0 oracle 四层之后，还是可在 WP-08 profile 规格就绪后与 W0 并行（§15.4 称 GP-1 可先做、不依赖 T1）。T1 的 G0 硬门不因此提前。

说明：以上两项来自此前会话记录，计划正文未单列；在用户确认前按暂定处理。

### 2.4 §13 前两条（仍待拍板）

| 项 | 状态 |
|---|---|
| 本计划立项：全量 Rust 从「暂缓」升级为「承诺终点」 | 待拍板 |
| provider 长尾取舍：接受「主力 Rust + 长尾 Bun 兼容边」的长期混血，最后 5% 不承诺全 Rust | 待拍板 |

首批契约/fixture 工作可在不预设这两项结论的前提下推进；任何生产换权/发布仍需先拍板。

## 3. A0 出口与 WP-01 输入

| 出口 | 判据 |
|---|---|
| 范围确认 | 用户确认 §1.1/§1.2，或给出修改 |
| 决策确认 | D1–D8 逐项确认/修改；§2.3 两项待确认有结论 |
| WP-01 输入 | manifest 四字段可机检；`owned_files` 两两交集为空；`contract_rev` 锁定；WP-02..WP-10 均有 owner/产物/DoD |
| 未确认前 | 不派发实现、不写迁移源码、不编译/运行新可执行体、不 commit/push |

A0 完成标志 = 本记录经用户确认并作为 WP-01 输入，不是代码交付。WP-01 已完成本记录的归档与机检字段落位（`contract_rev = cr-2026-10-30-r1`）。

**取证说明**：内容取自 `RUST_FULL_MIGRATION_PLAN.md` §2、进展摘要、§6 W0、§8、§9、§13、§15.4、§15.6、§16；基线 commit 与计划哈希见 `packages/chimera/specs/rust-host/manifest.yaml` 的 `base` 段。