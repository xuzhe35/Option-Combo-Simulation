# FOP / FUT / ROLL 综合成本账本实施计划

> 文件用途：这是 `cost_basis.html` 的 FOP/FUT 扩展计划，与既有
> `COST_BASIS_LEDGER_PAGE_PLAN.md`（股票/ETF 账本）分开验收。
>
> 状态：代码实施与自动验收已完成；等待真实 FOP/FUT 报表做外部格式复核  
> 制定日期：2026-08-26

## 1. 目标与不变量

目标是在不改变现有股票/ETF 结果的前提下，为同一成本账本增加一种
`FUT` 账本：FOP 的权利金和提前平仓现金流调整所交割 FUT 的等效成本，
FUT 换月时把实际 ROLL spread 延续到新月份合约。

以下不变量不可妥协：

1. `STK` 账本继续使用股数、每股成本和股票交割语义，既有事件及数据库
   无需人工迁移。
2. `FUT` 账本以期货根代码建账，但每个持仓必须保留具体合约月份及
   `conId/localSymbol`；不同月份不得静默合并。
3. FOP 指派/行权关闭期权并产生 FUT 张数，绝不产生股票股数，也绝不把
   `行权价 × 点值` 当作真实账户现金流。
4. FUT 名义本金不进入现金账本；期货成本以成交点位和已实现经济损益延续。
   期货逐日盯市现金流不重复计入综合成本。
5. ROLL 必须能由一条旧月平仓腿和一条新月开仓腿唯一证明。数量、账户、
   根代码、方向或时间无法唯一配对时整批阻断，不猜测。
6. TWS 快照可以经人工确认成为临时基线；后续完整 CSV 能原子取代该基线，
   采信后增量 CSV 则保留基线。行为与股票/ETF 账本一致。
7. 现有 `Reports/` 两份 CSV 不含 FOP/FUT/ROLL 行。实施阶段只能用合成的
   IBKR Flex/Activity Statement 样本验证格式；在取得真实报表前，不宣称
   已完成真实格式验收。

## 2. 成本定义

对账户内当前同方向的 FUT 净持仓，令：

- `q`：带符号 FUT 张数（多头为正、空头为负）
- `M`：FUT 点值/合约乘数
- `B`：当前 FUT 实际建仓均价形成的带符号基数
- `R_fut`：已平 FUT 的累计毛实现损益
- `F_fut`：FUT 成交、ROLL 及 FOP 交割相关费用
- `R_opt`：已经平仓、到期、指派或行权而不再承担风险的 FOP 净权利金

则当前综合成本点位为：

```text
FUT 综合成本 = (B - R_fut + F_fut - R_opt) / Σ(q × M)
```

未平仓 FOP 全部归零口径再从分子扣除 `openPremium`。

一次同数量、同方向的完整换月满足：

```text
新综合成本
= 旧综合成本 + 新月开仓价 - 旧月平仓价
+ ROLL 手续费 / (q × M)
```

该公式对多头和空头都成立。部分换月只处理唯一配对成功的数量；多余腿保留
为普通 FUT 开仓/平仓。当前同时存在相反方向或无法用同一点值归一的 FUT
持仓时不输出一个伪精确的合计成本，而是给出阻断告警并展示逐合约持仓。

## 3. 数据模型

数据库升级为 schema v3。由于 v2 的 SQLite `kind` CHECK 不允许新增事件类型，
迁移必须在一个事务中重建事件表、逐列复制旧数据并重建索引；迁移测试必须证明
失败时整库回滚、成功时旧事件逐字段不变：

### 3.1 账本

- `sec_type='STK'`：现有股票/ETF 账本。
- `sec_type='FUT'`：FOP/FUT 账本。
- 现有 `default_shares_per_contract` 在 FUT 账本中表示默认点值；协议同时返回
  更清晰的 `defaultMultiplier` 别名，避免破坏旧客户端。

### 3.2 新事件

- `futures_trade`：直接 FUT 开仓、平仓或 TWS FUT 临时基线。
- `futures_roll`：已唯一配对的旧月平仓 + 新月开仓；保存两端合约和成交价。

