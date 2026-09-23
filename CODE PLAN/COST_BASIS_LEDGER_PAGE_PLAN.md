# 标的综合成本账本设计与当前实现

> 状态：阶段 0-9 的页面、账本、CSV、TWS 对账/成交、What If 与压力测试
> **均已实现**，当前数据库 schema 为 v9。本文档是当前设计说明，
> 不再是待实施 backlog。唯一未提供的运维工具是独立的
> `backup_cost_basis_store.py`；当前没有该 CLI，也没有自动账本备份调度。
> FOP/FUT 扩展见 `COST_BASIS_FOP_FUTURES_ROLL_PLAN.md`。
> 当前导入规则见 [COST_BASIS_IMPORT_INTEGRITY.md](COST_BASIS_IMPORT_INTEGRITY.md)，随机回归见 [COST_BASIS_RANDOMIZED_REGRESSION.md](COST_BASIS_RANDOMIZED_REGRESSION.md)。
> 标准整数正向拆股（n:1，n 为 2–100 的整数）已实现：在手工录入里记录为一个拆股组，股票和生效日仍在交易的每个标准期权系列一起整笔转换，后端每次写入后复验。报表里的公司行动行仍阻断 CSV 导入（A2 待真实样本），反向、非整数拆股和非标准交割（B 线）不支持。设计、实施记录与验收见 [拆股与期权合约调整 CODE PLAN](COST_BASIS_CORPORATE_ACTIONS_PLAN.md) §15。
> 当前压力测试见 [STRESS_KERNEL_REFACTOR.md](STRESS_KERNEL_REFACTOR.md) 与 [STRESS_PORTFOLIO_WORKFLOW.md](STRESS_PORTFOLIO_WORKFLOW.md)；跨账本旧计划仅作历史追溯。
> 2026-09-19 核对：下文带日期的实测、迁移及阶段测试数量是历史记录，不代表本次重新执行或当前测试总数。
>
> 页面定位：独立的本地记账与对账页面。输入一个 IB 账户和一个标的（如 `U1234567 + TQQQ`），只聚合该账户里该标的的股票与期权仓位，按事件账本计算综合成本。**不下单、不建立持续行情订阅、不加载交易工作区脚本。**
>
> 适用后端：`ib_server.py`（账本 + 持仓/AvgCost + 近期成交 + 一次性行情
> + 长期期权 IV/折现曲线输入）、`historical_server.py`（账本、CSV、手工与本地情景回放）
>
> 复用来源：工作区 SQLite 持久化子系统的 loopback 约束、WS 协议形状
> 与 app-data 目录约定。工作区的 recovery-set 备份**不包含** `cost_basis.db`。

> 已确认口径（2026-08-22）：
>
> 1. 历史数据先走 **IBKR 报表 CSV 导入**一次性补齐，导入阶段提前到对账面板之前
> 2. 历史首次导入后，工作流以 TWS 当日成交为临时证据，次日 CSV 为最终裁判
> 3. 原 v1 账本按「一个标的一本」组织；2026-08-26 起改为**一个 IB 账户 + 一个标的一本**，同一标的在不同账户中完全独立计算

---

## 1. 需求理解

原始需求：

- 输入 IB 账户 + Underlying（例如 `U1234567 + TQQQ`）
- 只核对该账户里对应的该标的仓位
- Short Put 被行权 → 记录以执行价 `K` 买入该数量的标的
- Short Call 被行权 → 记录以执行价 `K` 卖出该数量的标的
- 累积所有期权费收入
- 综合以上算出一个「综合成本」
- 全部记录进数据库，方便对账

这是典型的 wheel / covered-call 长期持仓的**全周期净成本**记账，本质是一个**按 IB 账户+标的聚合的现金流账本**，不是快照工具。

## 2. 关键判断：为什么账本必须是事实来源

| 需要的数据 | IB API 能提供吗 | 结论 |
| --- | --- | --- |
| 当前各账户股票/期权数量 | 能。`ib.positions()` 跨全部 managed accounts，仓库里已有 `request_portfolio_positions_snapshot` | 用作对账校验和 |
| 当前均价 / 市价 / 已实现盈亏 | 部分。`updatePortfolioEvent` 只覆盖 TWS 推送账户更新的那个账户 | 尽力而为的旁证，不作为真相 |
| 历史成交（含权利金） | 部分。`reqExecutions` 只覆盖当前 API 客户端可见的近期窗口 | 当日/近期可预览后显式导入；长期仍以 CSV 补齐 |
| 行权 / 被指派事件 | 不能可靠区分。快照里只看到「期权没了、股票多了」 | 必须自己记（可由差异探测建议） |
| 历史股息 / 拆股 | 不能 | 必须自己记 |

因此：

> **账本（SQLite 事件流）是唯一事实来源；TWS 持仓快照只用来发现账本漏记，永不自动写入账本。**

这条是硬约束。任何「自动同步」的诱惑都会在某天静默污染成本记录，而记账错误是不可见的错误——直到你按它做交易决策为止。

## 3. 最终设计决策

1. 新增独立页面 `cost_basis.html`，专用最小 WebSocket 客户端，不加载 `app.js` / `ws_client.js` / `valuation.js`，出站消息走白名单。
2. 新增独立数据库 `cost_basis.db`（与 `portfolio.db` 同目录，不同文件）。理由见 §4.1。
3. 常规记账工作流保留审计历史：更正会标记原行作废并追加冲销记录，不直接改写原经济字段。用户明确确认的重建、清空、存档恢复或 JSON 恢复会先存档再替换活动事件；整本永久删除是另一个隔离的不可恢复操作。对账需要的是轨迹，不是最终态。
4. 事件行**存显式的有符号数量与现金**，不存"待推导的意图"。录入表单负责算默认值，引擎只负责求和。这样 CSV 导出脱离引擎也能读懂，券商报表导入也能套同一形状。
5. STK 账本同一份事件流支持**三种成本口径**（净现金 / 股票滚动均价 / 税务调整），同屏对比。只给一个数字无法对账——能和 TWS 对上的那个口径和你真正关心的那个口径不是同一个。
6. 对账差异只分类和说明，不能从当前持仓猜历史事件。先用 `reqExecutions`
   拉取 CSV 截止后当前 API 客户端可见的真实成交，逐笔预览且明确确认后才入账。
   只有账本完全没有、
   TWS 同时给出完整数量和均价的当前持仓，才允许用户显式“采信 TWS”建立
   当日临时基线；其余差异必须来自 CSV 或手工核实后的事件。
7. 页面永不下单、永不建立持续行情订阅。平时市价来自持仓快照里的 `marketPrice`；用户点击 What If 的「使用当前价」时，后端另外发起一次 TWS snapshot quote，返回后即结束，不留下订阅。失败时保留原假设价并显示错误。

### 批量 TWS 成交归账（2026-09-22）

「持仓对账」新增「批量查找 TWS 成交」：一次查询近期成交，对全部期权数量差异逐合约完整回放，保留原始价格、现金、费用与返佣。匹配成功项进入统一预览；缺佣金、身份歧义、无法解释差额或历史平仓无开仓支持的合约保留待处理并显示原因。股票/FUT 交割差异不由此猜测补齐。

「确认批量归账」在一次确认后复用 `import_cost_basis_events` 的原子事务和批次幂等。`twsReconciliation` 兼容原单合约对象，并支持合约证明数组；后端在同一写事务内逐项复核账本数量、成交范围和最终数量，可同时冲销多合约已证明被完整替代的临时基线。任一已选项失败则整批回滚。浏览器绑定账本版本及持仓差异内容；数量、合约身份变化或断线须重新预览，仅广播时间更新不会失效，不自动写账。没有数量差异（包括对账表已无该合约）的往返成交列入待处理，显示净现金并提示普通「拉取 TWS 成交」。

回归包含页面处理器、固定种子随机多合约场景、存储回滚/重试、WS 协议和隔离浏览器按钮流程。浏览器回归入口为 `scripts/verify_cost_basis_batch_browser.js`（需 Playwright 与 Chrome；拦截全部网络，不触达真实账本）。

### 3.1 文件布局

```text
<platform app data>/Option Combo Simulator/
├── portfolio.db                 # 既有工作区库，不动
├── cost_basis.db                # 成本账本
├── cost_basis.db-wal
└── cost_basis.db-shm
```

`maintenance-backups/` 及 workspace recovery manifest 当前只覆盖
`portfolio.db` 与归档分片，不覆盖账本库。需备份时应在后端停止或
数据库已静默时使用 SQLite-consistent 工具；不能在 WAL 活跃时只拷贝主 `.db`。

