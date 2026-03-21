# Option Combo Simulator 架构说明

## 1. 当前一句话总结

这是一个不经过构建步骤、依赖 `index.html` 顺序加载全局脚本的本地浏览器应用。

当前真实架构已经不是“一个巨大的 `app.js`”，而是：

- `index.html` 负责页面骨架、模板和脚本装配
- `app.js` 持有全局 `state`，负责顶层编排
- `pricing_core.js` / `amortized.js` / `valuation.js` / `session_logic.js` 提供纯计算和纯规则
- `control_panel_ui.js` / `session_ui.js` / `group_editor_ui.js` / `hedge_editor_ui.js` 负责编辑器与交互绑定
- `group_ui.js` / `hedge_ui.js` / `global_ui.js` 负责把派生结果写回 DOM
- `trade_trigger_logic.js` 负责 Trial Trigger 状态与请求构造
- `ws_client.js` + `ib_server.py` + `trade_execution/*` 负责 IBKR 实盘桥接与订单执行

## 2. 运行时分层

### 2.1 页面与模板层

- `index.html`
- `style.css`

负责：

- 左侧 Scenario Controls
- Group / Leg / Hedge 模板
- 全局卡片、图表容器、WebSocket 控件
- Trial Trigger 控件区

### 2.2 顶层状态与编排层

- `js/app.js`

负责：

- 持有全局 `state`
- 初始化页面
- 调度渲染
- 调用 valuation 计算
- 导入导出会话
- 连接 UI 模块和 WebSocket 模块

`app.js` 现在是 orchestration bridge，不再承担大部分细节逻辑。

### 2.3 纯计算与纯规则层

- `js/pricing_core.js`
- `js/amortized.js`
- `js/valuation.js`
- `js/session_logic.js`
- `js/product_registry.js`
- `js/trade_trigger_logic.js`

职责：

- 期权定价、股票腿/FUT/FOP/IND 乘数与语义
- amortized 成本计算
- group / portfolio 派生结果聚合
- session 导入导出、mode 规则
- 品种族元数据与能力开关
- Trial Trigger 的默认值、触发条件、退出条件、请求 payload

### 2.4 UI 编辑层

- `js/control_panel_ui.js`
- `js/session_ui.js`
- `js/group_editor_ui.js`
- `js/hedge_editor_ui.js`

职责：

- 绑定输入事件
- 渲染和更新 editor 行
- 控制 Trial / Active / Amortized / Settlement 切换
- 管理 Trial Trigger 控件、继续重试、取消订单等动作入口

### 2.5 DOM 写回层

- `js/group_ui.js`
- `js/hedge_ui.js`
- `js/global_ui.js`

职责：

- 把 valuation 结果写回页面
- 渲染黄色 Trial Trigger 预览区
- 显示 broker status、managed execution 状态、重试次数等

### 2.6 图表与概率分析层

- `js/chart.js`
- `js/chart_controls.js`
- `js/prob_charts.js`
- `js/distribution_proxy_config.js`
- `js/t_params_db.js`

职责：

- Group / Global PnL 图
- Group / Global amortized 图
- 概率密度与 expected PnL density
- Student-t 参数数据库
- futures/index family 的分布代理映射

### 2.7 实盘桥接与执行层

- `js/ws_client.js`
- `ib_server.py`
- `trade_execution/engine.py`
- `trade_execution/models.py`
- `trade_execution/adapters/base.py`
- `trade_execution/adapters/ibkr.py`

职责分工：

- `ws_client.js`
  - 维护浏览器 WebSocket
  - 发送 `preview` / `validate` / `submit` / `resume` / `cancel`
  - 接收 live quote、order status、execution-report fill cost
- `ib_server.py`
  - 连接 TWS / Gateway
  - 作为 WebSocket 入口与消息路由层
  - 广播 `orderStatus`
  - 监听 `execDetails`，把成交腿价格按订单归因后回推给前端
- `trade_execution/engine.py`
  - 把外部消息路由到具体执行适配器
- `trade_execution/adapters/ibkr.py`
  - IBKR `BAG + LMT` 订单构造
  - combo validate / preview / submit
  - managed repricing
  - continue monitoring / continue retries / cancel live order

## 3. 真实脚本加载顺序

当前 `index.html` 中的真实顺序是：

1. `js/t_params_db.js`
2. `js/market_holidays.js`
3. `js/date_utils.js`
4. `js/product_registry.js`
5. `js/trade_trigger_logic.js`
6. `js/distribution_proxy_config.js`
7. `js/pricing_core.js`
8. `js/bsm.js`
9. `js/chart.js`
10. `js/prob_charts.js`
11. `js/chart_controls.js`
12. `js/amortized.js`
13. `js/valuation.js`
14. `js/session_logic.js`
15. `js/session_ui.js`
16. `js/control_panel_ui.js`
17. `js/hedge_editor_ui.js`
18. `js/group_editor_ui.js`
19. `js/hedge_ui.js`
20. `js/group_ui.js`
21. `js/global_ui.js`
22. `js/app.js`
23. `js/ws_client.js`

这仍然是运行时约定，不是编译期约束。

## 4. 当前核心状态模型

全局 `state` 由 `app.js` 持有，关键字段包括：

- `underlyingSymbol`
- `underlyingContractMonth`
- `underlyingPrice`
- `baseDate`
- `simulatedDate`
- `interestRate`
- `ivOffset`
- `allowLiveComboOrders`
- `groups`
- `hedges`

### 4.1 Group

关键字段包括：

