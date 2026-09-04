# 压力测试跨账本保护叠加实施计划

> 文件用途：这是 `cost_basis.html` 到期压力测试的扩展计划，与既有
> `COST_BASIS_LEDGER_PAGE_PLAN.md` §7 / §10 中的压力测试分开验收。
>
> 状态：阶段 1–4 已实现并通过自动验收（`node tests/run.js` 1010 通过，2026-09-03）；
> 待 TWS 连接后做 §9 浏览器手工验收  
> 制定日期：2026-09-03  
> 已确认口径：叠加同账户另一本账本里的**全部未平多头期权（Long Call 与 Long Put 一起）**；
> 价格映射先用线性收益率外推，不做路径依赖。

## 1. 目标与不变量

目标是在 TQQQ 这类杠杆 ETF 账本的到期压力测试里，把同一 IB 账户下
QQQ 账本中的 Long Call / Put 当作跨标的保护一起估值，得到一条
「计入跨账本多头期权后盈亏」曲线。TQQQ 自身的扫描、结算回放与本账本
Long Call / Put 叠加逻辑**一行不动**。

以下不变量不可妥协：

1. 跨账本期权**只来自账本**（`cost_basis.db` 里同账户的另一本 STK 账本），
   不直接读 TWS 持仓。理由与主计划 §2 相同：只有账本能给出 `openPremium`、
   `conId / localSymbol` 与是否存在 `identityConflict`；TWS 持仓只用于
   逐合约 IV 与现价快照，仍然永不写入账本。
2. 叠加是**纯只读**的情景估值。不产生事件、不修改任何一本账本的 state，
   不切换当前 `state.bookId`，弹窗关闭后不留下任何行情订阅。
3. 叠加缺任何一张合约的 TWS IV、折现利率或联动标的现价，整体标记
   `unavailable` 并给出可读原因；**不使用统一假设 IV，不静默丢弃合约**。
   与现有 `missing_long_option_iv / missing_discount_rate` 同一原则。
4. 价格映射是**一个纯函数、一处调用**。当前实现为线性收益率外推；
   将来换成复利一致映射或历史 β 回归，只替换该函数与其测试。
5. 不叠加时 `buildStressTestSeries` 的输出必须与现在**逐字段相同**，
   现有 `tests/cost_basis_page.test.js` 中的压力测试断言不得改动。
6. 联动账本里的**空头**期权与股票仓位不计入。本功能回答的是
   「这些多头期权在情景日值多少钱」，不是合并两本账本的总盈亏。
7. **三项永远同一个情景日**。① 的结算日、② 与 ③ 的 BSM 估值日、TWS 利率的
   起算日是同一个 `throughExpiry`；任何「只给某一项换日期」的参数都不允许存在
   （2026-09-04 Review P1/P2）。
8. **联动账本必须与本账本同币种**。候选列表按币种过滤，`buildStressTestSeries`
   再校验一次（`linked_currency_mismatch`），没有汇率换算（Review P2）。
9. **合约身份严格分层匹配**，前后端同规则：账本行有 conId 只按 conId 匹配；只有
   localSymbol 只按 localSymbol；两者都没有才按 right / expiry / strike 匹配，且
   双方都知道 multiplier 时必须相等。强身份缺席但存在同条款报价 →
   `long_option_identity_mismatch` / `linked_option_identity_mismatch`，不降级（Review P2）。

## 2. 需求与边界

原始需求：

- 持有大量 TQQQ 头寸（股票 + 卖方期权），同时在 QQQ 上持有大量 Long Put
- TQQQ 与 QQQ 并非严格 3 倍线性关系，但先忽略复利与波动损耗
- TQQQ 下跌 30% 时假定 QQQ 下跌 10%，线性外推
- 想在到期压力测试里看到 QQQ Long Options 对 TQQQ 头寸的保护效果

边界：

- 只做「一本主账本 + 一本联动账本」。同账户多本联动账本、跨账户联动
  不在本期范围。
- 联动账本必须是 `secType = STK`，且与主账本同一 `account`、不同 `symbol`。
  FUT 账本不参与。
- 主账本目前也必须是 STK。FUT 主账本的压力测试尚未定义，本计划不扩展。

## 3. 数据来源

### 3.1 联动账本的期权仓位

1. 用户在压力测试弹窗选择联动账本。候选列表来自 `state.books`，过滤条件：
   `book.account === 当前账本.account && book.secType === 'STK'
   && book.bookId !== state.bookId`。