### 3.2 新增文件清单

| 文件 | 职责 |
| --- | --- |
| `cost_basis.html` | 页面骨架 |
| `cost_basis.css` | 页面样式（仿 `workspace_db_admin.css`） |
| `js/cost_basis_core.js` | **纯逻辑**：事件流 → 持仓/成本/对账差异。无 DOM、无网络、Node 可测 |
| `js/cost_basis.js` | 传输 + 渲染 + 表单 |
| `cost_basis_store.py` | SQLite 存储层：建表、追加、冲销、幂等、导入去重、快照 |
| `cost_basis_ws.py` | WS 协议层：loopback 校验、动作白名单、错误码、线程桥 |
| `cost_basis_executions.py` | TWS 成交序列化、账户/标的过滤、broker-local 时间与 execId 去重 |
| `tests/cost_basis_core.test.js` | 引擎金标准场景 |
| `tests/cost_basis_import.test.js` | CSV/Flex/Activity 解析、配对、去重与期初推导 |
| `tests/cost_basis_reports.test.js` | 真实报表 fixture 回归 |
| `tests/cost_basis_page.test.js` | 页面模块（无 DOM 依赖部分） |
| `tests/cost_basis_store_test.py` | 存储层不变式 |
| `tests/cost_basis_ws_test.py` | 协议层：loopback、白名单、不泄漏 SQL/路径 |
| `tests/cost_basis_executions_test.py` | TWS 时区、截止时间、佣金与 execId 回归 |

现有套件已在 `tests/run.js` 注册，`cost_basis.html` 已在资源盖戳脚本及测试的 `PAGES` 中。新增套件/页面仍需显式登记；完整清单以这些入口文件为准。

## 4. 数据模型

### 4.1 为什么是独立数据库文件

- `portfolio.db` 刚经过多轮归档/恢复/迁移不变式加固，其归档清单、迁移日志、校验流程都按工作区表枚举。塞进一套无关的关系表，等于让每条归档路径都要重新论证。
- 生命周期完全不同：账本很小、常规修正用冲销保留轨迹，
  **永远不该被 workspace revision 归档掉**。覆盖重建与整本删除是两个显式例外。
- 独立文件意味着可以单独拷走对账，几十 KB，随手可查。

复用 `portfolio_store.py` 的 `default_app_data_dir()` 与 loopback 判定。
备份目录与 recovery-set 发布器未复用，不应在文档中暗示已有自动备份。

### 4.2 表结构

以下是主要业务字段的设计摘录，不是可直接执行的完整 v9 建库脚本。实际 CHECK、索引及迁移以 `cost_basis_store.py` 的 schema 定义为准。v9 另有 `cost_basis_import_batches`（报表区间、文件摘要、核对项、写入数量及账本版本）和 `cost_basis_reset_coverage`（重建存档对应的覆盖 JSON 及摘要），与事件存档共同保存/校验。

```sql
CREATE TABLE cost_basis_books (
    book_id                     TEXT PRIMARY KEY,
    account                     TEXT NOT NULL,      -- 账本所属 IB 账户
    symbol                      TEXT NOT NULL,
    sec_type                    TEXT NOT NULL DEFAULT 'STK',
    currency                    TEXT NOT NULL DEFAULT 'USD',
    default_shares_per_contract INTEGER NOT NULL DEFAULT 100,
    start_date                  TEXT NOT NULL,      -- 起算日
    note                        TEXT NOT NULL DEFAULT '',
    created_at_utc              TEXT NOT NULL,
    updated_at_utc              TEXT NOT NULL,
    archived_at_utc             TEXT
);

CREATE UNIQUE INDEX idx_cost_basis_books_account_symbol
    ON cost_basis_books(account COLLATE NOCASE, symbol, sec_type, currency)
    WHERE archived_at_utc IS NULL;

CREATE TABLE cost_basis_events (
    event_id            TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    seq                 INTEGER NOT NULL,           -- 服务端分配的录入序号
    client_token        TEXT NOT NULL UNIQUE,       -- 幂等：断线重发不重复记账
    kind                TEXT NOT NULL CHECK (kind IN (
                            'opening_balance','share_trade','option_trade',
                            'option_assignment','option_exercise','option_expiry',
                            'dividend','fee','split','manual_adjust',
                            'futures_trade','futures_roll')),
    trade_date          TEXT NOT NULL,              -- YYYY-MM-DD
    broker_timestamp    TEXT,                       -- broker-local, 精确到秒
    account             TEXT NOT NULL DEFAULT '',
    -- 期权合约身份（股票/现金行为 NULL）
    right               TEXT CHECK (right IN ('C','P') OR right IS NULL),
    strike              REAL,
    expiry              TEXT,                       -- YYYYMMDD
    con_id              INTEGER,
    local_symbol        TEXT,
    option_sec_type     TEXT CHECK (option_sec_type IN ('OPT','FOP')
                                    OR option_sec_type IS NULL),
    shares_per_contract INTEGER,
    -- 显式有符号量（账户视角）
    contracts           REAL,   -- 期权张数增量：+ 增多头/减空头，- 增空头/减多头
    shares              REAL,   -- 股数增量：+ 买入，- 卖出
    future_expiry       TEXT,
    future_con_id       INTEGER,
    future_local_symbol TEXT,
    future_contracts    REAL,
    roll_to_expiry      TEXT,
    roll_to_con_id      INTEGER,
    roll_to_local_symbol TEXT,
    roll_to_price       REAL,
    roll_group          TEXT,
    price               REAL,   -- 正数量级：股票每股价 / 期权每股权利金 / 行权价
    cash_amount         REAL NOT NULL,  -- 有符号现金增量：+ 收到，- 付出（已含费用）
    fees                REAL NOT NULL DEFAULT 0,
    split_ratio         REAL,
    include_in_cost     INTEGER NOT NULL DEFAULT 1,
    tag                 TEXT NOT NULL DEFAULT '',
    source              TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual','reconcile','csv_import','execution_report')),
    external_ref        TEXT,                       -- IB execId / tradeID
    import_batch_id     TEXT,
    derived_mismatch    INTEGER NOT NULL DEFAULT 0, -- 现金被手工覆盖的标记
    allow_overdraw      INTEGER NOT NULL DEFAULT 0, -- 只属于获得例外的该行
    note                TEXT NOT NULL DEFAULT '',
    created_at_utc      TEXT NOT NULL,
    voided_at_utc       TEXT,
    voided_by_event_id  TEXT,
    void_reason         TEXT
);

CREATE UNIQUE INDEX idx_cost_basis_events_external
    ON cost_basis_events(book_id, account, external_ref)
    WHERE external_ref IS NOT NULL;                 -- 报表重复导入幂等
CREATE UNIQUE INDEX idx_cost_basis_events_book_seq ON cost_basis_events(book_id, seq);
CREATE INDEX idx_cost_basis_events_book_date
    ON cost_basis_events(book_id, trade_date, broker_timestamp, seq);
CREATE INDEX idx_cost_basis_events_batch ON cost_basis_events(import_batch_id)
    WHERE import_batch_id IS NOT NULL;

CREATE TABLE cost_basis_snapshots (                 -- 对账单：证明"当时我认为是多少"
    snapshot_id       TEXT PRIMARY KEY,
    book_id           TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    taken_at_utc      TEXT NOT NULL,
    as_of_date        TEXT NOT NULL,
    account_scope     TEXT NOT NULL,
    through_seq       INTEGER NOT NULL,
    event_count       INTEGER NOT NULL,
    events_sha256     TEXT NOT NULL,                -- 事后被改动可检出
    summary_json      TEXT NOT NULL,
    tws_snapshot_json TEXT,
    reconciled        INTEGER NOT NULL DEFAULT 0,
    note              TEXT NOT NULL DEFAULT ''
);

CREATE TABLE cost_basis_book_resets (
    reset_id       TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL,                  -- 故意不做 FK，整本删除才显式清理
    client_token   TEXT NOT NULL UNIQUE,
    reset_at_utc   TEXT NOT NULL,
    event_count    INTEGER NOT NULL,
    events_sha256  TEXT NOT NULL,
    events_json    TEXT NOT NULL,
    reason         TEXT NOT NULL DEFAULT ''
);
```

### 4.3 现金符号约定（唯一约定，全库贯彻）

`cash_amount` = 账户现金增量。**收到为正，付出为负，已扣费用。**

录入表单的默认推导（用户可覆盖，覆盖则置 `derived_mismatch=1` 并在流水里标注）：

- 股票行：`cash_amount = -(shares × price) - fees`
- 期权行：`cash_amount = -(contracts × shares_per_contract × price) - fees`

