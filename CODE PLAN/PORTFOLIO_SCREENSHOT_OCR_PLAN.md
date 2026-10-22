# 截图识别 Portfolio：独立页签、持仓快照与后续粗略压力测试

> 制定：2026-10-20。状态：**P0/P1 已实施；v2 单图字段与组合关系复核通过，多图/更多布局尚待验证**。
>
> 首次交付为计划文档；后续按用户要求实施 P0/P1，并提前接入最小的真实 OCR 核验路径。
> 当前实现及验收证据见 [阶段验收记录](PORTFOLIO_SCREENSHOT_OCR_VALIDATION.md)。
> 下文 P4 之后的数据库、存档、压力功能和 WS 协议仍是规划，不是已实现能力。
>
> 用户最新优先级：**第一步重点验证 OCR 能否正确读出持仓**；账号手工填写。
> NQ 期权属于复杂 FOP，先完成识别、表格和存档框架；未来只需按 NQ 涨跌幅、
> 对应日期和 IV 变化做粗略情景估算，不以精确定价或预测为首版目标。

## 1. 目标与首版范围

新增独立的「截图 Portfolio」页签：载入或拖入持仓截图，识别为可校对的持仓表，
在浏览器中形成有版本的 JSON 对象；确认后保存到独立 SQLite 库，能够按账号、
持仓日期查询、导出和恢复。以后在这个页面内新增粗略压力测试。

与现有功能的关系：

- `cost_basis.html` 继续处理事件账本及原有压力测试。
- 新页面处理的是某一时刻的**持仓快照**，不尝试从截图还原成交历史或综合成本。
- 股票、股票期权、期货、FOP、现金都可以进入识别表；“能识别归档”与“能估算风险”分开。
- 账号默认手填，第一版不做账号 OCR。填写账号不会证明图片来自该账户，存档中保留手工来源。
- 日期优先读截图中明确的持仓时点；没有则手填，不用期权到期日或上传日期代替。
- 首个可用里程碑是“这张图能读成正确、可核对的 Portfolio 表”，数据库和压力图均后置。

首版暂不做：交易、行权、持续行情订阅、自动写入旧账本、自动恢复交易工作区、
精准保证金/购买力、自动推导期货对应关系、跨账户合并、多币种汇率风险、
OCR 后无人确认直接入正式库、NQ 精确交割路径与历史全周期损益。

## 2. 已检查的仓库基础与实施约束

已阅读 `AGENTS.md`、`README.md`、`ARCHITECTURE.md`、`DEV_HANDOVER.md`、
`EXECUTION_SAFETY_CONTRACT.md`，以及以下设计和实现：

- `CODE PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md`：旧账本是事件事实来源，快照不能自动改账。
- `CODE PLAN/STRESS_KERNEL_REFACTOR.md`、`CODE PLAN/STRESS_PORTFOLIO_WORKFLOW.md`。
- `CODE PLAN/COST_BASIS_FOP_STRESS_CONTRACT.md`：既有 FOP 压力计算限定产品规则。
- `CODE PLAN/PORTFOLIO_SQLITE_PERSISTENCE_PLAN.md`、`CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md`。
- `cost_basis.html`、`js/cost_basis_stress_{models,core,worker}.js`、`js/cost_basis_fop_stress.js`。
- `js/product_registry.js`、`js/pricing_context.js`、`js/pricing_core.js`、`js/valuation.js`。
- `js/market_curves.js`、`yield_curve/backend_adapter.py`、`cost_basis_ws.py` 及两个后端的利率注入。

关键发现：

| 现状 | 对新功能的约束 |
| --- | --- |
| 前端为有顺序的全局脚本，无打包器 | 新页面沿用此结构，DOM-free 核心可用 Node 验证 |
| 股票压力核心 `compile(events, options)` 会读取账本引擎 | 不把截图伪装成开仓事件，也不直接套用旧入口 |
| FOP 压力模块依赖 FOP 账本图；当前产品规则为 CL/LO | NQ 不能因同为 FOP 就直接调用该模块 |
| `market_curves.js` 明确区分 discount / forward / carry | 共享利率工具，不能把 carry 当贴现率 |
| `pricing_core.js` 有模块级定价配置 | 需要时在独立 worker 内使用，避免影响旧页面 |
| FOP 利率动作要求现有 FOP bookId | 新页面不伪造 bookId；新增独立只读利率动作 |
| `yield_curve` 适配器支持 `requestedDate`、`refresh: false` | 历史截图按日期读缓存，避免混入未来利率 |
| 工作区备份只覆盖自己的数据库及归档分片 | 新库必须有自己的备份恢复，不能声称已被现有备份覆盖 |
| 两个后端共用显式 WS 消息上限，当前配置为 8 MiB | 图片有更小的业务上限，独立连接，不能扩大交易连接上限来迁就图片 |

本功能不涉及订单通道；新前端不加载 `app.js`、`ws_client.js`、`valuation.js`、
订单构建或执行脚本。两个后端挂载相同存储协议；识别是否可用由注入的服务能力决定。

## 3. 对用户示例截图的识别契约

### 3.1 必须识别的结构

截图不是扁平 CSV，至少包含以下不同层级：

| 可见内容 | 结构化结果 | 是否直接计入持仓 |
| --- | --- | --- |
| `TOTAL OCT ...` / `TOTAL JUN ...` / `TOTAL Other` | `group_summary` | 否，仅核对和显示 |
| 股票行 | `position`，类型 STK | 是 |
| 股票带日期/行权价/Call/Put 的行 | `position`，类型 OPT | 是，必要字段待核 |
| `<期货代码> <到期月> @<交易所>` 一类行 | `position`，类型 FUT | 是，不套股票市值公式 |
| `<代码> FOP (<交易类别>) ...` | `position`，类型 FOP | 是，保留 trading class 原文 |
| `<代码> ... <行权价>/<行权价> BearP ...` 父行 | `combo_summary` | 默认不计；只由选定腿表示经济持仓 |
| 父行下缩进的两条 Put | `position` + 同一 `parentRowId` | 是，父行不得再次计入 |
| `USD CASH` | `cash` | 单独保存，不当作股票 |
| 上方 Net Liquidity / Margin / Greeks | `account_summary` | 仅账户摘要，不当作持仓行 |
| 弹窗、提示、工具栏 | `decoration` | 否，不从中推断持仓账号或持仓日期 |