2. 选中后前端用现有 `list_cost_basis_events`（`bookId` 换成联动账本，
   `includeVoided: true`，沿用 `LEDGER_FETCH_SIZE` 分页）在后台拉全部事件，
   再调用 `core.computeLedger(events, { secType: 'STK' })` 得到
   `ledger.openOptions`。**不写入 `state.allEvents` / `state.ledger`**，
   存放在独立的 `state.stressLinked*` 字段里（见 §7）。
3. 从 `openOptions` 取 `contracts > 0` 且 `right ∈ {C, P}` 的全部合约。
   到期日不做过滤：早于或等于情景日的按内在价值结算（见 §5）。
4. 若同账户没有可选的联动账本，下拉显示「同账户没有其它 STK 账本」，
   叠加开关不可用。**不提供 TWS 持仓兜底**。
4a. 预选规则由纯函数 `chooseLinkedBook(book, candidates, remembered)` 决定：
   localStorage 记忆优先（账本仍存在时）；否则按 `LINKED_HEDGE_DEFAULTS`
   预置（当前只有 `TQQQ → QQQ, ratio 3`）预选账本但**不自动勾选**；
   其它标的不预选。未来扩展到其它 LETF 只需在该表加一行。
5. 联动账本事件在弹窗打开期间缓存；主账本切换、联动账本切换或点击
   「刷新」时重新拉取。用 generation 计数丢弃迟到响应，模式同 `_loadEvents`。

### 3.2 联动标的现价、逐合约 IV 与折现曲线

复用现有 `request_cost_basis_option_scenario_inputs`，**后端不改**：

- 该接口按 `bookId` 从存储中解析 `account / symbol / secType / currency`，
  并要求每个请求的合约都是该 symbol 下的真实多头 TWS 持仓。前端只需再
  发一次请求，`bookId` 换成联动账本，`contracts` 为 §3.1 第 3 步的合约
  身份（`conId / localSymbol / right / strike / expiry`）。
- 响应里的 `underlyingPrice` 即联动标的的基准价 `S_linked0`。
- `throughExpiry` 传主账本的 `state.stressExpiry`；曲线 `ratesByExpiry`
  由后端按各合约到期日给出。
- 请求行携带 `conId / localSymbol / right / strike / expiry / multiplier`；后端
  `cost_basis_ws.py` 转发 `multiplier`（正数或 None），`ib_server_market_data.py` 的
  `cost_basis_option_request_matches` 按 §1 第 9 条严格匹配，快照行也回传 `multiplier`。
- 请求只包含到期日**晚于**情景日的合约（内在价值结算不需要 IV）；
  若一张都没有，仍需发请求以取得 `underlyingPrice`，此时 `contracts` 为空数组。
  已核对（2026-09-03）：`cost_basis_ws.py` 只要求 `contracts` 是不超过 128 行的
  列表，`ib_server.py` 对空列表只快照标的现价与曲线，**后端无需改动**。
- 两次请求（主账本、联动账本）各自独立的 pending / error / fetchedAt，
  一个失败不影响另一个已取得的结果。

## 4. 价格映射

```
linkedPrice(point) = S_linked0 × (1 + changePct(point) / 100 / ratio)
```

- `ratio` 为面板上可编辑的带符号数字，默认 `3`（TQQQ 1% ↔ QQQ 0.333%）。
  `ratio = -3` 可用于 SQQQ 这类反向杠杆主账本。`ratio` 为 0、非有限数或
  绝对值小于 `0.01` 时视为无效，叠加不可用并提示。
- 映射作用于**收益率**而非价格比。主账本扫描范围最大 ±90%，
  `|ratio| ≥ 1` 时联动价格恒为正；`|ratio| < 1` 时对结果做 `max(0, ·)` 下限。
- 独立纯函数 `mapLinkedUnderlyingPrice(basePrice, changePct, ratio)`，
  只在 `buildStressTestSeries` 内部调用一次。
- 面板固定显示映射说明：`线性收益映射 1 : 3 · 忽略路径依赖与波动损耗`。

## 5. 每个扫描点的联动期权估值

对联动账本每张合格合约，在扫描点 `price` 上：