一条公式同时覆盖买卖两向：卖出 Put（`contracts = -5`，`price = 1.20`，spc=100）→ `cash = +600 - fees`。✅

### 4.4 每种事件的字段语义与推导效果

| kind | 必填 | 期权头寸 | 股票头寸 | 现金 |
| --- | --- | --- | --- | --- |
| `opening_balance` | `trade_date`,`account`,`shares`,`price` | — | `+shares` | `-(shares×price)` |
| `share_trade` | `shares`(±),`price` | — | `+shares` | `-(shares×price)-fees` |
| `option_trade` | `right`,`strike`,`expiry`,`contracts`(±),`price`,`spc` | `+contracts` | — | `-(contracts×spc×price)-fees` |
| `option_assignment` | 同上 + `shares` | `+contracts`（平掉空头方向） | 短 Put：`+|c|×spc`；短 Call：`-|c|×spc` | `-(shares×strike)-fees` |
| `option_exercise` | 同上 + `shares` | `+contracts`（平掉多头方向） | 长 Call：`+|c|×spc`；长 Put：`-|c|×spc` | `-(shares×strike)-fees` |
| `option_expiry` | `right`,`strike`,`expiry`,`contracts` | `+contracts`（归零） | — | `-fees` |
| `dividend` | `cash_amount`(+) | — | — | `+cash_amount` |
| `fee` | `cash_amount`(−) | — | — | `cash_amount` |
| `split`（拆股组表头，带 `split_group`） | `split_ratio`（整数 n）、`split_rule_ref`、`split_rounding` | 由同组 `option_split` 转换 | `shares × n`，在生效日开盘前、当日成交之前 | `0` |
| `option_split`（只随拆股组整组写入） | 源系列字段 + `split_to_strike`、`split_to_contracts` | 源系列整笔清零，新系列 `×n`，未实现权利金随仓位转移 | — | `0` |
| `split`（旧式单行，无 `split_group`） | `split_ratio` | 未平仓期权**标红待人工复核**，同日已有股票成交时提示 | `shares × ratio`，排在当日最后 | `0` |
| `manual_adjust` | `note` + 任意字段 | 可选 | 可选 | 可选 |

**关键点**：`option_assignment` 的 `price` 是行权价 `K`，只作用于**股票腿**；期权腿以 0 权利金归零（权利金在开仓那一行早已记过）。这是最容易记重复的地方，字段语义必须写死在表单和校验里。

`opening_balance` 只描述股票期初。**期初已实现的累计期权费另记一行** `manual_adjust`（`tag='prior_premium'`，`cash_amount=+累计权利金`），保持两者可分别追溯。

### 4.5 落库校验（fail-closed）

- 单条写入/冲销按 `trade_date → broker_timestamp → seq` 重放受影响历史；批量导入/重建先在事务内插入整批，再校验完整时间线，通过后才提交。乱序数组不会因临时缺少后插入的开仓而误拒绝，真正悬空的后续平仓仍导致整批回滚。
- 纯 `ibkr_close` 不得超量且不能由 `allow_overdraw` 绕过；`ibkr_open` 不能抵消已有反向仓位；`ibkr_close_open` 必须确实平掉已有反向仓位并反向开出余量。交割事件保留逐行持久化的显式 `allow_overdraw` 例外，不能用该开关掩盖普通 CSV 错误。
- 缺少乘数时，单条写入检查已有历史，批量还先检查整批明确乘数；只有唯一时才推导，多种调整乘数并存要求显式指定。
- 股票被卖成净空头：允许但返回 warning（短 Call 无股被指派 = 裸空股票，是真实情况，但你应该知道）。
- `client_token` 唯一：断线重发不重复记账。
- 服务端重算默认现金，与提交值偏差超过容差则置 `derived_mismatch` 并回传提示，**不拒绝**（券商的实际结算金额本来就会和理论值差几分钱）。
- 冲销走追加：`void_cost_basis_event` 写 `voided_at_utc` 并追加一条冲销记录，必须带 `void_reason`。引擎跳过被冲销行，流水表默认折叠、可展开。

## 5. 成本口径定义

设作用域内（账本所属 IB 账户 + 标的 + 起算日之后 + `include_in_cost=1` + 未冲销）：

```
sharesHeld    = Σ shares                    （经拆股调整）
netCash       = Σ cash_amount               （负数 = 净流出）
openPremium   = Σ cash_amount  over 仍未平仓合约的 option_trade 行
openShortPremium = 仍未平仓 Short Call / Put 对应的净权利金
shortPremiumNet = 全周期 Short Call / Put 对应的净权利金
costNetCash   = netCash - optionPremiumNet + shortPremiumNet
```

「尚未到期 / 履约义务尚存」的判定：按账户、Call/Put、执行价、到期日、乘数及券商合约身份分组累计 `contracts`，归零即该合约的全部权利金转入「已到期 / 已结算」。这两组都是已经收取或支付的权利金现金；分组表示的是合约履约状态，不是权利金是否「实现」。

核心账本仍保留净额 `openPremium / realizedPremium`，因此 Long Option 的支出与平仓回款不会从真实现金中消失。但标的综合成本、「若卖方期权归零」、两张「卖方权利金」卡、近 30 / 90 / 365 天窗口与年化率都只使用 Short Call / Put 的分拆桶，排除保护性或凸性 Long Call / Put 全周期的权利金支出、回款与盈亏。Long Option 只在压力测试中作为可选的独立市值 / 浮盈亏项。

### 口径 A：净现金综合成本（默认，即你要的那个数）

```
综合成本/股（保守）= (-costNetCash + openShortPremium) / sharesHeld
综合成本/股（卖方期权归零）= -costNetCash / sharesHeld
```

- 保守：头条成本只纳入已到期 / 已结算的卖方期权现金。尚未到期的卖方权利金虽已确定到账，在履约义务结束前暂不抵扣。Long Option 无论未到期、已平仓或已到期，其现金和盈亏都不进入标的成本曲线。
- 卖方期权归零：假设当前所有未平仓 Short Call / Put 到期归零；Long Call / Put 仍排除。
- 现金流标题栏提供「卖方权利金 · 按到期日查看」只读弹窗入口，不占现金流卡片高度：按到期日升序分别显示未平 Short Put / Call 张数、分摊开仓净权利金、该日合计和截至该日累计。直接汇总引擎的逐合约 `openShortPremium`，部分平仓后只保留剩余部分，不用 TWS AvgCost 重新估算，不含 Long Option；无 TWS 也可查看。总额与「尚未到期卖方权利金」卡片口径一致，缺失开仓权利金时提示不完整。权利金已收取，不表示到期日再次收款或最终盈亏；日期经过不会自动移除仓位，仍以账本平仓/结算记录为准。
- 这个数**可以为负**，且为负是有意义的（成本已全部收回）。UI 必须把负值显示成「−3.42（已完全回本）」，而不是当成异常。
- `sharesHeld = 0` 时每股成本无定义，改显示累计净现金；仍有未平期权或期货时，它不能解释为全周期已实现盈亏。
- `sharesHeld < 0` 时数值仍成立：净现金口径表示**空头回补盈亏平衡水位**，已到期 / 已结算权利金会抬高水位；纯股票/税务口径显示空头均价。负头寸是受支持的状态，只按全部事件回放后的最终余额判断，不因同一结算批次中间短暂跨过零而留下告警。

### 口径 B：纯股票均价（对账 TWS 用）

只按股票交易滚动平均成本，权利金完全独立列示：

```
买入：totalBasis += |shares|×price + fees
卖出：realized  += |shares|×(price - avg) - fees ; totalBasis -= avg×|shares|
avg = totalBasis / sharesHeld
```

这是**唯一应该和 TWS `avgCostPerUnit` 对得上的数**。对不上就是账本漏记了，页面直接标红。

### 口径 C：税务/券商调整口径

同 B，但被指派的期权把权利金滚进股票成本：

- 短 Put 被指派：每股成本 = `K - 该合约每股权利金`
- 短 Call 被指派：每股卖出价 = `K + 该合约每股权利金`

引擎能算是因为指派行携带合约身份，可回溯到开仓权利金。这是美股常见税务处理，也是 IBKR 某些成本基准视图的行为，用于解释「为什么 B 和券商某个列还是差一点」。

### 派生指标

