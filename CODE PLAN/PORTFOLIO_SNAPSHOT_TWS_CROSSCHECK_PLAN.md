# 截图 Portfolio JSON 与 TWS 持仓比对：代码计划

> 制定：2026-10-21；2026-10-22 两次改定位（见 §1.1）。状态：**X0–X5 已完成（2026-10-22，X5 为一次真实 TWS 只读比对）；X6 可选未做**。
> 阶段记录与实施中的差异：[PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_VALIDATION.md](PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_VALIDATION.md)。
> 上位计划：[PORTFOLIO_SCREENSHOT_OCR_PLAN.md](PORTFOLIO_SCREENSHOT_OCR_PLAN.md)；
> 识别现状：[PORTFOLIO_SCREENSHOT_OCR_VALIDATION.md](PORTFOLIO_SCREENSHOT_OCR_VALIDATION.md)。

## 1. 目标与定位

截图 Portfolio 的用途是给**当前持仓**做压力测试。截图得到的 Portfolio JSON 现在主要由
Codex 对话技能 `experimental_skills/tws-screenshot-json` 生成（GPT 视觉读图，准确度最高，
但不保证全对），也可能来自页面内的离线 OCR 或 local-codex 引擎。用户把 JSON 拖入
`portfolio_snapshot.html` 后，它就是页面内存里的唯一状态。

本功能：当截图所属账户就是当前连接的 TWS 账户时，只读拉取 TWS 持仓（Portfolio Position），
与页面内存中的 JSON 按合约逐条比对，列出哪里一致、哪里不一致。

- **第一交付是比对报告（X0–X5）**：只读、不改 JSON。
- **之后可选：采用 TWS 值（X6）**：按 §6 已确认的字段规则，先预览、确认后写入、可撤销。
- **用户把关**：截图是否最新、是否就是当前连接的账户，由用户负责。系统不设门槛，只显示
  TWS 快照时间并提醒「请确认截图为最新」。
- **只读**：只用 TWS 已有的三个只读快照动作；不下单、不订阅、不新增后端动作、不写数据库。

### 1.1 定位变更记录

1. 2026-10-21 初版：交叉核对，要求证明两个前提（截图来自当前账户、截图后无头寸变化），新增成交查询。
2. 2026-10-22 第一次：截图没有账号与时间，前提门槛只有理论意义，删除；改为「用 TWS 校正 OCR」，
   字段规则（现 §6）经用户确认。
3. 2026-10-22 第二次：JSON 主要来自 Codex 对话技能，识别已大体可用；用户要的首先是「对比，看是否
   匹配一致」。比对报告提前为第一交付，校正（采用 TWS 值）改为其后的可选阶段，规则不变。
4. 2026-10-22 第三次（X0–X4 已实施后）：账户常有不在截图里的零散持仓，截图也可能一次截不全。
   结论只要求**截图中的持仓都能在 TWS 中找到依据**；仅 TWS 有的持仓只作参考列出，不影响结论。

## 2. 输入：页面内存中的 Portfolio JSON（已核对代码）

| 项 | 现状 | 对本功能的影响 |
| --- | --- | --- |
| 载入 | 拖入或「导入 JSON」→ `importJson()` → `S.validate()` 后整体替换内存状态；`.json` 与图片可先后拖入 | 比对只读 `portfolioSnapshotState`；JSON 被替换、重新识别或编辑后，旧报告必须失效 |
| 读钩子 | `globalThis.__portfolioSnapshot.getSnapshot()` 返回深拷贝 | 浏览器断言可直接取当前 JSON |
| 版本 | `schemaVersion: 1`；技能用项目自己的 schema/core 生成并校验 | 不需要新的导入格式 |
| 持仓 | `positions[]` 只含原子合约（组合父行、现金、分组、`unclassified` 不在其中）；`instrument` 有 `secType/symbol/currency/conId/localSymbol/tradingClass/exchange/expiryDate/right/strike/multiplier`；`quantity` 字符串 | 与 TWS 只给原子腿的口径一致 |
| 字段来源 | `fieldEvidence[path].source` 为 `ai`（技能、local-codex）、`ocr`（离线引擎）或 `manual`；`problem`、`interpretation`（上标价格解读）、`visualChecks`（复看）保留 | 比对报告按来源显示；有 `problem` 或复看冲突的字段在报告中注明 |
| 技能不猜的字段 | 技能规定不补币种、交易类别、乘数；它们通常为 null | 这些字段为 null 时**不算不一致**，只显示「TWS 可补充」 |
| 身份不明的行 | 技能把 symbol/secType 不明的行转为 `unclassified` 源行，不进 `positions` | 报告单列这些源行的原文，供人工对照 TWS 独有持仓；不自动配对 |
| 账号与日期 | 通常为 null（技能不推断） | 不作为门槛；JSON 有账号且不在 TWS 账户列表中时只给提醒 |
| 页面打开方式 | 可经 8798 服务，也可 `file://` 直接打开 | 连 TWS 的 WebSocket 不依赖 8798，两种打开方式都应可用 |