人工金标准需在 P0 冻结。初步目读约有 **15 条原子持仓、1 条现金**，
另有组合父行及日期分组；这只是检查线索，不能直接当成已验证的 OCR 结果。

### 3.2 这张图的专门反例

1. 图片未提供可作为持仓归属证据的账号信息，账号输入为空，要求用户手填；忽略通知里的账号候选。
2. `OCT 20 '26`、`JUN 17 '27` 等分组日期是合约到期分组，不是截图日期。
3. 截断的 `CA...`、`PUT ...`、策略名省略号保留原文；若关键字段不能确认，显示未知。
4. `Q3B`、`Q3C`、`NQ` 不能互相替换；期权到期日不等于其绑定期货月份。
5. `POS` 有正负数量；颜色不作为正负号来源，不能把负号漏掉后仍判为可用。
6. 组合父行数量与两条腿数量同时出现。父行和腿双计是严重失败。
7. `AVG PRICE` 不保证等于未缩放的每单位权利金；先保存原值，不自动算入场成本。
8. `DELTA DLLRS` 是券商展示指标，不当作合约数量、标的价、总市值或 NQ 点值。
9. `MKT VALUE` 对 FUT 的展示不能按股票资产现值解释；`USD CASH + 所有 MKT VALUE`
   不一定等于净清算值，不能通过强行补差“修复”识别。
10. `81.1M`、`51.5K` 是带显示精度的摘要；保留原字符串和精度信息，不当作精确对账值。
11. IV 如 `30.5%` 可规范为 `0.305`，但必须保留来源列；`LASTIMPLD VL...` 列头截断时
    只能记录为待确认的展示 IV，不能默认它是同一时刻的 mid IV。
12. 图片中空白不是零；`--`、不可见和无法识别应区分，并列出原因。

### 3.3 OCR 成功的定义

成功是“所有可见经济行均找到，结构、符号、列和关键字段正确；不可读字段明确留空”。
不以生成一张漂亮的表、输出合法 JSON 或高自报置信度作为成功标准。

OCR 目标按三层记录：

- **原始识别**：未人工改动的行、字段、候选和错误；用于衡量识别器。
- **校对后快照**：用户确认的结构化 Portfolio；用于存档和后续计算。
- **可估算子集**：通过产品、数量、价格、时间和假设检查的选定持仓；用于后续粗略压力测试。

## 4. 页面形态与使用流程

### 4.1 新 Tab 的落点

在 `cost_basis.html` 导航增加「截图 Portfolio」入口，打开独立的
`portfolio_snapshot.html` 浏览器 Tab（`target="_blank"`、`rel="noopener"`）。
它有独立 state、连接和生命周期，原账本及原压力视图不变。新页不要求先选择账本，
可直接通过 URL 打开；需要时再在 FOP 页增加同样的导航链接。

新页有「导入与校对 / Portfolio / 存档 / 压力估算」内部页签；尚未实施的能力不显示可用按钮。
首个版本只提供前两个页签和 JSON 导出，不先做所有后台功能。

### 4.2 首次工作流

1. 点击选图或拖入 PNG/JPEG；显示原图、实际像素与预览。第一版单图，后续再做多图。
2. 点击「识别持仓」，显示识别进度、取消入口和失败原因。
3. 左侧原图、右侧表格；选择行时定位图片区域，问题字段高亮。
4. 手填 U 账号，补充持仓日期；若截图只有日期，时间精度保持 `date`。
5. 校正数量、合约、列含义、父子关系和未知字段；可标记“原图不可读”，不强迫猜填。
6. 查看原子持仓表、现金、账户摘要、待处理项以及 JSON；手工调整即时反映到内存对象。
7. 导出 JSON；P4 完成后，可点击「保存快照」。识别/改表不自动保存正式版本。
8. P5 完成后按账户/日期重新打开、比较、备份和恢复；P7 之后才有选定持仓的粗略压力估算。

图片载入、预览、手填账号、表格校对和 JSON 导出应可在识别服务暂不可用时继续使用。
没有识别服务时清楚显示原因，不能返回示例持仓冒充识别成功。

### 4.3 状态与中断

`empty → imageReady → recognizing → needsReview → reviewed → saving → saved`。

- `reviewed` 表示用户已核对已知与未知项，不代表所有合约可用于估算。
- 换图、重新识别或导入 JSON 增加 `generation`；旧请求结果不得覆盖当前草稿。
- 手工改过的结果与重新识别结果分开，用户比较后才替换，不静默覆盖。
- 保存发出后继续编辑时，ACK 仅确认已发送版本；当前新草稿仍为未保存。
- 刷新/关闭前提醒未保存；第一版不使用 localStorage 存放账号和整张持仓图。
- 多张图片合并、浏览器崩溃草稿恢复均后置，不能隐式声称支持。

## 5. 内存 JSON：PortfolioSnapshot v1

### 5.1 单一状态入口

页面内使用 `portfolioSnapshotState` 管理草稿，`buildSnapshot()` 产生纯 JSON。
提供只读检查接口，例如 `window.__portfolioSnapshot.getSnapshot()`，每次返回深拷贝。
不让 DOM 表格、另一个数组和数据库各自成为一套事实来源。

建议顶层结构如下。示例只展示一条股票行，省略的其他记录不表示零持仓；账号为合成值，
原始账号不写入仓库测试文件。

```json
{
  "schemaVersion": 1,
  "snapshotId": "client-generated-uuid",
  "revision": 0,
  "account": {"value": "U0000000", "source": "manual", "confirmed": true},
  "asOf": {
    "date": null,
    "instant": null,
    "timeZone": null,
    "precision": "unknown",
    "source": "unknown",
    "confirmed": false
  },
  "createdAtUtc": "2026-10-20T20:00:00Z",
  "coverage": {"kind": "visible_only", "userConfirmedComplete": false},
  "sources": [
    {
      "sourceId": "image-1",
      "sha256": "sha256-of-original-bytes",
      "mimeType": "image/jpeg",
      "width": 2526,
      "height": 2356,
      "recognitionRunId": "ocr-run-1"
    }
  ],
  "sourceRows": [
    {
      "rowId": "row-1",
      "sourceId": "image-1",
      "rowType": "position",
      "parentRowId": null,
      "bbox": [0.02, 0.55, 0.97, 0.02],
      "rawText": "ABC ... 1,200 ...",
      "rawCells": {"POS": "1,200"}
    }
  ],
  "positions": [
    {
      "positionId": "position-1",
      "sourceRowIds": ["row-1"],
      "instrument": {
        "secType": "STK", "symbol": "ABC", "currency": "USD",
        "conId": null, "localSymbol": null, "tradingClass": null,
        "exchange": null, "expiryDate": null, "expiryInstant": null,
        "right": null, "strike": null, "multiplier": null,
        "underlyingFutureRef": null
      },
      "quantity": "1200",
      "displayValues": {"mark": "12.34", "marketValue": "14808", "avgPrice": "10.125"},
      "fieldEvidence": {
        "quantity": {"source": "ocr", "raw": "1,200", "reviewStatus": "unreviewed"},
        "instrument.symbol": {"source": "ocr", "raw": "ABC", "reviewStatus": "unreviewed"}
      },
      "issues": [],
      "reviewStatus": "unreviewed"
    }
  ],
  "cash": [],
  "accountSummary": {},
  "review": {"status": "needs_review", "changes": []},
  "recognition": {"provider": null, "model": null, "promptVersion": null, "status": "not_run"}
}
```

