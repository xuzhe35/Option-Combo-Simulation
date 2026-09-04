# `cost_basis.html` Long Put / 跨账本压力测试改动 Review 与修复复核

> 最新复核日期：2026-09-05  
> 最新复核结论：提交 `9588183` 已覆盖第 15 节的关键功能修复；第 17 节新发现的股票行 BBO 宽限浪费与错误“最低 IV”注释也已在第 18 节所述改动中修复并通过回归。
> 当前建议：代码级问题已关闭；剩余事项只是在真实 TWS 连接下完成浏览器手工验收。

> Review 日期：2026-09-04  
> Review 范围：当前工作区相对 `HEAD` 的未提交改动  
> Review 方式：代码与设计文档审查、现有自动化测试；未连接真实 TWS 做浏览器手工验收  
> 结论：发现 5 项值得修正的问题，其中 1 项高优先级、3 项中优先级、1 项低优先级

第 1–8 节保留初次 Review 的问题现场；第 9、11、12 节记录前两轮修复与验证；第 13 节是精度迭代 Review，第 14 节是修复记录，第 15 节保留提交前曾被回退的现场，第 16 节记录重新写入过程，第 17 节是对已提交快照 `9588183` 的独立 Review，第 18 节记录本轮直接修复。

## 1. 总体结论

本轮迭代已经比较完整地建立了 TQQQ 主账本与同账户 QQQ 账本之间的 Long Call / Put 保护叠加能力。以下关键边界处理得较好：

- 联动仓位来自事件账本，而不是从 TWS 当前持仓反推历史事实。
- 联动账本数据保存在独立状态中，没有覆盖当前主账本的 `allEvents`、`ledger` 或 `bookId`。
- 行情与期权参数使用一次性 TWS snapshot，不创建持续行情订阅，也不写入账本。
- 缺少 IV、折现利率、标记价或完整合约信息时会整体停止叠加，没有静默丢弃合约或使用统一 IV 猜测。
- 联动账本事件和期权参数请求均有 generation 检查，可丢弃账本、到期日切换后的迟到响应。
- 未启用跨账本叠加时，原有压力测试序列形状保持不变。
- Long Option 的现金流仍保留在审计账本里，但没有重新混入标的综合成本口径。

主要风险集中在新增的“跌到位需要天数”语义。该参数会让主账本和联动保护采用不同估值日期，并且联动期权可能使用与实际剩余期限不匹配的零息利率。结果虽然能够正常生成，也能通过当前测试，但紫色合计曲线在经济含义上可能不成立。

## 2. Review 范围

重点检查了以下文件：

- `cost_basis.html`
- `cost_basis.css`
- `js/cost_basis.js`
- `js/cost_basis_core.js`
- `ib_server.py`
- `cost_basis_ws.py`
- `tests/cost_basis_page.test.js`
- `tests/cost_basis_core.test.js`
- `tests/cost_basis_ws_test.py`
- `CODE PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md`
- `CODE PLAN/COST_BASIS_CROSS_BOOK_HEDGE_OVERLAY_PLAN.md`
- `README.md`
- `ARCHITECTURE.md`

同时检查了本轮顺带加入的 What If 自动跟随参考价逻辑，包括手工输入暂停跟随、恢复跟随、主动刷新和迟到响应保护。该部分未发现需要单独阻止合并的明显错误。

## 3. Findings

### [P1] “跌到位需要天数”会让合计混合两个不同估值日期

位置：`js/cost_basis.js:1037-1040`、`js/cost_basis.js:1108-1114`、`js/cost_basis.js:1143-1144`

主账本部分始终通过：

```js
core.computeOptionSettlementScenario(events, price, {
    throughExpiry,
});
```

按所选 `throughExpiry` 计算结算结果。联动账本部分在填写 `horizonDays` 后，却改为按 `today + horizonDays` 计算 QQQ Long Option 市值，随后仍直接执行：

```js
totalPnl = pnl + linked.pnl;
```

例如：

- 主账本选择一年后的期权到期日；
- “跌到位需要天数”填写 20 天；
- ① 是一年后主账本的股票与期权结算盈亏；
- ③ 是 20 天后 QQQ Long Put 的理论市值变化；
- 紫线把这两个不同日期的值直接相加。

两个数字并不属于同一个投资组合时点，因此这个合计没有一致的经济含义。问题不会触发 unavailable，也不会给出显著警告，用户容易把紫线当作同一压力情景下的组合总盈亏。

建议：

1. 最稳妥的做法是让主账本和联动账本始终使用同一个估值日。
2. 如果要支持“今天 + N 天”的中途压力测试，主账本也需要在同一天做未到期头寸的 MTM，而不是继续按 `throughExpiry` 全部结算。
3. 如果短期内不扩展主账本中途 MTM，应限制 `horizonDays` 等于今天到 `throughExpiry` 的天数；或在日期不一致时只展示联动期权独立估值，不生成 `totalPnl` 合计曲线。

建议新增测试：构造 `throughExpiry` 与 `today + horizonDays` 不同的场景，断言系统拒绝生成合计，或者断言两个组成部分采用同一估值日期。

### [P2] Horizon 改变剩余期限后，BSM 仍使用按 `throughExpiry` 解析的零息利率

位置：`js/cost_basis.js:1108-1114`、`ib_server.py:2484-2493`、`ib_server.py:2582-2594`

前端在 Horizon 模式下用 `valuationDate` 重新计算期权剩余期限：

```js
timeYears = (expiryAt - valuationDate) / 365
```

但 `marketInputs.ratesByExpiry` 是后端以 `throughExpiry` 为情景日起点生成的：

```python
maturity_days = (expiry_date - scenario_date).days
resolved = resolve_snapshot_discount(curve, maturity_days)
```

其中 `scenario_date` 来自 `throughExpiry`，不是 `valuationDate`。

因此当 `valuationDate !== throughExpiry` 时，BSM 会混用：

- 按 `valuationDate` 计算的 `timeYears`；
- 按 `throughExpiry` 剩余期限解析的 `zeroRate`。

例如某合约从 `throughExpiry` 看剩余 137 天，但从 `today + 60` 看只剩 78 天，当前实现会使用 137 天期限的零息利率配合 78 天的 BSM 时间。收益率曲线较平时误差可能不大，但这是确定性的期限错配，在短端陡峭、事件期或更长 Horizon 下会放大。

建议：

1. 在 `request_cost_basis_option_scenario_inputs` 中增加明确的 `valuationDate` / rate-anchor 字段，并用它计算 `maturity_days`。
2. 或让后端返回足够的折现曲线节点，由前端按真实 `valuationDate → expiry` 期限解析。
3. 响应中应回传实际 rate anchor，前端校验它与当前估值日一致；不一致时 fail closed。

建议新增测试：让 `valuationDate` 明显晚于 `throughExpiry`，使用非平坦曲线，验证得到的是新剩余期限对应的利率，而不是旧期限利率。

### [P2] 已有强合约身份时，匹配失败仍会降级到 `right/expiry/strike`

