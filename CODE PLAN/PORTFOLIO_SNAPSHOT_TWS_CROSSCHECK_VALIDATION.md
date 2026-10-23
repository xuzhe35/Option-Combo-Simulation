# 截图 Portfolio JSON 与 TWS 持仓比对：阶段记录

> 对应计划：[PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md](PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md)。
> 2026-10-22：X0–X4 完成，随后按用户意见放宽结论规则（§8）。X5 已在用户在场时对真实 TWS 只读比对（§9），并据此改了 AVG PRICE 容差（§10）。可选的 X6（采用 TWS 值）未开始。

## 1. 范围与结论

页面「与 TWS 持仓比对」面板已可用：用户点击后，页面只读拉取 TWS 账户列表、持仓快照和估值快照，
与内存中的 Portfolio JSON 逐合约比对，显示一致、推定、歧义、截图重复、仅截图有，
以及数量、乘数、交易类别、AVG PRICE 的差异；MARK 与未实现盈亏只作参考。结论只要求截图中的持仓
都能在 TWS 中找到依据，仅 TWS 有的持仓单独列出作参考（§8）。JSON 不被修改。
没有改动 `ib_server.py`、`ib_server_ws.py`、`historical_server.py`。

§2–§8 的验证都用合成数据，没有连接真实 TWS 或 8765；真实账户的只读比对见 §9、§10。

## 2. X0：契约与合成样例

- `tests/fixtures/portfolio_snapshot/tws/drafts/*.draft.json`：三份 Codex 技能格式的合成草稿
  （consistent / differences / presumed）。
- `snapshots/*.json`：用技能自己的 `experimental_skills/tws-screenshot-json/scripts/build_portfolio.cjs`
  生成，保证与用户拖入的真实 JSON 同一格式（字段来源均为 `ai`）。重新生成方法：按 `portfolio_json.py build`
  的输入格式把草稿与合成 `source` 交给 `build_portfolio.cjs`。
- `tws_replies.json`：按 `ib_server.py` 三个序列化函数的字段形状写成的合成回复：两个账户；STK、OPT、
  FUT（日期与仅年月）、FOP（同到期同行权价、不同交易类别）、外汇 CASH；浮点行权价与数量；
  两条估值回复（后到者覆盖）；未就绪、未连接、坏条目三个变体。
- `expected_tws_positions.json`、`expected_reports.json`：**手算**的期望结果，不由模块生成。
  期望报告每行只列结果不是 `same` 的字段，测试同时断言其余已比较字段全是 `same`。
- 校验：`validateTwsPositions`、`validateComparison` 接受合法样例，拒绝版本、枚举、字段缺失、
  conId 重复、数值写法（`-2.0`、浮点数）、日期与 Call/Put 格式错误等九类改动。

## 3. X1–X3：模块与测试

| 阶段 | 内容 | 测试 |
| --- | --- | --- |
| X1 | `fromTwsReplies`：按账户过滤（大小写与空白不敏感）、规范化、估值合并；不可用与坏回复拒绝并给原因 | 4 项：与手算结果逐字段相等、拒绝原因、估值可缺且不改数量、不改输入且与条目顺序无关 |
| X2 | `compareSnapshot`：精确匹配、推定、歧义、重复、仅一侧、字段比较；`isStale` | 6 项：三个场景与手算期望一致、行顺序无关且可重复、编辑/换 JSON/排除行后过期而确认行不过期、手改值按 `manual` 标注、手动添加的空行不匹配 |
| X3 | `portfolio_snapshot_tws.js`：硬白名单、`requestId` 匹配、超时、断线 | 7 项（假 WebSocket）：白名单外动作（含下单、执行、订阅类名称）抛错且不写 socket，载荷不能覆盖 action；端点只接受主机与端口；账户去重；连接时推送的持仓快照与他人 `requestId` 被忽略；持仓超时、估值缺失不失败；主动关闭与断线拒绝挂起请求；连接失败与超时；新连接不沿用旧估值 |

`tests/run_portfolio_snapshot.js` 新增 `--stage X0` … `X6`（X 阶段同时运行 P0–P2 全部测试）。

实施中发现并修复：

1. 客户端在连接已断开时调用 `accounts()` / `positions()`，会先挂起一个等待计时器再因未连接而失败，
   计时器之后以未处理的拒绝触发。改为先检查连接，再挂起等待（测试捕获）。