- **每股综合成本参考** = 口径 A 的每股成本；它排除 Long Option 全周期现金，不是全组合立即清算盈亏平衡点。
- **股票市值加累计现金** = `sharesHeld × 参考价 + netCash`；仍有未平期权时还须计入期权资产/负债才是完整估值。压力测试使用独立的现金/头寸估值内核。
- **卖方权利金收入率**：近 30 / 90 / 365 天已到期 / 已结算 Short Call / Put 净权利金，及其相对占用资金（`sharesHeld × 成本`）的年化百分比。该窗口按合约义务结束日归类，不含 Long Option 支出或平仓盈亏。
- **按月 / 按到期日的权利金汇总**

## 6. 对账机制

页面拉两份快照（两个 action 都已存在，无需后端改动），再先按当前账本所属 IB 账户过滤：

- `request_portfolio_positions_snapshot` → 全账户权威数量
- `request_portfolio_avg_cost_snapshot` → TWS 均价、市价、已实现盈亏（**覆盖面受限，仅作旁证**）
- `request_cost_basis_market_price` → 用户点击「使用当前价」后读取一次 TWS snapshot quote（只读、无持续订阅）

按 `symbol` 过滤（股票 `secType='STK'`，期权 `secType='OPT'` 且 `symbol` 相同；调整后合约 `tradingClass` 可能不同，一并纳入），按账户分组，与引擎算出的账本持仓逐合约比对。

差异分类与处理：

| 差异形态 | 当前状态能说明什么 | 处理 |
| --- | --- | --- |
| 账本有期权、TWS 较少，Underlying 差额恰好匹配 | 可能交割，也可能是独立成交 | 只提示；导入 CSV 或手工核实，不生成事件 |
| 账本与 TWS 的期权数量不同 | 可能漏记增开、减仓或多笔相反方向成交 | 优先显示「查找 TWS 成交」；同账户同合约的近期真实成交必须按券商时间全部回放，回放终值与 TWS 当前持仓完全一致才进入确认预览；每笔减仓标作 Close，增开保持普通成交；AvgCost 仅为显式后备草稿 |
| 账本有期权、TWS 没有、已过到期日且 API 无匹配成交 | 可能到期，也可能较早有偿平仓 | 只提示；没有结算证据不得生成 `option_expiry` |
| TWS 有完整期权/FUT、账本为零 | 可信的当前数量与均价 | 用户确认后直接采信为 `tws_snapshot` 临时基线 |
| TWS 有股票、账本为零 | 可信的当前数量与均价 | 用户确认后直接采信为 `tws_snapshot` 临时基线 |
| 部分数量差异或缺均价 | 只能证明账本与当前状态不同 | 先拉取 TWS 近期成交，再导入 CSV；AvgCost 只可填入待核实草稿 |
| FOP 消失且新增 FUT 可能是交割 | 两条差异可能属于同一事件 | 阻止单独采信 FUT，要求完整 CSV/手工交割 |
| 数量一致但 TWS 均价与口径 B 差异 > 容差 | 权利金归属或漏记费用 | 只提示 |

完整的 TWS-only 持仓保留 `[采信 TWS]` 作为历史窗口不足时的基线后备：用户明确点击并再次确认后，按权威数量与 TWS 均价写入一条带 `tws_snapshot` 标签的当前日期基线。TWS 不提供原始开仓日期，因此界面明确说明日期语义。任一期权数量差额先显示 `[查找 TWS 成交]`：后端拉取近期成交，页面取同账户同合约的全部成交，按 `brokerTimestamp` / `execId` 稳定排序后从账本当前仓位逐笔回放；回放终值必须等于 TWS 当前仓位。每笔回放时以它之前的仓位判定 `ibkr_close` 或 `ibkr_exec`，不按 AvgCost 挑选任何单笔成交。确认导入后使用真实成交价、费用与带符号现金，卖方权利金的已结算值为开仓收入与平仓支出的净额。API 窗口不足且 TWS 有 AvgCost 时，才使用单独标示的后备按钮生成带风险说明的差额手工草稿，由用户核实后再写入。**任何情况下都不自动落库。**

`tws_snapshot` 只是用户确认的临时起点。以后的累计 Activity Statement 若能按账户、合约和秒级时间顺序独立重建采信时点的精确数量，且不需要未知权利金的 `prior_open`，则同一 SQLite 事务先冲销该基线、再写入 CSV 真实成交。TWS API 近期成交也可走相同事务：如果保留临时基线并回放全部同合约成交能到达 TWS 当前数量，则保留基线；如果只有先冲销该合约唯一的 AvgCost 临时基线、再回放全部成交才能到达 TWS 当前数量，则冲销基线。两种情况都不用净现金或 AvgCost 在多笔成交中挑一笔；不能唯一贴合时整批阻断。基线冲销与全部确认成交必须在同一 SQLite 事务完成。

若 TWS API 成交已经由用户确认入库，次日 CSV 对同一成交采用跨来源去重：优先核对 broker execId；Activity Statement 无 execId 时，按账户、合约、秒级时间、带符号数量、成交价和含佣金/返佣净现金匹配。TWS 按 fill 入库而报表只取 Order 行：Order 行附带其逐笔 Trade 行时逐笔一一对应，部分对应则已存部分记为重复、其余按 fill 拆分导入；没有 Trade 行时取同账户、同合约、同日、同方向、恰好加总等于 Order 行数量并包含所印秒数的唯一一组 fill（已存 fill 带 permId 时按订单分组，否则按时间连续段），再核对加总净现金与按数量加权均价（容差取报表原始价格文本的显示精度）。来源引用已在账本中的行视为重放，不参与匹配。证明通过的行进入 confirmedDuplicates，提交时不发送；能拼出多组、数量对上但现金/均价不符、同秒但经济项不符、同日但秒数不同、以及同合约同数量在相邻自然日存在未认领 TWS 成交（时区解码错误的症状）时整批阻断并列出两边数据。同引用不同经济项由服务端判为修订冲突；与账本 csv 行同秒同数量但身份不同、或与手工行同日同数量的行阻断；报表区间内未被任何行认领的 TWS 成交阻断。导入请求携带账本版本 digest、账本身份与报表登记，服务端在事务内复核。详见 `COST_BASIS_IMPORT_INTEGRITY.md`。

TWS 未连接时：整块降级为「持仓快照不可用」，账本与成本照常显示，明确标注「未对账」。

## 7. 页面结构

对账补充边界：完整期权 TWS-only 行在「查找 TWS 成交」旁保留次级「采信 TWS」，不能因主按钮优先级把后备入口隐藏；查询在途或已有待确认预览时不允许同时采信。定向查询只阻断属于或可能属于该合约的问题，明确无关合约的佣金缺失不参与本次导入；身份不明、涉及目标的重复 execId 仍阻断。

旧 `tws_snapshot` 没有券商时钟时，前后端都不再用 `created_at_utc` 推断先后。批量拉取遇到这种歧义继续失败关闭，但提示先取消预览、再点该合约的定向查找；没有对应差额入口或仍无法证明时使用完整 CSV 覆盖式重建。`[tws] timezone` 的非空值在服务端创建 IB 之前经 `ZoneInfo` 校验，非法值拒绝启动；缺省仍不允许账本成交导入，不猜测机器时区。配置测试通过注入时区数据验证，不固定要求仓库配置为纽约。

下面是早期多账户布局草图，仅用于说明信息分区。当前新账本按单账户隔离，实际页面含侧栏及 ledger/settings/stress 三个视图；旧多账户账本保留兼容展示。

```
┌ 顶栏 ────────────────────────────────────────────────────────┐
│ IB 账户 / 标的 [U1234567 · TQQQ ▾] [新建账本]  起算日 [2025-01-01] │
│ 口径 [净现金 ▾]  TWS: 已连接 · 快照 12:03:11 [刷新]              │
└─────────────────────────────────────────────────────────────┘

┌ 综合成本总览   视图 [按账户拆分 ▾ | 合并]  ────────────────────┐
│              U1234567      U7654321      合计                  │
│ 持股           1,000          500        1,500                 │
│ 综合成本/股    $38.42       $38.41       $38.42   净现金·仅已实现 │
│ 期权全归零     $36.90       $37.05       $36.95                 │
│ 纯股票均价     $44.10       $44.02       $44.07                 │
│ TWS 均价       $44.08         不可用      —      ✅ 差 $0.02     │
│ ────────────────────────────────────────────────────────── │
│ 累计净现金   −$38,420     −$19,205     −$57,630   收正付负     │
│ 已到期/已结算权利金 $8,300       $4,180      $12,480                 │
│ 尚未到期权利金   $1,520         $760       $2,280                 │
│ 股票已实现     $2,100       $1,050       $3,150                 │
│ 股息            $140          $70          $210                 │
│ 参考价 [52.30] → 盈亏平衡 $38.42 · 全部清算净收益 $20,820        │
└─────────────────────────────────────────────────────────────┘

┌ 持仓对账 ────────────────────────────────────────────────────┐
│ U1234567  股票      TWS 1,500 / 账本 1,500  ✅                  │
│ U1234567  P45 0919  TWS   -5  / 账本   -5   ✅                  │
│ U7654321  C60 0815  TWS    0  / 账本   -3   ⚠️                  │
│    差异待核实：查找真实 TWS 成交或导入 CSV，不由快照生成交割事件   │
└─────────────────────────────────────────────────────────────┘

┌ 期权费统计 ──────────────────────────────────────────────────┐
│ 近30天 $1,180 · 近90天 $3,940 · 近365天 $12,480                 │
│ 相对占用资金年化 21.7%    [按月] [按到期日]                       │
└─────────────────────────────────────────────────────────────┘

┌ 事件流水 ────────────────────────────────────────────────────┐
│ 日期 账户 类型 合约 数量 价格 现金 | 累计股数 累计成本 来源 操作     │
│ ... （含运行余额列，可看出每一笔如何改变成本）                      │
│ [显示已冲销行]  [筛选: 类型/账户/日期/标签]                        │
└─────────────────────────────────────────────────────────────┘

[录入事件] [拉取 TWS 成交] [导入 CSV] [生成对账快照] [导出 CSV]
```