## 3. TWS 侧已有基础（已核对代码）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 权威持仓快照 | `ib_server.py` `_build_portfolio_positions_payload`；WS 动作 `request_portfolio_positions_snapshot` | 来自 `ib.positions()`。回复 `portfolio_positions_snapshot`：`items`、`ibConnected`、`positionsReady`、`brokerTimestamp`、`brokerTimezone`，回显 `requestId`。每项：`account`、`conId`、`secType`、`symbol`、`localSymbol`、`expDate`（`YYYYMMDD` 或 `YYYYMM`，无连字符）、`right`、`strike`（浮点）、`multiplier`、`tradingClass`、`position`（浮点）、`averageCost`、`avgCostPerUnit`（绝对值、已除乘数、4 位小数）。**没有** currency、exchange |
| 估值快照 | `request_portfolio_avg_cost_snapshot` → `portfolio_avg_cost_update` | updatePortfolio 来源：另含 `marketPrice`、`unrealizedPNL`。TWS 未推送时**不回复**；只覆盖订阅了账户更新的账户 |
| 账户列表 | `request_managed_accounts_snapshot` → `managed_accounts_update` | `accounts`、`defaultAccount` |
| WS 路由 | `ib_server_ws.py` | 新连接自动推送上述三份快照；**未识别动作会落到 `dispatch_execution_action`**，客户端必须硬白名单 |
| Origin | `websocket_security.py` | 不校验 Origin |
| 历史后端 | `historical_server.py` | 只回空的 `portfolio_avg_cost_update`，不回持仓快照 |
| 参考写法 | `js/cost_basis.js` `requestPositions()`、`js/cost_basis_common.js` | 请求号、超时、只读白名单 |

## 4. 数据契约

### 4.1 TWS 头寸 JSON（`twsPositions`，v1）

客户端从 `portfolio_positions_snapshot`（数量与合约，权威）与 `portfolio_avg_cost_update`（估值，可缺）
合成，只含所选账户：

```json
{
  "schemaVersion": 1,
  "account": "<所选账户>",
  "brokerTimestamp": "2026-10-22T10:04:05",
  "brokerTimezone": "US/Eastern",
  "valuation": "available | unavailable",
  "positions": [{
    "conId": 123, "secType": "FOP", "symbol": "XYZ", "localSymbol": "...",
    "tradingClass": "...", "expiryDate": "2030-10-21", "expiryMonth": null,
    "right": "P", "strike": "40", "multiplier": "20", "quantity": "-2",
    "avgPrice": "12.3456", "marketPrice": "11.5", "unrealizedPnl": "-30"
  }]
}
```

- `positionsReady` 为 false、`ibConnected` 为 false 或超时 → 不生成，提示「TWS 持仓不可用」。
- 数值转为规范十进制字符串（与 `S.decimal` 同口径）；浮点先按 8 位小数四舍五入再去尾零
  （`27000.0` → `"27000"`，`0.30000000000000004` → `"0.3"`）。
- `expDate` 为 8 位时转 `YYYY-MM-DD`；6 位时填 `expiryMonth: "YYYY-MM"`，`expiryDate` 为 null。
- 估值按 `account + conId` 合并；缺失为 null，不推算。
- 账户号只出现在 `account` 字段。

### 4.2 比对报告（`twsComparison`，v1）