位置：`js/cost_basis.js:420-439`；后端同类逻辑位于 `ib_server.py:2322-2338`

`_findOptionQuote` 的当前逻辑是：

1. `conId` 相同则匹配；
2. `localSymbol` 相同则匹配；
3. 前两项不匹配时，继续按 `right + expiry + strike` 匹配。

问题在于：当账本已经有明确 `conId`，但快照里没有该 `conId` 时，代码仍可能抓到同到期日、执行价和方向的另一张合约。调整期权、公司行动后合约或其它具有相同可见条款但不同乘数/交割物的合约尤其危险。

前端随后使用账本自己的 `sharesPerContract` 乘以错误报价，可能产生显著错误的今日标记市值、情景市值和保护 P&L。后端 `_cost_basis_option_request_matches` 也采用相同降级方式，因此错误合约甚至可能被纳入快照请求。

建议采用严格分层匹配：

- 仓位有有效 `conId`：只接受相同 `conId`，不再降级。
- 没有 `conId`、但有 `localSymbol`：只接受相同 `localSymbol`。
- 两者都没有：才允许使用 `right + expiry + strike`，并同时核对 multiplier、symbol、currency、trading class 等可用字段。
- 强身份存在但找不到时，应返回 `missing_linked_option_quote` 或身份不匹配错误，而不是猜测。

建议新增测试：账本仓位 `conId=A`，快照只有相同条款但 `conId=B` 的报价，断言整体 fail closed。

### [P2] 联动账本没有限制币种，可能把不同货币面值直接相加

位置：`js/cost_basis.js:3464-3471`、`js/cost_basis.js:1143-1144`

联动账本候选仅检查：

- 同一个 account；
- `secType === STK`；
- 不是当前账本。

没有检查 `currency`。但最终 `linked.pnl` 会直接加到主账本 `pnl`，图表和 tooltip 又统一按主账本币种格式化。

对于 TQQQ ↔ QQQ，两本账本通常都是 USD，所以主路径不受影响；但 UI 文案和候选列表允许选择同账户的任意其它 STK 账本。一旦选择不同币种的账本，系统会把例如 USD 与 HKD/CAD/EUR 面值直接相加，结果确定错误且没有提示。

建议：

1. 当前版本直接把候选限制为与主账本相同币种，这是最安全的方案。
2. 如果未来确实需要跨币种，应引入带来源和时间戳的 FX snapshot，并把联动 P&L 明确换算到主账本币种。
3. `buildStressTestSeries` 的纯函数入口也应验证币种，而不能只依靠 UI 过滤。

建议新增测试：主账本 USD、联动账本非 USD，断言候选被过滤或序列返回明确的 `linked_currency_mismatch`。

### [P3] 只启用跨账本叠加时，编号在图例、状态和 tooltip 之间不一致

位置：`js/cost_basis.js:3315-3328`、`js/cost_basis.js:3102-3140`；设计要求见 `CODE PLAN/COST_BASIS_CROSS_BOOK_HEDGE_OVERLAY_PLAN.md:197-205`

设计文档规定：如果本账本的未到期 Long Option 叠加未开启，联动账本应显示为第 ② 项，合计写作 `①+②`。

当前 tooltip 已动态执行这一规则，但：

- 图例显示 `①+③`；
- 状态行固定写 `③ 已叠加`；
- 页面说明仍把联动账本固定称为 ③；
- 自动化测试也断言 `①+③`，把当前不一致锁定成了预期行为。

这不会改变数值，但同一张图出现两套编号，会增加用户核对分项和合计的难度。

建议抽出一个统一的组件编号映射，例如：

```js
const ownLongNumber = showConvexity ? 2 : null;
const linkedNumber = showConvexity ? 3 : 2;
```

图例、状态、卡片、SVG title、tooltip 和固定说明均从同一映射生成。随后更新当前断言 `①+③` 的测试。

## 4. 测试与验证结果

已执行：

```text
node tests/run.js
```

结果：

```text
1010 passed, 0 failed
```

已执行成本账本相关 Python 测试：

```text
python3 -m unittest \
  tests.cost_basis_ws_test \
  tests.cost_basis_store_test \
  tests.cost_basis_executions_test
```

结果：

```text
Ran 223 tests
OK (skipped=1)
```

另执行 `git diff --check`，未发现 whitespace error。

完整 JS 测试中的若干错误日志是测试用例主动注入异常、验证 UI 隔离行为产生的预期输出；最终测试结果为 0 failed。

## 5. 当前自动化测试的覆盖评价

新增测试覆盖较充分，包括：

- TQQQ −30% → QQQ −10% 的线性映射。
- 正向与反向杠杆比率。
- Long Call / Put 同时存在。
- 测试日前到期按内在价值结算。
- 今日之前到期的账本残留仓位被排除。
- 缺 IV、利率、mark、身份完整性时 fail closed。
- 固定 IV shock、跌幅 β 和期限衰减。
- Horizon 对剩余期限和 Theta 的影响。
- 联动账本事件加载不污染主账本。
- 账本切换后的迟到响应丢弃。
- localStorage 记忆不会自动开启紫线。
- What If 自动跟随、手工暂停、恢复和主动刷新。

但当前测试主要验证函数是否按现有实现运行，没有验证以下更高层语义：

1. `totalPnl` 的所有组成部分是否属于同一估值日期。
2. BSM 使用的零息利率期限是否与 `timeYears` 一致。
3. 强身份不匹配时是否错误降级到合约条款。
4. 主账本和联动账本币种是否一致。
5. 所有 UI 区域是否使用同一组件编号。

特别是 Horizon 测试目前只断言 QQQ Put 的期限缩短、价值下降，却没有检查主账本仍停留在另一个日期，也没有检查利率期限错配。因此测试通过不能证明紫色合计曲线具有一致的经济口径。

## 6. 未完成的验证

本次 Review 没有进行真实 TWS 浏览器验收。合并前仍建议按设计文档完成以下检查：

1. 同账户存在 TQQQ 与 QQQ 两本真实账本。
2. QQQ 账本同时包含测试日前到期和测试日后到期的 Long Put。
3. 核对 TWS 返回的每个 `conId`、`localSymbol`、IV、mark 和 multiplier 与账本仓位一致。
4. 对比 Horizon 留空、0 天、20 天以及恰好等于所选到期日的结果。
5. 在非平坦收益率曲线下核对每张递延期权使用的实际剩余期限。
6. 切换账本、切换到期日、请求进行中关闭弹窗，再确认迟到结果不会污染当前页面。
7. 断开 TWS 后确认基础曲线可继续显示，跨账本曲线明确停用且不保留陈旧结果。

## 7. 建议修复顺序

1. 先决定 Horizon 的统一估值日语义，修复不同日期 P&L 相加的问题。
2. 将相同估值日传给利率解析路径，消除 BSM 时间与零息利率期限错配。
3. 同时收紧前后端合约身份匹配规则。
4. 限制联动账本币种，或实现明确 FX 换算。
5. 最后统一 UI 编号和对应测试。

