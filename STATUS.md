# 当前交付状态

核对日期：2026-11-01。

## 最新调整：中文正文缩进及作者信息/脚注折叠

- 中文正文译文首行缩进 2em，随字号缩放；不会给来源英文、标题、图注/表注、列表、表格、图形、公式、代码、引用块或作者信息缩进。已有译文带前导空格时取消 CSS 缩进，避免叠加。
- SDT 注释节点保留在原处，以“脚注 N”折叠。作者信息仅在前文位置、内容特征和 SDT 回指支持时收起；前置边界不明确且没有明确关联时保留原样。连续作者节点可合并一个“作者信息”区。
- 展开保留原文节点、编号、链接和已存在译文卡片；新卡片只从现有译文缓存命中，不向模型发请求。无 API Key 时也会完成 DOM 折叠。
- 自动回归：87 项单元、20 项 Firefox 通过；Gecko 6 项通过。Gecko 中实际 PDF 用例跳过，因为没有配置 `ZRB_PDF_CASES`。现有 8 篇真实 PDF SDT 均不含 note/footnote，脚注行为没有真实脚注 PDF 样本；Windows Zotero 桌面验收待复核。
- 测试包：`zotero-reading-bilingual-1.6.13-notes-indent-test.xpi`，目标目录 `F:\111office\zotero\plugins`，1,094,448 字节，76 个运行文件，SHA-256 `02b20f2df25f1f81b5845342b4b73d0afeedb34049df29a02320cff4b942013d`；源码指纹 `10d5b8e53c42a40abbb74634cb63877b51d4e65c8f9348f2410128779d8ba396`。中间包保存在 `.diagnostics/zotero-metadata-indent-20261101/`。
- manifest 正式版本仍为 1.6.13。分支、HEAD 未变；未提交或推送。
- 细节与验证矩阵见 `docs/reading-formatting-validation.md`。

## 当前候选：原生图去重、图注顺序、复合块完整拆分

- 用户桌面反馈表明上一轮验收不完整：测试把原生图、表格简化为空节点，未证明去重及整篇阅读排布。
  当前用例已接入安装版 Reader 的实际 SDT renderer、样式、裁剪提供器和图片 hydration 方法。
- 截图样本已锁定为 Dogea 2023 第 8 页：原生图 10 与左侧图注漏关联；图 11 和表 5 被误包成一个表格裁剪块。
  原生侧图采用关联与替换，不重复追加；普通原生图恢复到对应图注前，图与表各自保留图注及译文顺序。
- 深入逐图检查发现 Dogea 第 12、13 页整列多图、多表也被误合并；已规划整组成员后拆分，增加 7 组完整边界与顺序断言。
  W37 的残缺双子图、完整图例、页脚和短正文边界也已补查修复。公式 18 与流程图分离后仍保留公式。
- 同组新图片全部解码成功后才隐藏原生块；失败保留原图，关闭功能恢复原节点位置和 hidden 状态。
  仅译文模式下使用可见原生区域触发加载；不改写 PDF、SDT 或译文缓存，不调用模型。
- 最终回归：87 项单元、16 项 Firefox、7 项 Gecko 均通过，无跳过。8 篇实际 PDF 共 74 个渲染区域通过，
  包括图、表与公式，不能称作 74 张独立缺图。冷渲染 74 次、重开磁盘命中 74 次、热重渲染零次、关闭缓存内存零。
- 最终代码及副本：`zotero-reading-bilingual-1.6.13-native-layout-verified-test.xpi`，已放入 `F:\111office\zotero\plugins`。
  1,090,628 字节、76 个运行文件、34 个 JS 语法检查通过。
  SHA-256：`566baff876375f212d153a32b87b3bccabb4b62c285806fd0c8634311e1f029e`。
  源码指纹：`970ed76b83f1f6b8e49c186f00c6d3de3dd8cc8a3c0e60562d81480b0f2bc2a1`。
- 证据：`../.diagnostics/zotero-native-figures-20261101/` 下 `unit-verified.log`、`browser-verified.log`、
  `pdf-verified-final.log`、`gecko-verified-final.log`、`rendered/integration-results.json`、`rendered/gecko-results.json`、
  全组合阅读页面与两篇问题论文全部本轮裁剪联系表、`build-verified-result.json`、`delivery-verified-check.json`。
  中间 `native-layout-test.xpi` 未通过逐图复查，已从插件目录移至诊断目录留档，不作为候选。
- 仍为本地几何恢复，没有更换为新的版面模型；不能保证任意复杂 PDF 均无误。Windows Zotero 日常安装、滚动与多插件组合待用户复核。
  分支及 HEAD 不变，未提交、推送、发布或改写历史；用户验收后再按授权整理正式提交。
  详见 `docs/pdf-native-layout-validation.md`。

