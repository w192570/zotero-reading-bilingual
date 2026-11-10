# 正文缩进与作者信息/脚注折叠验证

核对日期：2026-11-01。此记录对应测试包 `zotero-reading-bilingual-1.6.13-notes-indent-test.xpi`。

## 行为

- 只对语义上属于正文的段落译文加首行缩进。来源节点须为段落（`p`、`role=paragraph` 或 Reader 的段落类）；标题、图注、表注、列表、表格、图形、引用块、公式、代码、SDT 注释和作者信息均排除。
- 译文中有中文且没有模型已经输出的开头空白时，首行使用 `2em`。富文本只缩进顶层中文段落；列表、表格、公式和代码结构保持原样。双语模式只作用于译文卡片；原文节点不加缩进。
- PDF 的 SDT `aside.sdt-note[data-ref-path]` 视为 Reader 标注的注释节点，在原 DOM 位置收起为原生 `<details>`。正文脚注单独显示“脚注 N”；展开后原文节点、编号、链接、已有译文卡片仍在同一区域。
- 作者信息需要前置位置及明确内容信号（邮箱、单位名称、通讯作者或编辑说明）。SDT `data-back-refs` 可把单位注释关联到前面的作者块；仅有上标、数字或字号变化不会触发折叠。摘要/引言边界不明确且没有可验证回指时，作者段落保持原样。
- 连续作者信息在第一个原节点所在位置合并为“作者信息”。折叠说明与展开内容字号较小、间距紧凑。编辑译文仍使用现有卡片操作。
- 作者信息与脚注不发起翻译请求。已有译文卡片原位保留；没有卡片时只按现有原文键查已保存缓存，命中后恢复卡片。无密钥时也应用折叠样式。
- 所有处理只改变 Reader 当前 DOM 和插件创建的显示节点；不写回 PDF、SDT 二进制缓存或已有翻译缓存。

## 验证

- `npm test`：87 项通过，无失败、无跳过。
- `node --test --test-concurrency=1 tests/browser/*.test.cjs`：20 项 Firefox 测试通过，无失败、无跳过。新增场景验证三种显示模式、折叠展开、未能可靠识别时保持原布局、无 API Key 时折叠、中文首行缩进、模型已有空格、长脚注、链接、列表、图/表/公式/代码节点、缓存译文恢复及编辑保存。
- `node --test --test-concurrency=1 tests/gecko/*.test.cjs`：6 项通过；实际 PDF 裁剪用例因未设置 `ZRB_PDF_CASES` 跳过，与本次脚注排版无关。
- 当前诊断目录列出的 8 篇真实 PDF SDT 样本都没有 `note` 或 `footnote` 类型节点。因此脚注折叠由 Firefox/Gecko DOM 用例验证，尚无真实脚注 PDF 样本可验证。不能据此宣称 Zotero 桌面验收通过。
- `python tools/check-delivery.py --xpi ... --copy ...`：35 个 JavaScript 文件语法检查通过；包内 76 个运行文件逐项匹配当前源码，XPI CRC、交付副本哈希通过。

## 当前测试包

- XPI：`F:\111office\zotero\plugins\zotero-reading-bilingual-1.6.13-notes-indent-test.xpi`
- 字节数：1,094,448；SHA-256：`02b20f2df25f1f81b5845342b4b73d0afeedb34049df29a02320cff4b942013d`
- 运行源码指纹：`10d5b8e53c42a40abbb74634cb63877b51d4e65c8f9348f2410128779d8ba396`
- 源码包和目标副本哈希相同。先前生成的中间包保存在 `.diagnostics/zotero-metadata-indent-20261101/`，没有删除。
- 正式版本保持 1.6.13；没有提交、推送、更新 PR 或安装到 Zotero。
- 待用户在 Windows Zotero 中检查作者信息/脚注的原位折叠、译文编辑、字号与三种显示模式。