### 5.2 字段规则

| 类别 | 规则 |
| --- | --- |
| 数字 | 金额、价格、数量在持久化 JSON 中用规范十进制字符串；计算入口才转有限数值 |
| 空值 | `null` 表示未知，不允许通过 `Number(null)` 变成零；零必须是有证据的 `"0"` |
| 账号 | 手工填写并确认；普通展示可遮罩，导出保留真实值；不以固定数字长度猜账号 |
| 日期 | 到期日、截图时点、上传时点、识别时点、入库时点分别保存 |
| 日期精度 | 只有日期时不伪造 UTC 午夜；后续估算需显式选择时间假设并记录 |
| 合约 | 原文、规范字段和证明来源并存；缺 conId 可归档，不等于合约已资格化 |
| 乘数 | FOP/FUT 不默认 100；股票的每股单位规则也应记录规则来源 |
| 字段证据 | OCR 字符串、候选值、源行、可用时的字段框、人工改前/改后、原因 |
| 置信度 | 可为空；模型自报置信度只用于排序，不能直接作为已确认依据 |
| 行坐标 | bbox 为原图方向归一化后的 `[x,y,width,height]`，范围 0–1；必须记录变换关系 |
| 覆盖范围 | 默认 `visible_only`；截图上下滚动/折叠可能漏仓，不因识别无误就标为全账户 |

保留 `displayValues` 的所有识别列，如 mark、costBasis、dailyPnl、unrealizedPnl、
deltaDollars、marketValue、avgPrice、theta、lastPrice、displayIv。它们是截图观察值，
不直接承诺同一时点、同一定价单位或可进入同一个求和公式。

`positions` 只包含确认采用的原子行；分组和组合父行存在 `sourceRows`，以关系引用。
原始 OCR 输出独立保留，人工修订不改掉原始证据。同一合约重复出现在不同源行时先报告，
不自动相加或去重；未来多图分页也沿用该规则。

### 5.3 两级保存与估算门槛

- 内存草稿/JSON 导出：可缺账号、日期、字段，但显式标记 `needs_review`。
- 数据库存档：账号和持仓日期已人工确认，已逐项确认未解决问题及可见范围；未知合约仍可存档。
- 粗略估算：另行验证所选持仓、价格、日期、IV/模型和产品支持；未知项不能补零。

数据库允许保存“已审阅但不完整”的快照，索引显式记录 completeness，不把它标成完整账户。
人工确认只证明用户采信这些数据，不伪装为 TWS 或交易所证明。

## 6. OCR 方案：先测正确率，再扩功能

### 6.1 识别服务边界

新增 `portfolio_snapshot_ocr.py` 适配接口：输入图片字节、图像元数据、schema/prompt 版本，
输出受限的候选结构、原始字段、行关系和问题列表；不返回可执行指令。

不在本计划锁死供应商或承诺本地 OCR 的表现。P2 先选择一个可实际使用的图像识别后端，
以用户示例的人工金标准实测；比较项包括行召回、关键字段、表格结构、耗时和每图费用。
只做一个真实适配器加一个固定输出的测试适配器，避免首版变成多供应商平台。
没有凭据时只运行固定输出的接线测试，并明确标记“未验证真实识别”；这不能通过 OCR 验收。

如选择云端图像服务，凭据由后端本地配置持有；浏览器不接收密钥。载图不自动外传，
「识别持仓」按钮旁说明当前识别服务及图片传输方式，点击才发出本次识别。
实际接 OpenAI API 时再遵循当时的凭据配置工作流；本次计划阶段不创建或读取密钥。

### 6.2 识别流水线

1. 浏览器校验文件签名、类型、大小、像素数量和可解码性；处理方向，不覆盖原图。
2. 原图始终保留。可按表头/持仓区域裁剪生成识别副本，并记录副本到原图的坐标变换。
3. 先识别列名、分组、行层级、行框，再提取行内字段。是否一次请求完成由实测决定，
   不能仅因流程分两步就强制调用两次模型。
4. 长图按有重叠的纵向片段处理；每片保留表头映射。按原图坐标检查接缝重复和漏行，
   不凭合约名称相同就自动合并。第一版可先只支持单图整体读取，切片在真实失败时加入。
5. 输出 schema 校验通过后，交给 DOM-free 正规化模块；重新校验数字、日期、类型、符号和关系。
6. 展示逐项问题。低置信/不可读字段允许局部放大或局部重新识别；重新识别先比较差异。
7. 人工核对生成一个新草稿版本，再决定是否导出或存档。

图片里的文字均作为待识别资料。即使图片包含“忽略指令”“执行操作”等内容，也只能变成
不可信文本；识别器没有数据库写入、交易、工具调用或任意 URL 抓取能力。
渲染原文使用文本节点，不把 OCR 文本拼进 HTML。服务端输出也必须重新校验。

### 6.3 数字及列识别

- 严格解析负号、括号负数、小数点、千位分隔、百分比；不使用宽松 `parseFloat` 吞掉尾部。
- 处理 `0/O`、`1/I/l`、`5/S` 等候选，但不能在关键字段静默替换；保留原文与待确认值。
- 红绿背景只能帮助分割，不能替代明确数字、负号、Call/Put 文字。
- 先根据表头建立列索引；不得因某行缺单元格就让后续值整体左移。
- `POS`、`AVG PRICE`、`MARK`、`MKT VALUE`、`DELTA DLLRS` 必须区分。
- 金额核对只生成疑点。例如 STK 的 `q × mark` 与截图市值在显示舍入范围比较；
  不能为了让等式成立而自动修改 q、乘数或报价。
