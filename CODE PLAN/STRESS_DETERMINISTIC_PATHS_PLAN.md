# 压力测试：三条确定性价格路径（实施方案）

> 2026-09-07 立项。目标是把「跌到位需要天数」情景下的价格路径做成可选的三种确定形状，
> 让途中到期的合约按各自到期日的路径价结算，交割股票或现金持有到统一终点。
> 内核契约见 [STRESS_KERNEL_REFACTOR.md](STRESS_KERNEL_REFACTOR.md)；
> 这是 `COST_BASIS_ACCURACY_AND_BAND_REVIEW.md` §4.3 里「最低成本改进」的落地。
> 不做随机路径、不做 IV 记忆、不做资金利息，见 §8。

## 1. 现状（改动锚点）

内核 `js/cost_basis_stress_core.js`：

- `opts.path` 只接受 `immediate` / `gradual`（约 205 行），存进 `compiled.path`。
- `pathSpot(start, end, at, compiled)`（约 296 行）：`immediate` 或 `target === asOf` 时直接返回终值；
  `gradual` 按时间比例在 `start`、`end` 之间线性插值。
- `valuePosition`（约 304 行）：`expiryAt <= target` 的合约用 `pathSpot` 取到期日路径价判断 ITM，
  本账本交割股数 `delivered` 按**终值** `end` 估值（股票持有到终点），交割现金 `-delivered × strike`；
  联动多头按到期日路径价的内在价值变现，现金持平。
- `scenarioCost` 复用同一个 `valuePosition`，所以右轴的情景结算成本已经跟随路径；缓存键是各腿 ITM 位图。
- **联动路径价的小偏差**：`sweep` 先用复利映射把终值映射成联动终值 `mapped`，再把 `mapped` 当 `end`
  传给 `valuePosition`，途中到期的联动合约拿到的是「联动基价 → 联动终值」的线性插值，而不是
  「本账本路径价在该时刻的映射值」。复利映射下两者不等：映射的时间项 `timeYears` 应当是到期日而不是终点。
- 区间成员 `js/cost_basis_stress_band.js` 共用同一份 `compiled`，路径不属于成员维度。

页面 `js/cost_basis.js`：

- `state.stressPath`，控件 `#stress-path`（两项）；每账本记忆 `kernel: { pnlBasis, path, band, flatIv, ownBeta }`
  （`_writeStressLinkedMemory` / `_restoreStressLinkedChoice`）；状态行文案「线性渐变路径 / 立即冲击并保持」。
- tooltip 与切片核对没有任何「途中结算」信息：用户看不到哪张合约在路径上被指派、按什么价。

测试 `tests/cost_basis_stress.test.js`：`cross-expiry physical delivery depends on the chosen path`
已锁定 immediate 与 gradual 的差异（85 Put 在 gradual 路径下于 90 到期归零，不能复活）。

## 2. 三条路径的定义

统一用归一化时间 `u = (t − asOf) / (target − asOf) ∈ [0, 1]` 和终值变动 `Δ = end − start`：

| 键 | 名称 | 路径价 `S(u)` | 参数 |
| --- | --- | --- | --- |
| `immediate` | 立即到位并保持 | `end` | 无 |
| `gradual` | 逐日线性到位 | `start + Δ·u` | 无 |
| `overshoot` | 先过冲再回归 | `u ≤ τ`：`start + mΔ·u/τ`；`u > τ`：`start + mΔ + (1−m)Δ·(u−τ)/(1−τ)` | 谷底时点 `τ`（默认 0.5，范围 0.05–0.95）；过冲倍数 `m`（默认 1.5，范围 1–3） |

要点：

- `overshoot` 在 `m = 1` 时与 `gradual` **逐字节相同**；`τ` 此时无效。这是自然的回归锚点。
- 形状对上下两侧对称：终值下跌时是「先跌到 m 倍再反弹」，终值上涨时是「先涨过头再回落」。
  控件文案只描述下跌侧（用户关心的是保护），说明里注明上涨侧对称。不为上涨侧另做一条线性路径，
  否则同一条曲线在零点两侧用两种规则。
- 谷底价 `start + mΔ` 可以低于 0 吗：`m·|Δ|/start ≥ 1` 时路径价为负，内核 `fail('invalid_stress_path_shape')`，
  页面提示缩小扫描范围或过冲倍数。扫描范围 ±50%、`m = 1.5` 时最低点 −75%，合法。
