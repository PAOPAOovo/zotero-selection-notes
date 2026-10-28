# Selection Notes 1.0.8 for Zotero 9

1.0 系列最终版。在 Zotero PDF 阅读器中选中文字后，点击“📝 写笔记”，编写支持 Markdown、LaTeX 和围栏代码高亮的笔记；保存后点击原文高亮，即可查看渲染结果并继续编辑。

适用于 Zotero **9.0.x**，已在 macOS / Zotero 9.0.6 上验证。此版本包含核心笔记编辑与渲染功能，无 2.0 系列的整包导出功能。需要导出论文与笔记，请使用 [2.0.4](https://github.com/PAOPAOovo/zotero-selection-notes/releases/tag/zotero-selection-notes-2.0)。

## 安装

1. 从 [1.0.8 Release](https://github.com/PAOPAOovo/zotero-selection-notes/releases/tag/zotero-selection-notes-1.0) 下载 `zotero-selection-notes-1.0.8.xpi`。
2. 打开 Zotero“工具 → 插件”，通过齿轮菜单选择“从文件安装插件”。
3. 选择 `.xpi` 完成安装，完全退出（macOS：`⌘Q`）并重新打开 Zotero。

两个版本使用相同插件 ID，请选择一个安装。升级与更换版本会保留 Zotero 中已有批注。

## 使用

1. 在 PDF 中选中文字，点击“📝 写笔记”。编辑器仅在点击后打开。
2. 左侧编写 Markdown，右侧实时预览。
3. 点击保存或按 `⌘ Enter` / `Ctrl Enter`。
4. 再次点击原文高亮查看渲染结果，点击“笔记详情 / 编辑”可修改。

支持标题、粗体、斜体、删除线、链接、引用、列表、任务列表、表格、行内/块级公式和代码块。编辑器支持方向键操作，批注弹窗宽度会随笔记内容和阅读区调整。

````markdown
## 我的笔记

行内公式：$E=mc^2$。

```python
print("Hello, Zotero!")
```
````

## 数据和边界

笔记源码保存在 Zotero 原生批注的 `comment` 字段中；同步由 Zotero 管理。笔记编辑和渲染离线完成，原始 HTML 不会执行。当前仅声明支持 Zotero 9.0.x，其他系统和大版本尚未验证。

持久位置由原生高亮保存，“笔记详情 / 编辑”位于点击高亮后出现的批注弹窗中。内置 Markdown 与代码着色覆盖常用语法，并非完整 CommonMark 或语言解析器。

## 构建

需要 Node.js 18+、npm 和系统 `zip`：

```sh
npm ci
npm run build
npm run check
npm test
```

安装包生成在 `dist/`。KaTeX 及字体由构建脚本复制到安装包中。

## 许可

[MIT License](LICENSE)。KaTeX 使用 MIT License，其原始许可证随 XPI 分发。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## AI 辅助开发声明

本项目在开发过程中使用了 **OpenAI GPT / Codex** 辅助编写代码、调试问题和整理文档。项目的功能需求与发布决定由维护者确定。

This project was developed with assistance from OpenAI GPT / Codex for coding, debugging, and documentation.
