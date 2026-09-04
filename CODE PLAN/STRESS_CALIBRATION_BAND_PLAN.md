# 压力测试校准区间带（紫带）实施计划

> 文件用途：把到期压力测试里「计入联动多头期权后」的那条紫线改成一条带子，宽度来自
> 历史校准参数本身的不确定区间，而不是任何主观猜测。与
> `COST_BASIS_CROSS_BOOK_HEDGE_OVERLAY_PLAN.md` 的叠加逻辑分开验收。
>
> 状态：待实施  
> 制定日期：2026-09-05  
> 动机：模型参数已经收敛到数据能支持的精度，但每个参数仍有一个数据给出的区间。
> 单线会让读图者把「中值」当成「答案」；带子把「数据能说到哪一步」直接画在图上。
> 背景见 `STRESS_MODEL_RESEARCH_MEMO.md` §2.3、§2.4、§2.6。

## 1. 目标与不变量

目标：在 β 模式下，最外层曲线（①+②+③ 或 ①+②）除了中线，再画出一个上下沿，
悬停与卡片同时给出「中值（下沿 … 上沿）」。

不变量：

1. **带子的每一条边都来自脚本输出的区间**，不是手写。三个参数各有一个区间，区间的定义、
   样本数和取整规则都由 `scripts/stress_model_validation.py` / `scripts/skew_regime_study.py`
   打印，并由 `tests/stress_model_validation_test.py` 锁定聚合方法。
2. **中线不变**。带子只增加 `bandLower / bandUpper`，默认参数下 `headlinePnl` 逐字节等于现在。
   现有 `buildStressTestSeries` 的测试断言一条不改。
3. **上下沿是对合计取的极值，不是对某一项取的极值。** IV 抬升让多头增值、让空头负债变大，
   合计对参数不单调，所以必须在参数格点上逐点取 `min / max`，不能只算「乐观角」和「悲观角」。
4. **带子不可用时只隐藏带子。** 任一格点成员 `available === false`，中线照画，状态行说明
   「区间不可用：原因」；绝不静默画一条宽度为零的带。
5. **IV 模式为「无」或「固定点数」时没有带子。** 这两种模式没有校准参数可言。

## 2. 区间从哪里来

| 参数 | 中值（现状） | 区间 | 数据定义（脚本新增输出） |
| --- | --- | --- | --- |
| 期限衰减指数 `p` | 0.65 | [0.50, 0.76] | 下界：平方根规则，也是 ATM 抬升衰减的量级；上界：逐合约实际 DTE 的对数最小二乘（`fit_tenor_exponent`）。中值是逐行隐含指数中位数（`median_row_exponent`，0.64）取整 |
| 价外 Put 折扣 `OTM_SHOCK_FLOOR` | 0.50 | [0.35, 0.65] | 下界：价外 10–20% Put 抬升 / ATM 抬升的**均值**（0.34，被几段几乎没抬的事件拉低）；上界：价外 20%+ 的中位（0.63）。两者取整到 0.05。均由 B1 的 `otm_lift_ratio` 行聚合，新增 `otm_ratio_interval()` 输出 |
| β 表整体倍率 `betaScale` | 1.00 | [0.80, 1.25] | 把 2012–2026 按年份分成前后两半，各自跑 A1b 的分档回归；每档取两半之比的最小与最大，再对四档取中位，作为「不同时代 β 差多少」的区间。新增 `beta_regime_interval()`；四舍五入到 0.05。若两半之比落在 [0.8, 1.25] 之外，以脚本输出为准 |

「IV 不变」不作为带的一部分：它是明确的保守下限，已经是一个独立模式。面板提供一个复选
「区间包含 IV 不变下限」，默认关；开启后下沿取 `min(下沿, IV 不变)`，状态行注明。

## 3. 计算

### 3.1 纯函数