**流水里的「累计股数 / 累计成本」运行余额列是这个页面能对账的关键**——你能直接看出哪一笔把成本推到了现在的位置，而不是只看到一个结论数字。

页面另有一张只读的 **What If · 期权结算后成本** 情景卡：
默认勾选「自动跟随参考价」，与头条有效参考价共用同一数值；已有 TWS 持仓价格推送到达后立即重算，不轮询、不新增行情订阅、不写账本。上方手工参考价也会被跟随。手动输入 What If 假设价（包括 0 或编辑中的空值）自动暂停跟随，取消勾选则固定当前假设；重新勾选无需请求即可恢复。没有 TWS 价格或手工参考价时自动情景显示不可用，不把断线前的旧报价当作当前价。
点击「使用当前价」仍重新请求一次 TWS snapshot quote；成功后清除上方手工参考价并恢复自动跟随，后续持仓价格可以继续更新 What If。请求失败保留原假设；迟到响应不能覆盖用户新输入或其他账本。抓取时间只标注主动 quote，后续持仓价格替代时清除。压力测试参数刷新不覆盖手工 What If 假设价。
选择账本时读取一次已有持仓均价/市价缓存，避免首次推送早于账本加载而丢失参考价；之后依靠已有推送。自动频率由 TWS 账户/持仓推送决定，不是逐笔行情。IB 文档说明持仓变化或约三分钟周期更新；重复读取服务器缓存不会提高券商价格频率。
用户可选择「计算至」某个到期日：只虚拟结算该日及以前的未平期权，更晚的仓位仍保持未平与在险状态。
当前股票不卖出；选中范围内的期权按同一个标的到期价进行虚拟指派、行权或归零，
再用同一套账本重放计算结算后股数、总成本与每股综合成本。情景不包含期权时间价值或
结算费用，虚拟事件永不写入数据库。

「打开压力测试」进入同页独立视图，扫描目标价格并用一个现金/头寸内核估值。默认展示较当前快照的净值变化，本账本多空期权与联动账本多头期权使用所选模型从报价反解的本地 IV、冻结的 USD 折现曲线及统一情景时刻。默认美式 CRR，可选欧式 BSM；支持立即冲击/线性渐变、逐到期交割、保守 Short Put 指派覆盖、数量草稿和有限参数采样范围。范围不是置信区间，盈亏不由每股成本反推。联动只纳入同账户同币种 STK 账本的多头期权，价格映射区分单日与多日假设。需要完整快照的净值模式缺数据即停算；历史成本模式允许明确标示且无区间的降级。详细契约见 `STRESS_KERNEL_REFACTOR.md`，数量与资金口径见 `STRESS_PORTFOLIO_WORKFLOW.md`。

## 8. WebSocket 协议

沿用 `portfolio_store_ws.py` 的形状：默认 loopback-only、动作白名单、请求 id、结构化错误码、绝不回传 SQL 或数据库路径。

2026-09-11 LAN/Nginx Proxy Manager 部署扩展：仅账本允许通过
`[cost_basis] trusted_peers` 或 `OPTION_COMBO_COST_BASIS_TRUSTED_PEERS`
显式指定可信 TCP 对端 IP/CIDR。默认仍只接收 loopback；环境变量为空可撤销 INI
中的远程许可，非法列表整体拒绝远程访问。检查在首次建库和 broker fetcher 前执行，
不信任 `X-Forwarded-For` / `Forwarded`。9 月 2 日提交 `01292bc` 新增的本机
Origin 白名单造成原有 LAN/NPM 连接 HTTP 403，现已单独撤销：两个 WebSocket
服务接受任意浏览器 Origin（含 `null` 和缺失头），原 `server.allowed_origins` /
`OPTION_COMBO_WS_ALLOWED_ORIGINS` 配置不再生效。Origin 不是用户认证，浏览器
访问无关网页时仍可能向其可达后端发起连接。可信代理必须限制入口访问并阻止绕过代理；
账本 TCP 对端检查、workspace/admin 本地限制、交易安全和账本现金/事件语义均不改变。

另一种远程方式与 `trusted_peers` 并存：`[cost_basis] allow_remote = true` 放行所有来源（不限 IP），只用于 Tailscale 等外部已鉴权网络；可在配置中开启，或用通过
`OPTION_COMBO_COST_BASIS_ALLOW_REMOTE=true` 覆盖配置；环境变量优先，空值、false
或无效值均关闭远程访问。所有账本动作在打开数据库前统一检查。Docker NAT 后的
来源地址也支持，但不根据私网地址或转发头推断已鉴权；端口访问由部署方限制到
Tailscale 网络。本开关不改变工作区数据库管理与交易执行的权限边界。

| client action | server action |
| --- | --- |
| `request_cost_basis_status` | `cost_basis_status` |
| `list_cost_basis_books` | `cost_basis_books_list` |
| `create_cost_basis_book` | `cost_basis_book_created` |
| `request_cost_basis_delete_plan` | `cost_basis_delete_plan` |
| `delete_cost_basis_book` | `cost_basis_book_deleted` |
| `list_cost_basis_events` | `cost_basis_events_list`（分页 + 筛选） |
| `append_cost_basis_event` | `cost_basis_event_appended`（`client_token` 幂等） |
| `void_cost_basis_event` | `cost_basis_event_voided` |
| `import_cost_basis_events` | `cost_basis_events_imported`（批量，按 `external_ref` 去重） |
| `request_cost_basis_reset_plan` | `cost_basis_reset_plan` |
| `rebuild_cost_basis_book` | `cost_basis_book_rebuilt`（存档+清空+导入同一事务） |
| `save_cost_basis_snapshot` | `cost_basis_snapshot_saved` |
| `list_cost_basis_resets` | `cost_basis_resets_list` |
| `restore_cost_basis_reset` | `cost_basis_reset_restored` |
| `export_cost_basis_backup` | `cost_basis_backup` |
| `restore_cost_basis_backup` | `cost_basis_backup_restored` |
| `list_cost_basis_import_batches` | `cost_basis_import_batches_list` |
| `request_cost_basis_executions` | `cost_basis_executions`（实时后端） |
| `request_cost_basis_market_price` | `cost_basis_market_price`（实时后端一次性 quote） |
| `request_cost_basis_option_scenario_inputs` | `cost_basis_option_scenario_inputs`（v2 报价/IV、时点/身份及共享折现曲线；本地 IV 在前端反解） |

挂载点：`ib_server_ws.py` 的
`action in cost_basis_ws.COST_BASIS_CLIENT_ACTIONS` 分支，以及
`historical_server.py` 的 `handle_cost_basis_action` 分支。实时专属的三个读取动作在
`ib_server.py` 向 store environment 注入 fetcher；历史后端返回明确的 unavailable。
CSV 导出走浏览器端 Blob，不落服务端文件。

`cost_basis_ws.py` 还保留 `archive_cost_basis_book`、`list_cost_basis_snapshots` 和 `reset_cost_basis_book` 等底层动作，当前页面不调用它们。存档列表/恢复、JSON 备份/恢复及报表覆盖列表则已在前端白名单中并有页面入口。

## 9. 安全与失败模式