- `id`
- `name`
- `viewMode`
- `includedInGlobal`
- `isCollapsed`
- `liveData`
- `syncAvgCostFromPortfolio`
- `settleUnderlyingPrice`
- `tradeTrigger`
- `legs`

### 4.2 Leg

关键字段包括：

- `id`
- `type`
- `pos`
- `strike`
- `expDate`
- `iv`
- `currentPrice`
- `cost`
- `closePrice`

运行时还可能附加：

- `costSource`
- `executionReportedCost`
- `executionReportOrderId`
- `executionReportPermId`

### 4.3 Trade Trigger

当前 `tradeTrigger` 既有配置字段，也有运行时字段。

配置字段：

- `condition`
- `price`
- `executionMode`
- `repriceThreshold`
- `timeInForce`
- `exitEnabled`
- `exitCondition`
- `exitPrice`

运行时字段：

- `enabled`
- `status`
- `pendingRequest`
- `lastTriggeredAt`
- `lastTriggerPrice`
- `lastPreview`
- `lastError`

注意：

- `session_logic.js` 现在在导出和重新导入时会清掉这些运行时字段
- 也就是说，Trigger 配置会保留，但旧的 `Filled / Order ID / lastPreview` 不会再被带进 JSON

## 5. Trial Trigger 与订单执行

### 5.1 三种执行模式

当前支持：

- `preview`
- `test_submit`
- `submit`

语义：

- `Preview Only`
  - 只生成组合单预览，不送到 TWS
- `Send to TWS (Test Only)`
  - 真实送到 TWS，但使用保护性离谱价格，目标是让你在 TWS 里检查订单结构后手工丢弃
- `Send to TWS`
  - 真实 `LMT @ MID` 下单，并进入 managed repricing

### 5.2 正式下单的 managed repricing

正式 `submit` 模式的执行逻辑现在是：

- 初始按组合 middle price 提交 `BAG + LMT`
- 后端持续用各腿 live bid/ask 自己合成最新 combo mid
- 只有当 `|latest mid - working limit| >= threshold` 时才改价
- 如果达到最大自动改价次数，会停在 `stopped_max_reprices`
- 如果到达监控时限，会停在 `stopped_timeout`
- `Continue` 可以继续追加重试预算或继续监控
- `Cancel Order` 可以显式撤掉 TWS 里的 live order

这些参数现在由两部分控制：

- 每个 Group 的 UI 配置
  - `Drift 0.01 / 0.02 / 0.05`
  - `DAY / GTC`
- 全局默认执行配置
  - 来自 `config.ini` 的 `[execution]`

### 5.3 Exit Condition

`Exit Condition` 是当前真实存在的功能。

语义：

- 只在订单已经触发并且仍未终态时生效
- 如果 underlying 反向回到退出条件，则直接取消正在讨价还价的 live order

这条逻辑目前由前端在 live underlying 更新时判断，并通过 `cancel_managed_combo_order` 请求后端撤单。

## 6. 成本回填的两条来源

### 6.1 账户级兜底来源

- `updatePortfolio avgCost`

这是账户级的聚合均价，适合：

- 手工持仓同步
- 非 Trigger 订单的兜底回填

局限：

- 如果多个 Group 有完全相同的合约，会混成账户综合成本

### 6.2 Trigger 实单的精确来源

- `execDetails`

当前真实 `Send to TWS` 的 Trigger 订单，在成交后会：

- 通过 `orderId / permId`
- 结合每条腿的 `conId / expected side`
- 把这笔订单自己的腿成交均价回推给对应 Group

这条消息是：

- `combo_order_fill_cost_update`

前端收到后会：

- 只更新对应 Group 的对应腿
- 给腿标记 `costSource = 'execution_report'`
- 后续不再允许账户级 `portfolio avg cost` 覆盖这条更精确的成本

## 7. 当前 session 持久化规则

导出 JSON 时：

- 保留 group / leg / hedge 的静态配置
- 保留 Trigger 的配置部分
- 清掉 Trigger 的运行时订单状态

因此，重新导入后不会再看到：

- `Combo order: Filled`
- `Order ID / Perm ID`
- `Reprices 60 / 60`
- 黄色预览区中的旧订单详情

## 8. 配置文件

当前 `config.ini` 除了 TWS 和 WebSocket 配置，还支持执行默认值：

```ini
[execution]
managed_reprice_threshold_default = 0.01
managed_reprice_interval_seconds = 2.0
managed_reprice_max_updates = 12
managed_reprice_timeout_seconds = 600
```

说明：

- 这些是后端默认执行策略参数
- 每个 Group 的 `repriceThreshold` 和 `timeInForce` 仍可在前端单独配置
- 改完 `config.ini` 后需要重启 `ib_server.py`

## 9. 当前已知边界

- Managed repricing 目前实现位于 `trade_execution/adapters/ibkr.py`，还没有进一步抽成 broker-agnostic 的独立策略模块
- `Exit Condition` 的触发判断目前在前端，语义正确，但从长期演进看，未来可进一步下沉到后端执行层
- 页面刷新后，旧订单的 live 执行上下文不会自动恢复到新页面
- `contract_specs/*.xml` 仍未接入运行时，真实运行时元数据仍以 `product_registry.js` 为准

## 10. 当前最值得信任的文件

如果文档和代码不一致，优先相信：

1. `js/product_registry.js`
2. `js/pricing_core.js`
3. `js/valuation.js`
4. `js/session_logic.js`
5. `js/trade_trigger_logic.js`
6. `trade_execution/adapters/ibkr.py`
7. `ib_server.py`
8. `js/ws_client.js`