- 不用跨品种 `TOTAL POS` 校验原子数量，因为股票股数、合约张数、组合单位混在一起。

### 6.4 正确率与通过标准

P0 准备人工逐行核对的金标准：每个源行的类型、父子关系、可见字段、未知原因。
用户原图及完整识别结果存放在被忽略的私有测试目录，不纳入公开 Git；仓库内只放合成/脱敏样本。

| 指标 | 计算方式 | P2/P3 验收门槛 |
| --- | --- | --- |
| 原子持仓行召回 | 正确找到的可见原子行 / 人工可见原子行 | 用户基准图达到 100%；不能漏行后仍报完整 |
| 数量与方向 | 按金标准逐行匹配有符号数量 | 基准图可读数量 100% 正确；错号为阻断项 |
| 可读合约关键字段 | symbol/type/expiry/right/strike/tradingClass 分字段 exact match | 基准图可见可读部分 100%；截断未知单列，不从分母隐去实际错误 |
| 层级与去重 | group/combo/leg 分类及对应关系 | 基准图不得出现父子双计、腿遗漏 |
| 列归属 | 关键数值映射到正确列 | 不得把 delta dollars 当市值，或把均价当 mark |
| 未知字段诚实性 | 不可读字段是否保持未知 | 不得编造账号、截图日期、期货绑定或省略部分 |
| 其他金额和 IV | 分列计算 exact match；摘要另计显示精度 | 逐列报告，不以总平均正确率掩盖关键错误 |
| 重复性 | 同图重复 3 次，并测缩放/裁剪/压缩版本 | 记录各次结果和关键差异，不能只报告最好一次 |

“原始 OCR”和“人工改后”分别出报告。P2 通过是限定样例的可行性；P3 才扩到至少
10 张具有不同布局/缩放/折叠状态的合成、脱敏或私有截图，报告各图结果和人工修正耗时。
未达到原始识别门槛可以继续改适配器，但不能把人工修正后的 100% 写成模型正确率。
如模型读取截断字段，只有显式未知才算正确；可见字段读错仍计错。

## 7. 数据库映射与存档语义

### 7.1 独立数据库

新建应用数据目录下的 `portfolio_snapshots.db`，与 `portfolio.db`、`cost_basis.db` 平级。
不向旧事件账本塞截图，不修改旧工作区 schema，不复用旧存档分片。

第一版采用“**版本化 JSON 是正文，关系表是检索索引**”：数据库索引与版本 JSON
在同一事务内生成；禁止前端同时提交两份互不校验的持仓正文和关系化经济事实。

建议 schema（P0 冻结字段及完整 DDL，以下为职责草案）：

| 表 | 关键字段与作用 |
| --- | --- |
| `snapshot_documents` | snapshot_id、当前 revision、account、as_of_date、completeness、创建时间；账号/日期索引 |
| `snapshot_revisions` | `(snapshot_id, revision)`、canonical_json、payload_sha256、schema_version、保存时间、修订说明；版本不可变 |
| `snapshot_sources` | image_sha256、原图 BLOB、mime、width、height、bytes；按原始字节 hash 去重 |
| `snapshot_revision_sources` | `(snapshot_id, revision, source_id)`、image_sha256，关联正文 sources |
| `snapshot_recognition_runs` | run_id、source hash、provider/model/prompt 版本、原始候选 JSON、状态；供溯源 |
| `snapshot_save_receipts` | client_token、请求指纹、原始 ACK；幂等重试 |

为简化备份一致性，第一版选择原图 BLOB 入新库；限制单图与快照体积，不引入独立文件夹和
跨文件事务。识别临时图与未保存结果仅在内存/有时限临时区，未点击存档不自动进入正式库。
如果后续图片规模证明 BLOB 不合适，再设计独立资产仓，不在首版提前做分片和清理。

第一版不用 SQL 按每条腿做复杂统计；从版本 JSON 还原 Portfolio。若未来确实需要，
新增可重建的 position 索引表，不改变正文的事实来源。

### 7.2 写入和版本

`save(snapshot, expectedRevision, clientToken)`：

1. 服务端独立校验 schema、账号、日期、审阅状态、行关系、数字和图片引用。
2. 验证上传的原图 bytes 与 SHA-256 一致；不能凭前端伪造的 hash 接受不存在的来源。
3. 规范化 JSON，计算 SHA-256；正文 hash 不含 hash 自身、连接状态、blob URL、UI 选择或密钥。
4. 短事务 `BEGIN IMMEDIATE` 内校验 expectedRevision；生成不可变新版本、图片关系、索引、receipt。
5. 任意一步失败整笔回滚；相同 token/相同请求返回首次 ACK，不重复插入。
6. 相同 token/不同请求报冲突；不同 token/相同图片仅提示可能重复，不能吞掉真实的重新校对版本。

同账户同一天可有多个时间点和多个快照，不能用 `(account, date)` 作唯一键覆盖旧档。
手工修订账号/日期/数量也保存为新 revision，旧版本和原识别证据可追溯。
暂不提供永久删除、自动归档清理或“恢复并覆盖当前数据库”。

### 7.3 备份与恢复

- P4 同时提供单快照 JSON 导入/导出，确保数据库失效时仍可保存当前表格。
- P5 提供完整库备份：SQLite online backup 生成静态副本，校验数据库、正文 hash、图像 hash、引用关系，
  写入 manifest 后原子发布；不能在 WAL 活跃时仅复制 `.db` 主文件。
- 备份带原图、候选结果、人工改动、版本和幂等 receipt。既有 workspace recovery-set 不自动包含它。
- 同一库允许两个后端访问：WAL、busy_timeout、短事务；备份/迁移用独立跨进程锁。
  不把针对旧 portfolio 表结构的 maintenance guard 生硬套到新库。
- 恢复先进入全新临时库，校验通过并预览后再供打开；首版恢复入口不覆盖活动库。
- 快照可移植包采用 manifest + JSON + 原图，文件名由程序生成，拒绝路径穿越、超量条目和损坏 hash。
  包导入与库备份分别说明用途；只含 JSON 的导出显示“未包含原图”。
- 归档按持仓日期检索，备份按执行时间命名，两种日期不混淆。

