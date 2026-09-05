# 压力测试从弹层改为独立页面视图（实施方案）

> 2026-09-05 立项。目标是把 `cost_basis.html` 里的 `#stress-modal` 弹层改成本页第三个 `.page-view`，与 `ledger-view`、`settings-view` 并列。
> 不新建 HTML 页面，不改任何估值代码（`js/cost_basis_stress_*.js` 一行不动），不改任何 `stress-*` 元素 id。
> 内核契约见 [STRESS_KERNEL_REFACTOR.md](STRESS_KERNEL_REFACTOR.md)，区间见 [STRESS_CALIBRATION_BAND_PLAN.md](STRESS_CALIBRATION_BAND_PLAN.md)。

## 1. 为什么是页面视图，不是独立页面

弹层现在装了 35 个参数控件、状态行、图、约 20 行的悬停 tooltip、三张切片核对表、关键点卡片和三段折叠说明，全部塞在 `min(1180px, 96vw)` 宽、`94vh` 高、内部滚动的对话框里。联动面板一展开，图就滚出视口：调参看不到图，看图摸不到参数。问题是布局，不是信息量。

两条路线比较：

| | 独立 HTML 页面 | 本页第三个视图 |
| --- | --- | --- |
| WS 连接、账本列表、事件全量载入、账本引擎 | 全部重做（现在都在 `js/cost_basis.js` 内，未拆模块） | 原样复用 |
| What If 手工参考价、行情时间戳、当前账本 | 需要 URL 或存储传递，可能丢失 | `state` 原样可见 |
| 快照 generation 门禁、Worker 取消 | 跨页面处理 | 现有逻辑不变 |
| 页面测试（`tests/cost_basis_page.test.js` 从真实 HTML 建 DOM，154 处 stress 断言按 id 取元素） | 需要新 harness | id 不动即不改 |
| 桥接服务并发连接 | 新增一个客户端 | 无 |

设置页已经是视图而非弹层（`_showView` 切换 `ledger`/`settings`，见 `js/cost_basis.js:972`），压力测试走同一条路。

## 2. 现状清单（改动锚点）

HTML `cost_basis.html`：
- `#stress-modal.stress-modal` > `section.stress-dialog[role=dialog]` > `header.stress-header`（`#stress-title`、`#btn-close-stress-test`）> 两个 `.stress-controls` 行 > `#stress-band-status` > 本账本面板 `.stress-protection-panel` > 联动面板 `.stress-linked-panel` > `#stress-status` > `.stress-legend` > `.stress-chart-wrap`（`#stress-chart` + `#stress-tooltip`）> `#stress-slice` > `#stress-key-points` > `.stress-note-details`。
- 入口：`#btn-open-stress-test`（What If 面板，无账本时 disabled）。
- 脚本标签顺序不变。

JS `js/cost_basis.js`：
- `_showView(view)` 只认 `settings`，其余一律 `ledger`；写 `state.activeView`、顶栏 eyebrow/标题、侧栏高亮、移除 `sidebar-open`。
- `_openStressTest()`：置 `stressOpen`、重置 `stressExpiry/HorizonDays/BasePrice`、恢复联动记忆、显示弹层、加 `body.stress-modal-open`、渲染、按需刷新快照。
- `_closeStressTest()`：`_cancelStressJob()`、`_invalidateStressScenarioInputs()`、清 horizon 定时器、隐藏弹层、去 body 类、焦点回开关按钮。
- 门禁：`_renderStressTest` 首行 `if (!state.stressOpen) return`；Worker 迟到结果检查 `state.stressOpen`（约 468 行）；horizon 去抖回调检查 `stressOpen`（约 6083 行）。
- 接线：`btn-open-stress-test`、`btn-close-stress-test`、`#stress-modal` 遮罩点击关闭（约 6029 行）、`Escape` 关闭（约 6195 行）。
- 侧栏账本按钮点击：`_selectBook` 后 `_showView('ledger')`；`book-select` change 同理；`_fillForm` 也会 `_showView('ledger')`。
- `_renderAll()` 不包含 `_renderStressTest`，账本重载不会自动重画压力测试。