| 到期日 vs 情景日 `throughExpiry` | 估值方式 | 需要的输入 |
| --- | --- | --- |
| 晚于情景日 | 复用 `estimateDeferredLongOptions`，`scenarioPrice` 换成 `linkedPrice`，`marketInputs` 用联动账本那次请求的响应 | 逐合约 TWS IV、曲线 `r(T)`、`T = 到期日 − 情景日` |
| 早于或等于情景日 | 内在价值：Call `max(linkedPrice − K, 0)`、Put `max(K − linkedPrice, 0)`，乘 `contracts × sharesPerContract` | 无 |

- 新增薄包装 `estimateLinkedLongOptions(openOptions, linkedPrice, { throughExpiry, marketInputs })`
  先按到期日分流，再把两组结果合并成与 `estimateDeferredLongOptions`
  同形状的对象（`available / reason / count / contracts / callContracts /
  putContracts / marketValue / pnl / ivMin / ivMax / rateMin / rateMax / details`）。
- **盈亏口径（2026-09-03 实测后修正）**：`pnl = 情景日市值 − 今日 TWS 标记价市值`，
  即「相对今天多值多少」。已付权利金是沉没成本，不随情景变化，扣掉它只会把
  整条保护曲线压低一个常数，掩盖本功能要看的效果（首次实现用了
  `marketValue + openPremium`，在真实 QQQ 账本上 28 张 Put 的紫线整体低于绿线，
  已改）。今日市值取同一次 TWS 快照里每张合约的 `mark`；缺标记价 →
  `missing_linked_mark`，不用模型价代替。`premiumPnl = marketValue + openPremium`
  只在悬停里作参考。
- 因此联动账本的 TWS 请求要包含**今日之后**到期的全部多头合约（不只是测试日之后），
  测试日前到期的合约也需要标记价作参照；估值时传入 `asOf`（今日），
  到期日 ≤ 今日的合约计为 `expiredContracts`，不估值也不报错。
- 不合格情况与原因码：
  - `missing_linked_book`：未选择联动账本或账本事件尚未载入
  - `invalid_linked_ratio`：映射比率无效
  - `missing_linked_market_inputs`：联动账本的 TWS 参数尚未取得或 `throughExpiry` 不匹配
  - `missing_linked_option_iv` / `missing_linked_discount_rate`：至少一张递延合约缺 IV 或利率
  - `incomplete_linked_option`：合约缺 `strike / contracts / sharesPerContract / openPremium` 或存在 `identityConflict`
  - `invalid_linked_underlying_price`：联动标的现价缺失或非正
  - `missing_linked_mark`：至少一张仍存续的合约没有 TWS 标记价，无法算相对今日的变动
  - `linked_option_identity_mismatch` / `long_option_identity_mismatch`：账本 conId 或 localSymbol 在快照里找不到，但存在同条款的另一张合约
  - `linked_currency_mismatch`：联动账本币种与本账本不同

- **路径 σ 与点差口径的硬边界（2026-09-05 Review §13）**：复利映射在情景日晚于今天时必须有
  路径 σ：显式假设，否则取情景日之后仍存续、距现价最近的联动合约 IV 作代理（回传 strike 与距
  现价 %，超过 10% 标 ⚠），联动账本没有任何存续合约时 → `missing_linked_sigma` 停止，绝不按零
  损耗计算；情景日为今日则无损耗。点差折算口径只接受真正的两侧报价（0 ≤ bid ≤ ask 且后端
  `bidAskValid`），交叉 → `invalid_*_bid_ask`。后端行情按 20 张一批、每张合约取齐「mark +
  （存续则）IV」后再给两侧报价 0.75 s 宽限才取消。

IV 在整条扫描线上固定为当前 TWS 值，与本账本叠加一致。面板明写：
下跌情景中真实 IV 通常抬升，因此保护价值**被低估，方向偏保守**。

## 6. 序列形状与 UI

### 6.1 `buildStressTestSeries` 的新增输入与输出

新增 `opts.linkedHedge`（缺省 `null`，为 `null` 时输出与现在完全相同）：

```
linkedHedge: {
    symbol, bookId,
    openOptions,        // 联动账本 ledger.openOptions
    ratio,
    basePrice,          // S_linked0，来自联动账本 scenario inputs 的 underlyingPrice
    marketInputs,       // 联动账本那次 request_cost_basis_option_scenario_inputs 的响应
}
```