2. 账户预选：第一次比对后下拉框保留了上次的自动选择，导致新拖入的 JSON 不再预选它自己的账号
   （浏览器检查捕获）。改为：用户手动选择只对选择时的那份 JSON 有效；否则先用 JSON 的账号（若 TWS 有），
   再用 TWS 默认账户。

## 4. X4：页面集成与浏览器检查

- 新文件 `js/portfolio_snapshot_tws_panel.js`（面板控制器），页面加载顺序：schema、core、ocr、codex、
  tws_model、tws、页面控制器、tws_panel。8798 预览服务的静态白名单加入三个新脚本（有测试保证
  页面引用的每个脚本和样式都在白名单内）。
- 页面控制器只做了最小改动：保留原有 `__portfolioSnapshot` 导出行不变（其他会话的回复测试按这一行
  定位注入），另加只读钩子 `__portfolioSnapshotView`（`selectPosition`、`onChange`，每次表格重绘后通知）。
- 合成后端 `scripts/portfolio_snapshot_tws_synthetic_backend.py`：127.0.0.1；拒绝 8765；只服务白名单
  （页面、资源、断言脚本、`tests/fixtures/portfolio_snapshot/tws/` 下的 JSON），私有截图、配置、数据库和
  路径穿越均为 404（已用 curl 与 Python 测试验证）；记录收到的每个 WebSocket 动作。
- 页面内检查 `scripts/portfolio_snapshot_tws_browser_assertions.js` 先把 WebSocket 换成拒绝 8765 的守卫，
  再只通过拖入文件、输入和点击驱动页面。在应用内置浏览器中对最终版本
  （model `a8bdf37e9b61`、client `5eaac54b22c9`、panel `c27b62b3ade5`）运行：
  **main 27/27、timeout 3/3 通过**。覆盖：点击前零连接；三个场景的结果与手算期望一致；比对前后 JSON 不变；
  一致结论与筛选；导出报告与显示一致；新 JSON 使报告过期而确认行不会；JSON 账号预选与手动改选；
  账号不一致提示；差异文字；点击行跳到逐字段核对；估值缺失仍一致；未就绪、断线、端口无效；
  10 秒超时；全部动作仅为三个只读快照；全部连接都指向合成端口。
- 375px 手机宽度：页面无横向滚动，比对表在自身框内横向滚动（设最小宽度 640px 保证差异列可读）。
- **未验证**：`file://` 打开页面时的连接。应用内置浏览器把本地文件渲染为不执行脚本的静态快照，
  本机也未安装 Playwright。浏览器允许 `file://` 页面连接 `ws://`，代码也不依赖 8798，但没有实测。
- 8798 预览服务当前未运行；下次启动后会按新白名单提供三个新脚本。

## 5. 与计划的差异

1. 面板放在独立的 `js/portfolio_snapshot_tws_panel.js`，而不是写进 `js/portfolio_snapshot.js`，
   以保持共享控制器几乎不变。
2. 报告的 `snapshotRef` 用 53 位 cyrb53 指纹（`fingerprint`）而非 SHA-256：只用于判断 JSON 是否变化，
   需要同步计算；不作安全用途。
3. 报告每行包含所有已比较字段（含 `same`），便于导出后单独阅读。
4. TWS 中 STK/OPT/FUT/FOP 以外的持仓（如外汇 CASH）进入 `unsupported`，在「未参与比对」中列出，不影响结论。
5. 截图重复行的 TWS 候选、歧义行的候选都不再列为「仅 TWS 有」，避免同一持仓被计两次。
6. 推定匹配要求代码相同、类型相同或未知，其余身份字段最多一个不同；候选被多条 JSON 争用时都标为歧义。
   精确匹配可按排除法完成（例如截图缺交易类别，另一条已按类别匹配），此时注明 `matched_by_elimination`。

## 6. 测试与运行环境

- `node tests/run.js`：1438 通过，4 失败。4 个失败与本工作无关：`cost_basis_reports.test.js` 读取私有 IBKR
  报表时 OneDrive 占位文件超时（ETIMEDOUT），开始前的基线即如此。
- `node tests/run_portfolio_snapshot.js --stage X4`：130/130 通过（P2 仍为 110）。
- Python：`python3 -m unittest discover -s tests -p 'portfolio_snapshot*_test.py'`（系统 Python 3.14）58 项通过。
  项目 venv 缺 Pillow，其他会话的 Codex 测试在 venv 下有 12 个导入错误，与本工作无关；
  本工作的 `tests/portfolio_snapshot_tws_test.py` 在两个解释器下都通过。