## 上轮候选（用户反馈未通过桌面验收）：侧边图注、跨栏图、失效视图与提前加载

- 分支 `fix/toolbar-display-dropdown`，HEAD `1ab7450abca3ff8f0377aec2bca2764b92fc1e6d`；保留既有暂存与未暂存改动。
  本轮未核对远端 PR 新提交，未提交、推送或改写历史。正式版本仍为 1.6.13。
- 自动模式预取范围从上下 400 px 扩到各两屏，最少 1200、最多 3200 px；滚动停稳等待从 160 降到 80 ms。
  可见优先，跳过滚远的排队任务；保留输入避让、串行渲染、分段扫描与卸载布局。
- 增加靠页边多行图注的左右候选，使用相邻图注顶部划分侧图。无相邻栏阻挡时允许跨栏图，禁止吞入邻栏正文。
- W37N2YED 第 12 页图 10、11 和第 14 页图 13、14 已用实际 PDF 验证，完整图形、子图、坐标及色条保留，无页脚和邻图。
  7 篇实际 PDF 共 51 个补图全部载入；三种显示模式可见。源 PDF、SDT、译文缓存哈希保持不变。
- 清理失效视图，异步返回后复核存活状态；旧交付代码在真实 Gecko dead wrapper 测试复现报错，新代码通过。
  这是同类故障路径的验证，尚未还原用户桌面的每一次标签关闭操作。
- 缓存键切到 `region-crops-2`，旧误裁不再命中；左右方向纳入元数据校验。
  冷渲染 51 张、重开后磁盘命中 51 张且零重渲染；关闭后缓存内存为零。
- 最终自动回归：77 项单元、14 项 Firefox、7 项 Gecko，无失败、无跳过；另实际 PDF 浏览器集成用例通过。
  连续滚轮测试渲染在最后输入约 89 ms 后开始；双视图 28 图卸载 23 张，估算约 30.1 MB，返回布局高度不变。
  并行验收曾出现超时，保留日志；最终串行通过。Gecko 51 图冷/热全套约 119 秒，测试总预算调整到 240 秒。
- 当前候选：`zotero-reading-bilingual-1.6.13-figure-sides-test.xpi`，已复制至 `F:\111office\zotero\plugins`。
  1,087,417 字节，76 个运行文件；31 个 JS 语法检查及包与当前源码逐项校验通过。
  SHA-256：`5f9db8008cb00d3fbba3dbbc3836bbf5ed0ee286af68cb197335c43fd6afe24c`。
  运行源码指纹：`1584c5cd0c22ca13d7218a4c3b0a94555107ac29da117594f1dab9d08394f5f0`。
- 证据：`../.diagnostics/zotero-figure-sides-20261101/`，尤其 `unit.log`、`browser-final.log`、`pdf.log`、
  `gecko-serial.log`、`rendered/integration-results.json`、`rendered/gecko-results.json`、原页与补图 PNG、
  `lifecycle-before.log`、`side-cache-before.log`、`build-result.json`、`delivery-check.json`。
- Windows Zotero 安装后滚动手感与标签生命周期的完整桌面验收仍待复核。用户验收后再整理提交与正式版本，不能先推送。
  详见 `docs/pdf-figure-sides-validation.md`。

## 上一轮：失败段落恢复，保留成功译文

- 截图为 fetch 的 NetworkError，代表请求未正常取得响应，不能仅凭截图确定中断环节。
  只读检查发现当前配置为本地代理 127.0.0.1:8045，检查时 TCP 可连接；未调用用户的模型接口。
- 原实现虽保存成功缓存，但失败卡片缺少直接重试入口，批量结束还会把部分失败显示为完成。
- 新增「重试本段」及正文顶部「只重试失败段落」。先读取成功缓存，仅请求仍缺译文的条目，
  每批最多 5 段，使用当前提供商、模型、提示词及并发设置；同批相同原文去重，重复点击有任务锁。
  表格与手动选区保留各自专用请求；成功结果立即合并缓存，失败保留原文、错误信息与重试入口。
- 新写缓存过滤错误占位；旧缓存中的错误不会当成成功命中。编号回复缺段时保留缺口，
  不把后段译文错配过来。再次网络失败不会无限重跑；可手动编辑补写，保存不调用模型。
- 校验成功缓存、重复点击、批量去重、部分回复、错误占位、表格请求、视图移除、缓存写入异常、
  整轮进度统计。网络错误与缓存异常分开处理，缓存写入异常不会把当前视图已完成译文重新列为失败。
- 自动验收：71 项单元、13 项 Firefox、5 项 Gecko 通过，无跳过。Firefox 用本地测试服务器实际中断
  fetch，再恢复连接；验证只提交失败原文，成功卡片与成功缓存不变。Gecko 验证真实权限边界下的
  重试按钮和批量恢复。测试不使用用户的付费模型；日常 Zotero 安装后的操作仍待复核。