```
stressBandMembers(base)            // base = 当前 linkedHedge 参数
  → [{ label: 'center', overrides: {} },
     { label: 'p0.50/otm0.35/beta0.80', overrides: { ivTenorExponent: 0.50, otmShockFloor: 0.35, ivBetaScale: 0.80 } },
     ... 2^3 = 8 个角 ...]
```

- `otmShockFloor` 与 `ivBetaScale` 是 `linkedHedge` 的两个新字段（纯函数入口默认 0.50 / 1.00，
  与现在完全一致）。`autoBetaForDrop(drop) × ivBetaScale`；`otmShockFactor(strike, spot, right, floor)`。
- `buildStressBand(events, opts)`：
  1. `center = buildStressTestSeries(events, opts)`（就是现在的序列）；
  2. 若 `center.linkedIvMode !== 'beta'` 或 `opts.band !== true` → 返回 `{ available: false, reason: 'band_not_applicable' }`；
  3. 对 8 个角各跑一次 `buildStressTestSeries(events, { ...opts, linkedHedge: { ...opts.linkedHedge, ...overrides } })`；
  4. 任一成员 `available === false` → `{ available: false, reason: 成员.reason, member: label }`；
  5. 逐点 `bandLower[i] = min(所有成员 headlinePnl[i])`，`bandUpper[i] = max(...)`，中线不参与 min/max
     以外的任何计算；
  6. 返回 `{ available: true, lower, upper, members: 9, widthAtCenter, widthAtLow, widthAtHigh, parameters: {...区间} }`。
- 可选下限：`opts.bandIncludeFlatIv === true` 时再跑一个 `ivMode: 'none'` 成员，只参与 `lower`。

### 3.2 性能

一次带子 = 9 次序列，每次 61 点 × 全部合约 × 美式二叉树 121 步。用当前真实账本（31 张联动合约
+ 23 张本账本合约）估算约 9 × 61 × 54 × 1.5 万次乘加 ≈ 4.5 亿次，JS 大约 0.3–0.6 秒。

处理：

- 带子在 `_renderStressTest` 之后用 `requestAnimationFrame` 异步算，先画中线，带子算完再补画；
  输入连续变化时用与「跌到位天数」相同的 400 ms 去抖。
- 缓存键 = 序列输入的 JSON 摘要；键不变不重算。
- 状态行显示「区间计算 xxx ms · 9 个成员」，让慢的时候看得见。
- 若单次超过 2 秒，下一次自动降到 4 个成员（只取 p 与 β 的四角，折扣取中值）并注明「区间已简化」。

## 4. 展示

- **图**：在紫线（或未开联动时的绿线）之下画一个 `<path>` 多边形，`class="stress-band"`，
  填充用同色 12% 透明度，无描边；上下沿各一条 1px 虚线。带子画在所有线之下、网格之上。
- **图例**：紫线文字后追加「（带 = 校准区间 p 0.50–0.76 · 价外 0.35–0.65 · β ×0.80–1.25）」。
- **悬停**：合计行改为 `合计 −$34,546（−35,3xx … −33,2xx）`；新增一行「区间宽度」。
- **卡片**：合计下方加一行小字「区间 −$35.3k … −$33.2k」。
- **状态行**：`· 区间：9 个成员，−30% 处宽 $x，基准点宽 $0`（基准点因冲击为 0 应恰好宽 0，
  这是一个天然的自检，见 §6 第 5 条）。
- **面板控件**：在「IV 模式」旁加复选「显示校准区间带」（默认开，仅 β 模式可见）；
  「区间包含 IV 不变下限」（默认关）。按账本记忆。
- 带子的 y 轴范围要纳入 extent，避免上沿出界。

## 5. 脚本与数据

`scripts/stress_model_validation.py` 新增三段输出，并把聚合抽成纯函数：

- `otm_ratio_interval(ratios_10_20, ratios_20_plus)` → `{ low: round05(mean(r10_20)), high: round05(median(r20+)) }`。
- `beta_regime_interval(series, split_year=2019)` → 对前后两半各跑 `beta_table_from_pairs`，返回每档
  比值与 `{ low, high }`（四档比值的最小 / 最大，再取整）。