FOP 继续沿用 `option_trade / option_assignment / option_exercise /
option_expiry`，但只有 FUT 账本允许导入 `AssetClass=FOP`。FUT 账本中的
assignment/exercise 使用 `futureContracts`，不使用 `shares`。

事件新增字段：

- `futureExpiry / futureConId / futureLocalSymbol`
- `futureContracts`
- `rollToExpiry / rollToConId / rollToLocalSymbol / rollToPrice`
- `rollGroup`

`sharesPerContract` 在 FUT 账本中保存点值/乘数，以继续复用期权权利金公式
和合约身份校验。

## 4. 分阶段实施与逐步验收

### 阶段 1：schema v3 与服务端校验

实施：

1. 增加 v2 → v3 原子表重建迁移和新建库 schema。
2. `create_book` 接受 `STK/FUT`，唯一索引允许同一根代码分别存在两类账本。
3. 增加新事件字段、序列化和导出；按账本类型拒绝交叉事件。
4. FOP 交割现金仅允许费用，FUT 名义本金不作为现金。

验收：

- v2 真实结构副本迁移后旧事件逐字段不变。
- STK 账本拒绝 FUT/FOP 事件，FUT 账本拒绝股票交割事件。
- assignment/exercise 的 FUT 张数、方向和点值不一致时服务端拒绝。
- `tests/cost_basis_store_test.py`、`tests/cost_basis_ws_test.py` 全通过。

### 阶段 2：DOM-free FUT 成本引擎

实施：

1. 按 `account + futureExpiry + conId/localSymbol + multiplier` 追踪 FUT。
2. 直接 FUT 成交支持加仓、部分平仓、清仓和反向开仓。
3. 计算 FUT 已实现损益、实际均价、综合成本和“未平 FOP 归零”成本。
4. `futures_roll` 延续旧月经济成本并保留可审计 spread。

验收：

- 多头 `5000 → 平5100/开5120` 的新综合成本为 `5020`（未计费用）。
- 空头同一组价格也按同一公式延续。
- FOP 收入对多头降低成本、对空头提高等效卖出价。
- 部分换月、不同点值、相反方向和零持仓均有确定结果或明确告警。
- 原有全部 STK 核心测试逐项保持通过。

### 阶段 3：IBKR CSV 分类与 ROLL 配对

实施：

1. 资产分类拆分为 `OPT/FOP/STK/FUT`，按账本类型过滤，禁止把 FOP 当 OPT。
2. 解析 FUT 合约月份、点值、`conId/localSymbol`。
3. FOP 指派/行权的期权腿只和同账户、同时间、同根代码、数量匹配的 FUT
   交割腿配对。
4. FUT ROLL 只在旧腿含 close、新腿含 open、时间相同、绝对数量相等、月份
   不同且候选唯一时自动生成 `futures_roll`；否则进入待人工处理。
5. 普通单腿 FUT 成交生成 `futures_trade`。

验收：

- Flex 和中/英文 Activity Statement 合成样本均通过。
- 完整 roll 只生成一个事件，不重复保留两条 FUT 腿。
- 模糊 roll、缺失月份、不同点值、数量不等均阻断。
- 当前 `Reports/` 两个股票/ETF 文件的导入结果完全不变。

### 阶段 4：TWS FOP/FUT 对账与采信

实施：

1. FUT 账本只读取同根代码的 `FOP/FUT`，STK 账本仍只读取 `OPT/STK`。
2. FUT 持仓按具体月份对账；FOP 按完整期权身份对账。
3. 账本为空且 TWS 均价完整时，人工确认可分别采信 FOP 和 FUT 基线。
4. 完整 CSV 对 FUT/FOP TWS 基线执行与现有逻辑同等严格的原子取代检查。

验收：

- 存在真实 FOP/FUT 时不再返回空行或错误 `balanced=true`。
- 不同 FUT 月份不会互相抵销。
- 累计 CSV 取代基线，采信后增量 CSV 保留基线，部分重叠阻断。