- 页面永不发送任何下单或持续行情订阅动作；行情读取包括一次性标的报价，以及压力测试请求的有界期权报价批次；后者可能短暂建立流式行情，取数结束/失败后取消。出站白名单在 core 模块里，`js/cost_basis.js` 不得绕过。
- 账本写入永远需要用户显式确认；对账建议只是预填表单。
- 一条坏的账本请求不得拖垮 socket（`ib_server.py` 的同一条连接同时承载行情与订单监管）——异常一律在协议层收敛为错误响应。
- SQLite 用 WAL，后端是唯一 owner；数据库文件在 app data 目录，**不在仓库里**（仓库在 OneDrive 上，同步软件不能碰活的 WAL）。
- 拆股组的新行权价只按“整数分除以 n、半数进位”推导，只转换能证明为标准类的系列（按期权代码根判断，调整类如 `2TQQQ` 拒绝）；后端在每次写入后重放并证明每个组。旧式单行拆股跨越未平仓期权时，引擎仍**不猜**条款，标红要求人工确认。

## 10. 测试计划

`tests/cost_basis_core.test.js` 金标准场景：

1. 完整 wheel 周期：卖 Put → 被指派 → 卖 Call → 被指派，三种口径的最终数字
2. 只有权利金、无股票（`sharesHeld = 0`）→ 不得输出 Infinity
3. 成本为负（权利金累计超过投入）
4. 短 Call 被指派导致最终净空头 → 净现金标签切换为空头回补水位；同一结算批次中曾短暂为负、最终恢复非负时不告警
5. 拆股：拆股组整组转换股票与期权、权利金承接、拆股后平仓/指派/到期（`tests/cost_basis_splits.test.js`、`tests/cost_basis_splits_test.py`、拆股随机回归）；旧式单行拆股跨越未平仓期权时标红
6. 非 100 交割乘数（调整后合约）
7. 同一标的的两个账户账本互不干扰；旧版未限定账户账本仍能按账户拆分
8. 倒序补录：同一原子批次可先传平仓、后传更早开仓；单独提交没有开仓支持的纯平仓仍拒绝。补录还必须保证已有后续历史有效
9. 冲销行被正确排除
10. 尚未到期/已到期或已结算权利金拆分在合约多次加减仓后仍正确

`tests/cost_basis_store_test.py`：建表、`client_token` 幂等、`external_ref` 去重、冲销语义、超量平仓拒绝、快照哈希稳定性。

`tests/cost_basis_ws_test.py`：非 loopback 拒绝、白名单外动作不响应、错误不泄漏 SQL/路径、异常不逃逸。

`tests/run.js` 注册；`scripts/stamp_asset_versions.py` 的 `PAGES` 加页面。

## 11. IBKR 报表 CSV 导入

历史一次性补齐走这条路，之后每月导一次即可自动补账。导入器必须对格式变化**保守失败**，缺必要字段或存在歧义就阻断，并提示重新导出或核实。当前页面展示未映射列，没有交互式列映射编辑器。

### 11.1 支持两种导出形态

| 形态 | 特征 | 去重键 |
| --- | --- | --- |
| Flex Query CSV | 单行表头的平表，可配置列，通常含 `TradeID` / `IBExecID` | `TradeID` 或 `IBExecID` |
| Activity Statement CSV | 多段式，每行首列是段名（`Trades`,`Dividends`,`Financial Instrument Information`...） | 无稳定 id，退化为内容哈希 |

解析流程：

1. 嗅探首列是否为段名 → 判定多段式还是平表
2. 多段式：记录每行生效的 Header，优先 Order 行；配套 Trade 分笔用于核对和部分去重，没有 Order 时使用 Trade。另解析持仓、合约、股息、预扣税等段；本标的公司行动需人工核实
3. 按已知 IBKR 列名自动预填映射（`Symbol`,`Date/Time`,`Quantity`,`T. Price`,`Proceeds`,`Comm/Fee`,`Code`,`Asset Category`,`Strike`,`Expiry`,`Put/Call`,`Account`...）
4. 未识别的列在 UI 列出；**必填列缺失就拒绝导入**，不提供默认零值或自动猜列

### 11.2 行 → 事件的分类规则

依据 `Asset Category` + `Code`（IBKR 的 Notes/Codes 列）：

| Asset Category | Code 含 | 事件 kind |
| --- | --- | --- |
| Stocks | 无特殊码 | `share_trade` |
| Equity and Index Options | `A`（Assignment） | `option_assignment` |
| Equity and Index Options | `Ex`（Exercise） | `option_exercise` |
| Equity and Index Options | `Ep`（Expired） | `option_expiry` |
| Equity and Index Options | `O` / `C` / 同时 `C;O` | `option_trade`，分别保留开仓/平仓/反向开仓标签；现金结算指数产品不属于账本支持范围 |
| — | Dividends 段 | `dividend` |
| — | 本标的 Corporate Actions | 导入问题，要求人工核实；标准拆股改用手工拆股组记录，不会由 CSV 静默转换 |

**指派行的配对问题**：IBKR 把一次指派记成两行——期权行（码 `A`，数量平掉空头）和股票行（码 `A`，交割股数）。导入器必须把这两行**合并成一条 `option_assignment` 事件**，配对依据是同账户、同日期、同标的、股数 = 张数 × 乘数。配不上的落单行进「待人工处理」列表，不静默丢弃、也不当成普通交易记进去——两者都会算错成本。

### 11.3 幂等与预览

- 每行先算出 `external_ref`：`TradeID` / `IBExecID` 优先；缺失时对账户、秒级时间、合约、数量、价格、proceeds、佣金和 Notes 码生成稳定指纹。内容完全相同的多行按出现次数追加 `-2` / `-3`，作为多重集保留。落库走 `idx_cost_basis_events_external` 唯一索引，重叠时间段的报表可反复导入
- 导入前**必须**过预览页：显示「新增 N 条 / 已存在跳过 M 条 / 待人工处理 K 条」，逐行可见分类结果和推导出的现金，用户确认后才写库
- 导入按批记 `import_batch_id`；写入或校验失败整批事务回滚。已提交批次没有一键批量冲销接口，需按行核实冲销或从合适存档/完整历史重建

### 11.4 真实文件教会我们的（2026-08-22，实测 IBKR 中文 Activity Statement）

方案里对导入格式的描述基于英文报表，实测一份真实的中文报表后，补充以下硬性事实：

1. **报表是本地化的**：段名（`交易`/`未平仓持仓`/`账户信息`/`金融产品信息`）和列名（`资产分类`/`日期/时间`/`数量`/`交易价格`/`收益`/`佣金/税`）都是中文，但 `DataDiscriminator` 的取值和 Notes 的字母码（`A;C`、`C;Ep`、`C;Ex`、`O;P`）保持英文。两种语言都必须认。
2. **中文表头里 `代码` 出现两次**——既是合约列又是 Notes 列。任何「按表头文字建名→列号映射」的写法都会让后者覆盖前者，结果是每一笔指派都被当成普通交易。必须扫描全部出现位置、取第一个未被占用的。
3. **同一段可能有多套表头**：`金融产品信息` 对股票和期权各发一套。按「本段最后一个表头」统一映射会让先前的行整体错位一列。记录必须绑定读到它时生效的那个表头。
4. **文件带 BOM**，不剥掉的话第一列永远匹配不上任何别名。
5. **交易段没有账户列**，账户号在 `账户信息` 段的 `账户` 字段。不取它的话每一行都落在空账户上，按账户对账永远匹配不了。
6. **交易段也没有乘数列**，乘数在 `金融产品信息` 段。两段对同一合约的写法不同（一处 OSI `GLD   260819C00399000`，一处空格式 `GLD 19AUG26 399 C`），要都解析成同一个键才能连上。
7. **Order/Trade 过滤不能一刀切**：`未平仓持仓` 段用 `Summary` 做 discriminator，某些语言版本还可能翻译 Order/Trade。原实现在两者都不匹配时会把整段记录清空，表现为「0 条草稿」且不给任何理由——典型的静默失败。改为两者都不匹配时保留原记录。

### 11.4.1 重复导入与配对（2026-08-24 实测两份重叠报表后修正）

用 8/21 和 8/24 两份重叠报表实测，暴露两个**静默出错**的缺陷，都已修复并加了回归测试：

1. **Activity Statement 根本没有 TradeID 列**，所以 `externalRef` 全是 null，唯一索引形同虚设，重叠期间会被完整重复入账。方案 §11.3 写过「缺失则用内容哈希」，但实现里漏了。现改为按行内容派生稳定键 `stmt-<hash16>`，取值含到秒的时间戳、合约、数量、价格、收益、佣金和 Notes 码。同一笔成交在下一份报表里指纹相同；若报表内有多行完全一样，第二行起稳定追加 `-2` / `-3`，不会把同秒同价的两笔成交合并。
   - 指派事件的键**只取期权腿**，不取股票腿：期权腿在任何覆盖该日期的报表里都相同，而它跟哪条股票行配对可能随行序变化。
   - 期初补录桩的键**故意不含张数**（`prior-<hash16>` 只取账户+合约），保证每个合约每个账户最多一条补录桩，即使两份报表推导出的张数不同也不会多出一条。
