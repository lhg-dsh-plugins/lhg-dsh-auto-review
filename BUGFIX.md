# BUGFIX — 0.13.8 → 0.13.9

## 标题

被委托（delegate）的风险策略升级被误计为拒绝：审计折叠与投影折叠把没有 `outcome` 的 `risk-policy` 升级当作 denial，断路器可被「从未被本插件拒绝」的请求触发，委托放行还会混进拒绝列表与 `/auto-review approve` 候选。

## 现象与根因

审查者给出 `allow` 但 `riskLevel` 超过 `riskPolicy.maxAutoAllow` 时，`runtime.ts` 的 `review()` 记 `escalation: 'risk-policy'`；接下来按 `onHighRisk` 分岔：

- `'deny'`：`outcome = 'rejected'`，插件自己拒绝——这是真拒绝；
- `'delegate'`（**默认值**，`config.ts` 中 `onHighRisk` 默认 `'delegate'`）：`outcome = undefined`，裁决事件**不带 `outcome` 字段**，请求被交回人工审批链由下游决定——插件没有拒绝任何东西（上游自带测试 `test/answerer.spec.ts`「delegates an allow verdict whose risk exceeds maxAutoAllow」恰好断言了这一事件形状：`decision: 'allow'`、`escalation: 'risk-policy'`、且 `not.toHaveProperty('outcome')`）。

但两处折叠的 denial 谓词漏掉了 outcome 这一半：

- `src/events.ts` 的 `isDenial()`：`decision === 'deny' || escalation === 'risk-policy'`——其自己的文档注释都写的是「an allow overridden by the risk policy (escalation: 'risk-policy' **with the deny outcome**)」，实现与注释不符；
- `src/projection.ts` 的 `applyAutoReview`：内联了同一错误谓词，决定面板的 `recentDenies`。

同仓另外两处实现用的是正确谓词，可作对照：runtime 的内存镜像记 `denial: decision === 'deny' || (overridden && outcome === 'rejected')`；invariant 伴侣 `src/invariant.ts` 亦以 `escalation === 'risk-policy' && outcome === 'rejected'` 判定。即同一条日志在「可写审计事件的宿主」与「内存镜像宿主」上会算出不同的拒绝数。

后果（默认配置即可达）：断路器默认 `consecutiveDenies: 3`——同一回合内 3 次高风险但被委托人工链的 allow 就会把 `consecutiveDeniesInOpenTurn`/`deniesInRecentVerdicts` 顶满并触发断路器；`action` 配为 `reject`/`abort-turn` 时，后续请求会被本不该触发的断路器直接拒绝/中止回合。`lastDeniedVerdicts` 与面板 `recentDenies` 也会把委托放行列为「待 approve 的拒绝」。

上游 open issue 为 0 条（仅 2 个 dependabot PR），基线测试全绿，本缺陷由静态审查定位、复现坐实。

## 证据链

1. **修复前复现**（新增 `test/escalation-denial.spec.ts`，用与 answerer 完全一致的委托升级事件形状）：8 条用例中 4 条失败——`isDenial(委托升级) === true`（应为 false）、3 条委托升级使 `consecutiveDeniesInOpenTurn` 返回 3（应为 0）、`lastDeniedVerdicts` 列出委托升级（应为空）、投影 `recentDenies` 含委托升级（应为空）；4 条对照用例（`outcome: 'rejected'` 的真拒绝升级）在修复前后均通过。
2. **基线对照**：`git stash` 掉两处源码改动后复跑同一测试文件，结果逐字回到 4 failed / 4 passed——失败由缺陷本身引起，非测试或环境问题。
3. **基线全量**：上游 HEAD（`eda595c…`）`pnpm test` 299 passed / 23 skipped / 0 failed，`pnpm run typecheck` 退出 0。

## 改动文件

- `src/events.ts`：`isDenial()` 谓词补 `&& data.outcome === 'rejected'`（1 行）。
- `src/projection.ts`：`applyAutoReview` 的内联 denial 谓词同样补齐（1 行）。
- `test/escalation-denial.spec.ts`：新增回归测试（8 条），上游既有测试一字未改。
- 契约同步：`package.json`（version 0.13.8→0.13.9、repository.url 改落点仓）、`CHANGELOG.md` 新增 [0.13.9] 条目、`README.md` 顶部加中文 fork 头（原文未删），新增 `UPSTREAM.md` / 本文件；`LICENSE` 与上游逐字一致。pnpm-lock.yaml 不含根包版本字段，无待同步项。

## 复验结果

- 回归测试：修复后 8/8 通过。
- 全量测试：307 passed / 23 skipped / 0 failed（基线 299 + 新增 8，零回归）。
- `pnpm run typecheck` 退出 0；`pnpm run build` 成功；`pnpm run lint` 0 errors（7 warnings 与基线同存）。

## 验证边界

- 修复只涉及事件折叠的计数语义，不改变 answerer 的任何结算行为：委托仍是委托、拒绝仍是拒绝，裁决事件本身的写法不变。
- 未在真实 DSH 宿主中做端到端验证；事件形状取自上游自带 answerer 测试的断言，折叠函数为纯函数，离线复现即完整覆盖该缺陷路径。
- 断路器 `action: 'delegate'`（默认）下误触发的表现是「回合内剩余请求被静默委托、不再走 AI 审查」；`reject`/`abort-turn` 下的误拒绝/误中止未单独构造宿主级复现，但其计数来源与已复现的折叠完全相同。