前两项建议作为合并阻断项处理。第三、第四项属于错误估值的防护边界，也建议在正式开放任意联动账本选择前修复。第五项不影响数值，可以单独快速修正。

## 8. 最终评价

这轮迭代在数据隔离、账本事实来源、只读行情和 fail-closed 方面是扎实的，Long Put 确实已经进入压力测试计算链路。当前最大的不足不是 Long Put 被漏算，而是新增的时间维度没有贯穿整个组合估值：主账本结算日、联动期权估值日和折现利率期限可能各自不同，最后却被包装成同一条合计曲线。

建议修复 P1/P2 时间语义后，再把这套结果用于实际仓位风险判断。

## 9. 修复记录（2026-09-04，同日）

逐条核实后全部成立，均已修复并加了针对性测试。`node tests/run.js` 1010 通过；
`tests.cost_basis_ws_test / cost_basis_store_test / cost_basis_executions_test /
ib_server_ws_test` 285 通过。

| Finding | 结论 | 修复 |
| --- | --- | --- |
| P1 合计混合两个估值日 | 成立。首版「跌到位需要天数」只推后 ③ 的估值日 | 天数改为整个弹窗的情景日（`_stressScenarioDate()`）：① 的结算、② 与 ③ 的 BSM、两次 TWS 快照请求都用同一个 `throughExpiry`；`estimateDeferredLongOptions` / `estimateLinkedLongOptions` 删除 `valuationDate`，纯函数层面不再存在「只给某一项换日期」的入口；控件移到主控件行，选择到期范围会清空天数，不按账本记忆。测试：源码断言不含 `valuationDate`；harness 断言天数=20 时主账本与联动账本两次请求的 `throughExpiry` 都是 `20260923`，卡片显示本账本 9/4 到期的 Short Put 已在该日结算 |
| P2 利率期限错配 | 成立，同一根因 | 随 P1 消失：后端仍以 `throughExpiry` 为 `scenario_date` 解析利率，而它现在就是唯一的估值日 |
| P2 强身份降级匹配 | 成立 | 前端 `_findOptionQuote` 改为严格分层（conId → localSymbol → 条款 + multiplier），新增 `_optionQuoteIdentityConflict` 给出 `long_option_identity_mismatch` / `linked_option_identity_mismatch`；后端 `_cost_basis_option_request_matches` 同规则，移到 `ib_server_market_data.py`（`cost_basis_option_identity` / `cost_basis_option_request_matches`）以便单测，identity 与快照行新增 `multiplier`，`cost_basis_ws.py` 转发请求行的 `multiplier`。测试：JS 纯函数与序列级 fail-closed；Python 4 个用例覆盖三层规则与 multiplier |
| P2 币种 | 成立 | 候选只列同账户、同币种 STK 账本；`buildStressTestSeries` 接收 `currency` 并在 `_prepareLinkedHedge` 校验 → `linked_currency_mismatch`。测试：HKD 账本不出现在候选；纯函数返回该原因 |
| P3 编号不一致 | 成立 | 新增 `stressComponentNumbers(showConvexity, showLinked)`，图例、状态行、卡片、SVG title、tooltip 全部取自它；页面说明改为「未开启 ② 时 ③ 就是 ②」。测试改为断言 `①+②` 并断言状态行不含 ③ |

§6 的 TWS 浏览器手工验收仍未做。

## 10. 修复复核结论（2026-09-04）

### 10.1 原 5 项 Finding 的覆盖状态

| 原 Finding | 实现复核 | 测试复核 | 结论 |
| --- | --- | --- | --- |
| P1 合计混合两个估值日 | `_stressScenarioDate()` 生成唯一情景日；① 结算、②/③ 估值及两次 snapshot 请求均使用相同 `throughExpiry` | Harness 覆盖 Horizon=20 时两次请求同为 `20260923`，并检查主账本短 Put 已在该日结算 | 已覆盖 |
| P2 利率期限错配 | 后端用同一个 `throughExpiry` 解析 `scenario_date`，并以 `expiry_date - scenario_date` 解析曲线期限；前端 BSM 的 `timeYears` 也以同一日期为起点 | 前端覆盖统一日期及剩余期限；当前没有直接 mock 非平坦曲线并断言后端 `maturity_days` 的专门测试 | 实现已覆盖；建议补直接后端回归测试 |
| P2 强身份降级匹配 | 前后端均改为 conId-only / localSymbol-only / 无强身份才按条款匹配，并在条款层核对 multiplier；强身份冲突返回具名 unavailable | JS 覆盖主账本和联动账本 fail-closed；Python `CostBasisOptionIdentityTest` 4 项覆盖三层规则及 multiplier | 已覆盖 |
| P2 跨币种直接相加 | UI 候选限制同账户、同币种 STK；纯函数入口再校验币种并返回 `linked_currency_mismatch` | 覆盖候选过滤、大小写/空格规范化及纯函数拒绝 | 已覆盖 |
| P3 编号不一致 | `stressComponentNumbers()` 统一图例、状态、卡片、SVG title 与 tooltip 的编号 | 覆盖四种 ②/③ 组合；只开联动时断言 `①+②` 且状态无 `③` | 已覆盖 |

原 5 项问题不是只改了表面文案：统一估值日已经贯穿结算、期权估值和快照协议；身份、币种两项也在 UI 之外的纯函数/后端边界做了第二层防护。就这 5 项本身而言，修复是完整的。

### 10.2 新发现：[P1] 主账本期权快照的迟到响应可覆盖新情景或新账本

位置：`js/cost_basis.js:3495-3542`、`js/cost_basis.js:3602-3610`、`js/cost_basis.js:6387-6399`

联动账本的 `_refreshStressLinkedInputs()` 已经有 `stressLinkedInputsGeneration`、捕获的 `mainBookId / linkedBookId / throughExpiry` 和 `isCurrent()` 校验，但主账本 `_refreshStressMarketInputs()` 没有相同保护：

- 请求开始后只设置全局 `stressInputsPending = true`；
- `_invalidateStressScenarioInputs()` 清掉旧数据，却既不递增主账本 generation，也不终止/失效当前主请求；
- 新情景触发的 `_refreshStressMarketInputs()` 因为 `stressInputsPending` 仍为 true 直接返回；
- 旧请求完成后不校验 `bookId` 或情景日，直接写入 `stressLongOptionInputs`、`marketPrice` 和 `stressBasePrice`。

这个竞态很容易由普通输入触发：在“跌到位需要天数”中键入 `20` 时，第一个字符 `2` 会发起 `today + 2` 的请求；第二个字符把值变成 `20`，但 `today + 20` 的请求被 pending 门禁吞掉。随后 `+2` 的旧响应写回。由于响应的 `throughExpiry` 与当前情景不一致，估值函数通常会 fail closed，图表停在“无可用参数”状态，直到用户手工刷新。

