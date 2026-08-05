# 修复存档：Live 合约编辑恢复 + Global Auto Close 快照路由

- **日期**：2026-08-05
- **分支**：`codex/fix-calendar-cache-bust`（工作区未提交改动之上的修补）
- **背景**：对本地领先远端的约 +1857 行未提交改动（Global Auto Close 全链路、FOP 美式定价开关、live 图表节流 + 合约编辑防串价）做整体 review，发现 1 个确认 bug 和 2 个风险点，本次全部修复并补回归测试。
- **验证基线**：修复前 JS 630 通过 / Python 104 通过；修复后 JS **632 通过、0 失败**（新增 2 个测试、改写 1 个既有测试），Python **104 通过**（无 Python 改动）。

---

## 修复 1：合约编辑后改回原值 → 该腿行情永久卡死（确认 bug，中等严重）

### 原因

新的防串价机制在编辑腿合约（strike/expiry/绑定期货）时，立即把腿 id 放进
`_liveQuoteRuntime.invalidatedOptionSubscriptionIds`，此后该 id 的所有 tick 一律以
"option contract edit pending resubscription" 拒收；同时清掉腿上的报价、IV 和
qualified 合约元数据。这个集合唯一的清空点是 `_resetLiveQuoteRuntime()`，而它只在
`_sendLiveSubscriptions` 真正发出新订阅时执行。

问题在 `js/ws_client.js` 的订阅签名去重：如果编辑最终又落回与上次订阅完全相同的合约
（例如 735 → 740 → 改回 735，或输错一位马上撤销），重建的订阅签名与
`_lastLiveSubscriptionSignature` 相同，函数在 reset 之前就 `return false`。
于是失效集合永远不清空——该腿从此收不到任何行情，价格空、identity 停在
pending/rejected，直到用户碰巧做出其他改动触发一次真正的重订阅、或断线重连。
订阅请求只由 leg 的 strike/expDate/type + profile 构造，失效时删除的 qualified
元数据不参与签名，所以"签名相同但集合非空"的状态确实可达。

### 办法

在签名去重的早退条件上追加一项：**只有失效集合为空时才允许跳过重订阅**
（`js/ws_client.js`，`_sendLiveSubscriptions`）：

```js
if (!historicalMode && options.force !== true
    && _lastLiveSubscriptionSocket === ws
    && _lastLiveSubscriptionSignature === subscriptionSignature
    && _liveQuoteRuntime.invalidatedOptionSubscriptionIds.size === 0) {
    return false;
}
```

集合非空时落入正常发送路径：`_resetLiveQuoteRuntime()` 清空失效集合，服务端重新确认
合约身份并重发 expiry timing 等元数据，被清掉的腿字段随之全部恢复。选择"多发一次
等价订阅"而不是"只清集合"，是因为后者无法恢复已删除的 `expiryAsOf`/qualified
元数据（它们来自订阅确认消息，不随普通 tick 重发）。代价仅是改回原值这一场景多一轮
与上次完全相同的订阅请求，服务端本就幂等处理。

### 结果

- 新增回归测试 `tests/ws_client.test.js` —
  "recovers quotes after an edited contract is reverted to the subscribed identity"：
  建立初始订阅 → 编辑 strike 并 invalidate → 改回原值 → 再次 `handleLiveSubscriptions()`。
  断言：确实多发出一次 subscribe（未被签名去重吞掉），且随后 tick 被接受，
  `currentPrice` 恢复、identity 回到 `verified`。
- ws_client 套件 88/88 通过；修复前该测试会在"第二次 subscribe"断言处失败。

---

## 修复 2：重连快照绕过 Global Auto Close 的状态处理（防御性修复，低-中严重）

### 原因

`js/combo_order_transport.js` 的 `handleMessage` 对实时 `combo_order_status_update`
先经 `_handleGlobalEquivalentStatus` 分流（识别 `requestSource ===
'global_equivalent_underlying'` 的净 Underlying 单）。但 `_applyActiveComboOrdersSnapshot`
（处理重连后的 `active_combo_orders_snapshot`）绕过了这个分流，把快照条目直接交给
按组处理器 `_applyComboOrderStatusUpdate`。全局等效单的 groupId 是虚拟的
`__global_equivalent__`，找不到真实 Group，条目被静默丢弃。

Review 中进一步核对了服务端（`ib_server_order_tracking.py` 的
`build_active_combo_orders_snapshot`）：已终结（Filled）的 tracking 会以真实
`combo_order_status_update` 推送重放（会走全局分流），因此"Filled 调整彻底丢失"
比最初担心的更难触发；但**非终结（working）的全局单确实只出现在快照列表里**，
被丢弃后前端 runtime 无法恢复"Underlying 单仍在工作"的状态显示，且客户端对
"Filled 只经快照到达"的场景没有兜底。

### 办法