```json
{
  "schemaVersion": 1,
  "createdAtUtc": "...",
  "snapshotRef": {"snapshotId": "...", "revision": 0, "positionsDigest": "<positions 规范化后的 SHA-256>"},
  "tws": {"account": "...", "brokerTimestamp": "...", "brokerTimezone": "...", "valuation": "available"},
  "verdict": "supported | differences | no_positions",
  "rows": [{
    "positionId": "chat-r3", "conId": 123,
    "match": "exact | presumed | ambiguous | json_only | tws_only | duplicate_in_json",
    "candidates": [123, 124],
    "fields": [
      {"path": "quantity", "json": "-1", "tws": "-2", "result": "different", "source": "ai"},
      {"path": "instrument.multiplier", "json": null, "tws": "20", "result": "tws_only_value"},
      {"path": "displayValues.avgPrice", "json": "12.35", "tws": "12.3456", "result": "within_display_precision"},
      {"path": "displayValues.mark", "json": "11.4", "tws": "11.5", "result": "info_time_varying"}
    ]
  }],
  "notCompared": {"comboParents": 2, "cash": 1, "unclassified": [{"rowId": "r9", "rawText": "..."}]},
  "summary": {"exact": 0, "presumed": 0, "ambiguous": 0, "jsonOnly": 0, "twsOnly": 0, "fieldDifferences": 0}
}
```

- 报告只存在页面内存中，不写入 Portfolio JSON，也不导出为文件（2026-10-22 用户决定去掉导出；结果在网页里查看）。
- `snapshotRef` 与当前内存 JSON 不一致（导入新 JSON、重新识别、编辑字段）时，报告显示「已过期」，
  需重新比对。

## 5. 匹配与比较规则（DOM-free）

### 5.1 合约匹配

身份键：

| 类型 | 身份字段 |
| --- | --- |
| STK | symbol |
| OPT | symbol、expiryDate、right、strike |
| FUT | symbol、expiryDate（TWS 只有年月时按年月比较，注明月份级匹配） |
| FOP | symbol、expiryDate、right、strike；JSON 有 tradingClass 时必须相同（技能通常不给，则不参与） |

匹配顺序（每个 TWS 持仓最多匹配一条 JSON 持仓）：

1. **精确**（`exact`）：JSON 身份字段齐全且与唯一一个 TWS 持仓相等。
2. **推定**（`presumed`）：JSON 身份字段有空值或有一个字段不同，而在尚未匹配的 TWS 持仓中相容的
   **只有一个**。报告中单列，并标明是哪个身份字段不同。
3. **歧义**（`ambiguous`）：相容候选不止一个（如同到期同行权价、不同交易类别），列出全部候选，不选择。
4. **仅 JSON 有**（`json_only`）：TWS 当前持仓中没有。
5. **仅 TWS 有**（`tws_only`）：JSON 中没有。只作参考单独列出（截图可能只截了部分持仓，或是不需要做压力测试的
   零散投资），不进比对表、不影响结论；JSON 里所有 `unclassified` 源行原文另列，供人工对照。
6. 两条 JSON 持仓身份相同 → 都标 `duplicate_in_json`，不相加。

不参与：组合父行、现金、分组汇总、`unclassified` 源行（数量与原文写入 `notCompared`）。

### 5.2 字段比较

| 字段 | TWS 来源 | 结果 |
| --- | --- | --- |
| 数量（含符号） | 持仓快照 | 十进制精确比较：`same` / `different`（符号相反单独注明） |
| 身份字段（推定匹配时） | 持仓快照 | `different` 时列出 JSON 值与 TWS 值 |
| 乘数、交易类别 | 持仓快照 | JSON 为 null → `tws_only_value`（不算不一致）；都有且不同 → `different` |
| AVG PRICE | `avgCostPerUnit` | 符合 TWS 的显示取整 → `within_display_precision`；否则 `different`。JSON 为 null → `tws_only_value`。TWS 值为绝对值，只比较大小 |
| MARK、UNRLZD P&L | 估值快照（可缺） | 只显示差额与相对差，`info_time_varying`，永不计为不一致；估值不可用时 `unavailable` |
| MKT VALUE、DAILY P&L、COST BASIS、DELTA、THETA、IV、LAST、currency、exchange、现金 | 不提供 | 不比较 |