更严重的路径是请求期间切换主账本。`bookScopedStateReset()` 没有重置 `stressInputsPending`，旧请求也不检查捕获的 `bookId`；旧账本的标的现价和 snapshot 因而可能写入新账本。如果新旧账本碰巧选择同一情景日，日期校验不足以阻止错误数据被使用。

建议参照联动请求实现主账本保护：

1. 增加 `stressInputsGeneration`；情景日改变、主账本切换、弹窗关闭或连接失效时递增。
2. `_refreshStressMarketInputs()` 捕获 `bookId`、`throughExpiry` 与 generation，并在成功、失败、finally 写状态前统一调用 `isCurrent()`。
3. 不要让旧请求的 `finally` 清掉新请求的 pending；pending 最好与 generation 绑定。
4. 对 Horizon 输入做短 debounce，或允许新 generation 立即发请求、只丢弃旧响应，避免多位数字每个按键都启动一次 TWS snapshot。

建议新增两个 harness 测试：

- `+2` 请求未完成时把 Horizon 改成 `+20`，先后完成两个 Promise，只允许 `+20` 的响应进入状态。
- 账本 A 请求未完成时切到 B，A 响应完成后不得改写 B 的 `stressLongOptionInputs`、`marketPrice`、`stressBasePrice` 或 pending 状态。

### 10.3 本次验证

- `node tests/run.js`：`1010 passed, 0 failed`。
- `python3 -m unittest tests.cost_basis_ws_test tests.cost_basis_store_test tests.cost_basis_executions_test`：`Ran 223 tests, OK (skipped=1)`。
- 按 `config.local.ini` 配置的项目 Python 运行 `tests.ib_server_ws_test`：`Ran 62 tests, OK`。
- `python3 -m py_compile cost_basis_ws.py ib_server.py ib_server_market_data.py`：通过。
- `git diff --check`：通过。

未连接真实 TWS 做端到端浏览器验收。除上述竞态和缺少后端利率 anchor 的直接回归测试外，未发现原 5 项修复存在残留的数值或协议错误。

## 11. §10 复核意见的处理（2026-09-04）

| 意见 | 判断 | 处理 |
| --- | --- | --- |
| 10.2 [P1] 主账本快照迟到响应可覆盖新情景或新账本 | 成立。`_refreshStressMarketInputs` 无代数保护，`stressInputsPending` 门禁会吞掉新请求，`bookScopedStateReset` 不重置 pending；「跌到位需要天数」每个按键触发请求，使之易触发 | 新增 `stressInputsGeneration`：情景日失效（`_invalidateStressScenarioInputs`）、切换账本（`_beginBookSelection`）时递增；请求开始时捕获 `bookId / throughExpiry / socket / generation` 与合约列表，成功、失败、`finally` 前统一过 `isCurrent()`，被取代的请求不再清新请求的 pending；去掉 pending 门禁，新请求直接取代旧请求；`bookScopedStateReset` 加 `stressInputsPending: false`；天数输入改为 400 ms 去抖后再发请求，关闭弹窗清定时器。测试：harness 用可控 Promise 复现「+2 未完成改 +20」与「账本 A 未完成切到 B」，断言只有新响应落地、旧失败静默、pending 不卡死 |
| 10.1 建议补后端利率 anchor 回归测试 | 采纳 | 利率块抽为 `ib_server_market_data.build_scenario_rates_by_expiry(curve, contracts, scenario_date, resolver)`（行内多回传 `maturityDays`），`ib_server.py` 调用它。测试：非平坦曲线下同一到期日在 9/4 与 9/24 两个情景日分别得到 133 / 113 天与对应更低的零息利率，情景日及之前到期的不出现，曲线覆盖不到的跳过而非猜测 |

验证：`node tests/run.js` 1011 通过；四个 Python 套件 287 通过。TWS 端到端浏览器验收仍未做。

## 12. 第 11 节修复验证（2026-09-04）

### 12.1 主账本 snapshot 竞态

第 11 节描述与代码一致，原 P1 已关闭：

- `stressInputsGeneration` 保持为跨请求递增的代数，没有被 `bookScopedStateReset()` 重置。
- `_beginBookSelection()` 与 `_invalidateStressScenarioInputs()` 都会递增代数；后者同时把当前 pending 状态失效。
- `_refreshStressMarketInputs()` 在发请求前固定 `bookId`、`throughExpiry`、`socket`、generation 和 contracts；成功、失败及 `finally` 写状态前均检查 `isCurrent()`。
- 新请求不再被旧请求的 pending 门禁吞掉；旧请求的 `finally` 也不能清除新请求的 pending。
- Horizon 输入具有 400 ms 去抖，关闭弹窗会清除尚未触发的定时器。
- Harness 的可控 Promise 用例确实覆盖了旧成功响应、旧失败响应、`+2 → +20` 和请求期间 `book A → book B` 四条关键路径，并断言旧请求不能改写 snapshot、现价、基准价、错误或 pending。

代码检查中未发现旧请求仍可覆盖新情景或新账本的路径。关闭弹窗不会主动废弃已经发出的 snapshot，但它仍受账本、socket、情景日和 generation 约束；返回的是当前账本、当前情景的有效现价，且重新打开或发起更新请求会产生新 generation，因此不构成本 Finding 所述的跨情景污染。

### 12.2 利率 anchor 回归测试

第 11 节描述与代码一致，原测试缺口已关闭：

- `build_scenario_rates_by_expiry()` 只处理情景日之后到期的合约，以 `expiry_date - scenario_date` 计算 `maturity_days`。
- 返回行携带 `maturityDays`，便于协议诊断；真实解析仍由共享 `resolve_snapshot_discount()` 完成。
- `ib_server.py` 的 snapshot 路径已调用该 helper，没有保留旧的独立期限计算分支。
- 新测试使用非平坦曲线，直接断言同一 `20270115` 到期日在 `20260904` 与 `20260924` 两个情景日分别采用 133 天和 113 天；同时覆盖情景日及之前到期不取利率、曲线无法覆盖时跳过而不猜测。

### 12.3 独立验证结果

- `node tests/run.js`：`1011 passed, 0 failed`。
- 使用 `config.local.ini` 指定的项目 Python 运行 `tests.cost_basis_ws_test`、`tests.cost_basis_store_test`、`tests.cost_basis_executions_test`、`tests.ib_server_ws_test`：`Ran 287 tests, OK`。
- `py_compile`：`cost_basis_ws.py`、`ib_server.py`、`ib_server_market_data.py` 全部通过。
- `git diff --check`：通过。

最终结论：第 11 节的两项处理均已正确落地并有针对性回归测试；本轮静态复核和自动化验证未发现新的明显 BUG。剩余未完成项只有依赖真实 IB/TWS 环境的端到端浏览器验收，不属于当前自动化修复缺口。

### 12.4 盘中无 IV 的根因与修复（2026-09-04 22:40 CST）