## 8. 传输、识别任务和服务隔离

### 8.1 最小独立客户端

`js/portfolio_snapshot_client.js` 使用独立 WS，不复用交易页面连接。新页的出站动作白名单：

| 阶段 | 拟议 action | 作用 |
| --- | --- | --- |
| P2 | `request_portfolio_snapshot_capabilities` | 返回识别服务、限制、存储/利率可用性 |
| P2 | `recognize_portfolio_screenshot` | 发起单图识别，仅返回候选 |
| P2 | `cancel_portfolio_screenshot_recognition` | 尽力取消；旧回复仍受 generation 检查 |
| P4 | `upload_portfolio_snapshot_source` | 明确存档时暂存图像，返回有时限的 source token |
| P4 | `save_portfolio_snapshot` | 校验后正式提交 JSON + 已暂存来源 |
| P4 | `list_portfolio_snapshots` / `load_portfolio_snapshot` | 按账号、日期、revision 读取 |
| P5 | `export_portfolio_snapshot_bundle` / `import_portfolio_snapshot_bundle` | 有界分页/分块导入导出 |
| P7 | `request_portfolio_snapshot_discount_curve` | 根据截图日期只读缓存利率 |

备份完整库先用专用 CLI，不通过 WS 返回任意文件路径。识别与存储动作不会转发至交易 dispatcher。
两后端均挂载 `portfolio_snapshot_ws.py`；historical 后端没有 broker 也应能识别和存档。
识别器未配置时返回 `ocr_unavailable`；P7 利率只读，无市场数据刷新。

### 8.2 文件和任务限制

P0 冻结默认限制，首版建议：单图原始 bytes ≤ 4 MiB、最长边 ≤ 8192、总像素 ≤ 2000 万；
JSON 正文 ≤ 1 MiB。4 MiB 经 base64 后加 envelope 仍低于当前 8 MiB WS cap，
但必须以序列化后的实际字节数再次校验；遇到更小的部署限制按实际上限拒绝并提示压缩副本。

- 每次消息只带一张图，不把多图打包进同一消息；原始超限图先由用户选择生成缩小副本，
  界面标明保存的是副本，不能说保留了未上传的原图。
- 解码后再校验尺寸，阻止极端像素图片耗尽内存；PNG/JPEG 以内容签名校验，不只看后缀。
- 每连接一个识别任务、每后端最多两个、全进程有界队列或直接 busy；P2 选择直接 busy，避免无界等待。
- 识别网络请求使用异步或独立执行单元，不能阻塞 WS 事件循环和订单监督；数据库 IO 不在主循环跑。
- 默认识别超时 90 秒，界面持续显示状态；断开/取消后释放临时对象；不无限自动重试付费请求。
- 保存与识别的上传 token 分用途，绑定会话、图像 hash、大小和有效期；不接受客户端文件路径。
- requestId、source hash、generation、snapshotId/revision 精确配对，响应未匹配则丢弃。
- 新协议默认只允许 loopback；服务端先做访问检查再解码/调用识别器；不修改全局 Origin 或交易网络策略。
- 源图、账号、正文、模型原文和密钥不写常规日志；日志只含任务 ID、字节数、耗时和稳定原因码。

图片超过首版限制是有提示的失败，不能悄悄裁掉持仓区域后称识别完整。
对象 URL、临时 bytes 和超时任务需有明确释放点。

### 8.3 初始原因码

`image_type_unsupported`、`image_too_large`、`image_decode_failed`、`image_dimensions_exceeded`、
`ocr_unavailable`、`ocr_busy`、`ocr_timeout`、`ocr_output_invalid`、`recognition_superseded`、
`account_required`、`asof_required`、`unreviewed_critical_field`、`combo_overlap`、
`contract_unresolved`、`revision_conflict`、`source_missing`、`source_hash_mismatch`、
`rate_unavailable`、`rate_date_mismatch`、`scenario_inputs_incomplete`。

每个码有中文解释、对应字段或行、下一步；前端不直接展示服务商堆栈或服务器路径。

## 9. 代码复用：共享基础能力，不复制账本语义

| 来源 | 使用方式 | 接入阶段 |
| --- | --- | --- |
| `js/market_curves.js` | 直接引用同一个文件；读取 discount curve、插值及期限利率 | P7 |
| `yield_curve` repository / backend adapter | 注入只读接口，按日期选择缓存，不复制下载器 | P7 |
| `js/american_binomial.js` | 后续需要美式估值时直接引用 | P7 评估 |
| `js/product_registry.js`、现有日期工具 | 复用可验证的产品/日期元数据；默认 profile 不当作 NQ 规则证明 | P6/P7 |
| `cost_basis_stress_models.js` 的纯定价函数 | 先做依赖盘点，可直接复用则引用；抽取才做双入口回归 | P6/P7 |
| `pricing_core.js` | 若采用则在 worker 中独立初始化；不为了几条公式加载整个主壳 | P7 评估 |
| 旧 worker generation / 取消模式 | 复用设计，新增适合快照输入的 worker 协议 | P7 |
| 旧 SQLite/协议实现 | 复用已合适的目录解析、规范化、事务模式；不复用旧业务表名与动作 | P4 |
| `cost_basis_stress_core.js` / FOP 压力主入口 | 不直接用于截图；它们要求账本历史/产品规则 | 不接入 |

原则：用户说的“复制必要功能过来共享”落实为**同一份基础实现＋新页面适配层**，避免长期维护
两套利率或定价公式。抽取公共模块必须有真实的两个调用者和必要测试，不在 OCR 首阶段重构旧压力内核。

页面加载顺序按阶段增加：`schema/core → OCR normalizer → client → view/controller`；
压力阶段另在 worker 加载日期/产品工具、market curves、选定定价器，再加载 snapshot stress。
worker 依赖 URL 与页面资源盖戳一致，不拼一套可能过期的裸文件名。

## 10. 后续 NQ 粗略压力估算：刻意后置

### 10.1 用户需要的结果

给定 NQ 涨跌幅、目标日期和 IV 变化，粗略比较选定持仓的价值变化。
结果标注“假设情景估算”，不是行情预测、精确交割结果、保证金或实盘可成交损益。
先验证 OCR 和快照，再独立补充这一节的数值契约；P0–P5 不被 NQ 定价细节阻塞。

初始控件建议：