- 未重跑实际 PDF 的裁剪测试；补图算法未改动，已有图形相关单元、浏览器与权限测试通过。
- 证据：`../.diagnostics/zotero-translation-retry-20261101/` 的 `before.log`、`extra-before.log`、
  `cache-before.log`、`after.log`、`unit-tests.log`、`browser-tests.log`、`gecko-tests.log`、
  `browser-retry.log`、`failed.png`、`build-result.json`、`delivery-check.json`。

## 已保留：公式标记原样显示的修复

- 用户安装包哈希与上一 typography-test 交付一致；找到对应实际译文缓存，行内变量的数学标记有效。
  普通单元测试可以渲染，不能解释桌面失败；真实 Gecko 测试复现了库载入失败后原样输出的问题。
- 已确认两处加载器缺陷：依赖可能不可用的 `hiddenDOMWindow.atob`；UMD 库选择的 `globalThis/self`
  没有绑定到 `loadSubScript` 目标，导致 `markdownit` 导出不在预期对象上。
  即使提供有效 atob，旧导出目标仍无 markdownit，独立探针已验证。
- 修改 `translation-renderer.js`：使用 bootstrap 已提供的标准 atob，显式把 globalThis/self 绑定到库作用域。
  原始译文、公式分隔符、缓存格式及标题排版不改写。
- 验证：59 项单元、11 项 Firefox、4 项 Gecko 回归通过，无跳过；新增用例覆盖截图中的 5 个行内变量。
  直接从交付 XPI 的 jar URI 加载脚本、注册静态资源，5 个变量、KaTeX CSS 和字体均成功加载。
- 桌面安装后的显示待用户复核。本轮未重跑 6 篇实际 PDF 的图形裁剪测试。
- 证据：`../.diagnostics/zotero-inline-math-20261101/` 内 `gecko-before.log`、`export-probe.log`、
  `gecko-after.log`、`unit-tests.log`、`browser-tests.log`、`gecko-tests.log`、`xpi-gecko.log`、`delivery-check.json`。
  其中最初的 `before.log` 是普通单元测试通过的诊断对照，不是失败证据。

## 已保留：标题和图表说明的译文排版

- 原因：Reader 已输出分层标题、图注节点，译文卡片统一样式没有跟随原文的结构。
- 修改：仅调整 `reading-bilingual.js` 生成的 CSS。标题译文按 h1–h6 / ARIA 层级加粗至 700，
  相对普通译文分别为 150%、130%、115%、110%、105%、105%；图注、表注译文为 85% 并居中。
- 缓存恢复的卡片直接应用，长图注换行；正文提及图号不按图注处理，表格单元格字号保持原值。
  识别依赖 Reader 的语义节点，不根据正文中的数字猜标题。
- 标题样式初次验收：旧样式下 2 项新增 Firefox 回归失败；新样式下当时 58 项单元、11 项 Firefox 测试通过，无跳过。
  覆盖标题层级、图注/表注、长图注、嵌套图注、三种显示状态、24px 自定义字号及译文编辑。
- 已查看 Firefox 生成的对照、仅译文截图。Windows Zotero 安装后的排版待复核。
  本次未重跑实际 PDF / Gecko 补图测试，上一轮的 40 处补图结果见下方历史记录。
- 诊断证据：`../.diagnostics/zotero-typography-20261101/` 中的 `before.log`、`after.log`、
  `unit-tests.log`、`browser-tests.log`、`translation.png`、`bilingual.png`、`delivery-check.json`。

## 当前测试包与 Git

- 包名：`zotero-reading-bilingual-1.6.13-retry-test.xpi`；源码目录与 `F:\111office\zotero\plugins` 各一份。
- 1,085,368 字节，76 个运行文件；包内文件与当前源码逐项一致，交付副本哈希一致，29 个 JavaScript 文件语法通过。
- SHA-256：`289e8568f02026acf1e1f210d5c7acd3e6f87155dda957231dd732b0c8a48d49`。
- 运行源码指纹：`6c3dfd84371d3c41c443c48ada837674555924daace6f16556360456319360c4`。
- 本地分支与 HEAD 仍为 `fix/toolbar-display-dropdown` / `1ab7450abca3ff8f0377aec2bca2764b92fc1e6d`。
  未调整暂存区、提交、推送或整理历史，本轮未刷新远端；manifest 保持 1.6.13，旧测试包保留。
- 下一步：安装当前测试包、重启 Zotero 并重开阅读模式；遇到失败时用单段或失败项重试。
  无需清理成功缓存或重翻全文。功能验收后再统一正式版本和处理提交历史。

