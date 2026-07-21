# 历史日历组合 EOD 验证报告

## 验证目标

验证下列日历 Straddle 路径是否一致：

1. 在历史建仓日按真实双边 BBO midpoint 建立 Paper Trade。
2. 用建仓时的本地 BBO IV、美元 r 和当日结构化 implied λ，预测近腿到期时的组合价值。
3. 快进到近腿到期日：近腿用标的收盘价计算 intrinsic，远腿使用当天真实双边 BBO midpoint，得到 Paper Trade P&L。
4. 在目标时刻用当天远腿 BBO 重新锚定，再向前推进 1 毫秒，强制经过生产定价模型而不是“当前 midpoint”捷径，检查极限收敛误差。

验证器直接加载以下生产文件，不维护第二套期权公式：

- `js/date_utils.js`
- `js/iv_term_structure_core.js`
- `js/pricing_context.js`
- `js/pricing_core.js`

脚本为 `scripts/validate_calendar_projection.js`。

## 数据口径

- 数据源：`market_data.cleaned.db` 中的 SPY EOD 期权链。
- 只接受 exact-date 数据，禁止 `on_or_before` 回退。
- 期权价格必须来自原始双边 bid/ask；不使用 vendor IV、model price、last 或合成 mark。
- 每日快照没有盘中时间戳，因此统一假定为纽约时间 16:00；夏令时转换由生产日期函数完成。
- 近腿到期价值使用 `abs(underlying close - strike)`，避免把可能不同步的 0DTE EOD quote 当成结算价。
- 利率严格使用建仓日或之前最近的 `rates.db` 记录。
- λ 由建仓日完整 ATM Straddle term structure 通过生产 IVTS 算法反推；缺少任一需要日期就跳过样本，不回退 0.3。

## 首批真实样本

金额均为一组一张合约、不含佣金和滑点。

| 场景 | Entry / Front / Back | K | Paper P&L | Entry 预测 | Entry 误差 | 前一可用日误差 | 目标 +1ms 误差 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 无休市日控制组 | 2026-02-17 / 02-18 / 02-19 | 683 | $28.00 | $48.73 | +$20.73 | +$20.73 | -$0.000003 |
| 普通周末 | 2026-02-23 / 02-27 / 03-02 | 682 | $195.00 | $176.54 | -$18.46 | -$63.73 | -$0.000003 |
| 周末 + MLK 假日 | 2026-01-12 / 01-16 / 01-20 | 695 | -$4.00 | $13.82 | +$17.82 | +$20.14 | -$0.000001 |

结构化 λ 证据：

- 无休市日控制组：`not_required`。
- 普通周末：2026-02-28 与 2026-03-01 均为 `0.0732`。
- MLK 样本：2026-01-17、01-18 和整日休市的 01-19 均为 `0.0450`。

汇总：

- Entry 条件预测 MAE：`$19.00 / 1-lot`。
- 前一可用 EOD 预测 MAE：`$34.87 / 1-lot`；没有单调变小。
- 目标时刻重新锚定后、向前 1 毫秒的最大绝对误差：`$0.00000269 / 1-lot`。

## λ 研究对照

同一批样本保持其他输入不变，只替换非交易日权重。该对照仍为每个非交易日显式提供日期，不代表允许标量绕过正式安全阀。

| Clock | 三样本 MAE |
| --- | ---: |
| 当日 structured implied λ | $19.00 |
| λ = 0 | $24.14 |
| λ = 0.3 | $53.68 |
| Calendar，λ = 1 | $137.06 |

样本只有三个，不能据此估计长期最优 λ；但它说明在这三个案例中，固定 `0.3` 明显不如当日曲面反推值，也说明日历日时钟会严重高估周末方差消耗。

## 结论

1. **极限收敛路径通过。** 目标时刻用最新 BBO 重新锚定，并强制走 1 毫秒模型路径后，Payoff 当前点与 Paper Trade P&L 的差异低于一美分的万分之一。这支持“近腿 intrinsic、远腿本地 BBO IV、r 与 λ 不重复应用”的实现是数值自洽的。
2. **建仓日预测不会机械地等于未来实际 P&L。** 三个 Entry 误差约为每组 `$18–21`，其中包含真实 IV/skew、Carry、报价与流动性随后变化；这不是仅靠修公式就能消除的误差。
3. **前一日 EOD 不保证比建仓日更准。** EOD 数据只提供相隔一天的快照，隔夜 IV 变化可以大于剩余 theta，因此“越靠近越收敛”只在相同市场输入逐渐逼近目标时刻的极限上成立，不要求逐日误差单调下降。
4. **结构化 λ 安全阀实际生效。** 扫描中有多个日期因为无法从当日曲面得到完整、范围合格的 λ 而被跳过；验证器没有用 0.3 或最近日期填洞。

## 当前数据库不能证明的部分

现有数据库没有：

- ES/FOP 和对应期货报价；
- 分钟级或逐笔 option BBO；
- 同一批次的 Spot/Future、Carry、r 和 λ 时间戳；
- IB ContractDetails 的真实 `expiryAsOf`；
- 正式 settlement fixing。

因此本报告是 **ETF EOD 验证**，不能替代“ES 到期前最后几分钟”的实盘级验证。后者需要从现在起保存同一 snapshot id 下的近远腿 BBO、对应 Future、Spot/Index、r 曲线、Carry、结构化 λ、ContractDetails 和最终 fixing。

## 重跑命令

```text
node scripts/validate_calendar_projection.js
```

输出完整 JSON：

```text
node scripts/validate_calendar_projection.js --json /private/tmp/calendar-projection-report.json
```

自定义样本：

```text
node scripts/validate_calendar_projection.js \
  --case "2026-02-23:2026-02-27:2026-03-02:682:ordinary weekend"
```