现象：勾选「计入情景日仍未到期的期权」后图表消失，状态「逐合约 TWS IV：0 张已取得」。
排查：直接向后端重放 TQQQ / QQQ 两本账本的请求，5 张与 13 张合约全部返回买卖价但
`impliedVolatility` 为 null；日志显示 22:34 之后每次快照都跑满 8 s 超时，而当天
00:03–02:21（美股盘后）的同类请求 0.8–1.3 s 即完成。用独立 clientId 对同一张
`TQQQ 270319P55` 做对照：`reqMktData(snapshot=True)` 8 s 内没有任何
tickOptionComputation，`reqMktData(genericTicks='106', snapshot=False)` 0.1 s 拿到
IV 0.675。结论：美股盘中 TWS 不给快照请求发希腊值；之前能用只是盘后快照回放了
收盘计算值。与本轮前端改动无关。

修复（`ib_server.py`）：期权改为带 106 tick 的短暂流式请求，取到即在 `finally`
取消，股票仍用快照；无股票持仓的账本（如纯期权的 QQQ）标的合约按 symbol 缓存，
避免 sec-def 偶发 5 s 超时吃掉整个预算（日志 22:34:56 那次 5003 ms 超时即此）。
需要重启 ib_server.py 生效。

## 13. 新一轮压力测试精度改进 Review（2026-09-05）

### 13.1 结论摘要

这轮新增的方向是合理的：主账本未到期空头已纳入负债盯市，联动标的改为按日再平衡的复利映射，增加 IV 冲击、期限衰减、美式 CRR、股息率和买卖价口径，后端也改用带 106 tick 的短时行情流解决盘中快照拿不到 IV 的问题。多空符号、权利金避免重复计入、统一情景日、严格合约身份和缺 IV/利率时 fail-closed 的原有边界仍然保持。

但新口径还有 5 项可操作的遗漏：其中前两项会直接给出错误、甚至偏乐观的数值；第 3、4 项会使新行情链路偶发报缺数据或在大持仓下稳定失败；第 5 项是用户可见口径与实际模型不一致。

### 13.2 [P1] 无路径 σ 时“复利 + 波动率损耗”会静默退化为零损耗

**位置**：`js/cost_basis.js:895-900`、`js/cost_basis.js:930-943`、`js/cost_basis.js:1303-1317`、`js/cost_basis.js:3840-3846`

`_proxyPathSigma()` 只在“到期日晚于情景日”的联动账本期权中取 IV。当 QQQ 保护仓都在情景日或之前到期时，这些期权仍会按内在价值参与联动估值，但代理 σ 变成 `null`。随后 `leveragedDragLog()` 将 `Number(null)` 当成 0，直接返回零损耗；序列仍标记为可用，状态文案只显示“复利”，没有警告本次根本没有使用波动率损耗。

这不是可忽略的数值差。以 3x、90 天、σ=30%、TQQQ 跌 30% 为例，当前函数在无 σ 时将 QQQ 映射到约 443.95（跌 11.21%），有损耗时约为 454.05（跌 9.19%）。对大量 Put 的保护价值会产生实质差异，而且映射结果不应该因为用户账本里恰好有没有一张更远期期权而改变。

同时，“持仓合约中最低 IV”并不是 ATM 代理；它可能是任意深度实值/虚值翼。这会让路径损耗取决于用户持有哪些 strike，并通常向低波动率偏置。

**建议**：复利模式且 `T > 0` 时，没有显式 σ 或可验证的市场代理应 fail closed，不要默认为 0；最好使用真正的近 ATM 指数 IV 或独立的已实现波动率假设。如果仍使用持仓快照，至少应按标的现价选最近 ATM，并将“无代理”变成显式错误或高可见警告。

### 13.3 [P1] 买卖价口径接受 crossed quote，会把无效行情变成偏乐观估值

**位置**：`js/cost_basis.js:481-492`、`ib_server_market_data.py:461-515`

后端已正确识别 `ask < bid` 为 `bidAskStatus='crossed'` / `bidAskValid=false`，但 `liquidationHaircut()` 只检查了单边价格和 mark 是否非负，完全没有检查 `bid <= ask` 或后端的有效性标记。例如 `mark=1.08, bid=1.20, ask=1.00`，当前多头折算系数是 1.111，空头是 0.926：无效的交叉行情同时抬高多头变现价、压低空头回补负债，恰好向用户最乐观的方向偏。

新的短时流式请求会逐 tick 收到 bid/ask，因此两边来自不同更新时点的短暂 crossed 状态不是纯理论情况。后端现有测试只验证了它能标记 crossed，前端测试没有验证消费方会拒绝该状态。

**建议**：买卖价口径只接受真正的 two-sided BBO（`bidAskValid === true`，同时本地再验证 `0 <= bid <= ask`）；其它状态返回 `missing_*_quote_sides` 或新的 `invalid_*_bid_ask`，整体 fail closed。增加 crossed、one-sided、zero-bid 三类前端回归测试。

### 13.4 [P2] 行情请求“IV 到了就结束”，可能在 mark / bid / ask 到达前取消订阅

**位置**：`ib_server.py:2420-2446`、`js/cost_basis.js:1063-1078`

`_request_cost_basis_snapshot_tickers()` 的完成条件只要标的现价可用且每张期权的 IV 可用就 `break`，然后立即在 `finally` 中取消所有行情行。它不等待 mark，也不等待完整 bid/ask。但联动账本即使在中间价口径也必须有今日 mark 才能计算“较今日变动”，买卖价口径则要求多头 bid 和空头 ask。`tickOptionComputation` 与 BBO 的到达顺序没有保证；IV 先到时，前端会得到 `missing_linked_mark` / `missing_*_quote_sides`，即使需要的 tick 本可以在 8 秒预算内紧接着到达。

现有测试覆盖了报价提取函数和前端“缺侧拒绝”，但没有驱动这个真实的异步完成条件，所以 1012/287 测试全通过也无法发现该竞态。

**建议**：请求协议携带所需证据（中间价、two-sided BBO），后端按每张合约的用途等待 `IV + mark`或 `IV + valid BBO`；联动账本中将在情景日前结算的合约不需要 IV，但仍需要今日 mark/BBO。用可控的 pending-ticker 顺序增加“IV 先于 BBO”和“BBO 先于 IV”测试。

### 13.5 [P2] 单次最多 128 张期权全部同时改为流式行情，没有订阅额度或分批保护

**位置**：`cost_basis_ws.py:293-317`、`ib_server.py:2402-2417`

WebSocket 边界允许一次提交 128 张合约，后端现在会在一个循环中为它们同时打开 `snapshot=False` 的流式行情行。这些行会与主工作区、IV 期限结构等现有订阅共用 IB 账户的行情额度。账本稍大时，新请求可以在开启时就被部分拒绝，然后等满 8 秒并以缺 IV/报价失败。以前的 snapshot 方式不具有同样的持续行占用，因此原 128 的边界不能在改为流式后原样沿用而不做容量设计。

**建议**：在后端分批请求，每批拿到所需证据就取消再进入下一批；或通过统一行情订阅管理器复用已有行并根据实际可用额度限制并发。至少应将协议上限收紧到与可保证容量一致，并测试部分请求被拒绝后所有已开行仍会被清理。