### 阶段 5：页面与审计展示

实施：

1. 新建账本必须显式选择“股票/ETF”或“FOP/FUT”。
2. FUT 账本把“股数/每股”切换为“FUT 张数/成本点位/点值”。
3. 事件表和导入预览显示 FUT 月份、ROLL 两端价格与 spread。
4. 手工表单仅显示当前账本允许的事件和字段。
5. CSV 导出包含全部新字段，不丢失 roll 审计证据。

验收：

- 页面静态测试证明 STK/FUT 两套标签和字段不会混用。
- 旧 STK 账本加载、录入、导入、对账和导出路径保持可用。

### 阶段 6：端到端时序和回归

实施并验证以下序列：

1. FOP 开仓 → 提前平仓 → FUT 尚未出现。
2. FOP 开仓 → 指派/行权 → FUT 建仓 → FOP 收入进入综合成本。
3. FUT 建仓 → 完整换月 → 再次换月。
4. 部分换月 → 旧月和新月同时存在。
5. TWS 采信 → 次日增量 CSV。
6. TWS 采信 → 后续累计 CSV 完整覆盖。
7. CSV 重复导入、批次重放、冲销和重建。
8. 原有两份 `Reports/` 按 8/21 → 8/24 顺序导入，结果保持一致。

最终门禁：

- 全部 JS 测试通过。
- 全部 cost-basis Python 测试通过。
- 旧库迁移测试通过。
- 计划末尾填写每项命令、通过数和任何未能用真实数据验证的限制。

## 5. 完成记录

完成日期：2026-08-26。

### 5.1 各阶段结果

- 阶段 1 完成：schema v3 采用事务内重建事件表，旧 v2 结构和旧事件
  迁移测试通过；同一根代码可分别建 `STK` 和 `FUT` 账本。
- 阶段 2 完成：多头、空头、提前平 FOP、FOP 交割、完整 ROLL、部分
  ROLL、费用及相反 FUT 方向均有独立核验。
- 阶段 3 完成：Flex 和中文 Activity Statement 合成格式样本通过；
  部分 ROLL 的共同数量生成 `futures_roll`，剩余数量保留为
  `futures_trade`；不可唯一证明的组合整批阻断。
- 阶段 4 完成：TWS `FOP/FUT` 按完整合约身份对账；人工采信保留
  快照的真实本地时间；完整累计 CSV 原子取代临时基线，快照之后的
  增量 CSV 保留基线，部分重叠阻断。
- 阶段 5 完成：建账、录入、摘要、流水、对账、导入预览和导出均按
  `STK/FUT` 切换语义；FOP 交割表单不再显示股数。
- 阶段 6 完成：新增了端到端时序、基线取代、部分期间期初持仓和旧库
  迁移门禁。报表期初已有 FUT 但文件无建仓价时，现在整批阻断，不再用
  0 价或静默忽略伪造成本。

### 5.2 验证记录

- `node tests/run.js`：`902 passed, 0 failed`。
- `python3 -m unittest tests.cost_basis_store_test tests.cost_basis_ws_test`：
  `Ran 162 tests, OK (skipped=1)`；跳过项是可选 IB 桥接环境测试。
- `python3 scripts/stamp_asset_versions.py --check`：页面资源指纹一致。
- 真实报表回归：按 `Reports/` 中 8/21 → 8/24 的顺序对
  `GLD/QQQ/SLV/SPY/TQQQ/USO` 重新执行部分重叠导入，六个标的都与直接使用
  8/24 报表重建的持仓、现金、权利金和成本一致；TQQQ 综合成本为
  `68.212288`。

### 5.3 仍需外部数据的限制

`Reports/` 当前仍只有股票/ETF 和 OPT 记录，没有真实 FOP 指派、FUT 成交或
ROLL 行。因此已完成的是代码、合成 IBKR 格式和旧真实 OPT/STK 报表的验收；
在真实 FOP/FUT CSV 到位前，不声称已验收券商对这些行的所有本地化字段组合。