| 文件 | SHA-256（前 16 位） |
| --- | --- |
| `js/portfolio_snapshot_tws_model.js` | `a8bdf37e9b61351a` |
| `js/portfolio_snapshot_tws.js` | `5eaac54b22c97471` |
| `js/portfolio_snapshot_tws_panel.js` | `c27b62b3ade5d546` |
| `js/portfolio_snapshot.js` | `fff427decd887003` |
| `portfolio_snapshot.html` | `a3eb3064d98e7d2c` |
| `portfolio_snapshot.css` | `928bcf30fd09b04d` |
| `scripts/portfolio_snapshot_tws_synthetic_backend.py` | `55bf2c5a21d1482d` |
| `scripts/portfolio_snapshot_tws_browser_assertions.js` | `c4ee4e31f564b35c` |
| `scripts/portfolio_snapshot_ocr_server.py` | `87c363fcafe3f054` |
| `tests/portfolio_snapshot_tws_model.test.js` | `34456b51a28ca294` |
| `tests/portfolio_snapshot_tws_client.test.js` | `60fb2980c2ff0181` |
| `tests/portfolio_snapshot_tws_test.py` | `61a83d85faf2149a` |
| `tests/fixtures/portfolio_snapshot/tws/expected_reports.json` | `eb09c4c41ab48f62` |
| `tests/fixtures/portfolio_snapshot/tws/expected_tws_positions.json` | `8d8ea36f5775cc14` |
| `tests/fixtures/portfolio_snapshot/tws/tws_replies.json` | `668d1fc0c23cf915` |

## 7. 待办

- ~~X5~~：已完成，见 §9、§10。
- **X6（可选）**：按计划 §6 采用 TWS 值。
- `file://` 打开时的浏览器实测（需要能执行本地页面脚本的浏览器）。
- 真实账户中的期货 / 期货期权、多账户和远程 `ib_server.py` 尚未实测（X5 只覆盖本机一个账户的股票与股票期权）。

## 8. 结论规则放宽（2026-10-22）

用户指出：账户常有不在截图里的零散投资，截图也可能一次截不全；这些持仓不需要做压力测试。原实现
（与当时计划 §5.2 一致）要求两边完全一一对应：只要 TWS 有一条截图没有的持仓，结论就是「有差异」。

改为：

- 结论只看截图中的持仓：JSON 至少有一条持仓，且每条都是精确匹配、没有不一致字段 → `supported`
  （「截图中的持仓都能在 TWS 中找到依据」）；JSON 没有持仓 → `no_positions`；其余 → `differences`。
  原 `consistent` 改名为 `supported`，避免导出的报告被理解为「两边完全一致」。
- 仅 TWS 有的持仓仍写入报告（`match: tws_only`），但不进页面比对表、不算待处理、不用警示色，
  另列在可展开的「TWS 另有、截图未包含的持仓（参考，不影响结论）」中。
- 截图一侧的要求不变：仅截图有、歧义、重复、推定匹配和字段不一致仍算差异。

新增合成场景 `partial`（只截了账户的一部分，截到的 4 条都一致；技能构建器生成，期望结果手算）：
结论 `supported`，另有 3 条仅 TWS 有。新增测试：部分截图通过；仅 TWS 有的持仓不能掩盖截图中的差异
（把其中一条数量改错后为 `differences`）；空 JSON 为 `no_positions`。浏览器检查新增部分截图的结论、
参考列表与筛选三项。

结果：`node tests/run.js` 1440 通过、4 失败（同 §6 的环境原因）；`--stage X4` 132/132；Python 快照测试
（系统 Python）全部通过；页面内检查在 model `32b55f4340a4`、panel `f51a09404479` 上 main 30/30、timeout 3/3。