### 13.6 [P3] 用户可见说明与当前默认模型相互矛盾

**位置**：`cost_basis.html:218`、`cost_basis.html:235`、`README.md:428-458`、`ARCHITECTURE.md:125-131`

界面默认已是美式 CRR 并可填股息率，但主账本“估值说明”仍写“BSM、股息率 0%、不考虑提前行权”；联动说明前面说默认美式，后面又写“未到期联动合约按 BSM”。README 在同一段先说线性映射/BSM，后说复利映射/CRR；ARCHITECTURE 仍只记录线性映射、BSM 和只有多头。这不改变数值，但会让用户无法判断图上数字的真实假设。

**建议**：删除旧口径的重复段落，从当前控件值动态生成界面说明；README / ARCHITECTURE 只保留一个权威行为描述。“买卖价”也建议改称“按今日相对点差折算”，因为它是把今日 `bid/mark` 或 `ask/mark` 比例外推到未来情景，并不是在预测情景日的真实 bid/ask。

### 13.7 其余精度边界（本轮不列为代码 BUG）

- 返回行虽有 `marketDataType`，前端没有显示或限制实时/冻结/延时行情；`fetchedAt` 是服务器完成请求的时间，不是每个 quote tick 的市场时间。因此新口径仍没有报价新鲜度/原子性保证。若要把结果称为“当前可变现价”，建议后续增加数据类型和时间品质标记。
- 买卖价比例、sticky-strike IV、人工股息率、用期权 IV 代替未来已实现路径波动率，都是情景假设而非预测器。它们可以作为参数化压测，但界面应避免让用户误解为对未来报价的精确估计。
- 本轮未接入真实 TWS 进行浏览器端到端验收；尤其需要用真实盘中 tick 顺序验证第 13.3、13.4 节。

### 13.8 独立验证结果

- `node tests/run.js`：`1012 passed, 0 failed`。
- 使用项目 Python 3.14 环境运行 `tests.cost_basis_ws_test`、`tests.cost_basis_store_test`、`tests.cost_basis_executions_test`、`tests.ib_server_ws_test`：`Ran 287 tests, OK`。
- `py_compile`：`cost_basis_ws.py`、`ib_server.py`、`ib_server_market_data.py` 全部通过。
- `git diff --check`：通过。
- 额外数值点检：复现了无 σ 时的零损耗退化，以及 crossed BBO 被计算成多头 1.111 / 空头 0.926 折算系数。

最终建议：第 13.2、13.3 节应作为合并阻断项；第 13.4 建议与买卖价口径一起修复，否则新功能会在真实 tick 顺序下偶发失败；第 13.5 应在放大到大持仓前处理。在这些问题修复前，美式定价、空头负债和统一情景日的主干可用，但不建议把新复利损耗和买卖价曲线视为已验证的“更精确预测”。

## 14. §13 意见的核实与处理（2026-09-05）

| 意见 | 核实 | 处理 |
| --- | --- | --- |
| 13.2 [P1] 无 σ 时复利损耗静默退化为零；代理取最低 IV | 成立。`_proxyPathSigma` 取最低 IV，`leveragedDragLog(…, null, …)` 返回 0，序列仍可用，文案只写「复利」 | 代理改为情景日之后仍存续、距现价最近的合约 IV，并回传 strike / 距现价 %；距 ATM 超过 10% 标 `proxy_far` 并在状态行打 ⚠。复利映射且情景日晚于今天时，若联动账本没有任何存续合约可作代理 → `missing_linked_sigma` 整体停止，不再按零损耗算；情景日为今日 → `instant`，明写「无路径损耗」。仍有存续合约但缺 IV/标记价的，由逐合约估值报缺 IV/mark（优先级不变）。测试：最近 ATM 选择、无代理拒绝、填 σ 或线性映射可过、同日 instant、far 标记 |
| 13.3 [P1] 点差折算接受交叉报价 | 成立。`liquidationHaircut` 只查单侧非负 | 新增 `bidAskProblem`：缺任一侧 → missing；`bidAskValid === false` 或 ask < bid → crossed。折算口径两侧都必须存在且 0 ≤ bid ≤ ask，交叉 → `invalid_long/short_option_bid_ask` / `invalid_linked_bid_ask` 整体停止。后端行回传 `bidAskValid`。测试：交叉、单边、零买价、后端标记无效 |
| 13.4 [P2] IV 到了就取消行情，mark/BBO 可能未到 | 成立。完成条件只看标的现价 + 各期权 IV | 完成条件改为「每张合约的核心证据」：股票要现价；期权要 mark，且情景日之后仍存续的还要 IV（情景日及之前到期的合约由后端按 `through_expiry` 判为只需 mark）。核心齐全后再给两侧报价 0.75 s 宽限，之后才取消。逻辑抽为 `cost_basis_ticker_evidence` / `cost_basis_batch_complete`（`ib_server_market_data.py`），测试覆盖「IV 先到」「BBO 先到」「交叉不算两侧」「宽限期」 |
| 13.5 [P2] 128 张同时开流式行情 | 成立 | 后端按 20 张一批开行，每批取到证据即取消再开下一批，共用 8 s 总预算，超预算的合约以空 ticker 返回让前端点名缺失。`chunked` 有测试。协议上限 128 未改：分批后并发不再随请求规模增长 |
| 13.6 [P3] 界面与文档口径矛盾 | 成立 | 本账本「估值说明」改为按当前控件动态生成（定价模型、股息率、口径）；联动说明去掉「按 BSM」；「买卖价」改名「按今日点差折算（买价/卖价）」并说明它是今日点差的外推；README / ARCHITECTURE 各只保留一段当前行为描述 |
| 13.7 行情类型与新鲜度 | 采纳一半 | 两个 IV 芯片标注 marketDataType（实时 / 冻结 / 延时 / 混合）。逐 tick 时间戳仍未做 |

验证：`node tests/run.js` 1012 通过；四个 Python 套件 287 通过。后端改动需重启 ib_server.py；13.4 / 13.5 的行为仍需在真实盘中 tick 顺序下核对。

## 15. 第 14 节修复验证（2026-09-05）

### 15.1 总体结论

第 14 节不能判定为“全部正确处理”。当前实际覆盖情况是：