每个 point 新增：`linkedPrice`、`linkedMarketValue`、`linkedReferenceValue`（今日标记市值）、
`linkedPnl`（较今日变动）、`linkedPremiumPnl`（较买入权利金，参考）、`linkedExpiredContracts`、
`linkedCount`、`linkedContracts`、`linkedCallContracts`、`linkedPutContracts`、
`linkedIvMin / Max`、`linkedRateMin / Max`、`linkedAvailable`、`linkedReason`，
以及 `totalPnl = pnl + linkedPnl`（`pnl` 保持现有含义：本账本含多头期权后盈亏）。

series 顶层新增：`linkedHedgeEnabled`、`linkedSymbol`、`linkedRatio`、
`linkedBasePrice`、`linkedCount / Contracts / CallContracts / PutContracts`、
`linkedIvMin / Max`、`linkedRateMin / Max`、`linkedInputsFetchedAt`。
`available` 增加条件：启用叠加时所有点 `linkedAvailable` 为真；
`reason` 优先级：`unresolved_options` > 本账本凸性原因 > 联动原因。

### 6.2 弹窗新增控件（`cost_basis.html`）

在现有 `stress-protection-inputs` 下方新增一组：

| id | 控件 | 说明 |
| --- | --- | --- |
| `stress-include-linked-hedge` | checkbox | 「叠加同账户其它账本的多头期权」 |
| `stress-linked-book` | select | 候选见 §3.1；空时禁用并显示原因 |
| `stress-linked-ratio` | number input | 默认 3，step 0.01，允许负数 |
| `stress-linked-iv-mode` | select | IV 模式，默认 `none`（IV 保持不变 = sticky-strike 保守下限）。`fixed`：全扫描线统一抬升 N 点（上涨侧也抬，只适合「IV 整体变成 X」的问题）。`beta`：每个扫描点抬升 β × max(0, −联动映射跌幅%)，基准点与上涨侧为 0，对应现货与 IV 的负相关（VRP 备忘 E17：SPY/QQQ corr(ret, ΔIV) ≈ −0.7）。按主账本记忆 |
| `stress-linked-iv-shock` | number input | `fixed` 模式的点数，默认空 = 0；点数超出 ±500 或冲击后任一合约 IV ≤ 0 → `invalid_linked_iv_shock` |
| `stress-linked-iv-beta` | number input | `beta` 模式的系数（点 / 每跌 1%），默认 1.5，范围 0–20，否则 `invalid_linked_iv_beta`。1.5 是 NDX/VXN 日频回归的量级，暴跌中更陡；是起点值不是拟合值，后续可用 VRP 数据集回归替换 |
| `stress-linked-iv-tenor` + `stress-linked-iv-tenor-days` | checkbox + number | 仅 `beta` 模式。按期限衰减：每张合约的冲击 × min(1, √(参考期限 ÷ 情景日剩余天数))，参考期限默认 30 天（β 所描述的 IV 期限）。默认勾选。理由：spot-vol β 来自 30 天 IV，暴跌中一年期 IV 只抬前端的 1/3–1/2；用户账本合约距到期 42–651 天，平铺 β=1.5 在 QQQ −10% 给 +78k，衰减后 +35k（2026-09-04 实测）。参考期限无效 → `invalid_linked_tenor_days` |
| `stress-horizon-days`（主控件行，不在联动面板） | number input | 跌到位需要天数。留空 = 在所选到期日结算；填 N 则**整个弹窗的情景日**变为今天 +N 天：① 本账本 N 天内到期的期权按情景价结算，② 与 ③ 仍存续的多头期权都在同一天以 BSM 估值（Theta 计入），TWS 快照（IV、标记价、折现利率）也按该日重新请求，利率期限 = 该日到各合约到期日。非负整数、≤ 3650，否则整体停止并提示。**不按账本记忆**，每次打开留空。选择到期范围会清空天数。2026-09-04 Review P1/P2 的修复：首版把天数只作用于 ③（估值日与 ① 不同、利率仍按测试日解析），已撤销 |

任何模式都只改联动合约的情景市值，今日标记市值不变。状态行的 IV 区间取**基准点**（`series.centerIndex`），悬停给出本点实际冲击点数。**弹窗打开时叠加开关一律不勾选**（`chooseLinkedBook` 永远返回 `enabled: false`）：账本、比率、IV 模式与参数按账本记忆，紫线本身每次都要手动勾选，避免默认假设误导读图（2026-09-04 用户要求）。
| `stress-linked-inputs` | 容器 | 显示联动账本状态两行：`QQQ 账本：N 张 Long Call + M 张 Long Put · 事件 T 条` 与 `逐合约 TWS IV：K 张已取得 · QQQ 基准 $xxx` |
| `stress-linked-note` | small | 固定假设说明：线性映射、IV 固定偏保守、不计空头腿 |