| 文件（§8 后） | SHA-256（前 16 位） |
| --- | --- |
| `js/portfolio_snapshot_tws_model.js` | `32b55f4340a4bb22` |
| `js/portfolio_snapshot_tws_panel.js` | `f51a0940447917a4` |
| `portfolio_snapshot.html` | `2c06e34f7a98bcf3` |
| `scripts/portfolio_snapshot_tws_browser_assertions.js` | `bb8c3543c06aca3f` |
| `tests/portfolio_snapshot_tws_model.test.js` | `13b82059d17eeb66` |
| `tests/fixtures/portfolio_snapshot/tws/expected_reports.json` | `2464e1cf52d7827e` |
| `tests/fixtures/portfolio_snapshot/tws/drafts/partial.draft.json` | `9f5bce2a5ba83f20` |
| `tests/fixtures/portfolio_snapshot/tws/snapshots/partial.json` | `af217586f56507a5` |

## 9. X5：真实 TWS 只读比对（2026-10-22，用户在场并同意）

- 环境：用户重启 TWS 后，8765 上的 `ib_server.py` 已连接（`ibConnected: true`，1 个受管账户）。页面经 8798 打开；
  用户指定的 JSON 为 Codex 技能对一张合并截图的读图结果（47 条原子持仓，STK/OPT；另有 3 条组合父行、
  2 条分组汇总，无现金与未归类行）。JSON 经一次性的回环单文件服务载入页面，载入后即停止该服务。
- 只发送了三个只读快照请求；比对前后 JSON 深比较不变。TWS 返回 56 条可比持仓，估值可用。
- 结果：**47/47 条截图持仓精确匹配到 TWS 合约，身份与数量全部一致**；无推定、歧义、重复或仅截图有。
  TWS 另有 9 条截图未包含的持仓（参考，不影响结论）。
- 结论为 `differences`，原因全部是 AVG PRICE：17 条差值都小于 0.001。逐条分析：截图显示三位小数，
  相对 TWS 的四位小数值，**多头向上取、空头向下取**（7 条多头均为向上取整，9 条空头均为向下取整；
  另 1 条多头在 TWS 四位小数已舍入的情况下同样符合）。用「多头：截图值 ∈ [TWS, TWS + 一个显示单位]；
  空头：截图值 ∈ [TWS − 一个显示单位, TWS]（再加 0.00005 的四位舍入）」检验，47 条全部符合，没有例外。
  因此这 17 条不是读图错误，而是现行容差（显示末位的一半）与 TWS 均价的显示取整方向不符。
- MARK 与未实现盈亏只作参考：MARK 相对差中位数约 0.39%，最大约 10%（盘中价格变化，截图与 TWS 快照不同时）。
- 未写入任何真实账号、合约、数量或金额到仓库；本次比对报告未导出。


## 10. AVG PRICE 容差改为按 TWS 显示取整方向（2026-10-22）

依据 §9 的真实账户结果（47/47 符合「多头向上、空头向下」），用户决定改规则：

- 多头（TWS 数量 > 0）：截图值 ∈ [TWS, TWS + 一个显示单位]；空头：截图值 ∈ [TWS − 一个显示单位, TWS]；
  两端各加 0.00005 吸收 TWS 四位小数的舍入。显示单位取截图原始读数（有上标解读时用解读值）的小数位数。
  方向取自 TWS 数量的符号。原「半个末位」的对称容差取消。页面文字改为「符合 TWS 显示取整（多头向上、空头向下）」。
- 合成样例随之改成真实的显示方式：多头股票行 TWS 41.2345 的截图均价由 41.23 改为 41.24（consistent、partial、
  differences 三份草稿），四份快照用技能构建器重新生成；手算的期望报告不需改动。
- 新测试（手算）：多头 41.24 / 41.235 符合、41.23 / 41.234（取错方向）与 41.25（超出一个单位）不一致；
  空头 1.23 / 1.234 符合、1.24 / 1.235 / 1.22 不一致；TWS 已四位舍入时多头 5.432 对 5.431 符合，
  5.433 与 5.430 不一致。
- 结果：`node tests/run.js` 1441 通过、4 失败（同 §6 环境原因）；`--stage X4` 133/133；Python 快照测试
  （系统 Python）全部通过；合成页面检查 main 30/30、timeout 3/3。
- **真实 TWS 复核（同一份 JSON，只读）**：47/47 精确匹配，AVG PRICE 4 条相同、43 条符合显示取整、0 条不一致；
  字段不一致 0；TWS 另有 9 条（参考）。结论变为 `supported`（「截图中的持仓都能在 TWS 中找到依据」）。
  比对前后 JSON 不变；JSON 经一次性回环单文件服务载入，用后即停止。

