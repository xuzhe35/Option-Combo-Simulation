# 草稿与交付契约

最终输出为当前项目的 Portfolio `schemaVersion: 1`，由项目自身的 schema 校验并序列化，使用两空格缩进、正常中文和换行。默认与原图同目录同名、扩展名改为 `.json`。将 JSON 直接拖入 `portfolio_snapshot.html`，或使用右上角「导入 JSON」载入，再拖入同一原图核验。不是交易事件或账本备份；`cost_basis.html` 的恢复入口接受另一种账本格式。TWS 比较尚不属于此实验。

先写 UTF-8 草稿（非最终交付文件）：

```json
{
  "headers": ["截图里的实际表头"],
  "notes": ["截图范围或整体疑点，可为空数组"],
  "rows": [
    {
      "rowId": "r1",
      "rowType": "position",
      "parentRowId": null,
      "description": "XYZ Oct18'30 100 PUT",
      "values": {
        "instrument.symbol": "XYZ",
        "instrument.secType": "OPT",
        "instrument.expiryDate": "2030-10-18",
        "instrument.right": "P",
        "instrument.strike": "100",
        "quantity": "-2",
        "displayValues.avgPrice": "1.23"
      },
      "issues": []
    }
  ]
}
```

这是合成的格式示例，不能作为识别词典或真实图答案。缺失的合法字段会明确展开为 null，显式的零用字符串 `"0"`，全部数值使用字符串，不接受 JSON number。多出/拼错的字段拒绝。

## 字段

`values` 可用字段（与当前页面一致）：

- `instrument.symbol`、`instrument.secType`（STK / OPT / FUT / FOP / UNKNOWN）
- `instrument.expiryDate`（YYYY-MM-DD）、`instrument.right`（C / P）、`instrument.strike`
- `instrument.tradingClass`、`instrument.currency`、`instrument.exchange`、`instrument.multiplier`
- `quantity`（有正负号）
- `displayValues.mark`、`displayValues.displayIv`（原始百分数字符串，如 `25%`）
- `displayValues.costBasis`、`displayValues.marketValue`、`displayValues.avgPrice`
- `displayValues.dailyPnl`、`displayValues.unrealizedPnl`、`displayValues.deltaDollars`
- `displayValues.theta`、`displayValues.lastPrice`

价格 MARK、AVG PRICE、LAST 以及 COST BASIS、市值、数量、Delta 金额、Theta 必须按实际表头分别读取。未知不填零；不要计算缺失列。FOP 不当作股票期权；期货没有行权价和 Call/Put。日期和类型可以按明确可见描述解释，不能根据金融常识补币种、交易类别、合约乘数或缺失字符。`CA…` / `PU…` 出现在明确期权到期日和行权价之后，可以结合结构判读 C / P，疑点记录在 issues。

每行必须有唯一 `rowId`、`rowType`、`description`、`values`。行类型：`position` / `cash` / `group_summary` / `combo_summary` / `unclassified`。可选 `parentRowId`、`partial`（默认 false）、`issues`（默认 []）。现金额外填 `cashCurrency`、`cashAmount`；非现金不能填现金字段。

组合父行的 values 保留在源行，不进入 positions。parentRowId 只能指向前面仍在作用域内的组合父行；独立同级行、分组、现金结束该作用域。组合任意嵌套、任意可见腿数；折叠、缺腿或疑点用 partial:true，不补隐藏腿。身份不明的 position 转为 unclassified，保留全部源文，不静默丢弃。

## 排版解读和复看记录（按需）

若原始读数包含上标等排版，只有看图能确认数值含义时才额外提供：

```json
"interpretations": {
  "displayValues.avgPrice": {
    "value": "1.234",
    "reason": "原图小数点后第三位以较小上标显示；已查看该格局部"
  }
}
```

values 仍保存原始读数，例如 `1.23⁴`。只允许非空数值读数的显式解读；不允许给缺失项补数，不支持剥除 LAST 字母前缀。解释后的数字仍须通过原有严格 decimal 校验，并作为机器解读标记供人工批量核验。这不是自动 Unicode 替换规则。

若独立复看出现不同读数：

```json
"rereads": {
  "instrument.strike": [{"raw": "101", "reason": "放大局部后的另一种读数"}]
}
```

该记录不能覆盖首读；脚本保存双方并加入待核验问题。复看一致也可记录，但不代表两个独立模型或像素级证明。

最终 JSON 包含 sources（原图文件名、SHA-256、尺寸，不嵌入图片）、sourceRows、positions、cash、fieldEvidence、recognition、review 等完整结构。所有持仓保持 unreviewed，整体 needs_review；来源是 `codex-chat-skill`，不是网页 CLI 引擎的传输证明。没有可靠会话元数据时 model 和 reasoningEffort 为空。

完成后核对交付文件的统计：源行有没有遗漏，positions 是否仅原子腿，现金是否独立，null 与 0 是否有区别，疑点是否仍在 JSON。格式校验不能检测肉眼未记录的漏行或静默读错。