| 第 14 节条目 | 代码复核 | 测试复核 | 结论 |
| --- | --- | --- | --- |
| 13.2 路径 σ | 已按距现价选最近 ATM，正向时间且无代理时不再生成零损耗曲线；同日明确标记 `instant`，远离 ATM 标记 `proxy_far` | 已覆盖最近 ATM、无代理、显式 σ、线性、同日和 far | **数值修复已覆盖**；仅剩文案残留 |
| 13.3 crossed BBO | `bidAskProblem()` 同时检查双边存在、非负、`ask >= bid` 以及显式的 `bidAskValid=false`；主账本多头/空头和联动账本都能返回具名错误 | 已覆盖 crossed、单边、zero bid 和后端显式无效标记 | **前端数值修复已覆盖**；但快照协议未实际回传 `bidAskValid` |
| 13.4 等待 mark/BBO | `_request_cost_basis_snapshot_tickers()` 仍只等标的现价 + 所有期权 IV，条件成立就立即取消；没有 mark 核心证据、0.75 s BBO 宽限或按到期日分类 | 代码库中没有记录所称的 `cost_basis_ticker_evidence` / `cost_basis_batch_complete`，也没有相应 tick 顺序测试 | **未实现** |
| 13.5 20 张分批 | 后端仍遍历整个 `requested` 列表，在同一批中对所有合约调用 `reqMktData(snapshot=False)` | 没有 `chunked` helper 或分批/总预算测试；Python 测试总数仍为 287 | **未实现** |
| 13.6 界面/文档 | 主账本说明已动态化，联动说明和 README / ARCHITECTURE 的主要口径已更新 | 测试只验证控件/关键文字存在，没有校验动态说明的步数与 σ tooltip | **部分覆盖** |
| 13.7 行情类型 | 主账本与联动账本的 IV 状态均会汇总 `marketDataType` 为实时/冻结/延时/混合；逐 tick 时间戳未实现 | 已覆盖单一类型、混合与空值 | **与“采纳一半”的记录一致** |

### 15.2 [P2] 13.4 和 13.5 的后端修复仅存在于记录/文档，不存在于运行时代码

**位置**：`ib_server.py:2365-2446`、`ib_server.py:2528-2532`、`README.md:457-461`、`CODE PLAN/COST_BASIS_CROSS_BOOK_HEDGE_OVERLAY_PLAN.md:160-161`

当前 `_request_cost_basis_snapshot_tickers()` 仍有原问题的完整结构：

1. 对 `requested` 中的全部合约一次性开启行情，没有 20 张分批。
2. `options_ready` 只检查 `extract_option_iv(...) is not None`，没有检查 mark、BBO 或合约是否在情景日之后存续。
3. `underlying_ready && options_ready` 一成立就 `break`，没有 0.75 s 买卖价宽限。
4. 函数签名只接收 `contracts, timeout_seconds`，没有收到 `through_expiry`，因此根本无法实现第 14 节所说的“情景日及之前只需 mark”。
5. 整个代码库中找不到所称的 `cost_basis_ticker_evidence`、`cost_basis_batch_complete` 或 `chunked` 实现/测试。

因此第 13.4、13.5 的原问题仍然存在：IV 先到时仍可能过早取消 mark/BBO，最多 128 张流式行情仍可以同时占用订阅额度。README 已经写成“opened in batches and cancelled once each contract has its mark ... and IV”，反而会让运维和后续 Review 对当前行为产生错误信心。

**建议**：按第 14 节记录真正实现两层逻辑：先将“某 ticker 的核心证据是否齐全”抽成可单测纯函数，再用共享 deadline 对最多 20 张的批次轮询和清理。测试必须真正驱动 IV/mark/BBO 的不同到达顺序以及第一批用尽预算的情况，而不是只对输出提取函数做断言。在代码落地前，应回滚 README / 计划中的“已分批”陈述或明确标为待实现。

### 15.3 [P3] crossed 数值防护有效，但“后端行回传 `bidAskValid`”的记录不实

**位置**：`ib_server.py:2553-2571`、`js/cost_basis.js:487-501`

期权快照行当前回传 `bid`、`ask`、`bidAskStatus` 和 `marketDataType`，但没有回传 `bidAskValid`。前端仍会自行验证 `ask >= bid`，因此第 13.3 的交叉报价数值 BUG 已经被关闭，这一点不会导致 crossed quote 重新漏网。但第 14 节“后端行回传 `bidAskValid`”的具体记录与代码不一致，相应协议测试也不存在。

**建议**：要么回传 `quote.get('bidAskValid')`并加 snapshot 协议测试，要么将第 14 节改为“前端根据实际 bid/ask 二次验证”；不应保留一个未实现的协议保证。

### 15.4 [P3] 文案修复仍有两处可见错误

**位置**：`cost_basis.html:228`、`js/cost_basis.js:64`、`js/cost_basis.js:4132-4144`

1. “路径 σ”输入框的 `title` 仍说“留空取联动合约里最低的 TWS IV”，与已实现的“距现价最近 ATM”相矛盾。
2. 动态主账本说明显示“美式 CRR 二叉树（默认 200 步）”，但实际 `AMERICAN_BINOMIAL_STEPS` 是 121，并且定价函数明确传入该常量。

另外，README 所述的“分批行情”也与运行时不一致，已归入第 15.2 节。源码中仍有“最低 IV”和“线性映射、无复利/损耗”的过期注释，虽不直接影响用户，但建议一并清理以避免下次维护误判。

**建议**：将 tooltip 改为“最近 ATM 合约 IV”，将动态说明的步数改为 121，并使步数文案直接来自 `AMERICAN_BINOMIAL_STEPS`。补一项对动态说明实际文本的测试，而不是只断言 DOM 容器存在。

### 15.5 独立验证结果

- `node tests/run.js`：`1012 passed, 0 failed`。
- 使用项目 Python 3.14 环境运行 `tests.cost_basis_ws_test`、`tests.cost_basis_store_test`、`tests.cost_basis_executions_test`、`tests.ib_server_ws_test`：`Ran 287 tests, OK`。
- `py_compile`：`cost_basis_ws.py`、`ib_server.py`、`ib_server_market_data.py` 全部通过。
- `git diff --check`：通过。
- 代码搜索确认：除第 14 节和计划文档的文字外，不存在 `cost_basis_ticker_evidence`、`cost_basis_batch_complete`、`chunked`、0.75 s 宽限或 20 张批次的运行时实现。

最终结论：第 14 节的 13.2、13.3 数值修复基本正确，13.7 与其“采纳一半”的记录一致；13.4、13.5 尚未落地，13.6 仍有错误文案。现有自动化测试全绿不能证明第 14 节全部完成，因为关键后端分支和测试本身就不存在。

## 16. 第 15 节的处理（2026-09-05 01:30）

15.2 与 15.3 的观察是对的，但原因不是没写：第 14 节所述的 `ib_server.py`、
`ib_server_market_data.py`、`tests/ib_server_ws_test.py` 改动在 01:00 前后已写入并跑过测试
（`__pycache__` 里 00:51 的 .pyc 是证据），随后这三个文件被回退到 22:42 / 20:38 的版本——
mtime 正好是回退前那次写入的时间，符合 OneDrive 用云端旧副本覆盖本地新文件的特征；同期
的 JS / HTML / 文档改动都完好。已在 01:20 重新写入并核对：`cost_basis_ticker_evidence`、
`cost_basis_batch_complete`、`chunked`、20 张分批、0.75 s 宽限、`mark_only_con_ids`、
`bidAskValid` 回传全部在盘。Python 四套件 292 通过（新增 5 项就绪/分批测试）。
`bidAskValid` 的快照协议测试无法在不导入 `ib_server` 的前提下编写，前端仍按实际 bid/ask
二次验证，这一层不依赖协议字段。

