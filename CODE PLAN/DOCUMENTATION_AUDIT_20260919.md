# 文档与当前代码一致性核对 · 2026-09-19

## 范围与基线

核对本仓库 39 份 Markdown / 说明性 TXT 文件，涵盖启动维护、运行架构、交易安全、账本导入、估值研究、数据库归档和历史验收记录。以本地工作区实际代码为准：分支 `feat/cost-basis-stress-overlay`，HEAD `08f4ca4`，包含开始核对前已有的未提交修改；这不是远端 main 的状态声明。排除依赖缓存、其他 worktree、个人报表、生成数据和纯依赖清单。

本轮更新 33 份既有文档，另纠正 `config.ini` 的说明注释；所有配置值保持不变。本文是新增的核对索引。未改运行逻辑或真实账本，也未提交或推送。

## 主要纠正与代码依据

| 主题 | 当前事实及核对依据 |
| --- | --- |
| 页面与加载顺序 | 五个前端入口；主页面有序全局脚本以 `index.html` 为准；共享持久化、管理与账本协议同时挂载于两个后端。 |
| 利率与启动 | 历史利率优先严格按日期读取 `yield_curve` JSON，旧 `rates.db` 是降级后备；对照 `historical_data.py`、启动脚本和 Docker 入口。 |
| CSV 与账本 | 完整批次时间线校验、真正跨零的 C/O、期初 Basis 证据、全量内容摘要与重建保护，以 `cost_basis_store.py`、`cost_basis_ws.py`、`js/cost_basis_import.js`、`js/cost_basis_core.js` 为准；区分正常追加与显式重建/恢复。 |
| 压力测试 | ΔNAV、同模型本地 IV 反解、冻结同步快照、默认敏感性成员及情景范围含义，对照 `cost_basis_stress_*` 和页面实际控件；旧模态框与旧模型方案注明历史适用范围。 |
| IVTS 与分析 | 区分严格 BBO 校准、带审计的估计来源和普通分析后备；结构化 λ 不按普通报价 120 秒自动过期；MRR 使用官方周收盘观测。依据 `iv_term_structure_core.js`、`implied_lambda_handoff.js`、`session_logic.js`、`pricing_context.js`、`pricing_core.js`。 |
| 交易安全 | Global Auto Close 先预览再提交，订单计划有时效与上下文绑定；断线暂停重报价不等于撤单。依据 `trade_execution/`、后端路由及前端执行动作。 |
| 工作区归档 | 先建恢复快照，再复制和校验，最后分块删除活动副本；手动默认、自动可显式启用；原身份恢复仍禁用。依据 `portfolio_archive.py`、`portfolio_admin_ws.py`、`portfolio_maintenance.py`。 |
| 部署与配置 | 当前工作区账本远程开关为 `allow_remote`，浏览器来源仍需精确配置；不把其他分支的协议或新版开关混入当前文档。 |

## 核对边界

本轮做静态代码对照、文档交叉核对、本地 Markdown 文件链接检查、主页面脚本顺序核对、测试入口注册检查和配置值不变检查；不把这些称为新的运行回归测试。未重跑 TWS 实盘、Windows 启动、Docker 发布或研究回测。历史报告中的样本量、通过数和截图仍归属于原日期/版本，不冒充本次实测。当前机器缺失的旧脱敏 CSV 已在对应历史报告中注明。

旧设计约束、未实现的提案、研究假设和历史验收结果均保留其性质；本次修正的是把它们误写成当前运行行为的文字。仓库后续代码变化仍须同步维护相应说明。

## 逐文件清单