<details>
<summary>2026-10-17 历史交付记录（下列构建与指纹不是当前包）</summary>

核对日期：2026-10-17。此文件是恢复工作的入口，不替代实时源码、日志或用户最新指令。

## 范围与阶段

当前工作是 PDF 阅读模式缺图补充、三档设置、资源释放与本地 PNG 缓存。
本轮处理 GFocal 图 3 的定位失败：SDT 公式框误含图形，原定位规则把它整体阻断。
已修正公式文本边界，并处理相邻子图标签、双语图题、中文正文范围与误标页眉。
已扩展到 6 篇实际 PDF、40 处补图，以及 18 份已有缓存的几何审计。
此前滚动停稳后启动渲染、分段扫描、异步编码的修改继续保留，当前回归通过。
日常桌面的实际视口与首次滚动手感仍待复核。原有暂存和未暂存修改均保留。

| 内容 | 代码 | 自动验证 | Windows Zotero 桌面 |
| --- | --- | --- | --- |
| 从原 PDF 裁剪单图，支持位图与矢量图 | 已实现 | 六篇实际 PDF，40 处补图 | 待复核 |
| 误扩公式框、子图标签、双语图题及中文范围 | 已修正 | 新增 9 项回归、实际目标图视觉检查 | 待复核 |
| Gecko 跨环境数组权限错误修正 | 已实现 | 旧包失败复现、新代码真实权限回归 | 待复核 |
| 关闭／点击补图／自动补图，默认点击 | 已实现 | 单元、Firefox 设置输入及权限回归 | 待复核 |
| 自动模式观察器之外的可见区域检查 | 已实现 | 浏览器及受控几何的权限测试 | 实际视口待复核 |
| 内存预算、离屏卸载与布局恢复 | 已实现 | 28 图双视图压力、恢复及关闭通过 | 待复核 |
| PNG 磁盘缓存、限额、失效与容错 | 已实现 | 真实文件、IOUtils、40 处冷/热读取通过 | 待复核 |
| 缓存开关、占用显示、清理入口 | 已实现 | Firefox 真实输入通过 | 待复核 |
| 首次补图的滚动响应 | 已修改 | 旧包失败复现，真实滚轮/Gecko 输入响应通过 | 待用户复核 |

缓存遵循三档模式，默认点击、默认开启本地缓存。初始预算为内存估算 32 MiB、
磁盘 128 MiB/2000 条；只管理插件专属缓存。可见图优先，内存估算不代表应用 RSS 硬上限。
此前独立 Zotero 10.0.6 可以启动，但未取得测试入口执行结果；隔离进程已关闭，
不得将本轮自动测试写成 Windows 桌面验收通过。详见新增的规范和验证报告。

## Git 与交付