- AVG PRICE 的显示精度取 JSON 字段证据中的原始读数（`raw`，有上标解读时用解读值）的小数位数。
  TWS 显示均价时多头向上取、空头向下取（2026-10-22 真实账户 47/47 验证，见验证记录 §9）：
  多头（TWS 数量 > 0）允许截图值 ∈ [TWS, TWS + 一个显示单位]，空头允许 ∈ [TWS − 一个显示单位, TWS]，
  两端各加 0.00005 吸收 TWS 四位小数的舍入。原「半个末位」的对称容差已取消。
- 每个字段同时显示 JSON 的来源（`ai` / `ocr` / `manual`）和已有疑点（`problem`、复看冲突），
  方便判断不一致是读错还是 TWS 口径不同。
- `verdict = supported` 仅当：JSON 至少有一条持仓，且每条都是 `exact`、没有 `different` / `json_missing`。
  `tws_only` 不参与结论。它只说明「截图中的持仓都能在 TWS 中找到依据」，不说明截图包含了全部持仓，
  也不说明未比较的字段正确。JSON 没有持仓时为 `no_positions`，其余为 `differences`。

### 5.3 不变式（测试必须覆盖）

- 比对不修改内存 JSON（深比较前后相等）；同一输入两次报告逐字节相同（`createdAtUtc` 由调用方传入）。
- 组合父行、现金、`unclassified` 行不进入匹配。
- 每个 TWS 持仓最多出现在一行的 `exact`/`presumed` 中。

## 6. 可选阶段的字段采用规则（2026-10-22 用户已确认，X6 才实施）

比对报告之上，用户可选择「采用 TWS 值」。先生成预览（逐字段 JSON 值 → TWS 值），确认后一次写入、
可整次撤销：

| 字段 | 规则 |
| --- | --- |
| 身份（symbol、secType、expiryDate、right、strike、tradingClass） | 匹配后以 TWS 为准：空 → 填入；不同 → 替换 |
| conId、localSymbol | 总是写入 |
| 乘数 | 空 → 填入；不同 → 替换 |
| 数量 | 不同 → 替换 |
| AVG PRICE | 符合 TWS 显示取整（§5.2）→ 保留 JSON 值（记为已由 TWS 确认）；否则替换；空 → 填入 |
| MARK、UNRLZD P&L | JSON 为空或带疑点 → 填入；JSON 可靠但不同 → 不改，只显示差额 |
| 其它字段、现金 | 不改 |

- 推定匹配在预览中单列、可取消；歧义由用户选候选，不选不改；`tws_only` 默认不加入，勾选才加入。
- 写入的字段 `fieldEvidence.source = 'tws'`，保留原 `raw`、`originalValue`、`corrections` 及原来源，
  记 `tws: {value, brokerTimestamp}`；原 `problem` 清除；所在持仓回到「未核对」；
  `review.changes` 追加 `{source: 'tws', ...}`。
- 已在预览中确认的 `source: 'tws'` 字段不再进入批量确认的机器更改清单；之后手改变为 `manual`。
- 记录 `twsReconciliation`（可选顶层字段）随 JSON 导出，不含撤销数据；旧 JSON 没有它照常导入。

## 7. 传输与安全边界

- 新 DOM-free 客户端 `js/portfolio_snapshot_tws.js`：独立 WebSocket，默认 `ws://127.0.0.1:8765`，
  主机端口可在页面设置。用户点击「与 TWS 持仓比对」才连接，完成或关闭面板即断开。
  不依赖 8798，`file://` 打开的页面也可用。
- 出站**硬白名单**仅三个：`request_managed_accounts_snapshot`、`request_portfolio_positions_snapshot`、
  `request_portfolio_avg_cost_snapshot`。其它动作在客户端抛错、不写入 socket，有测试覆盖。
- 入站只处理当前请求代次的对应回复（持仓快照按 `requestId`）；连接时服务端自动推送的快照与
  其它广播一律忽略，只用本次请求的回复。