「刷新 TWS 现价与期权参数」按钮同时刷新主账本与联动账本两次请求。

### 6.3 图表与卡片

**呈现口径（2026-09-04 按用户反馈重做）**：所有盈亏按编号分项罗列再加总，
图例、悬停、卡片、状态行共用同一套编号，不再出现「本账本」「含跨账本保护」
这类合并叫法：

- ① 本账本到期结算盈亏（股票按情景价，所选日及以前的期权按指派 / 行权 / 归零）
- ② 本账本测试日仍未到期的 Long Call / Put 相对买入权利金的浮动盈亏
- ③ 联动账本多头期权相对今日标记价的变动
- 合计 = 已开启项之和；只开 ③ 时它显示为 ②，合计写作「①+②」

曲线命名：蓝虚线 ①、绿线 ①+②、紫线 ①+②+③。悬停先列分项与合计，再列
明细（② 理论市值 / IV / r(T)，③ 情景市值 / 今日市值、较买入权利金参考）。

- 新增第四条曲线「计入 QQQ 多头期权后盈亏（左轴）」，legend id
  `stress-legend-linked-pnl`，颜色与现有三条区分（建议紫色系）。
  未启用叠加或联动合约为 0 时隐藏。
- 左轴 extent 把 `totalPnl` 纳入计算。
- Tooltip 新增两行：`QQQ 映射价 $xxx（−10.0%）` 与
  `QQQ 多头期权 市值 $xxx · 盈亏 $xxx`。
- 关键点卡片（下行 / 基准 / 上行）在启用叠加时把主数字换成 `totalPnl`，
  标签「含跨账本保护盈亏」，并新增一行
  `本账本 $xxx · QQQ Long Call / Put $xxx`。
- 状态行追加：`· 已叠加 QQQ 账本 N 张 Long Call + M 张 Long Put
  （映射 1 : 3 · QQQ 基准 $xxx · TWS IV a%–b%）`。

### 6.4 记忆

按主账本 `bookId` 记住上次选择的联动账本 `bookId`、`ratio` 与开关状态，
存 `localStorage`，key 前缀 `optionComboStressLinkedHedge:`。读取失败或
联动账本已不存在时回退到关闭状态，不报错。

## 7. 状态与协议

`state` 新增（与现有 `stressLongOptionInputs / stressInputsPending /
stressInputsError` 并列，命名同前缀）：

```
stressIncludeLinkedHedge: false,
stressLinkedBookId: '',
stressLinkedRatio: 3,
stressLinkedEvents: [],          // 联动账本事件（含 voided，与主账本一致）
stressLinkedLedger: null,        // core.computeLedger 结果
stressLinkedEventsPending: false,
stressLinkedEventsError: '',
stressLinkedLoadGeneration: 0,
stressLinkedInputs: null,        // 联动账本 scenario inputs 响应
stressLinkedInputsPending: false,
stressLinkedInputsError: '',
stressLinkedInputsGeneration: 0, // 迟到的 IV 快照按代数丢弃
```

实现细节：联动请求的合约列表与 `throughExpiry` 在同一时刻捕获，
不能在渲染之后再读 `state.stressExpiry`（渲染会把不在本账本到期日列表里的
日期归一化，实测会让请求带上错误的合约并被代数检查丢弃）。

`bookScopedStateReset`（书本切换时的清理路径）必须一并清空以上字段，并把
`stressInputsPending` 置回 false。主账本快照与联动快照都有各自的代数
（`stressInputsGeneration` / `stressLinkedInputsGeneration`）：情景日失效、切换账本时递增，
迟到响应按代数丢弃；天数输入去抖 400 ms 后才发请求（2026-09-04 Review §10.2）。

WebSocket 出站白名单**不新增消息类型**；只复用
`list_cost_basis_events` 与 `request_cost_basis_option_scenario_inputs`。
两者的服务端权限、超时（15 秒）与 loopback 约束不变。

## 8. 代码落点

