# PDF 缺图排查与 1.6.11 回退验证

> 历史记录：用户随后提供的桌面错误控制台证实 1.6.11 存在安全包装与页面接口兼容问题。
> 后续改为单图区域补充，见 [1.6.12 验证记录](pdf-figure-crop-validation.md)。

日期：2026-10-15。修改基于 `fix/toolbar-display-dropdown` 分支的
`1ab7450abca3ff8f0377aec2bca2764b92fc1e6d`（1.6.10）。
开始及打包前核对远程，PR #2 仍为 open / draft，head 没有新提交。
本次未推送远程分支。

## 已确认的原因

在实际原 PDF 与本机 `.zotero-sdt-cache` 中逐一比对，确认图形在 SDT
结构中缺失，并非单纯被插件的「仅译文」样式隐藏。

| 样本 | 原 PDF | 缓存结构 | 已确认的缺失 |
| --- | --- | --- | --- |
| Carneiro / Gamboa 2019，期刊版 | 14 页，MD5 `e92b123b2a4aeeff524530708fd77d11` | 3 个 image 块、30 个 caption 块 | PDF 第 4 页的 Figure 3 拓扑图是位图，原图完整；SDT 保留图题，却无该图对应的 image 块 |
| LRQ-Solver，期刊预印版本 | 19 页，MD5 `0e5816a1151a2a4a4ab63826d64aedad` | 1 个 image 块、20 个 caption 块 | PDF 第 2 页 Figure 1 为矢量曲线图，原图完整；SDT 保留图题，无对应 image 块 |

两份缓存的 source.hash 均与原 PDF 的 MD5 一致；processor.type 为 pdf，
processor.version 为 14，与 Zotero 10.0.6 随附 worker 元数据一致。
不能将其归结为「用了另一份 PDF 的旧缓存」。

本机 Zotero 版本：10.0.6，BuildID 20261007153950；本机已安装该插件为
1.6.9，与恢复到的分支版本 1.6.10 不同。本次没有替换已安装插件。

检查了本机 Reader 的实现：PDF 的 SDT 图像/公式/表格通过
`createSDTBlockCropProvider()` 获取锚定区域，再由
`renderRegionCrops()` 渲染源 PDF。不存在的图像块不会创建对应裁剪节点。
因此，修复 CSS 或重复执行已有节点的图片加载不能补回上述缺失。
没有证据证明所有其他缺图都来自同一原因，也未确定 worker 内哪一条
分类或过滤规则导致这些块丢失。

## 本次修改

- 新增 `content/scripts/pdf-figure-fallback.js`：识别保留图题、缺少相邻图形块的页，
  在图题前插入「原 PDF 第 N 页（图表补充，含原页文字）」预览，同页去重。
- 直接使用已打开 PDF Reader 的 PDF.js 文档渲染原页，支持位图与矢量图。
  在源 PDF 的 document 中创建画布，保留该 document 已加载的内嵌字体；
  在 SDT iframe 中绘制会产生缺字，已由实际截图发现并修正。
- 预览在接近视口时加载；页面串行渲染，单次画布不超过约 1200 万像素；
  加载失败可点击重试，关闭视图/停用插件会断开观察器、取消任务并释放预览。
- 与自动翻译设置独立，支持主/副阅读视图；原文、对照、仅译文均保留预览。
  补充说明文字不进入翻译，也不被作为原文隐藏。
- 版本升至 1.6.11。没有改写 SDT、PDF、译文缓存或 Zotero 安装文件。

## 测试与证据

1. `npm test`：25 项通过，包括原有 16 项及新增 9 项。
2. `npm run test:browser`：4 项 Firefox 真实输入测试通过。
3. `npm run test:pdf`：1 项集成测试、2 个实际 PDF 用例通过。
   使用这两篇原 PDF、其实际 SDT 解包结果及 Zotero 10.0.6 随附的 PDF.js。
   Carneiro 触发并渲染 10 个原页预览；LRQ-Solver 触发并渲染 8 个，合计 18 页。
   两个指定问题页的图形区域均包含有效像素，三种显示模式均可见；
   关闭/重新打开阅读视图可重建预览，运行前后原 PDF、原始 SDT 二进制缓存、
   已有译文缓存和解包 JSON 的 SHA-256 保持一致。
4. JavaScript 语法检查、`git diff --check` 通过；XPI 打包时逐项比对运行文件内容。

本地诊断目录：工作区 `.diagnostics/zotero-pdf-figures/`，保存两份 SDT
解包 JSON、用例清单、集成测试结果 JSON、测试日志和两张回退截图。
原论文、用户缓存、测试依赖与本机 Zotero 资源均未纳入插件包或 Git 提交。

## 验证边界

这是经过实际问题 PDF 验证的**原页回退方案**，尚未修复 Zotero SDT 提取器。
预览包含原页文字，会与阅读模式正文重复；未自动裁剪图形。
依赖可识别的 Figure/Fig./图编号、图题节点和页锚点；图题也缺失、跨页图形、
已有图像块的回载失败尚未覆盖。相邻块依据位置匹配，特殊排版可能误判。

Firefox 集成测试模拟 Reader/SDT 接口，使用真实 PDF.js 渲染 PDF；
并非直接操作 Windows Zotero 桌面程序。尚未在桌面 Zotero 中安装 1.6.11
并完成阅读模式实测，不能据此宣布桌面缺图问题已全面修复。
没有删除或重新生成 Zotero 的原始 SDT 缓存；回退不依赖缓存重提取。

原始 PR：[w192570/zotero-reading-bilingual#2](https://github.com/w192570/zotero-reading-bilingual/pull/2)。