| 文件 | 本轮处理 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 已更新 |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | 已更新 |
| [CODE PLAN/COST_BASIS_CROSS_BOOK_HEDGE_OVERLAY_PLAN.md](../CODE%20PLAN/COST_BASIS_CROSS_BOOK_HEDGE_OVERLAY_PLAN.md) | 已更新 |
| [CODE PLAN/COST_BASIS_FOP_FUTURES_ROLL_PLAN.md](../CODE%20PLAN/COST_BASIS_FOP_FUTURES_ROLL_PLAN.md) | 已更新 |
| [CODE PLAN/COST_BASIS_IMPORT_FIXES_20260910.md](../CODE%20PLAN/COST_BASIS_IMPORT_FIXES_20260910.md) | 核对后保留 |
| [CODE PLAN/COST_BASIS_IMPORT_FIX_VERIFICATION_20260910.md](../CODE%20PLAN/COST_BASIS_IMPORT_FIX_VERIFICATION_20260910.md) | 已更新 |
| [CODE PLAN/COST_BASIS_IMPORT_INTEGRITY.md](../CODE%20PLAN/COST_BASIS_IMPORT_INTEGRITY.md) | 已更新 |
| [CODE PLAN/COST_BASIS_IMPORT_INTEGRITY_REVIEW_20260910.md](../CODE%20PLAN/COST_BASIS_IMPORT_INTEGRITY_REVIEW_20260910.md) | 已更新 |
| [CODE PLAN/COST_BASIS_IMPORT_REGRESSION_20260914.md](../CODE%20PLAN/COST_BASIS_IMPORT_REGRESSION_20260914.md) | 已更新 |
| [CODE PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md](../CODE%20PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md) | 已更新 |
| [CODE PLAN/COST_BASIS_RANDOMIZED_REGRESSION.md](../CODE%20PLAN/COST_BASIS_RANDOMIZED_REGRESSION.md) | 核对后保留 |
| [CODE PLAN/COST_BASIS_REVERSAL_REGRESSION_20260919.md](../CODE%20PLAN/COST_BASIS_REVERSAL_REGRESSION_20260919.md) | 已更新 |
| [CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md](../CODE%20PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md) | 已更新 |
| [CODE PLAN/PORTFOLIO_SQLITE_PERSISTENCE_PLAN.md](../CODE%20PLAN/PORTFOLIO_SQLITE_PERSISTENCE_PLAN.md) | 已更新 |
| [CODE PLAN/STRESS_CALIBRATION_BAND_PLAN.md](../CODE%20PLAN/STRESS_CALIBRATION_BAND_PLAN.md) | 已更新 |
| [CODE PLAN/STRESS_DETERMINISTIC_PATHS_PLAN.md](../CODE%20PLAN/STRESS_DETERMINISTIC_PATHS_PLAN.md) | 已更新 |
| [CODE PLAN/STRESS_KERNEL_REFACTOR.md](../CODE%20PLAN/STRESS_KERNEL_REFACTOR.md) | 核对后保留 |
| [CODE PLAN/STRESS_MODEL_VALIDATION_2026-09-05.md](../CODE%20PLAN/STRESS_MODEL_VALIDATION_2026-09-05.md) | 已更新 |
| [CODE PLAN/STRESS_PORTFOLIO_WORKFLOW.md](../CODE%20PLAN/STRESS_PORTFOLIO_WORKFLOW.md) | 核对后保留 |
| [CODE PLAN/STRESS_VIEW_LAYOUT_PLAN.md](../CODE%20PLAN/STRESS_VIEW_LAYOUT_PLAN.md) | 已更新 |
| [CODE PLAN/review_artifacts/cost_basis_import_fix_verification_20260910/README.md](../CODE%20PLAN/review_artifacts/cost_basis_import_fix_verification_20260910/README.md) | 已更新 |
| [COST_BASIS_ACCURACY_AND_BAND_REVIEW.md](../COST_BASIS_ACCURACY_AND_BAND_REVIEW.md) | 核对后保留 |
| [COST_BASIS_LONG_PUT_STRESS_REVIEW.md](../COST_BASIS_LONG_PUT_STRESS_REVIEW.md) | 已更新 |
| [DELTA_HEDGE_CURRENT_STATE.md](../DELTA_HEDGE_CURRENT_STATE.md) | 已更新 |
| [DEV_HANDOVER.md](../DEV_HANDOVER.md) | 已更新 |
| [EXECUTION_SAFETY_CONTRACT.md](../EXECUTION_SAFETY_CONTRACT.md) | 已更新 |
| [IVTS_DASHBOARD_PLAN.md](../IVTS_DASHBOARD_PLAN.md) | 已更新 |
| [README.md](../README.md) | 已更新 |
| [STRESS_MODEL_RESEARCH_MEMO.md](../STRESS_MODEL_RESEARCH_MEMO.md) | 已更新 |
| [TWS_REAL_ORDER_REVIEW.md](../TWS_REAL_ORDER_REVIEW.md) | 已更新 |
| [VRP_PLAYBOOK.md](../VRP_PLAYBOOK.md) | 已更新 |
| [VRP_RESEARCH_MEMO.md](../VRP_RESEARCH_MEMO.md) | 已更新 |
| [contract_specs/README.md](../contract_specs/README.md) | 核对后保留 |
| [option_combo_starter/README.md](../option_combo_starter/README.md) | 已更新 |
| [option_combo_starter/docker-build.txt](../option_combo_starter/docker-build.txt) | 已更新 |
| [option_combo_starter/sample_commands.txt](../option_combo_starter/sample_commands.txt) | 已更新 |
| [validation/历史日历组合EOD验证报告.md](../validation/%E5%8E%86%E5%8F%B2%E6%97%A5%E5%8E%86%E7%BB%84%E5%90%88EOD%E9%AA%8C%E8%AF%81%E6%8A%A5%E5%91%8A.md) | 已更新 |
| [yield_curve/README.md](../yield_curve/README.md) | 已更新 |
| [日常维护操作指南.md](../%E6%97%A5%E5%B8%B8%E7%BB%B4%E6%8A%A4%E6%93%8D%E4%BD%9C%E6%8C%87%E5%8D%97.md) | 已更新 |