CSS `cost_basis.css`：
- `body.stress-modal-open … { overflow: hidden }`（433 行）。
- `.stress-modal`（fixed 遮罩）、`.stress-dialog`（1180px / 94vh / 内部滚动）、`.stress-header`（sticky）、`.stress-close`（450–483 行）。
- `.stress-controls` 横向 flex-wrap；`.stress-protection-inputs` 横向 flex；`#stress-chart` `min-width: 760px; min-height: 390px`，图用固定 `viewBox 0 0 960 470`，宽度随容器缩放，`.stress-chart-wrap` 横向可滚。
- `@media (max-width: 680px)` 里有 `.stress-modal` / `.stress-dialog` 全屏化规则（757–758 行）。
- 布局常量：侧栏 248px；`main` 最大 1560px、左右内边距 2rem。

尺寸预算：1440px 屏幕上工作区内容宽约 1128px，左栏 320px 加间距后图列约 790px，仍满足 760px 最小宽；1280px 屏幕上图列只剩约 630px。所以双栏断点定在 **1360px**，以下改上下堆叠。

## 3. 目标结构

```
#stress-view.page-view.stress-view[hidden]
├─ header.stress-view-header          （eyebrow「What If · 多价格情景」、#stress-title、#btn-close-stress-test 文案「← 返回账本」）
├─ aside.stress-params                （sticky; top = 顶栏高度 + 1rem; 自身可滚，max-height: calc(100vh - 顶栏 - 2rem)）
│   ├─ details.stress-param-group[open]  「情景」   到期范围、基准现价、刷新现价按钮、跌到位天数、扫描范围、到位路径
│   ├─ details.stress-param-group[open]  「估值与口径」 定价模型、股息率、变现口径、盈亏口径、每周额外净收入
│   ├─ details.stress-param-group        「采样情景范围」 两个区间开关、独立本标的 β、#stress-band-status
│   ├─ details.stress-param-group        「本账本未到期期权」 现有 .stress-protection-panel 整体搬入（开关 + IV/利率来源 + 估值说明）
│   ├─ details.stress-param-group        「联动账本」 现有 .stress-linked-panel 整体搬入；分组 open 状态跟随 #stress-include-linked-hedge
│   └─ details.stress-help.stress-note-details 「分项口径与假设说明」
└─ section.stress-results
    ├─ #stress-status
    ├─ .stress-legend
    ├─ .stress-chart-wrap（#stress-chart 高度改为 min(62vh, 560px)，viewBox 不变）
    ├─ #stress-key-points
    └─ #stress-slice
```

规则：
- 所有 `stress-*` id 原样保留，只改父容器；`#stress-modal`、`.stress-dialog`、`.stress-header`、`.stress-close` 四个壳选择器删除。
- 左栏内 `.stress-controls` 改为单列 grid，控件宽 100%；`.stress-protection-inputs` 改为纵向排列，`.stress-linked-inline` 的三个复选框各占一行。
- 各分组 `details` 的 open 状态：「情景」「估值与口径」默认展开；「本账本未到期期权」「联动账本」的 open 跟随对应总开关（开关勾选后自动展开，取消后收起，用户手动展开不受影响）；不持久化。
- 图始终在结果列顶部，切参数时可见；关键点卡片紧随其后；切片核对在最后，因为它随悬停更新且体积最大。
- 顶栏标题：`_showView('stress')` 把 eyebrow 写成「What If · 多价格情景」，标题写成 `${account} / ${symbol} · 到期压力测试`；`#stress-title` 仍由 `_renderStressTest` 维护（测试依赖）。
- 侧栏「系统」标签上方新增导航项 `#btn-open-stress-view`（图标「⚡」，主文「到期压力测试」，副文「当前账本 · 多价格情景」），无账本或账本未完整载入时 disabled；进入压力测试视图时高亮。What If 面板里的 `#btn-open-stress-test` 保留。

## 4. 行为契约