- 遵守 `EXECUTION_SAFETY_CONTRACT.md`：无下单或预览路径，不新增后端动作，不改 `ib_server.py`。
- 测试只连合成后端（拒绝 8765 端口）；浏览器检查不得连到真实 8765。真实 TWS 验收（X5）
  只在用户在场并同意时进行。
- TWS 持仓只在内存中；不写数据库、不生成文件。浏览器本地存储只记一项：上次后端有应答的主机和端口
  （键 `optionCombo.portfolioSnapshot.twsEndpoint`，值仅 `{host, port}`），下次打开页面时预填。
  截图页是独立连接，不读成本账本页保存的服务器（两页不同源，也不共享连接）。

## 8. 文件分工（拟议）

| 文件 | 内容 |
| --- | --- |
| `js/portfolio_snapshot_tws_model.js` | DOM-free：TWS 回复 → `twsPositions`；匹配；比较；报告与校验；X6 的预览/应用/撤销 |
| `js/portfolio_snapshot_tws.js` | DOM-free WS 客户端：白名单、请求号与代次、超时、连接状态 |
| `js/portfolio_snapshot.js`、`portfolio_snapshot.html/.css` | 比对面板；加载顺序在 schema/core 之后、页面控制器之前 |
| `scripts/portfolio_snapshot_tws_synthetic_backend.py` | 合成后端：127.0.0.1、拒绝 8765；可编排账户、持仓、估值、延迟、`positionsReady: false`、断线 |
| `scripts/portfolio_snapshot_tws_browser_assertions.js` | 页面内断言（经 `__portfolioSnapshot.getSnapshot()` 取 JSON） |
| `tests/portfolio_snapshot_tws_model.test.js`、`tests/portfolio_snapshot_tws_client.test.js` | Node 测试，注册到 `tests/run.js` 与 `tests/run_portfolio_snapshot.js` |
| `tests/fixtures/portfolio_snapshot/tws/` | 合成 TWS 回复、合成 Portfolio JSON（含 `ai`、`ocr`、`manual` 来源）与**手算**期望报告；不得含真实持仓 |

两个新 DOM-free 模块可加入 TypeScript 检查试点（`// @ts-check` + `tsconfig.json`），不改运行时代码。
不改 `ib_server.py`、`ib_server_ws.py`、`historical_server.py`（历史后端按超时显示「此后端不提供 TWS 持仓」）。

## 9. 分阶段实施与验收

每阶段先写失败测试，再实现，再跑本阶段及之前全部测试；阶段记录写入新的
`CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_VALIDATION.md`。`tests/run_portfolio_snapshot.js` 增加
`--stage X0` … `X6`（同时运行 P0–P2 及技能相关的全部测试）。

### X0：冻结契约与合成样例

交付：§4 两个 JSON 的字段表与校验（`validateTwsPositions`、`validateComparison`）；
`tests/fixtures/portfolio_snapshot/tws/`：合成的三类 TWS 回复（STK、OPT、FUT 日期与仅年月、FOP 同到期同行权价
不同交易类别、两个账户、`positionsReady: false`、浮点行权价与数量、估值缺失），以及用**技能的
`build_portfolio.cjs`** 从合成草稿生成的 Portfolio JSON（保证与真实输入同格式），每个场景附手算期望报告。

验收：校验接受合法样例、拒绝缺字段/错类型/未知结果值；合成 JSON 通过页面 `S.validate`。

### X1：TWS 回复 → `twsPositions`

交付：`fromTwsReplies(positionsReply, avgCostReplies, account)`。

验收（Node）：只保留所选账户；不可用条件各有测试；数值与日期规范化（8 位、6 位到期）；
估值缺失时数量照常；输入不被修改；两次输出逐字节相同。

### X2：匹配与比较

交付：`compareSnapshot(snapshot, twsPositions, {createdAtUtc})`，实现 §5。

验收（Node，对照 X0 期望报告）：

- 精确、推定（缺行权价、读错到期日）、歧义、仅 JSON、仅 TWS、JSON 内重复各有测试。
- 技能留空的乘数、交易类别显示 `tws_only_value`，不计不一致。
- AVG PRICE 按 TWS 显示取整方向判断（含上标解读值）；MARK/UNRLZD 只为 info；估值不可用时 `unavailable`。
- 组合父行、现金、`unclassified` 不参与，`notCompared` 计数与原文正确。
- §5.3 不变式全部覆盖。