- 报告末尾新增「## D. 区间」一节，把三个区间与其样本数打印出来；`CODE PLAN/STRESS_MODEL_VALIDATION_*.md`
  重生成。
- `scripts/skew_regime_study.py` 已输出 `p` 的最小二乘与中位；不再改。

页面常量 `BAND_INTERVALS = { tenorExponent: [0.50, 0.76], otmFloor: [0.35, 0.65], betaScale: [0.80, 1.25] }`
必须与脚本最新输出一致；测试里用脚本函数对合成数据的结果反向核对取整规则，真实数值以报告为准。

## 6. 测试

`tests/cost_basis_page.test.js`：

1. **成员枚举**：`stressBandMembers` 返回 9 个成员，8 个角覆盖 2³ 组合，每个角的 overrides 只含三个字段。
2. **默认不变**：`buildStressBand` 的 `center` 与 `buildStressTestSeries` 输出 `deepStrictEqual`；
   `otmShockFloor` 缺省 0.50、`ivBetaScale` 缺省 1.00 时序列逐字节等于现状（复用现有 `withHedge` 夹具）。
3. **夹逼**：每一点 `lower ≤ headlinePnl ≤ upper`；基准点（联动跌幅 0）三者相等。
4. **非单调证明**：构造一本带深度价内 Short Put 的账本，使「β 最大 / p 最小 / 折扣最高」这个角的合计**不是**
   最大值；断言 `upper` 仍等于逐点 `max`，从而证明实现没有走「乐观角 = 上沿」的捷径。
5. **零宽自检**：`ivMode: 'beta'` 时基准点及全部上涨侧点 `upper − lower === 0`。
6. **不适用与不可用**：`ivMode: 'none' / 'fixed'` → `band_not_applicable`；某个角缺 IV（构造一张只在
   某角出现 IV ≤ 0 的合约）→ `available: false` 且 `member` 指向该角；中线仍 `available`。
7. **可选下限**：`bandIncludeFlatIv` 开启后 `lower ≤ IV 不变序列的 headlinePnl`，`upper` 不变。
8. **Harness**：默认状态下 β 模式画出 `stress-band` 路径；固定点数模式下不画；悬停合计行格式为
   `合计 X（L … U）`；卡片有「区间」行；状态行含成员数；关闭复选后路径消失；账本记忆恢复开关。
9. **性能护栏**（非断言，只记录）：在 harness 里对 61 点 × 20 张合约计时，打印耗时；若超过 1 秒
   在 CI 输出里可见，不 fail。

`tests/stress_model_validation_test.py`：

10. `otm_ratio_interval` 的取整与空输入（返回 `None`，报告写「样本不足」）。
11. `beta_regime_interval`：用两段合成序列（前半 β=0.8、后半 β=1.2）恢复区间 [0.80, 1.25]，
    验证分年逻辑与四档取最值。
12. 报告函数在缺服务时仍按 §19.7 的方式退出，带子相关段落不引入新的 I/O 路径。

## 7. 分阶段实施

1. 脚本：三个区间函数 + 「D. 区间」输出 + 测试 10–12；重跑并更新报告。
2. 纯函数：`otmShockFloor / ivBetaScale` 两个入口字段（默认与现状一致）+ `stressBandMembers` +
   `buildStressBand` + 测试 1–7。
3. 渲染：带子路径、图例、悬停、卡片、状态行、控件、记忆、异步与缓存 + 测试 8–9。
4. 文档：`STRESS_MODEL_RESEARCH_MEMO.md` §3 加「区间」小节；主计划 §6.3 指向本文件；README 一句。

## 8. 已知限制

- 区间只覆盖三个校准参数；映射倍数、路径 σ、上涨侧不加冲击这些假设不在带子里。
- β 的区间用「前后两半历史」代表时代差异，不是统计置信区间；样本薄的 >20% 档尤其如此。
- 带子是参数不确定性，不是结果分布；同一参数下不同路径的分布仍要靠蒙特卡洛。