2. **指派配对忽略了交割价**。同一天、同账户、同股数、只有行权价不同的两笔指派（wheel 一次被指派多张就是这样）会交叉配对，各自拿到对方的结算现金。IBKR 把股票行和期权行分组存放，相对顺序不保证。现改为**先按交割价匹配**，无价格的报表才退回按数量匹配。

实测结果（TQQQ）：导入 8/21 文件 +7 条；再导 8/24 文件 +7 新增 / 跳过 7 条重叠；同一文件再导一次 +0 / 跳过 14。最终 14 条事件，股数与四个未平仓合约**逐一对上报表申报的期末持仓**。

### 11.4.2 期初推导必须扣掉账本已有的持仓（2026-08-24 浏览器实测后修正）

第三个静默出错的缺陷：`deriveOpeningPositions` 只看报表，不看账本。

场景：账本里已有 8/24 那份报表的 14 条 TQQQ 事件（含 4 个未平仓合约的**真实开仓和权利金**）。下周导入 8/25–8/31 的报表时，那份报表只有这 4 个合约的**平仓**、没有开仓，于是推导出「期初持有 4 个合约」并再补 4 条零权利金的桩。合并后账本认为你仍持有 4 个已经到期的空头合约——持仓被污染；同时还会误报「期初还持有 200 股」，照着补就把股数记两遍。

修正：`deriveOpeningPositions` 接受 `existingOpen` / `existingShares`，把账本已有的持仓从推导结果里扣掉，页面从 `state.ledger` 传入。按时间顺序逐份导入报表时，账本当前的未平仓量就等于下一份报表的期初量，扣减后恰好归零。部分持有的情况只补差额。

实测：账本有内容时补桩 0 条、期初股数 0；空账本时仍补 4 条、报 200 股（行为不变）。合并后四个卖方合约全部归零，综合成本 65.9328——正好等于此前「若未平仓卖方期权全部归零」那一行的预测值。

### 11.5 期初持仓：精确推导，不是猜

一份部分期间的报表必然会平掉「开仓在报表期之前」的合约。存储层对此 fail-closed（拒绝整批），这是对的——悬空的平仓会让成本静默出错。

解法不是放宽不变式，而是利用报表自己的数据做**精确算术**：

```
期初持仓 = 报表期末持仓（未平仓持仓段） − 本批净变动
```

两边都是已知量，不含推测。实测这份报表：补上推导出的期初合约后，六个标的的**期末持仓与报表逐合约完全一致，零悬空平仓**。

两条边界：

- **期权期初有完整 Basis 证据时**，核对平仓数量与 `Basis + close cash = realized P/L` 等条件，生成 `prior_basis` 并还原期初现金；该日不是实际开仓日期。没有成本证据才使用零权利金 `prior_open` 并明确标示不完整；存在矛盾 Basis 时阻断。
- **股票期初有完整、可归属的 Basis 时**可以生成 `opening_balance` 草稿（包括有成本的零成交首份报表）。未知或矛盾的期初成本阻断整批，不能写成虚假空头，也不猜价格。
- 此处期末减净变动是数量证明，不等于全周期现金完整。追加还需扣除适用截止日已有持仓，跳过已证明重复的行，检查存根替换及报表覆盖。

### 11.4.3 提前平仓与滚动（2026-08-25 用真实数据核验）

滚动（买回近月、卖出远月）是 wheel 的核心动作，它的现金流**已完整纳入**：

- 报表里 `C` 码的行进 `option_trade`，方向按张数正负，现金取报表的 `收益 + 佣金/税`（买回时 `收益` 为负），和开仓行走同一条路径、同一个公式。
- 该合约累计的权利金按比例转入「已到期 / 已结算」：买回 5 张空头里的 2 张，转入 2/5 的贷方**加上整笔借方**；全部平掉则整份转入已结算。恒等式「已到期/已结算 + 尚未到期 = 期权净权利金」在真实数据上对每个标的都成立。
- 滚动不动股票，所以持股与纯股票均价不变。

**两个口径在亏损滚动时方向相反，这是设计如此，不是 bug**。实测（TQQQ 200 股，P68 收 235.58 后以 421.12 买回，同时卖出 P67 收 508.88）：

| 口径 | 滚动前 | 滚动后 | 变化 |
| --- | --- | --- | --- |
| 保守（只用已到期/已结算权利金抵扣） | 68.2123 | 69.1400 | **+0.9277** |
| 若期权全部归零 | 65.9328 | 65.4940 | **−0.4388** |

保守口径上升 0.9277 = 锁定的实亏 185.54 ÷ 200 股；全归零口径下降 0.4388 = 本次净收现金 87.76 ÷ 200 股。前者说「你确定性地亏掉了这些钱」，后者说「如果新卖出的也归零，你比之前收得更多」。两句都是真的，页面同时给出。

### 11.5.1 覆盖式重建（schema v2，2026-08-25 新增）

口径或解析器变化之后，最干净的收拾方式是清空账本、用一份完整报表重新导入，而不是手工修补几十条事件。为此新增 `reset_cost_basis_book`。

设计上守四条：

1. **清空前先存档**。整份事件（含已冲销行）序列化成 JSON 写进 `cost_basis_book_resets`，带 sha256。活动账本变成真正干净的空账本（不留一堆墓碑行污染流水表），但数据没有真的丢。
2. **确认 + 身份/版本/计划复核**。弹窗显示标的、当前事件数和将写入的事件数，不要求抄写短语。提交同时携带完整账本身份、ledger digest 和服务端计划凭据，写事务内检查；同条数的历史变更也使旧预览失效。
3. **先预览、后清空**。页面的顺序是：选文件 → 解析出草稿并预览 → 勾选「覆盖式重建」→ 弹窗确认 → 提交时才先清空再导入。覆盖预览不会与即将被存档删除的 TWS 成交做追加去重；坏文件不可能让你落得一个空账本。
4. 清空、存档恢复和 JSON 恢复同样是显式确认后先存档再替换活动历史。永久删除账本单独隔离；不开放任意 SQL 或按事件主键物理删除。

这些替换历史的操作都会保留账本身份，并分别确认、存档；整本永久删除则连同账本身份一起移除，不属于重建流程。

schema 从 v1 升到 v2，迁移只新增一张表，不动任何既有行；已在真实库的副本上演练过（14 条事件一条不少）。

schema v5（2026-08-26）在 `cost_basis_books` 增加账本级 `account`，并把活动账本唯一键改为
`account + symbol + sec_type + currency`。迁移不改写事件：旧账本所有带账户的行都指向同一账户（允许全书拆股行留空）时才自动采用该账户；真正混合或存在其他未标账户事件的旧账本保持为「旧版未限定账户」，不自动拆分。

schema v6（2026-09-02）把 `allow_overdraw` 持久化到获得例外的那一条事件，整段时间线重放时逐行判定。新请求的开关不再代替旧事件的审核语义，因此一条历史例外不会让后续正常写入失败。

schema v7（2026-09-02）清除旧版本从非权威自由备注中误推的 `broker_timestamp`；只有 CSV、TWS 成交和明确的 TWS 临时基线可提供券商本地时钟证据。

### 11.5.1.1 当前正确性与安全边界（2026-09-02）