- 本地分支：`fix/toolbar-display-dropdown`。
- 本次核对的本地 HEAD：`1ab7450abca3ff8f0377aec2bca2764b92fc1e6d`。
- [PR #2](https://github.com/w192570/zotero-reading-bilingual/pull/2)。此前 2026-10-16 核对远端为上述 HEAD，草稿、未合并。本次收尾仅重核本地；未刷新远端状态。
- 工作树保留原有暂存和未暂存修改；本轮继续增加源码、测试与文档，未调整索引，未创建提交。
- 主线程此前要求暂不提交。后续提交、推送和历史整理必须依据用户最新授权；此记录本身不是执行授权。
- manifest 版本：`1.6.13`；当前候选为测试构建，尚未正式发布。

最近已打包候选：

- 名称：`zotero-reading-bilingual-1.6.13-figure-layout-test.xpi`。
- 源码目录和用户指定的 `F:\111office\zotero\plugins` 各有一份。
- 大小：1,082,343 字节，76 个运行文件。
- SHA-256：`7710d36a75a14b38881f6ab67865e7362f53b8330e566c05eb3742aa781465e8`。
- 当前源码、包内逐项内容、目标副本已通过交付脚本核对。旧 figure-scroll-test、figure-cache-test、figure-modes-test 包保留为历史构建，不代表当前源码。

本轮只读交付检查：24 个 JavaScript 文件语法通过，76 个运行文件与源码逐项一致，副本哈希一致。
运行文件指纹：`e62db0ecf6ba6a5fe1afa503f01fe8db21fd152ff59cfc3fc885f8a35a6b1d28`。
结构化结果位于 `../.diagnostics/zotero-pdf-figures/layout-generalization/delivery-check.json`。
此前检查器自身的 9 个场景记录仍为历史证据，未在本轮重跑；机械检查不代替行为或桌面验收。

```powershell
python tools/check-delivery.py --xpi "zotero-reading-bilingual-1.6.13-figure-layout-test.xpi" --copy "F:\111office\zotero\plugins\zotero-reading-bilingual-1.6.13-figure-layout-test.xpi"
```

## 验证证据

以下均为本轮当前运行源码的适用测试，无跳过。文档更新不改变运行文件指纹。

| 验证 | 本轮结果 | 本地证据 |
| --- | --- | --- |
| 单元 | 58 项通过 | `unit-tests.log` |
| Firefox 浏览器 | 9 项通过 | `browser-tests.log` |
| Gecko 权限、模式与输入响应 | 3 项通过，包含于完整 4 项运行 | `gecko-tests.log` |
| 实际 PDF 自动补图 | 1 项、6 篇、40 处补图通过 | `pdf-tests.log`、`rendered/integration-results.json` |
| 实际 PDF 权限与磁盘缓存 | 1 项、6 篇、40 处补图，冷/热均通过 | `gecko-tests.log`、`rendered/gecko-results.json` |
| 批量几何审计 | 18 篇、226 图题；无法产生候选从 11 降至 0 | `audit-before.json`、`audit-after.json` |
| 原有两篇逐像素比较 | 24 张输出图均不变 | `previous-24-comparison.json` |
| 安装包和副本一致性 | 当前源码逐项及哈希核对通过 | `build-result.json`、`delivery-check.json` |

上述本地证据位于工作区的 `../.diagnostics/zotero-pdf-figures/layout-generalization/`，不随仓库分发。
几何审计不代表 18 篇所有图片内容正确；本轮人工对照了新增样本的目标图。
早期滚动问题证据仍保留于 `scroll-jank/`，不作为新增定位规则的验证证明。
普通 Firefox、受控 Gecko 权限用例都不等同于用户 Windows Zotero 内的安装操作。

- [缺图定位与多 PDF 回归](docs/pdf-figure-layout-validation.md)
- [三档设置验证说明](docs/pdf-figure-modes-validation.md)
- [补图资源与缓存规范](docs/pdf-figure-cache-spec.md)
- [缓存、性能与桌面验证边界](docs/pdf-figure-cache-validation.md)
- [首次补图的滚动响应](docs/pdf-figure-scroll-validation.md)
- [权限错误复现与修正](docs/pdf-figure-permission-validation.md)
- [单图裁剪验证](docs/pdf-figure-crop-validation.md)
- [早期整页回退记录（历史）](docs/pdf-figure-fallback-validation.md)

## 待完成

1. 在日常 Windows Zotero 中安装当前候选包并重启，重点复核 GFocal 第 4 页、原问题论文、首次滚动手感和缓存恢复；放入普通目录不等于安装。不需要按论文配置参数。
2. 尚未完成超大真实文库的长期运行与应用 RSS 测量，不扩大当前性能结论。
3. 用户确认后再决定统一正式版本、提交/推送与历史整理。目前这些动作均未执行。

</details>

## 最新修复：章节标题编号恢复（2026-11-01）

- 根因已定位：全文批量翻译和选中文本翻译都把译文直接交给卡片显示；提示词没有要求保留章节编号，显示层也没有恢复编号。缓存命中时同样直接显示原缓存值。
- 仅对语义明确的标题节点（H1-H6、role=heading 或 heading 类名）抽取原文编号；图表、列表、表格和普通段落不处理。新译文、旧缓存以及已存在卡片都在显示时补齐；不重复编号，不改写译文缓存。再次点击全文翻译可校正已经存在的标题卡片，无需调用模型。
- 回归：87 项单元测试通过；Firefox 标题与排版测试 3 项通过，覆盖旧卡片、缓存命中、全文新译文、选中文本、编号去重、正文排除及图注排除。浏览器全套两次均有与本改动无关的单例波动：一次下拉点击等待超时（单独运行该文件 4 项通过），一次长文图片卸载断言少卸载 1 张；其余 20/21 通过。Windows Zotero 桌面验收待复核。
- 静态交付检查通过：35 个 JS 语法检查、76 个运行文件与当前源码匹配。测试包 `zotero-reading-bilingual-1.6.13-heading-number-test.xpi` 已另存到仓库根目录及 `F:\111office\zotero\plugins`，SHA-256 `bb63aa8db35a06aa913dcb2b7b7fac0694c2d439951e88d053bb0226ef1baa8a`。保留原 `notes-indent-test.xpi` 回退包。manifest 仍为 1.6.13；未提交或推送。

## 最新修复：列表误折叠与显示模式记忆（2026-11-01）

- 列表误分类原因：作者信息识别会沿 SDT 回指扩展到前置信息中的短块；扩展候选原先没有排除列表结构或以项目符号开头的内容。现在作者信息候选、回指扩展及脚注候选都会跳过语义列表节点和显式项目符号项；真实 SDT 脚注仍按原节点类型处理。没有样本 SDT 原始结构，因此这里只能确认修正了与截图现象吻合的代码路径，桌面实际 PDF 仍待复核。
- 显示模式新增 Zotero 偏好 `readerDisplayMode`，默认“对照”；用户通过工具栏下拉框选择时保存，重新打开阅读文档后按上次选择初始化。缓存/翻译的内部显示更新不会覆盖该选择。
- Firefox 浏览器测试 `tests/browser/metadata-and-indent.test.cjs`：6 项通过，覆盖点号列表回指、误标脚注排除、真实脚注保留、三种模式与显示模式重新打开恢复。
- 单元测试：87 项通过。静态交付检查：35 个 JavaScript 文件语法通过，76 个运行文件与 XPI 源码及目标副本一致。
- 测试包 `zotero-reading-bilingual-1.6.13-list-mode-memory-test.xpi` 已生成于仓库根目录，并复制到 `F:\111office\zotero\plugins`；SHA-256：`2b8467bc0a3b3ddcd32fa72c0acd7c3cf54f596386600e8316ae09559df3e6d9`。正式版本仍为 1.6.13；未提交或推送。Windows Zotero 桌面安装验收待完成。

## 本轮修正：作者信息显示、阅读模式恢复与章节标题误编号（2026-11-01）

- 按用户标注移除正文内“作者信息”折叠区；作者姓名、单位、通讯作者及编辑说明保留在原位置。旧版插件已经生成的作者信息折叠区会在新代码运行时原位展开。正文解释性脚注仍按 SDT 脚注节点折叠。工具栏“原文 / 对照 / 仅译文”模式选择器保留。
- 修复仅译文模式重开后退回原文：此前模式恢复只发生在翻译流程启动时；现在 SDT 文档创建或替换时立即读取 Zotero 偏好并恢复模式，包括外层 Reader 观察器已存在的情况。普通 PDF 页面的 textLayer 不套用该模式。
- 修复章节标题被加上 C/D：旧规则把任何以罗马数字字母开头并后接字母的文本都当成编号，导致 Chapter、Description 分别被截取为 C、D。现在优先提取 Chapter/Part 后的真实编号，罗马编号要求是独立 token；现有错误译文卡也会显示层纠正，不改译文缓存。覆盖 Chapter 1、无编号 Description、真实罗马编号 IV。
- 自动验证：单元测试 87 项通过；Firefox 工具栏、元数据与排版定向测试 14 项通过；静态检查与包内文件一致性通过。Windows Zotero 桌面验收仍待完成。
- 候选包 `zotero-reading-bilingual-1.6.13-author-inline-mode-restore-test.xpi` 位于仓库根目录及 `F:\111office\zotero\plugins`。正式版本仍为 1.6.13；未提交或推送。

## 最新修正：模式偏好读取分支错误与工具栏恢复顺序（2026-11-01）

- 用户再次报告“对照 / 仅译文”退出后均回到“原文”。本轮确认了此前修复遗漏的根因：`set` 使用完整偏好名称且传 `global=true`，`get` 却没有传该参数。Zotero 会给读取名称再次添加 `extensions.zotero.` 前缀，因而读不到已保存的值并回退原文。现补齐读取参数，沿用已有正确保存的偏好，无需迁移或删除用户配置。
- 已先复现后修正：修正测试替身的偏好分支规则后，浏览器用例出现 `saved=translation`、`restored=original`；加载本机 Zotero 10.0.7 的真实 `xpcom/prefs.js` 后，同样复现两种译文模式回到原文。此前简单 Map 替身忽略 `global` 参数，导致旧测试误通过。
- 完整进入流程还复现了工具栏先读取旧卡片可见性、正文后恢复偏好的时序错误。现同步工具栏时先初始化新 SDT 的显示模式，再更新下拉框；保留已有文档中的用户选择。运行代码仅修改偏好读取及这一恢复顺序。
- 自动验证：88 项单元测试通过；14 项 Firefox 定向测试通过；1 项真实 Gecko 测试通过（无跳过），使用本机安装版 Zotero 的偏好实现及隔离原生配置，覆盖下拉框 change、三种模式、插件实例重建、Reader 初始化、已有缓存卡片和工具栏一致性。已有译文不进入模型调用。该测试不等同于用户日常 Zotero 桌面安装验收，桌面重开仍待复核。
- 测试包 `zotero-reading-bilingual-1.6.13-display-mode-persistence-test.xpi` 已生成于仓库根目录及 `F:\111office\zotero\plugins`。76 个运行文件，1,095,319 字节，SHA-256：`9121933c518fb2cc7e22107a15bc88ec292edaefafed21d4cddce83426e9c6e8`。36 项 JS 语法检查通过，包内源码及目标副本逐项一致。保留上一包 `author-inline-mode-restore-test.xpi` 回退；版本仍为 1.6.13，未提交或推送。

## 测试版：手动裁剪／修正图片（2026-11-02）

- 原生图片、插件补图和失败框共用右键菜单及悬停轻量入口。编辑器从 Reader 正在读取的原 PDF 页面预览；按 PDF 坐标保存最多 12 个选区，可重画、拖动、改边界、增删、排序和跨页预览。确认后各选区独立显示，放在所选图注上方或原位置。即使没有可靠图注，原生图片仍可手动修正。
- 用户勾选具体替换碎片后才隐藏原图节点。正文、公式、表格、图注、译文、链接和页面容器均不作为整块替换目标；选区外仍含其他内容的原生大裁剪采用局部 CSS 遮罩保留其余像素。SDT 明确标出的辅助短标签只在格式匹配、几何范围完全覆盖且用户另行勾选后才会替换，匹配译文也须来源文本完全一致。用户操作不触发模型请求。
- 修正记录独立存放在 Zotero 数据目录插件专属 `reading-bilingual/manual-figures-v1`，以文献标识和 PDF 内容指纹隔离；可清理的 PNG 缓存删除后仍按选区重新生成。记录原子落盘。取消、渲染失败、视图关闭或新节点插入失败时保留旧显示；重裁插入成功后才撤下旧图。关闭视图释放编辑器、监听器和图像。
- 红绿用例：手动修正前新增“重裁插入失败时旧图和旧选区记录仍保留”的失败测试，初次运行按预期失败，修复后通过。
- 自动验证：`npm test` 103/103；完整 Firefox 浏览器套件 27/27；Firefox 手动编辑器定向套件 3/3；本机 Gecko 153.0 + Zotero 10.0.7 随附 Reader/PDF.js 的真实 PDF 用例 1/1。实际样本为 Cella 翼肋论文报告的 Figure 18（PDF 第 17–18 页）：两页 Rib 1–4 与 Rib 5–10 分别按选区顺序生成；同坐标 PNG 与 Reader 原生渲染结果逐字节相同，标签/尺寸完整。检查了 90° 旋转副本、PNG 缓存清理和插件实例重建恢复、迟到补图去重、取消、恢复原显示、失败回退及 Reader 关闭资源释放。原 PDF、SDT 与译文文件哈希未变。
- Figure 18 的原生裁剪还覆盖了相邻 Figure 17；经确认的局部遮罩保留上方 Figure 17 像素，选区内被替换的原图无残留像素。浏览器和隔离 Gecko 结果不等同于日常 Zotero 桌面验收。
- 静态交付检查：42 项 JS 语法检查通过，XPI 包含 79 个运行文件，并与当前源码及目标副本逐文件校验一致。候选包 `zotero-reading-bilingual-1.6.13-manual-figure-crop-test.xpi` 已放在仓库根目录和 `F:\111office\zotero\plugins`；大小 1,113,823 字节，SHA-256：`18133bcd05854b02e005ef5de8dbe621688912600420cc98d4a3bd487aa99347`。保留上一包 `zotero-reading-bilingual-1.6.13-display-mode-persistence-test.xpi` 回退。正式版本仍为 1.6.13；未提交或推送。
- 证据、原样本检查副本和截图保存在 `F:\备份\test\.diagnostics\zotero-manual-crop-20261101\`，不随 XPI 分发。规范与限制见 [手动裁剪规范](docs/manual-figure-spec.md)。
- 待用户在日常 Windows Zotero 安装该候选 XPI，实际打开原 Figure 18 样本，检查原生图入口、拖框和手柄操作、重开/重启后的恢复、仅译文布局及长文滚动观感；安装复核前不标记桌面验收通过。

## 本轮增补：图片裁剪编辑器与跨页图（2026-11-02）

- 阅读模式所有可识别图片均支持双击放大；手动修正后的预览可切换为编辑器主区域的大图查看，再返回编辑。Ctrl+滚轮只缩放左侧 PDF 预览窗，不影响阅读页面或整个编辑器。
- 插件补图和失败框均提供裁剪入口；替换范围用候选图片缩略图和悬停定位展示，不要求记页码与序号。框选区域后只自动勾选几何范围明确包含的原生碎片，用户取消勾选后不会被后续选区重新勾回。
- 原生跨页图按共享图注和 SDT 来源顺序合并相邻页的图形碎片；Cella 实际 PDF 的 Figure 18 对应 PDF 第 17、18 页共 7 个图像碎片，按区域顺序预览，不强制拼接成长图。
- 自动回归：`npm test` 104/104；`npm run test:browser` 28/28；真实 Gecko 153.0 + 本机 Zotero Reader/PDF.js 对 Figure 18 的裁剪与恢复用例通过。运行环境不是日常 Windows Zotero 桌面会话，桌面验收仍待用户复核。
- 本轮测试包 `zotero-reading-bilingual-1.6.13-figure-editor-usability-test.xpi`：79 个运行文件，1,117,667 字节，SHA-256 `ef7b47a271cb0c2d94221d52d1aa09aea0975c30b096a3c8657f6d8b7984d850`。包内文件、当前源码与 `F:\111office\zotero\plugins` 副本逐项一致。保留上一测试包 `zotero-reading-bilingual-1.6.13-manual-figure-crop-test.xpi` 作为回退；正式版本仍为 1.6.13。
- 图像裁剪/跨页识别相关文件已提交：`9181cdc`（Improve figure crop editing and cross-page detection）；未推送。其他排版、翻译相关改动仍保留在工作区，没有纳入本次提交。日常 Zotero 桌面验收仍未完成。

## 本轮修正：图片操作反馈与放大预览（2026-11-02）

- 裁剪按钮此前在 PDF 指纹或 Reader 初始化失败时只写日志和 `title`，界面没有反馈；现在显示处理中状态，失败时给出可读错误。补图按钮改为绑定在按钮本身，避免依赖阅读文档上的捕获式点击代理。
- 浮动裁剪按钮位置按可见的图片/矢量图边界计算，不跟随更宽的 SDT 容器；离开图片后延迟隐藏，跨过空隙移到按钮时不闪退。双击后的预览新增缩放、适合窗口、关闭控件和滚轮缩放；单击图像不会误关，Esc 可关闭。
- 自动验证：`npm test` 104/104；`npm run test:browser` 31/31。浏览器套件首次并行运行有 3 项既有超时，单独复跑均通过，随后完整套件通过。真实 Gecko 153 + Zotero Reader/PDF.js：7 项通过、2 项因环境未配置而跳过；Figure 18 实际跨页 PDF 裁剪用例通过。
- 新包 `zotero-reading-bilingual-1.6.13-figure-zoom-interaction-test.xpi`：79 个运行文件，1,119,133 字节，SHA-256 `8d48ab4bd2e0322f3de868a9a7e6d04ed322a069efbef751c84487e4538fd150`。语法、XPI 文件清单及插件目录副本校验通过；保留上一包 `zotero-reading-bilingual-1.6.13-figure-editor-usability-test.xpi` 回退。正式版本仍为 1.6.13。
- 日常 Windows Zotero 桌面交互验收仍待完成；自动化结果不能替代桌面验收。

## 本轮调整：图片预览定位、公式图表裁剪与段落重译（2026-11-02）

- 放大预览原来只把预览容器放在屏幕中央，媒体仍从容器顶部排列；现在单图在预览可用区域居中，多图作为有序组展示，并清除克隆媒体继承的浮动和定位样式。缩放和窗口变化后，裁剪按钮会按当前命中的具体图像边界重算，固定在图像右上角；滚动时仅在指针仍位于图像或按钮上时跟随，关闭视图会移除新增的窗口监听。
- 裁剪候选识别现在允许 SDT 数学块中的独立图片/SVG/画布，以及图表块或图表容器中的图形叶节点；替换目标仍是该媒体节点，不会把公式块、表格或正文容器作为隐藏对象。覆盖了公式 SVG、图表画布和无图注、链接嵌套的高窄图片。
- 每个译文卡片右上角增加“重译本段”操作，沿用现有并发限制和模型适配，只发送当前段落，并跳过该段缓存读取；成功后更新这段译文及缓存，不调用全文翻译流程。
- 自动验证：单元测试 104/104；Firefox 浏览器套件串行运行 34/34；Firefox 153 + 本机 Zotero Reader/PDF.js 的 Gecko 套件 7 项通过、2 项因未配置独立 Zotero 安装目录而跳过。Figure 18 跨页 PDF 原生渲染/坐标用例通过。并行运行时出现资源竞争型超时，串行完整回归通过。
- 静态交付检查：42 个 JS 文件语法通过；XPI 79 个运行文件与当前源码及交付副本逐项一致。测试包 `zotero-reading-bilingual-1.6.13-image-recrop-retranslate-test.xpi` 位于仓库根目录和 `F:\111office\zotero\plugins`，大小 1,119,639 字节，SHA-256 `ce55dd998df096d472b5b83487110fb03317dd5a68a27636eb6548f16810184e`。保留上一包 `zotero-reading-bilingual-1.6.13-figure-zoom-interaction-test.xpi` 作为回退；版本仍为 1.6.13。
- 用户提供的第 4、5 张截图没有对应 PDF/SDT 文件，本轮通过带链接的嵌套高窄图片和不同 SDT 媒体类型覆盖候选路径，尚不能确认与截图中的具体来源结构完全相同。日常 Zotero 桌面安装及这两张图对应 PDF 的验收仍待完成。