| 文件 | 改动 |
| --- | --- |
| `js/cost_basis.js` | 新增 `mapLinkedUnderlyingPrice`、`estimateLinkedLongOptions`、`chooseLinkedBook`；`buildStressTestSeries` 增加 `linkedHedge` 分支；新增 `_stressLinkedBookCandidates`、`_loadStressLinkedEvents`、`_refreshStressLinkedInputs`、`_ensureStressLinkedData`；本账本与联动账本共用 `_deferredLongOptionRequests(openOptions, throughExpiry)`；`_renderStressTest / _renderStressChart / _renderStressCards / tooltip` 增加第四条曲线与文案；`_openStressTest` 恢复记忆并触发加载；事件绑定；三个新函数导出到 `page` 命名空间供测试 |
| `cost_basis.html` | §6.2 的控件与 legend；`?v=` 版本号由 `scripts/stamp_asset_versions.py` 生成，不手写 |
| `cost_basis.css` | 第四条曲线颜色变量、联动控件排版 |
| `tests/cost_basis_page.test.js` | §9 的用例 |
| `CODE PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md` | §7 压力测试段落加一句指向本文件 |
| `README.md` / `ARCHITECTURE.md` | 功能清单与数据流各加一行 |

后端：无改动（§3.2 已核对空 `contracts` 可被接受）。

## 9. 测试计划

`tests/cost_basis_page.test.js`（通过 `node tests/run.js` 运行）：

1. `mapLinkedUnderlyingPrice`：ratio 3 时 −30% → −10%；ratio −3 时 −30% → +10%；
   ratio 0 / NaN 返回 null；`|ratio| < 1` 时不产生负价。
2. 不传 `linkedHedge` 时 `buildStressTestSeries` 输出与现有断言逐字段一致
   （直接复用现有用例的 `deepStrictEqual` 基线）。
3. 联动账本一张 QQQ Long Put 到期日晚于情景日：每点 `linkedPnl` 随
   `linkedPrice` 单调；`totalPnl = pnl + linkedPnl`；`linkedPrice` 与映射函数一致。
4. 联动账本一张到期日等于情景日的 Long Put：按内在价值结算，
   不请求 IV；同一 series 内与递延合约混合时 `linkedCount` 计两张。
5. Long Call 与 Long Put 同时存在：`linkedCallContracts / linkedPutContracts`
   分别正确，上行情景 Call 贡献为正。
6. 缺 IV → `available: false, reason: 'missing_linked_option_iv'`；
   `marketInputs.throughExpiry` 不匹配 → `missing_linked_market_inputs`；
   `basePrice` 非正 → `invalid_linked_underlying_price`；
   `identityConflict` → `incomplete_linked_option`。
7. 源码断言：`function mapLinkedUnderlyingPrice`、
   `function estimateLinkedLongOptions` 存在；`cost_basis.html` 含
   `stress-linked-book`、`stress-linked-ratio`、`stress-legend-linked-pnl`。
8. 出站消息白名单未新增类型（现有白名单测试保持通过）。

浏览器手工验收（TWS 已连接，同账户已有 TQQQ 与 QQQ 两本账本）：

- 打开 TQQQ 压力测试，勾选叠加，选 QQQ，ratio 3：状态行出现 QQQ 张数、
  基准价与 IV 区间；第四条曲线在 −30% 处高于绿色曲线。
- 把 ratio 改成 1：−30% 处 QQQ 映射价变为 −30%，保护贡献明显增大。
- 断开 TWS 后点刷新：联动状态显示失败原因，绿色曲线仍可显示（若主账本
  参数此前已取得）。
- 切换到 QQQ 账本再切回 TQQQ：联动状态被清空后按记忆恢复并重新拉取。

## 10. 分阶段实施

1. ✅ **纯函数与序列**：`mapLinkedUnderlyingPrice`、`estimateLinkedLongOptions`、
   `buildStressTestSeries.linkedHedge` 分支，附 §9 第 1–6 条测试。
2. ✅ **数据加载**：联动账本候选、事件后台加载、scenario inputs 二次请求、
   generation 防迟到、书本切换清理。测试用页面 harness 驱动真实的加载函数，
   断言主账本 `allEvents / ledger / bookId` 在整个过程中逐字节不变，
   且页面所有 `request('…')` 动作都已在出站白名单内。