在 `_applyActiveComboOrdersSnapshot` 的循环里，先把每个条目交给
`_handleGlobalEquivalentStatus`，命中（返回 true）则处理完毕，未命中才走原有的
按组处理器——与实时消息的路由完全一致：

```js
if (_handleGlobalEquivalentStatus(update)) {
    return;
}
_applyComboOrderStatusUpdate(update);
```

`_handleGlobalEquivalentStatus` 对非全局条目返回 false、不产生副作用，因此普通订单
路径不受影响；`_applyEquivalentExpiryAdjustment` 按 adjustmentId 与固定
underlyingLegId 幂等更新，重复应用不会双记。

### 结果

- 新增回归测试 `tests/combo_order_transport.test.js` —
  "applies a Global Auto Close fill replayed through the active orders snapshot"：
  模拟页面重载后（内存 runtime 全失）仅通过快照收到 Filled 的全局等效单，断言
  调整正确落到真实 Group（深度 ITM 腿 closePrice=0、合成对冲腿 pos=-100、
  runtime 状态 completed）。
- transport 套件 29/29 通过；修复前该测试中 Group 完全不变。

---

## 修复 3：输入过程中的中间值触发真实重订阅（行为回归，轻度）

### 原因

`js/group_editor_ui.js` 新加的 250ms debounce 调度器把"本地重算 + live 重订阅"
一起放在计时器回调里。用户慢速输入 "735" 时，停顿超过 250ms 就会以 strike=7 这样的
中间值向 TWS 发起一次真实订阅（清空输入框则是 strike=0，因为 input 处理器是
`parseFloat(...) || 0`），随后再订正——造成订阅抖动和无效合约请求。改动前的行为是
input 只做本地重算，不触发订阅。

### 办法

把调度器的提交拆成两层（`_createLegContractEditScheduler`）：

- **debounce 计时器 → `refreshLocal()`**：只调 `updateDerivedValues()` 本地重算，
  保持 pending，**不**提交订阅——保留了"停止输入后数值和图表跟上"的体验；
- **`flush()`（change/blur/离散编辑）→ 完整 commit**：`handleLiveSubscriptions()` +
  `updateDerivedValues()`，清 pending。expiry 日期选择和绑定期货下拉本就是离散事件，
  维持原有的 `schedule()+flush()` 立即提交。

另外给 strike 输入框补了 `blur` 监听调用 `flush()`：`change` 事件在"同一次聚焦内
编辑后又改回原值"时不触发，但失效的订阅仍需要一次 commit 才能恢复行情——这条路径
与修复 1 配合闭环（blur → flush → handleLiveSubscriptions → 签名相同但失效集合非空
→ 重订阅恢复）。

### 结果

- 改写既有测试 `tests/group_editor_ui.test.js` —
  "debounces option contract edits, invalidates immediately, and commits once"：
  现在断言计时器回调只做本地重算（subscriptions 仍为 0、pending 保持 true），
  `flush()` 才提交订阅，且重复 flush 是 no-op。
- group_editor_ui 套件 33/33 通过。

---

## 明确不修的项（评估后记录在案）

**FOP 美式树的 q 取全局标量利率**（`js/pricing_core.js`）：americanFuturesMode 用
q=r 消除期货风险中性漂移是标准做法，但 q 取的是 `globalInterestRate` 标量；开启
`useMarketDiscountCurve` 后折现用期限结构利率，树内漂移不严格为零。影响量级极小
（漂移误差 ~ |r_term − r_scalar| × T，通常远小于 IV 校准误差），修复需要把期限
利率穿透到 IV 反解与重定价两条路径，属中等复杂度改动，性价比不足。若未来重仓
FOP 美式定价再考虑。

另外 review 确认过、无需改动的部分：Python 全链路（engine → adapter →
order_tracking）的辅助方法、导入、digest 防篡改与净额分摊数学；调整应用的幂等性；
session 快照剔除 `globalEquivalentClose`；图表节流的 drawCharts 贯穿。

---

## 改动文件清单（本次修复新增的改动）

| 文件 | 改动 |
| --- | --- |
| `js/ws_client.js` | 签名去重早退追加"失效集合为空"条件 |
| `js/combo_order_transport.js` | 快照条目先经全局等效分流再走按组处理 |
| `js/group_editor_ui.js` | debounce 拆分 refreshLocal/commit；strike 补 blur flush |
| `tests/ws_client.test.js` | 新增改回原值后行情恢复的回归测试 |
| `tests/combo_order_transport.test.js` | 新增快照重放全局 Filled 的回归测试 |
| `tests/group_editor_ui.test.js` | 改写调度器测试匹配新提交语义 |
| `index.html` / `chart_lab.html` | 上述 3 个 JS 的缓存版本号 bump 至 `20260805-edit-revert-recovery-v1` |

## 最终验证

```
node tests/run.js                                  → 632 passed, 0 failed
.venv/bin/python -m unittest tests.ibkr_adapter_pricing_test → 104 tests OK
```