- 参考 NQ 价格，由截图可确认值或用户手填，并标明价格日期。
- NQ 涨跌幅，例如 `-10% / -5% / 0 / +5% / +10%`。
- 目标日期，必须不早于基准日期；只有日期时用户选择时间假设。
- IV 变化优先用“百分点”：30% + 5 点 = 35%；如支持相对百分比另设选项，不混用。
- 逐腿 IV 优先取可确认的截图展示值，也可手填。所有假设展示来源。
- 选择纳入的持仓；NQ、TQQQ、UVXY 不自动视为同一个风险因子。

### 10.2 从简单到复杂的模型选择

P6 先验证线性头寸和场景映射，P7 再选择一个 NQ 期权近似：

1. **Greek 近似**：只有 Delta/Gamma/Vega/Theta 的单位和观测时点已确认时才使用。
   `DELTA DLLRS` 和组合 Theta 不能直接拼成逐腿 Greeks；截图不齐时不得假装可计算。
2. **简化重估**：输入足够时，以 Black-76 等明确指定模型对 NQ 期权做近似；
   忽略美式提前行权或采用共同 NQ 参考价等简化可以接受，但必须让用户明确选择并显示。
   这只是情景代理，不要求首版建立精确 NQ 月份绑定、完整交割账本和美式路径。

两者选一个先做，不首发两套引擎。若真实截图缺 Greeks，而可补 NQ 价格与 IV，优先评估简化重估。
精确未来合约绑定未知不会阻止存档；近似时用显式 `proxyUnderlying` 假设，不能把该假设写回合约身份。
期货线性变化用 `数量 × 点值 × 价格变化`，点值必须有来源或人工确认，不能套用股票乘数。

粗略模型可以简化市场行为，但不能简化数量正负、父子去重、单位、日期和缺项处理。
没有足够输入的腿保留在 Portfolio 表，估算区列出排除原因；只有用户明确选择了可用子集，
才展示该子集结果，并始终列出纳入/排除的行，不能把局部结果称完整账户净值。

### 10.3 估算基线与利率

- 主结果是相对当前所选快照的变化，不倒推成本，不复制旧账本每股成本线。
- 模型预测变化采用 `Σ q × multiplier × [V_model(scenario) − V_model(anchor)]`；
  零时间/零涨跌/零 IV 冲击严格归零。
- 截图 mark 与模型 anchor 的残差单独显示；不能把残差当作 NQ 涨跌收益。
- FUT 采用线性变化；现金首版不计融资和利息。FUT mark 的名义金额不作为账户资产现值再加一次。
- 只有用户提供并确认范围一致的 NAV 时，才可展示 `NAV_base + Δ`，否则只展示变化金额。
- 历史截图通过新利率动作传 `requestedDate=asOf.date`、`refresh=false`，只读不晚于当日的曲线。
  适配器历史请求的 `cached` 不自动代表曲线足够近，需返回并检查 actual curve date 与允许间隔。
- 缺利率可显式填“假设利率”，全程标注；不能拿今天 latest 曲线冒充历史曲线。
- `discount` 与 `carry` 类型不混；旧曲线过期判定不能照搬“相对今天”的规则去拒绝所有历史截图。
- 粗略模型第一版不处理跨期权到期后的路径：目标日期不晚于所选期权允许的截止时刻；
  到期边界先单独验证内在价值。跨到期后如何处理另设后续阶段，不悄悄删掉到期腿。
- 若选择对数期权模型，F ≤ 0 或非法 IV 停止对应情景；不使用 epsilon 把它变成有效价格。

### 10.4 展示与共享

先表格，后曲线：每行展示数量、参考价格/IV、情景价格/IV、模型与假设、变化金额，底部求和。
跑通独立手算例后才添加扫描图和数量试调。初版不搬过 β/期限/价外折扣等整套股票压力参数，
不把 TQQQ 的 3 倍属性当成 NQ、QQQ、UVXY 的自动映射。
股票/OPT 与 NQ/FOP 的估算都按 capability 开启，所有计算仅读内存，不写旧库，不下单。

## 11. 文件分工（拟议）

按阶段创建，禁止为了“搭框架”一次性生成所有空模块：

| 文件 | 职责 | 阶段 |
| --- | --- | --- |
| `portfolio_snapshot.html` / `portfolio_snapshot.css` | 独立 Tab、选图、原图对照、结构表 | P1 |
| `js/portfolio_snapshot_schema.js` | schema 常量、严格字段规则、JSON 进出 | P0/P1 |
| `js/portfolio_snapshot_core.js` | DOM-free 状态变换、层级、校验、去重提示 | P1 |
| `js/portfolio_snapshot_view.js` / `js/portfolio_snapshot.js` | 表格、图片框、字段编辑、生命周期 | P1–P3 |
| `js/portfolio_snapshot_ocr.js` | 候选正规化、列与父子映射、差异比较，无网络 | P2 |
| `js/portfolio_snapshot_client.js` | 专用连接、requestId、超时、generation、白名单 | P2 |
| `portfolio_snapshot_schema.py` / `portfolio_snapshot_protocol.json` | 服务端类型、与前端共用 fixture | P2/P4 |
| `portfolio_snapshot_ocr.py` | 图像服务适配、有限并发、输出校验 | P2 |
| `portfolio_snapshot_ws.py` | 新 action 路由、访问/体积限制、任务清理 | P2/P4 |
| `portfolio_snapshot_store.py` | 独立 SQLite、版本、来源、幂等、检索 | P4 |
| `portfolio_snapshot_backup.py` | 一致备份、manifest、校验和隔离恢复 | P5 |
| `js/portfolio_snapshot_scenario.js` | 纯情景参数、线性基准 | P6 |
| `js/portfolio_snapshot_stress.js` / `_worker.js` | 快照估算；接口待 P7 数值契约冻结 | P7 |
| `tests/fixtures/portfolio_snapshot/` | 合成/脱敏 goldens、schema、错误、数值向量 | P0 起 |
| `tests/run_portfolio_snapshot.js` | 分阶段 Node 验收入口 | P1 起 |
| `scripts/verify_portfolio_snapshot_ocr.py` | 固定 goldens 评测；真实识别显式运行 | P2 |
| `scripts/portfolio_snapshot_synthetic_backend.py` | 临时库、固定识别候选、浏览器隔离验证 | P2/P4 |
| `scripts/portfolio_snapshot_browser_assertions.js` | 拖拽/识别/校对/保存/重载流程 | P2 起 |
| `scripts/backup_portfolio_snapshots.py` | 新库备份/校验/隔离恢复 CLI | P5 |
| `CODE PLAN/PORTFOLIO_SCREENSHOT_OCR_VALIDATION.md` | 每阶段证据、限制和下一步 | P0 起 |