- `target === asOf`（同一时刻）时三条路径都退化为终值，与现状一致。

## 3. 内核改动

1. **路径对象**。`opts.path` 继续接受字符串；新增 `opts.pathShape = { trough: τ, overshoot: m }`，
   只在 `path === 'overshoot'` 时读取并校验；缺省用默认值。编译结果 `compiled.path`、`compiled.pathShape`，
   序列输出 `series.path`、`series.pathShape`。非法形状 → `invalid_stress_path_shape`；非法键 → 现有 `invalid_stress_path`。
2. **`pathSpot` 改为查表**：`PATH_SHAPES[path](start, end, u, shape)`，三个纯函数放到
   `js/cost_basis_stress_models.js`（`pathSpotImmediate/Gradual/Overshoot`），可单测。
3. **联动路径价按时刻映射**。`valuePosition` 对联动合约不再接收 `mapped` 终值做插值，而是接收本账本终值，
   在内部用 `pathSpot` 得到到期时刻的本账本价 `S_own(u)`，再调 `M.mapLinkedUnderlyingPrice(basePrice, change(u), ratio,
   { mapping, sigma·sigmaScale(u), timeYears: u·(target−asOf)/YEAR })` 得到联动路径价。
   - `u = 1` 时结果必须与现有 `mapped` 完全一致（存续合约的估值不变）。
   - 暴跌 σ 放大 `sigmaScale` 按**该时刻**的联动跌幅取值，不再固定用终点跌幅。
   - 线性映射时联动路径价 = `basePrice × (1 + change(u)/ratio)`，与旧的线性插值在 `gradual` 下相同。
4. **明细字段**。`valuePosition` 对已结算腿返回 `settledAt`（到期时刻 ISO）、`settlementSpot`（路径价）、
   `settlementPathU`（归一化时刻）；`sweep` 的 `details[]` 原样带出。对未结算腿不加字段。
5. **不改**：交割股票持有到终点按终值估值；联动到期变现现金持平；`scenarioCost` 缓存键仍是 ITM 位图
   （位图变了自然重放）；区间成员共用路径；每周假设收入按天数不变。

## 4. 页面改动

1. `#stress-path` 增加第三项「先跌到更深再反弹（过冲后回归）」。选中时显示两个半宽输入：
   「谷底时点（占天数比例）」`#stress-path-trough`（0.05–0.95，默认 0.5）和「过冲倍数」`#stress-path-overshoot`
   （1–3，默认 1.5），带 title 说明：`1` 等于逐日线性；`1.5` 表示终值跌 20% 时途中最深跌 30%。
   两个输入放在「情景」组，紧跟「到位路径」之后，按现有 `.half` 规则并排。
2. 状态 `state.stressPathShape = { trough, overshoot }`；每账本记忆 `kernel.pathShape`；恢复时非法值回默认。
   输入事件走现有的 `_writeStressLinkedMemory(); _renderStressTest();`，不触发行情刷新（路径不影响快照）。
3. 状态行路径文案三选一：「立即冲击并保持 / 线性渐变路径 / 过冲 1.5× 于 50% 时点后回归」。
4. tooltip：已有「结算结果 N 张指派 · N 张行权 · N 张归零」一行；`overshoot` 或 `gradual` 下在其后加一行
   「途中结算价」，列出被结算合约中最早与最晚的路径价区间，例如「途中结算价 61.20 ～ 68.40」。
   不逐张列，tooltip 已有 20 行。
5. 切片核对新增第四栏「途中结算」：逐张列出 `settledAt`、`settlementSpot`、结果（指派/行权/归零）、
   交割股数与现金。immediate 路径下该栏显示「全部按终值结算」。这一栏就是路径存在的证据，也是核对之处。
6. 「分项口径与假设说明」加一句：路径决定途中到期合约的结算价与交割；IV 冲击仍按终点跌幅计算，
   不模拟谷底 IV 的记忆效应；交割股票持有到终点按终值估值。

## 5. 与区间、降级、Worker 的关系

- 区间成员共用 `compiled`，路径参数进入 `_stressSeries` 的缓存键（在 `options` 里），改路径即重算中线与区间。
- 降级曲线（联动缺失 / 仅到期结算）沿用同一路径参数；到期结算曲线本身就是路径最敏感的部分。
- Worker 协议不变：`options` 整体传入，`pathShape` 随之透传；`tests/cost_basis_stress_worker.test.js`
  加一条断言 `pathShape` 到达 Worker 并出现在返回的 `series` 上。

