# 1.6.13：Gecko 跨环境数组权限错误

## 桌面反馈与根因

用户安装 1.6.12 后，Figure 2 补图显示：
`定位图形区域：Permission denied to pass object to privileged code`。
这发生在区域渲染之前；快捷键布局、其他插件模型缓存等日志并非本次根因证据。

此前 Firefox 页面测试中的插件与 Reader 都在普通内容环境，不能触发系统权限
与内容权限之间的 Gecko 检查。本次用隔离临时配置启动 Firefox Marionette，
以系统权限运行真实插件源码，以内容权限保存 SDT 和文档。

最小样本只含同页一个 heading 与一个 caption。原代码的 `map(r => r.slice(1))`
产生的中间数组继续调用 `some(...)` 时触发与截图完全相同的错误。
该样本无需 PDF、网络或其他 Zotero 插件，因此可以排除 PDF 下载和区域渲染。
用实际 Carneiro SDT 的图题 ref 68 也复现了同一错误。

修复前运行 `node --test tests/gecko/figure-permissions.test.cjs`：
1 项失败，实际消息为 `Permission denied to pass object to privileged code`。
修复后，原错误写法作为阳性对照仍会抛出该消息，生产入口已通过。

## 修改

- 在每个阅读视图建立补图状态时，将 SDT JSON 数据复制到插件环境；
  区域定位、图题位置推断与派生数组均使用本地快照。原 SDT 不修改。
- 原生渲染仍在 Reader 环境执行，传入坐标转换到 Reader 环境。
- 控制台错误保留 message 与 stack，避免旧版只打印调用栈而漏掉原因。
- 增加真实 Gecko 权限回归，分别覆盖可用 Cu.cloneInto 与 JSON 转换路径。
  全链路用例执行定位、内容环境渲染、像素裁剪和图像解码。

## 验证与边界

单元测试 32 项通过，原有 Firefox 测试 5 项通过。
实际问题 PDF 常规集成测试通过：Carneiro 14 个补图，LRQ-Solver 10 个补图。
PDF、SDT 和译文缓存运行前后哈希不变。
新增 Gecko 权限测试共 3 项通过：最小报错复现与修复、完整跨权限加载链路、
两篇实际 PDF 共 24 个图形。每个图形均完成原生区域渲染、去白边和图片解码。
两处重点图形与独立核对的边界相符；与普通内容测试的全部裁剪框相比，
Carneiro 最大差异约 0.501 PDF 点，LRQ 完全一致。
窗口外测试文档没有刷新帧，因此测试用计时器调度 PDF.js 的 requestAnimationFrame，
不改动插件或原生区域渲染代码。

修复前测试直接从已交付的 1.6.12 XPI 读取旧源码再次确认失败，
修复后同一命令通过。`ZRB_FIGURE_SOURCE` 可指定待比较的旧源码。
最终证据见工作区 `.diagnostics/zotero-pdf-figures/1.6.13/`：

- `gecko-before-fix.log`：旧 XPI 的精确报错复现；
- `gecko-after-fix.log`：新版的最小与全链路权限回归；
- `gecko-tests.log`、`gecko-results.json`：完整权限测试与 24 个图形；
- `unit-tests.log`、`browser-tests.log`、`pdf-tests.log`：原有回归；
- `gecko-*-ref-*.png`：真实权限环境中逐图保存的裁剪图像；
- `build-result.json`：包内文件与源码比对、目标副本 SHA-256。

产物为 `zotero-reading-bilingual-1.6.13.xpi`，共 75 个运行文件，
复制到 `F:\111office\zotero\plugins`。保留此前安装包；测试和论文不打入 XPI。

这些测试使用真实 Gecko 权限检查和 Zotero 10.0.6 随附的渲染代码，
仍不等于在用户的 Windows Zotero 配置中安装并点击验证。
图形边界推断的限制沿用 1.6.12 报告。

代码保留在 `fix/toolbar-display-dropdown`，远端 PR #2 未推送修改。