既有文件只按需要小改：两个后端的模块挂载、`ib_server_ws.py` 路由、`cost_basis.html` 导航、
`config.ini` 的可选非敏感配置、`.gitignore` 私有样本目录，以及资源盖戳与测试登记。
启动脚本只有实际增加运行依赖时才考虑修改，修改前重新阅读整条启动链。

## 12. 分阶段实施与可验证门槛

### P0：冻结样例、字段和真实识别验收标准

交付：

1. 人工逐行核对示例图，写 goldens：源行类型、关键字段、父子关系、明确未知。
2. 固定 schema v1、数字/时间规则、账号手填、覆盖范围和存档门槛。
3. 冻结首版文件限制、OCR 适配接口、评测字段与失败原因。
4. 建立 validation 文档；私有原图留在忽略目录，只提交脱敏/合成 fixture。

验收：能独立回答“哪些是持仓、哪些不能双计、哪些看不出”；至少包含错号、截断名、
无账号、无日期、组合父子、空值反例。此阶段不需要模型 API、不需要旧账本和真实数据库。

### P1：最小可运行页面和内存 Portfolio（优先小步）

交付：独立 Tab 入口、选图/拖拽、预览、手填账号/日期、表格、JSON 查看/导出。
用明确标识的合成候选 JSON 验证接线；同时允许手动添加/编辑一行，测试数据不得冒充真实 OCR。

验收：

- 拖拽与点选产生同一图片状态；非法/超限图有明确反馈。
- 数量修改立即反映在唯一内存 JSON，导出再导入保持语义一致。
- 无账号/日期时可继续校对，状态为未完整；不自动填今天。
- 打开新页不需要账本、不发旧账本动作、不触达 broker。
- 旧压力测试入口和状态不受新增导航影响。

门槛：P1 只验证框架，不声称识别功能已实现；完成后立即转 P2，不先扩数据库/图表。

### P2：真实单图 OCR 跑通并量化正确率（第一重点）

交付：一个真实识别适配器、输入/输出校验、单图请求、结果定位、取消、基础评测报告。

验收：

- 用用户基准截图逐项对人工 goldens，比对未经人工修改的原始结果。
- 达到 §6.4 的行召回、数量方向、合约可读字段及父子不双计门槛。
- 同图重复 3 次，报告模型/提示版本、错误字段、耗时和费用；不可读字段留空。
- 断网、无凭据、busy、超时、错误 JSON 有稳定反馈，旧识别回复不能覆盖新图。
- 账号仍手填、截图日期不能从到期分组中猜出。

门槛：若原始识别不过关，继续改善分割/提示/适配器，只交付实验结果；不开始压力图，
不以“用户能手改”宣布 OCR 已过关。无需为了测试而开启 TWS 或重启真实桥接。

### P3：校对闭环与多样本验证

交付：字段证据、原文/规范值对照、修订记录、父子处理、重复提示、局部重识别比较。

验收：

- 至少 10 张不同样例逐图出报告，原始正确率和人工修正后的正确率分开。
- 合成错误包括：负号丢失、串列、重复腿、折叠组合、模糊/遮挡/缩小、无日期与混合日期。
- 对明确不可读项能保存为未知；未检查字段不能一键变成“模型已确认”。
- 原图与表格逐行对应，重新识别不丢手改记录；记录完成一张图的人工校对耗时。

门槛：达到“可靠生成可审阅 Portfolio”的里程碑，JSON 已可手工备份。
多图自动拼接不属于本阶段必做项，除非样例证明单图无法满足实际场景。

### P4：数据库存档与按账户/日期读取

交付：新库、版本化 JSON、原图/识别来源、幂等保存、列表、重开；两后端同协议。

验收：

- 确认账号与日期后保存，关页重开后逐字段一致；原图 hash 和修订轨迹可验。
- 同日多快照不覆盖；账号改正生成新 revision；缺字段已审阅快照标为不完整。
- 重试同 token 不重复写入；旧 expectedRevision 冲突；事务故障整笔回滚。
- 前端篡改字段类型、来源 hash、父子关系时后端拒绝；保存失败仍可导出内存 JSON。
- 两后端均在临时数据库上验证，不读写真实 `cost_basis.db` 或 `portfolio.db`。

### P5：独立备份、恢复演练和可移植包

交付：SQLite 一致备份 CLI、校验 manifest、单快照包、临时库恢复、格式版本策略。

验收：

- 在另一个空临时目录恢复后，账号、日期、所有 revision、原图和识别/修订证据一致。
- 活跃 WAL 条件下备份仍一致；损坏 JSON/hash、缺原图、路径穿越、未来 schema 被拒绝。
- 备份中断不发布半成品；恢复失败不修改活动库；双后端并发保存有冲突/重试边界。
- 文档明确新库备份独立于既有 workspace recovery-set。

此阶段完成即可作为“图片 → Portfolio → 可检索档案”正式里程碑。

### P6：情景输入框架与线性资产验证

交付：NQ 涨跌幅/目标日期/IV 变化参数、纳入持仓列表、手工假设来源、线性变化表。
只验证 FUT/STK 等明确线性输入；OPT/FOP 暂显示待接入，不能按线性头寸替代。

验收：纯期货按 q × 点值 × ΔF 手算一致，负数量方向正确；零冲击为零；
改变情景不修改快照；NQ 冲击不自动传到 TQQQ/UVXY；选定子集和排除项始终可见。

### P7：NQ 期权粗略估算和共享利率

实施前交付一份短数值契约：选择 Greek 近似或简化重估中的一个，冻结输入单位、
IV 冲击、日期、基线、到期边界、适用范围和手算/独立参考向量。无需升级为精确 FOP 账本。

交付：共享利率读取、显式 NQ 参考/代理假设、worker、逐腿估算表；表正确后再加曲线。

验收：

- `0 天 / 0 涨跌 / 0 IV 冲击` 的变化为零；逐腿与组合合计一致。
- 时间、IV、涨跌幅分别改变时只有对应参数生效；IV 百分点/相对值不混淆。
- 独立基准计算验证多空方向、乘数和数量线性，不用生产模块生成预期答案。
- 历史利率无未来数据；缺失可手填假设且全程标注；模型残差和场景变化分开。
- 简化月份代理不污染原合约身份；F ≤ 0、到期边界、缺 IV/价格有明确停止原因。
- 改参数/快照会取消旧任务；迟到结果丢弃；计算全程不写旧库或发 broker 动作。