## 6. 测试

内核 `tests/cost_basis_stress.test.js`：

1. **形状纯函数**：三个 `pathSpot*` 在 `u = 0 / τ / 1` 的值；`overshoot` 在 `m = 1` 时与 `gradual` 处处相等；
   `τ` 越界与 `m` 越界各自 `invalid_stress_path_shape`；`immediate` 忽略 `u`。
2. **谷底指派**：85 Put 于第 5 天到期，终点第 10 天为 90（沿用现有算例，start 80）。`gradual` 归零（已有）；
   `overshoot m = 2, τ = 0.5` 时第 5 天路径价 = 80 + 2×10×1 = 100，仍归零；改终点为 70：
   `gradual` 第 5 天 75 → 指派；`overshoot m = 1.5` 第 5 天 65 → 指派，交割 −100 股按终值 70 估值，
   `shares = −100`、`settlementCashPaid = 8500`、`cost = 85`。断言 `details[0].settlementSpot` 为 65。
3. **反弹漏保护（Review 4.3 的第二种情形）**：Long Put 90 于第 5 天到期，终点 95：`immediate` 归零，
   `overshoot m = 1.5, τ = 0.5` 时第 5 天路径价 = 80 + 1.5×15 = 102.5 仍归零；把 Δ 改为下跌的对称算例
   证明路径价低于行权价时能行权拿到内在价值，而 `immediate` 拿不到。
4. **联动按时刻映射**：线性映射、比率 3、联动基价 500、本账本 80 → 60（−25%）、`gradual`；联动 Put 于中点到期，
   路径价应为 500 × (1 − 0.125) = 437.5；改复利映射并给定 σ，断言中点用 `timeYears = 0.5 × 天数/365` 的映射值，
   且终点存续合约的估值与改动前逐字节相同。
5. **区间与路径**：`overshoot` 下 `band.points` 每点 `lower ≤ headline ≤ upper`，且所有成员的 `settlementSpot` 相同
   （路径不是成员维度）。
6. **同一时刻退化**：`target === asOf` 时三条路径的 `points` 逐字节相同。
7. **成本一致性**：`overshoot` 下 `inconsistent_settlement_shares` 不触发（右轴重放与左轴交割股数一致），
   缓存命中次数不随扫描点数线性增长（用计数桩）。

页面 `tests/cost_basis_page.test.js`：

8. 第三项选中显示两个输入、其它路径隐藏；输入非法值时状态行提示、图清空；记忆写入 `kernel.pathShape`，
   恢复时非法值回默认。
9. 状态行文案三选一正确；tooltip「途中结算价」行只在有已结算腿且路径非 immediate 时显示。
10. 切片「途中结算」栏逐张内容等于 `details` 里的字段格式化结果；immediate 下显示「全部按终值结算」。

Worker：

11. `pathShape` 透传并出现在返回序列。

## 7. 分阶段实施

1. 模型层三个纯函数 + 内核路径对象 + 校验 + 明细字段（测试 1、2、3、6、7）。
2. 联动按时刻映射（测试 4）；这一步单独提交，因为它会改变 `gradual` 下途中到期联动合约的旧结果，提交信息要说明差异来源。
3. 页面控件、记忆、状态行、tooltip、切片栏（测试 8–10）；Worker 断言（11）；区间断言（5）。
4. 文档：`STRESS_KERNEL_REFACTOR.md` 计算主线加一条路径规则；`COST_BASIS_LONG_PUT_STRESS_REVIEW.md` §2 的
   路径描述更新；README 压力测试段落一句；`stamp_asset_versions.py` 盖戳。

## 8. 不做什么，以及为什么

- **IV 记忆**：真实市场里谷底抬高的 IV 在反弹后只部分回落，本方案的 IV 冲击仍按终点跌幅算，
  `overshoot` 下终点存续合约的 IV 会偏低。这是已知偏保守的地方，写进说明；要做需要新的历史研究
  （谷底后 5–20 日的 IV 回落比例），不在本次范围。
- **资金利息与分红现金流**：路径上的交割现金和股票持有到终点不计利息、不计分红，与现状一致。
- **提前指派**：美式树给出行权权利价值，路径不模拟提前指派时点。
- **随机路径 / 蒙特卡洛**：三条确定性路径是它的前置，不在本次范围。
- **上涨侧单独形状**：见 §2，对称处理。
