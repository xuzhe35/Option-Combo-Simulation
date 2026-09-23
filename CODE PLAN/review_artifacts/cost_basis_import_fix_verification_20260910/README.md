# 修复验收隔离脚本（2026-09-10）

只调用本地页面函数和临时数据库；不连接真实账户或读取真实账本。
从仓库根目录依次运行：

```sh
node "CODE PLAN/review_artifacts/cost_basis_import_fix_verification_20260910/verify_page.js" /tmp/cb_fix_fixtures.json
python3 "CODE PLAN/review_artifacts/cost_basis_import_fix_verification_20260910/verify_store.py" /tmp/cb_fix_fixtures.json /tmp/cb_fix_coverage.json
node "CODE PLAN/review_artifacts/cost_basis_import_fix_verification_20260910/verify_async.js" /tmp/cb_fix_coverage.json
```

如系统没有 python3，请使用项目配置的 Python 解释器。脚本仅依赖 Python 标准库与仓库原有 JavaScript 测试辅助器。

断言记录验证当时的行为，既有修复正例，也有仍然错误的反例。运行成功不等于业务正确；当前代码上部分历史断言可能失败，不应为了让它们通过而恢复旧错误行为。该目录保留当时证据，现行验收使用 `tests/cost_basis_import_pipeline.test.js`、`tests/cost_basis_import_pipeline_test.py`、`tests/cost_basis_import_async.test.js` 及随机回归套件。
结果日志只含合成账户/成交。源文件摘要用于标识未提交工作区的验证版本。