### X3：WS 客户端

交付：`portfolio_snapshot_tws.js`。

验收（Node，假 WebSocket）：白名单外动作（含执行类动作名）抛错且不写 socket；连接时的自动推送、
过期代次与他人 `requestId` 的回复都被忽略；持仓快照 10 秒无回复 → 不可用；估值无回复 → 只标估值不可用；
断线后旧回复不能写入新一次比对。

### X4：页面比对面板

交付：「与 TWS 持仓比对」按钮、连接设置、账户选择（一个账户时自动选中；JSON 账号若在列表中则预选）、
比对结果表（按结果筛选；点击跳到对应持仓行；不一致字段高亮）、TWS 快照时间与「请确认截图为最新」提醒、
过期提示（不提供报告导出）。

验收（合成后端 + 浏览器断言，绝不连接 8765）：

- 未点击按钮时不发起任何到 8765 的连接（网络请求断言）。
- 拖入合成技能 JSON 后比对：「全部一致」「数量不同」「乘数仅 TWS 有」「歧义 + 推定」「仅 TWS 有 + unclassified 原文」
  「`positionsReady: false`」「后端断线」七个场景，页面结果与 X0 期望报告一致。
- 比对前后 `__portfolioSnapshot.getSnapshot()` 深比较相等；拖入另一个 JSON 或编辑字段后报告显示「已过期」。
- 经 8798 打开与 `file://` 打开两种方式都能连接合成后端。
- 手机宽度（375px）可用；资源版本盖戳与 `node tests/run.js` 通过。

### X5：真实 TWS 比对验收（用户在场）

前置：用户同意连接真实 TWS；只用三个只读动作。

1. 用户截取当前持仓图，用技能生成 JSON，拖入页面后立即与 TWS 比对。
2. 记录各结果数量；对每个不一致做人工判定（JSON 读错 / TWS 口径不同 / 截图非最新 / 截图范围外）。
3. 验证记录只写统计和脱敏描述；原图、TWS 回复与报告存于被忽略的私有目录。

### X6（可选）：采用 TWS 值

交付：`buildAdoptionPreview`、`applyAdoption`、`undoAdoption`（§6），预览对话框，`twsReconciliation` 记录，
core 中 `source: 'tws'` 的疑点与机器更改规则。

验收：§6 每条规则各有测试；预览不改 JSON；撤销后与原 JSON 深比较相等；推定可取消、歧义不选不改、
`tws_only` 勾选才加入；导出→导入保留 `twsReconciliation`；无该字段的旧 JSON 照常导入；
X4 的浏览器场景加上「采用→撤销」。

## 10. 不做的事

- 账户与截图时间的系统级证明（用户把关）；成交查询。
- 比较或改动 TWS 不提供的字段（MKT VALUE、DAILY P&L、COST BASIS、希腊值、IV、LAST、现金）。
- 自动配对 `unclassified` 源行；自动加入 TWS 独有持仓；自动删除 TWS 中没有的 JSON 持仓。
- 改动 Codex 技能的输出格式；历史时点持仓重建；任何数据库、账本写入；本地存储中除主机与端口外的任何内容。

## 11. 风险与已知限制

- 截图不是最新时，截图后的变化会显示为不一致（X6 下还会被采用）；TWS 快照时间与提醒是唯一的提示手段。
- 推定匹配可能配错（读错的行权价恰好落到另一个持有的合约上），因此单列并注明不同的身份字段。
- updatePortfolio 只覆盖订阅了账户更新的账户；其它账户 MARK/UNRLZD 为 `unavailable`。
- `avgCostPerUnit` 是绝对值，符号不参与比较。
- TWS 与截图对 FOP 交易类别、期货到期日写法可能不同；只做明确的格式规范化，不做模糊匹配。
- 截图页文件正被其它会话修改（Codex 引擎与技能相关的未提交工作）；X4 接入页面前先与那边的改动对齐，
  X0–X3 的 DOM-free 模块不受影响。
- 真实持仓敏感：仓库公开，fixtures 一律合成；验证记录不写真实合约、数量、金额。