| 文件（§10 后） | SHA-256（前 16 位） |
| --- | --- |
| `js/portfolio_snapshot_tws_model.js` | `299ac91280b77f50` |
| `js/portfolio_snapshot_tws_panel.js` | `30431a8385bef670` |
| `portfolio_snapshot.html` | `9010bb728f93499a` |
| `tests/portfolio_snapshot_tws_model.test.js` | `7b18484348d0f122` |
| `tests/fixtures/portfolio_snapshot/tws/snapshots/consistent.json` | `2ef913912c92ec41` |
| `tests/fixtures/portfolio_snapshot/tws/snapshots/partial.json` | `b4214be2cda8d263` |
| `tests/fixtures/portfolio_snapshot/tws/snapshots/differences.json` | `7d04f4c533f306b9` |
| `tests/fixtures/portfolio_snapshot/tws/snapshots/presumed.json` | `08a6132d9fa66c5f` |

## 11. 去掉报告导出（2026-10-22）

用户决定比对结果只在网页里查看，不生成文件。删除「导出比对报告」按钮及其下载代码；面板现在只有
「与 TWS 持仓比对」一个按钮。静态测试新增：三个 TWS 脚本不含 `createObjectURL`、下载链接或保存文件接口，
页面中没有导出按钮；页面检查中原「导出的报告与显示一致」改为「无导出控件、无下载链接」。
`validateComparison` 仍保留，供测试校验报告结构。

结果：`node tests/run.js` 1441 通过、4 失败（同 §6 环境原因）；`--stage X4` 133/133；Python 快照测试全部通过；
合成页面检查 main 30/30、timeout 3/3。

| 文件（§11 后） | SHA-256（前 16 位） |
| --- | --- |
| `js/portfolio_snapshot_tws_panel.js` | `88b83c8334f6eca2` |
| `portfolio_snapshot.html` | `16205379603ee5da` |
| `scripts/portfolio_snapshot_tws_browser_assertions.js` | `6fda5314134cfdc6` |

## 12. 记住上次的后端主机与端口（2026-10-22）

截图页的比对使用自己的连接（`js/portfolio_snapshot_tws.js`），不复用、也读不到成本账本页保存的服务器
（账本页在 `127.0.0.1:8000` 源下存设置，截图页经 8798 或本地文件打开，不同源）。为方便连接远程 `ib_server.py`：

- 后端对账户请求有应答后，页面在本浏览器的本地存储中记下这次的主机和端口（一个键
  `optionCombo.portfolioSnapshot.twsEndpoint`，值只有 `{host, port}`），下次打开时预填。无效的主机/端口、
  连接失败或超时都不会覆盖已记住的值；存储里格式不对、多出字段或不合法的值一律忽略；浏览器禁用本地存储时页面照常工作，只是不记住。
- 客户端提供 `rememberedEndpoint` / `rememberEndpoint`（存储由调用方注入）；面板只把 `localStorage` 交给它们，
  自身不直接读写。持仓、报告和账户仍不写入任何存储。
- 测试：Node 新增一项（往返、只写一个键、非法端点不覆盖、八种坏值被忽略、存储抛错与缺失）；静态检查改为
  模型不碰存储、客户端只有一处写入、面板只引用一次 `localStorage` 且不直接读写。页面检查新增：有应答后
  只记下主机与端口（一个键）；端口无效与连接被拒都不覆盖；重新加载后预填（单独的 `remembered` 阶段）。
  连接日志检查允许那次有意被拒的探测端口，仍不允许 8765。
- 结果：`node tests/run.js` 1442 通过、4 失败（同 §6 环境原因）；`--stage X4` 134/134；Python 快照测试全部通过；
  合成页面检查 main 32/32、timeout 3/3、remembered 1/1。测试源（8812）中留下的键已清除。
- 未在远程 `ib_server.py` 上实测。

| 文件（§12 后） | SHA-256（前 16 位） |
| --- | --- |
| `js/portfolio_snapshot_tws.js` | `021541cfb08a9e58` |
| `js/portfolio_snapshot_tws_panel.js` | `5f385beb7d7ec4dc` |
| `portfolio_snapshot.html` | `d3002cba408e8d59` |
| `scripts/portfolio_snapshot_tws_browser_assertions.js` | `8712af2b5d16173d` |
| `tests/portfolio_snapshot_tws_client.test.js` | `9c8d1d11479dd67b` |