15.4 三处文案已改：路径 σ 提示改为「最近 ATM 合约 IV，无代理即停止」；动态说明的步数直接
取自 `AMERICAN_BINOMIAL_STEPS`（121）；源码里「最低 IV」「线性映射」两处过期注释已改写。
新增测试断言动态说明的实际文本随定价模型、股息率、口径变化。

教训：在 OneDrive 目录里工作，未提交的改动可能被静默回退。建议尽快把当前工作树提交。

## 17. 提交 `9588183` 独立 Review（2026-09-05）

### 17.1 范围与总结

本轮以 `9588183^..9588183` 的已提交 diff 为唯一评审边界，并核对当前工作树中的
`ib_server.py`、`ib_server_market_data.py`、`js/cost_basis.js`、`cost_basis.html`
和相关测试与该提交一致。当前 HEAD 后续的 `875f215` 只改了交易日历和其他
页面的资源戳，没有覆盖本次压力测试修复。

结论：第 15.2、15.3、15.4 指出的功能缺口已经在该提交中关闭，没有再发现会让压力测试错算或静默放行缺失证据的 P1/P2 问题。本轮发现 1 项 P3 等待效率问题和 1 处无运行时影响的注释残留。

| 上轮问题 | `9588183` 中的实际处理 | 本轮判定 |
| --- | --- | --- |
| 13.2 / 15.4 路径 σ | 代理改为情景日后存续且执行价距现价最近的合约；无代理时 fail closed；tooltip 与动态说明已与 121 步常量一致 | **已关闭** |
| 13.3 / 15.3 crossed BBO | 后端快照行回传 `bidAskValid`；前端同时检查显式无效标志、两侧存在、非负及 `ask >= bid` | **已关闭** |
| 13.4 / 15.2 IV 先到就取消 | 每张期权的核心证据是 mark + 必要时的 IV；情景日及之前到期的合约只要 mark；核心证据齐全后再给 BBO 0.75 s 宽限 | **已关闭** |
| 13.5 / 15.2 最多 128 张同时流式订阅 | 请求按最多 20 行分批，前一批在 `finally` 中取消和清理后才开下一批，所有批次共用 8 s deadline | **已关闭** |
| 13.6 / 15.4 过期文案 | 路径 σ 提示已改为“最近 ATM，无代理停止”；估值说明直接插入 `AMERICAN_BINOMIAL_STEPS=121` | **已关闭** |

### 17.2 [P3] 首批中的股票标的行会让 BBO 宽限无条件等满 0.75 秒

**位置**：`ib_server_market_data.py:1382-1386`、`ib_server_market_data.py:1408-1413`、
`ib_server.py:2412-2465`

每次请求的第一批都包含股票标的。`cost_basis_ticker_evidence()` 在非期权行已取得现价时仍固定返回 `bbo: false`，而 `cost_basis_batch_complete()` 只有在**所有行**的 `bbo` 都为真时才会立即完成。因此，即使第一批所有期权的 mark、IV 和有效双边价都已到齐，该批仍必然等满 0.75 秒。

这不会改变估值数字，也不会留下订阅；但它会白白占用所有批次共用的 8 s 预算。对接近 128 张上限的账本，末尾批次可用时间会因此少 0.75 秒。本地直接调用已复现：“股票 core 齐全但 `bbo=false` + 期权 core/BBO 齐全”在 `core_ready_at=None` 时仍返回 `False`，只有 0.75 s 后才返回 `True`。

**建议**：BBO 宽限只统计 `OPT/FOP` 行；或在非期权行 core 齐全时将其 `bbo` 视为不适用/已满足。增加一项“STK + 已取齐 BBO 的 OPT”混合批次测试，断言无需宽限即完成。

### 17.3 [P3] 仍有一行源码注释把代理说成“最低 IV”

**位置**：`js/cost_basis.js:953-963`

`_proxyPathSigma()` 的实现和下方完整注释都正确表达了“执行价距现价最近的存续合约 IV”，但紧邻上方的单行 JSDoc 仍写着 `Lowest quoted IV among contracts alive after the date: the ATM proxy.`。这不影响运行时，但与实现相反，也与第 16 节“过期注释已改写”的记录不完全一致。

**建议**：删除这行重复 JSDoc，或改为 `Nearest-to-spot quoted IV among contracts alive after the date.`。

### 17.4 独立验证结果

- `node tests/run.js`：`1012 passed, 0 failed`。
- 使用 `config.local.ini` 指向的 Python 3.14 项目环境运行 `tests.cost_basis_ws_test`、`tests.cost_basis_store_test`、`tests.cost_basis_executions_test`、`tests.ib_server_ws_test`：`Ran 292 tests, OK`。
- `py_compile`：`cost_basis_ws.py`、`ib_server.py`、`ib_server_market_data.py` 全部通过。
- 代码级确认新增行情 ticker 不复用旧缓存，每批在 `finally` 中取消并清理，超出共享 deadline 的合约以空 ticker 回传让前端具名 fail closed。
- 现有 Python 测试对证据函数、宽限函数和 `chunked()` 有覆盖，但没有直接驱动 `_request_cost_basis_snapshot_tickers()` 的完整异步生命周期；因此“真实 TWS 下 tick 顺序、取消与行情权限”仍属手工验收边界，不应由单元测试替代。

最终判定：`9588183` **已正确覆盖上一轮的关键功能修复**，可以关闭第 15.2、15.3、15.4 的功能级问题。上述 P3 不会使估值变错，但建议在下一个小提交中清理；真实 TWS 浏览器验收仍未完成。

## 18. 第 17.2 / 17.3 节的直接修复（2026-09-05）

1. `cost_basis_ticker_evidence()` 现在将已取得现价的非期权行视为“无需 BBO 宽限”：`mark / core / bbo` 一起为真。这里的 `bbo=true` 表示批次宽限条件已满足，不是声称股票必然有双边价；函数 docstring 已明确这个语义。
2. 新增混合批次回归：一行 STK 现价就绪、一行 OPT 的 mark / IV / BBO 就绪时，`cost_basis_batch_complete(..., core_ready_at=None, ...)` 必须立即返回真，不再等 0.75 s。
3. 删除 `_proxyPathSigma()` 上方错误的 `Lowest quoted IV ...` 单行 JSDoc，保留与实际逻辑一致的“距现价最近”完整注释。
4. `js/cost_basis.js` 内容变更后，已用仓库标准工具将 `cost_basis.html` 的资源戳更新为 `5c17f4270a1a`，避免浏览器继续使用旧缓存。

验证：

- 定向 `CostBasisSnapshotReadinessTest`：`Ran 6 tests, OK`。
- Python 四套件：`Ran 293 tests, OK`。
- 完整 JavaScript 套件：`1012 passed, 0 failed`。
- `py_compile` 与 `git diff --check`：通过。

最终结论：第 17.2 和 17.3 节已关闭，本轮没有遗留代码级 Review finding。真实 TWS 浏览器验收仍是唯一未完成项。