1. `_showView` 增加 `stress` 分支：`state.activeView = 'stress'`，三个视图互斥显示，侧栏压力测试项 `active`。
2. `_openStressTest()` 去掉弹层显示和 body 类，改调 `_showView('stress')`；其余（重置情景日期、基准价、恢复联动记忆、渲染、按需刷新）不变；焦点仍落到 `#stress-expiry`。
3. `_closeStressTest()` 去掉弹层隐藏和 body 类，改调 `_showView('ledger')`；取消 Worker、失效快照、清定时器、焦点回 `#btn-open-stress-test` 不变。
4. **离开视图即关闭**：`_showView(next)` 在 `next !== 'stress' && state.stressOpen` 时先执行 `_closeStressTest` 的拆除部分（不递归调用 `_showView`）。这样侧栏切账本、点设置、`_fillForm`、`book-select` change 都会取消进行中的批次，迟到结果被 `stressOpen === false` 门禁丢弃。弹层时代这些入口被遮罩挡住，视图时代必须显式处理。
5. 切换账本（`_selectBook`）不会自动重开压力测试；用户回到账本后再点入口，`_openStressTest` 按新账本重新初始化。不持久化 `activeView`，页面刷新总是回到账本视图。
6. `Escape` 只在 `state.stressOpen` 时返回账本视图（现有行为不变）；遮罩点击关闭的监听删除。
7. `body.stress-modal-open` 滚动锁定删除；页面正常滚动，左栏 sticky。
8. 在 900px 以下的窄屏，侧栏抽屉 `sidebar-open` 由 `_showView` 统一关闭，压力测试视图不例外。

## 5. 样式

- `.stress-view { grid-template-columns: minmax(300px, 330px) minmax(0, 1fr); gap: 1.25rem; align-items: start; }`
- `.stress-params { position: sticky; top: calc(78px + 1rem); max-height: calc(100vh - 78px - 2rem); overflow: auto; }`
- `.stress-param-group > summary` 复用 `.stress-help > summary` 的按钮外观，但通栏显示并带展开箭头；组内元素间距 .55rem。
- `.stress-results` 各块沿用现有 `.stress-legend`、`.stress-chart-wrap`、`.stress-key-points`、`.stress-slice` 规则，去掉它们的 `margin: 0 1.25rem` 外边距（原为对话框内边距）。
- `@media (max-width: 1360px)`：`.stress-view` 单列，`.stress-params` 取消 sticky 和高度限制，结果列在下。
- `@media (max-width: 680px)`：删除 `.stress-modal` / `.stress-dialog` 规则；控件 100% 宽规则保留并改挂到 `.stress-params` 下。
- `.stress-tooltip` 定位逻辑用 `.stress-chart-wrap` 的 `getBoundingClientRect` 和 `clientWidth`（约 2608–2614 行），与容器无关，不改。

## 6. 第三阶段（可选）：悬停 tooltip 瘦身

tooltip 现有 20 行，其中八行是估值明细（② 期权/交割净值、② 本地 IV、② 无风险利率、空头负债、空头本地 IV、联动情景市值/今日市值、联动 IV、联动较买入权利金）。方案：
- tooltip 保留：价格、情景日、联动映射价、采样范围、五个分项加合计、结算后成本/持股/结算结果。
- 上述八行移入 `#stress-slice` 新增第四栏「估值明细」，由 `_renderStressSlice` 从同一个 series point 读取，字段名与 tooltip 现用字段完全相同。切片随悬停更新并在移开后保留，所以信息不丢，只是从瞬时浮层变成可停留阅读。
- 行 id 保留并搬到切片内，渲染函数只改写入目标。

此阶段与前两阶段解耦，可独立取舍。

## 7. 分阶段实施

1. **HTML 搬运 + JS 视图切换**：建 `#stress-view`，按 §3 分组搬入；`_showView`/`_openStressTest`/`_closeStressTest` 按 §4 改；侧栏入口；删遮罩监听。此阶段结束后功能完整，只是样式仍是弹层旧规则。
2. **CSS 双栏**：§5 全部；删除四个壳选择器和 433 行滚动锁定。
3. **tooltip 瘦身**（§6，可选）。
4. **文档与盖戳**：README 428/569 行、ARCHITECTURE 139 行把 modal 改为 view；DEV_HANDOVER 压力测试段落加一句；`python3 scripts/stamp_asset_versions.py` 重新盖戳 `cost_basis.css`、`js/cost_basis.js`。

每阶段结束跑 `node tests/run.js`，Python WS 套件不受影响可不跑。

## 8. 测试

全部加在 `tests/cost_basis_page.test.js`，沿用现有 harness（真实 HTML 建 DOM、`h.state`、`h.renderStress`、假 Worker 记录 `terminated`）。