3. ✅ **UI**：控件、第四条曲线、tooltip、卡片、状态行、假设说明、localStorage 记忆；
   已重打资产哈希。
4. ✅ **文档**：主计划 §7 指针、README / ARCHITECTURE 各一段。
5. ⏳ 浏览器手工验收（需 TWS 连接与同账户 TQQQ / QQQ 两本账本）后合并。

## 11. 已知限制

- 线性收益率映射不含路径依赖、复利与波动损耗；持有期越长、震荡越大，
  真实 TQQQ / QQQ 关系偏离越多。本功能是情景估值，不是对冲比率的依据。
- IV 沿扫描线固定，且不做 skew 调整。下跌情景低估 Put 价值，上行情景
  低估 Call 价值的程度较小。
- 联动账本的空头期权、股票与已实现盈亏一律不计入；本功能不是合并账本。
- 只支持一本联动账本。若 QQQ 期权分散在同账户多本账本或多个账户，
  需要先在账本层面合并，或等待后续扩展。
- 联动账本的 `openPremium` 依赖该账本本身记账完整；账本漏记会直接
  反映为保护盈亏失真。对账仍以各自账本的 TWS 差异面板为准。

## 12. 可信度提升五步（2026-09-04，用户确认顺序 1→5，全部已实现）

| 步 | 改动 | 口径 / 公式 | 测试 |
| --- | --- | --- | --- |
| 1 | 情景日后仍未到期的**空头**期权盯市 | `estimateDeferredShortOptions`（与多头共用 `_estimateDeferredOptions`，`marketValue` 带符号）。贡献 = 已收权利金 + 负债市值（负数）。口径 A 的综合成本本就把仍未到期的卖方权利金加回（实测 blendedCost 73 而非 70），所以这里计全额，不重复。新增分项，编号按开启顺序分配（`stressComponentNumbers(showConvexity, showShorts, showLinked)`）。本账本 TWS 请求改为包含双向持仓；后端 `ib_server.py` 对请求合约不再只接受多头持仓 | 现有扫描测试补 P70@0902 的 IV 与利率后断言 `pnl = base + long + short`、负债 > 0、下跌侧为负；缺 IV → `missing_short_option_iv`；身份冲突 → `short_option_identity_mismatch` |
| 2 | 以指数为驱动的复利映射 | `(1+ΔT) = (1+R)^ratio × exp(−(ratio²−ratio)/2·σ²·T)`，按 ΔT 反推 R；σ 留空取联动合约里到期日晚于情景日的最低 TWS IV 作代理（`_proxyPathSigma`），T = 今天→情景日。3× 跌 30% ⇒ 指数 −11.2%。线性模式保留作对照。横轴加一行指数价格 | `mapLinkedUnderlyingPrice` 复利 / 线性 / 负倍数 / 归零；`leveragedDragLog`；序列级 σ 代理与假设、`invalid_linked_sigma / invalid_linked_mapping` |
| 3 | 本账本期权 IV 冲击随联动 β 放大 | 本账本每点冲击 = |ratio| × 联动冲击点数，走同一 `_applyIvShock`（含期限衰减）；未开联动叠加时本账本 IV 固定 | 状态行「IV 冲击随 QQQ β 按 3.00× 放大」；`ownIvShockPoints`；冲击后 IV ≤ 0 → `invalid_*_iv_shock` |
| 4 | 买卖价变现口径 | `liquidationHaircut`：多头 × bid/mark，空头 × ask/mark，联动账本今日市值直接取 bid；内在价值结算不折算；缺任一侧 → `missing_*_quote_sides`。后端快照行新增 `bid / ask / bidAskStatus` | 折算比例逐点验证（0.9 / 1.2）；缺侧拒绝；联动 reference 取 bid |
| 5 | 美式二叉树 + 股息率 | `priceScenarioOption`：`american`（CRR 121 步，`js/american_binomial.js`，页面新增该脚本）/ `european`（BSM 加连续股息率 q）；默认美式；股息率默认 QQQ 0.6%、TQQQ 1%，可改；美式模块未加载 → `missing_american_pricer`，不静默回退 | 美式 ≥ 欧式、深度价内 Put 提前行权价值、股息压低 Call 抬高 Put、期末等于内在价值；序列级默认欧式（纯函数）、页面默认美式 |

未做（需要新假设或新数据源）：sticky-delta 偏斜、β 历史回归、蒙特卡洛路径、历史情景回放。
