# WP-10 control-plane oracle（test 侧入口）

状态：契约阶段，已执行。`contract_rev = cr-2026-10-30-r1`。
本目录只放机读清单、合成 fixture、纯参考判定器与校验脚本；不导入 `packages/chimera/src/**`，不打开 DB/网络/子进程。

## 文件

| 文件 | 作用 |
|---|---|
| `semantic-points.json` | 343 个 W-E 语义点的“点/桶 → owner → fixture 状态”映射（223 点 + 12 个 mechanical 桶 = 343） |
| `domains/*.json` | 12 个控制域的清单：fixtures、semantic_points（含 `待补` 与 owner 角色）、new_capabilities、known_differences |
| `fixtures/**/*.json` | 29 组合成输入 → 期望 verdict；由 `fixtures/judges.ts` 执行 |
| `fixtures/judges.ts` | 纯参考判定器；按契约规则计算期望值，不调用生产代码 |
| `format.ts` | 三层机读格式的 schema/校验/断言求值/禁用内容扫描；`fixture.status` 支持 `existing-domain`（域级关联）、`existing`（点级 parity，当前未用）、`pending`、`not-applicable` |
| `control-check.ts` | 主校验：计数、owner、引用闭包、schema、域覆盖、29/29 judge |
| `control.test.ts` | `bun test` 入口（1 test / 4 expect） |
| `build-semantic-points.ts` | 从本机 W-E 归档重新生成 `semantic-points.json`（需要 `--source`） |

## 运行（从 `packages/chimera`）

```bash
bun test/oracle/control/control-check.ts
bun test --timeout 30000 test/oracle/control/control.test.ts
```

期望：

```text
PASS semantic points: 223 enumerated + 12 buckets = 343
PASS fixture status: existing-domain 67, existing 0, pending 276, not-applicable 0
PASS domains: 12 manifests, 29 fixtures (14 behavior, 15 negative)
PASS judges: 29/29 fixtures executed
```

## 343 口径

- 223 个逐点行有 `file:line`（来自 W-E 归档 `nonMechanical`）。
- 120 个 mechanical 点只有模块级计数；用 12 个 bucket 承载，`fixture.status = pending`，不伪造逐点行号。
- 67 个逐点行的 `existing-domain` 是域级 fixture 关联，不是点级 parity；`existing` 预留给真正的点级 parity（当前为 0）。详见 `specs/rust-host/control/semantic-points.md` 与 `known-differences.md`。

## 约束

- 合成输入只使用 `synthetic://`、`synthetic-*` 等占位符；不写真实 URL、内网域名、provider id、IP、凭据或 home 路径。
- `control-check.ts` 会扫描本目录 JSON 与 `specs/rust-host/control/*.md` 的禁用内容；新增 fixture 必须通过该扫描。
- 新增域或 fixture 时，同步更新 `domains/<domain>.json` 的 `fixtures` 与 `semantic_points`，否则引用闭包检查失败。