- 部分 TWS 版本的成交时间戳不带时区后缀，API 也不报告登录时区。服务端在初始化 IB 和账本存储前校验 `[tws] timezone`：非空但无效的 IANA 时区直接阻止启动；留空时成交导入失败关闭。有效配置在连接前写入 ib_async 的 `TimezoneTWS`，解码后的 aware datetime 再转成同一券商本地墙钟。持仓基线使用服务端返回的 `brokerTimestamp`，不混用浏览器时钟或数据库创建时间。
- 引擎先验证事件能否改变仓位，再把现金计入汇总；被拒的超量平仓或反向开仓不会污染预览和 What If。
- 账本切换使用请求代际和账本 ID 双重守卫，旧账本分页响应不能覆盖新账本状态。
- 手工录入在请求期间禁用提交，幂等 token 由表单指纹派生；同批 TWS 成交的重复 `execId` 在预览阶段即阻断。
- 股息用完整标的边界匹配；预扣税导入为带 `withholding_tax` 标签的 fee 事件。
- 页面按税后股息展示（2026-09-23）：`withholding_tax` / `withholding_tax_refund` 标签的 fee 仍按普通现金计入净现金与综合成本，核心另外汇总为 `dividendWithholding`（带符号）和 `withholdingFees`。"已实现"卡片显示税后股息 + 股票已实现；费用卡与明细表"费用合计"扣除这部分预扣税，避免重复扣减。净现金、综合成本与总盈亏不变。
- `allow_overdraw` 属于单条历史事件，不会因后来请求的开关变化而使整段时间线失效。
- 导入和覆盖重建与单条追加共用期权乘数推断，避免其他客户端遗漏 `sharesPerContract` 时出现不同结果。
- 两个 WebSocket 服务的 Origin 校验已因 LAN/NPM 403 回归撤销，接受任意 Origin（含 `null` 和缺失头）。网络/代理入口必须保护共享交易连接；账本 TCP 对端和 workspace/admin 本地限制保持不变。
- 流水的 running cash cost 是完整现金审计口径；页面标题综合成本按既定产品口径排除 Long Call/Put 全生命周期的权利金支出、回款及盈亏。两者有意不同，并在页面说明中分别命名。
- 删除账本只需一次浏览器确认；服务端删除计划凭据仍用于检查计划是否过期、账本是否在确认期间发生变化。
- 指定持仓差异的 TWS API 成交按券商时间全量回放：保留临时基线能贴合就追加；只有冲销唯一临时基线才能贴合就在同一事务冲销后写入全部成交；其他组合阻断。该路径不比较 AvgCost/临时现金，CSV 来源仍按报表独立重建规则处理。

### 11.5.2 整本永久删除（2026-08-26 新增）

新建账本的账户复用主页面 `Enable Trade` 的 TWS managed-account 选择规则：
单账户自动选，多账户显式选。IB API 未连接时，同一个选择器回退到已有账本
账户，保证历史后端仍能建账。

（2026-09-09 修订）手工输入账号在连接状态下同样保留：跑在另一台机器上的
账户永远不会出现在本机 TWS 列表里，而它们的账本仍然要留在本地。列表里没有
的账号只提示后果并要求确认，不再拒绝。这类账本照常记账，标的行情仍走本机
TWS 连接（`_request_cost_basis_market_price` 找不到同账户持仓时会自行
qualify `Stock(symbol, 'SMART', currency)`），但期权快照只覆盖本机该账户的
真实持仓，压力测试因此退回结算价曲线，持仓/成交/AvgCost 对账对它没有意义。

`delete_cost_basis_book` 是刻意隔离的不可恢复操作。它用账本 ID 精确定位，
并在一个 `BEGIN IMMEDIATE` 事务内删除该账本的 `cost_basis_snapshots`、
`cost_basis_events`、`cost_basis_book_resets`，最后删除 `cost_basis_books`。
确认短语同时携带账户、标的和三类实时数量，例如
`DELETE U1234567 TQQQ 14 EVENTS 3 SNAPSHOTS 1 RESETS`。数量在取得写锁后
重新计算；前端在用户点击一次普通确认后自动回传该短语，不要求手工抄写。
计划过期、短语不符或任一步失败都整体回滚。此操作不会先生成
reset archive，否则就不算“删除干净”；同标的其他账户因 book_id 不同不受影响。

### 11.6 时区与日期

CSV/Flex 的 `Date/Time` 按账户报表时区解析为精确的 broker-local
`YYYY-MM-DDTHH:MM:SS`，`trade_date` 取同一本地日期。部分 TWS 版本的成交时间戳
不带时区后缀，API 也不报告 TWS 登录时区；服务端在初始化 IB 和账本存储前
用 `tws_timezone.py` 校验 `config.ini` 的 `[tws] timezone`，非空但无效的配置
阻止启动。有效配置在首次连接前设置 `ib.TimezoneTWS`。ib_async 解码后的
aware datetime 必须转回该显式 `ZoneInfo` 后再去掉 tzinfo；时区留空时整批成交
fail-closed，不允许把服务器或浏览器时钟当作依据。
持仓采信基线使用后端提供的 `brokerTimestamp`，不使用浏览器本地时间。
旧基线缺少券商时钟时，不从 `created_at_utc` 猜测先后关系：批量导入继续阻断，
并指引用户取消预览后到持仓对账定向查找，以完整成交回放后的数量核对。
自由备注里的日期时间永不作为 broker 证据。回放顺序在前后端统一为
`trade_date -> broker_timestamp -> seq`。

## 12. 分阶段实施

| 阶段 | 内容 | 可独立验证 |
| --- | --- | --- |
| 0 | 本方案 + 口径确认 + schema 冻结 | ✅ 已完成 |
| 1 | `cost_basis_store.py` + 存储层测试 | ✅ 150 tests |
| 2 | `cost_basis_ws.py` + 两个后端挂载 + 协议测试 | ✅ 59 tests |
| 3 | `js/cost_basis_core.js` 引擎 + 金标准测试 | ✅ 101 tests |
| 4 | 页面骨架：账户+标的账本选择、手工录入、流水、三口径总览 | ✅ 58 page tests |
| 5 | **IBKR 报表 CSV 导入**：解析、分类、指派配对、预览、幂等 | ✅ 81 import + 4 report tests |
| 6 | TWS 持仓对账面板 + TWS-only 临时基线采信 | ✅ 引擎已测；差异只提示、不猜历史事件 |
| 7 | 对账快照与 CSV 导出 | ✅ 已实现；账本备份 CLI 不存在，已作为明示运维边界 |
| 8 | 卖方期权费统计、年化、What If 与 Long Call/Put 可选压力覆盖 | ✅ 已实现 |
| 9 | 近期 TWS 成交拉取、execId 批内/库内去重、佣金门禁与 CSV 跨来源对账 | ✅ 10 execution tests；长期历史仍以 CSV 为准 |

### 实现期间发现并修掉的问题

按方案实现的过程中，有几处只有真正跑起来才会暴露：

1. **全书拆股会凭空造出一个空账户**：`account=''` 的拆股事件会为空账户名建状态，之后在每个按账户视图和对账表里都多出一个幽灵账户。改为不建状态、直接作用于在场账户。
2. **多头合约消失时草稿方向算反**：空头消失是被指派，多头消失是行权/卖出，两者交割方向相反。原来一律按被指派推断，会生成一条把股数推向错误方向的草稿。
3. **单账户用户永远看不到 TWS 均价对账**：只有一个账户时页面只渲染「合计」列，而合计列去查一个名为 `combined` 的账户，必然查不到——恰好废掉了最重要的那一行。改为在所有持股账户都有 TWS 均价时按股数加权合成；只要有一个账户缺，就显示不可用而不是给出部分混合的误导数字。
4. **`[hidden]` 被类选择器压过**：`.inline-form { display: flex }` 优先级高于浏览器默认的 `[hidden]{display:none}`，新建账本表单永远展开。加了全局 `[hidden] { display: none !important; }`。
5. **流水表「累计成本」列与头条数字口径不同**：运行余额列必然含未平仓权利金，和保守口径的头条数字对不上。这种无声的不一致足以让人怀疑整个工具，已把口径写进表头。

导入器（阶段 5）排在对账面板（阶段 6）之前，因为对账只有在账本已经补齐历史之后才有意义——对着一本空账做对账，差异列表会长得没法看。

## 13. 已知限制

- TWS 均价/市价只覆盖 TWS 推送账户更新的那个账户；其余账户的口径 B 对账会显示「TWS 均价不可用」，数量对账不受影响。
- 旧版未限定账户的账本仍可显示多账户合并数字；新账本始终以单一 IB 账户为边界。
- 现金担保占用、保证金成本、融资利息不计入 v1。
- 支持可交割的股票/ETF + OPT，以及可交割的 FUT + FOP；现金结算指数期权不适用。
- FOP/FUT 仍等待真实券商报表覆盖所有本地化字段组合；当前验收基于合成格式与真实 STK/OPT 报表回归。
- 没有内建的 `cost_basis.db` 自动备份或独立 CLI；workspace recovery set 不会代替这个责任。


## 2026-09-10 导入完整性修复

导入/清空/重建/恢复要求完整账本身份和版本；相同引用先核对修订，跨格式匹配一对一，期初存根按新增真实历史净数量替换。schema v9 让报表覆盖与重建存档一起保存/恢复；v8 遗留覆盖标为待重核，事件不改写。页面提供带摘要的 JSON 事件备份及显式恢复入口（7 MiB 上限），恢复前自动存档当前事件。当前行为与回归入口见 `COST_BASIS_IMPORT_INTEGRITY.md`。