### P8：按真实使用证据扩展（不属于当前首发承诺）

多图分页/合并、更多券商布局、批量导入、未保存草稿恢复、快照比较、定期备份、
数量试调、股票期权估算、跨资产映射、NQ 更细月份曲线或更精确模型。
各项单独定义验收后再做；不会因为已有框架就默认全部开启。

## 13. 验证入口与测试隔离

拟建立按阶段可运行的命令，脚本交付前不得称已执行通过：

```bash
# P1 起：当前阶段的纯逻辑/页面契约测试
node tests/run_portfolio_snapshot.js --stage P1

# P2 起：固定识别结果回归（不调用外部服务）
python3 scripts/verify_portfolio_snapshot_ocr.py --mode fixture \
  --raw tests/private_portfolio_snapshot/browser/raw-ocr.json \
  --golden tests/private_portfolio_snapshot/golden.json \
  --output tests/private_portfolio_snapshot/fixture-report.json

# P2/P3：显式真实识别评测；输出目录必须被 git 忽略
python3 scripts/verify_portfolio_snapshot_ocr.py --mode live \
  --image 'Portfolio SC/20261020.jpg' \
  --golden tests/private_portfolio_snapshot/golden.json \
  --output tests/private_portfolio_snapshot/ocr-report.json --runs 3

# P4 起：服务端 schema / store / WS；各测试自己创建临时目录
python3 -m unittest discover -s tests -p 'portfolio_snapshot_*_test.py'

# 接入公共模块或页面后：现有回归和资源版本检查
node tests/run.js
python3 scripts/stamp_asset_versions.py --check
```

每阶段还需实际浏览器验证对应动作。自动测试使用合成后端、临时库和固定 OCR 响应，
端口由测试分配且拒绝生产 8765；浏览器网络限制到测试后端，不能碰真实券商或真实业务库。
真实 OCR 质量评测是独立显式步骤，不在每次离线测试中产生付费调用。

新增页面要同时登记 `scripts/stamp_asset_versions.py`、`tests/asset_versions.test.js` 的页面列表；
新增 Node suites 登记到 `tests/run.js`。共享定价修改时补受影响的股票/FOP/利率回归，
纯文档和导航变更不跑整套市场数据测试。

验证记录每项至少包含：阶段、代码版本、样例/数据来源、环境、执行入口、结果、
原始 OCR 与人工校对差异、已知限制、失败反例，以及是否达到进入下一阶段的门槛。

## 14. 上线、回退和最终完成定义

- P1–P3 可独立使用内存/JSON；识别功能失败不影响原账本。
- P4 仅新库写入；关闭新 Tab 入口或识别 capability 即可回退，不需要迁移旧库。
- 新库升级前做已验证副本；未来 schema 的数据保持只读/拒绝写入，不尝试猜测降级。
- P7 未验收前不展示可用压力按钮；存档功能无需等待它。
- README / ARCHITECTURE / DEV_HANDOVER / AGENTS 的新增页面和模块描述在实际交付阶段更新，
  不能现在就把规划功能写成已实现。

三个独立完成标准：

1. **识别可用：P0–P3。** 示例真实 OCR 达到门槛，能逐行校对得到正确的内存 Portfolio，
   账号手填、日期不猜、父子不双计，未知信息不编造，支持 JSON 导出。
2. **存档可用：P4–P5。** 可以按账号与日期保存、重开、追溯、备份和在空库恢复，原图与修订不丢失。
3. **粗略估算可用：P6–P7。** 在明确范围和假设下比较 NQ 涨跌、日期与 IV 对选定持仓的近似影响，
   单位与方向正确、结果可复算，不宣称精确预测，不污染原始快照和旧账本。

### 14.1 P0/P1 实施补记（2026-10-20）

- P0 冻结契约与逐行目读基准已建立；P1 的独立 Tab、拖拽、原图定位、字段编辑、
  逐行核验及内存 JSON 已实现。用户最终人工验收仍待实际操作。
- 为满足“拖入图片就能实际看识别信息”，提前接入 P2 的最小真实 OCR 通路。
  选用本机 macOS Vision，无 API key、无外传；不是固定样例回填。
- 当前采用独立 loopback HTTP 预览服务（8798），不挂载旧 WS 后端：这是本阶段避免改动
  broker/数据库、方便真实图片验收的实施调整。§8 的 WS 动作留待后续真正需要时实施。
- 当前只支持指定 TWS 列布局。三次真实识别均有 15 条持仓、1 条现金，数量/正负号一致；
  一条 FOP 的 symbol 和 tradingClass 将 NQ 读成 NO，保留原文和疑点，不静默修正。
  所以 P1 功能通过不等于 P2 的 100% 关键字段要求通过。
- 下一步以用户逐行核验和误读改进为主；未启动 P4 之后的数据库或压力功能。

### 14.2 v2：局部重读与组合结构一般化（2026-10-20）

- 原始整图识别仍保留 NO 两处误读；新增通用文本区域 2×/3× 重读，以位置对应和两次一致
  为采用条件，解决当前 NQ/NO。没有 ticker 字典、NO→NQ 替换或图片身份回填。
  首次值、两次重读和坐标随 JSON 保留，界面显示依据；分歧、缺尺度、错位及截断都不猜。
- 组合从“部分名称提示 + 遇 TOTAL 才结束”改为缩进栈与单合约结构联合判断。
  未见过的展开组合名称、不同腿数及嵌套均可保留原子腿；独立 peer 立即结束上一组合。
  策略名只作折叠行提示，不从名称推导腿数或数量。折叠、单腿可见、角色不明均提示不完整。
- 补充组合父子关系、原图定位和腿跳转；JSON 校验循环和子腿归属，旧 JSON 缺结构证据时提示重识别。
- 基准扩到全部 20 个可编辑字段（含明确未知），15 × 20 = 300 项，另比对组合父行第 17 行与
  第 18/19 行两条腿。连续三次实图比对一致，未修改原始截图或用人工改表作为正确率证据。
- 多样本 OCR 和不同券商/版式仍未完成验证。数据库、备份、压力功能继续不实施。