1. **视图互斥**：`_showView('stress')` 后 `#stress-view` 可见、`#ledger-view` 与 `#settings-view` 隐藏，`state.activeView === 'stress'`，顶栏 eyebrow/标题为压力测试文案；再 `_showView('ledger')` 三者复原。
2. **入口门禁**：无 `state.ledger` 时点击 `#btn-open-stress-test` 和 `#btn-open-stress-view` 均不改变 `activeView` 与 `stressOpen`；载入账本后点击进入 stress 视图，`stressOpen === true`，`document.activeElement` 为 `#stress-expiry`。
3. **返回与 Escape**：点击 `#btn-close-stress-test` 或派发 `Escape`：`stressOpen === false`、`activeView === 'ledger'`、假 Worker `terminated === true`、`stressLongOptionInputs`/`stressLinkedInputs` 已失效、焦点回 `#btn-open-stress-test`。
4. **离开视图即关闭**：压力测试打开且有进行中的 Worker 时，分别调用 `_showView('settings')`、点击侧栏另一账本按钮、触发 `book-select` change：`stressOpen === false`，Worker 已终止；随后向假 Worker 投递一条迟到的 series 结果，断言 `#stress-chart` 仍为空、`#stress-status` 未被改写。
5. **重新进入按新账本初始化**：切换账本后再次进入，`stressExpiry === state.whatIfExpiry`、`stressHorizonDays === null`、`stressBasePrice` 等于新账本的参考价、联动记忆按新 bookId 恢复。
6. **id 迁移守卫**（静态）：正则提取 `js/cost_basis.js` 中所有 `$('stress-…')` / `$('btn-…stress…')` 字面量，断言每个 id 在 `cost_basis.html` 中恰好出现一次；并断言 HTML 不再含 `stress-modal`、`stress-dialog`、`stress-close`。
7. **CSS 守卫**（静态，沿用 544/2314 行的读 CSS 断言方式）：不含 `.stress-modal`、`.stress-dialog`、`stress-modal-open`；含 `.stress-view` 的双栏 `grid-template-columns`、`.stress-params` 的 `position: sticky`、`max-width: 1360px` 断点内的单列规则。
8. **分组随开关展开**：勾选 `#stress-include-linked-hedge` 后其所在 `details.open === true`，取消后 `false`；用户先手动打开再取消开关时保持打开（需要在 change 处理里区分「由开关驱动」）。
9. **侧栏入口高亮与禁用**：无账本 disabled；进入 stress 视图 `active`；回账本视图后 `active` 移除且当前账本按钮重新 `active`。
10. **窄屏抽屉**：`body.sidebar-open` 存在时进入 stress 视图，断言该类被移除。
11. **tooltip 瘦身**（若做第三阶段）：对同一个 point，切片「估值明细」四栏各行文本等于原 tooltip 行会得到的文本（用同一格式化函数生成期望值）；tooltip 中这些行元素不存在。
12. **回归**：现有全部 stress 页面测试不改一行通过；`node tests/run.js` 总数只增不减。

## 9. 手工验收（真实 TWS）

- 1440px 宽：进入压力测试，展开联动面板并逐个改 β、期限指数、价外折扣，图与关键点卡片始终在视口内随改随变。
- 联动快照拉取进行中（状态行显示「拉取中…」）时从侧栏切到另一账本：账本视图正常，控制台无迟到渲染；回原账本再进入，参数记忆恢复，快照重新拉取。
- `Escape` 返回账本，What If 面板的参考价与自动跟随状态未被改变。
- 1280px 宽：自动堆叠，图不被压窄到出现横向滚动条。
- 手机宽度：侧栏抽屉进入压力测试后自动收起，控件通栏。

## 10. 非目标

- 不做独立 HTML 页面，不做 URL hash 路由，不持久化 `activeView`。
- 不改 `js/cost_basis_stress_models.js`、`_core.js`、`_band.js`、`_worker.js`，不改 series 字段与 Worker 协议。
- 不改任何 `stress-*` id、不改 `STRESS_LINKED_STORAGE_PREFIX` 记忆格式。
- 不动 `#premium-expiry-modal`（`<dialog>`），它体积小，仍是弹层。
