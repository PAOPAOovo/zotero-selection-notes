# Selection Notes for Zotero 9

Selection-anchored Markdown, LaTeX, and code notes for the Zotero PDF reader.

在 Zotero 中选中 PDF 文字，点击“📝 写笔记”，即可编写支持 Markdown、LaTeX 和代码高亮的笔记。保存后点击原文高亮，就能查看排版后的内容并继续编辑。

## 发布版本

本仓库仅发布两个版本，均适用于 Zotero **9.0.x**，已在 **macOS / Zotero 9.0.6** 上验证。

| 版本 | 用途 | 安装包 |
| --- | --- | --- |
| **2.0.4** | 当前推荐版本；含笔记编辑及 PDF、HTML、Markdown 导出 | `zotero-selection-notes-2.0.4.xpi` |
| **1.0.8** | 1.0 系列最终版；含笔记编辑和渲染，无整包导出 | `zotero-selection-notes-1.0.8.xpi` |

请从 [Releases](https://github.com/PAOPAOovo/zotero-selection-notes/releases) 下载对应的 `.xpi`。两个版本使用相同的插件 ID，请选择其中一个安装；升级会保留已有批注。旧版源码位于 [release-1.0.8](https://github.com/PAOPAOovo/zotero-selection-notes/tree/release-1.0.8) 分支，最新版位于 `main`。

## 安装

1. 下载所需版本的 `.xpi` 文件。
2. 在 Zotero 打开“工具 → 插件”，点击齿轮菜单，选择“从文件安装插件”。
3. 选择下载的 `.xpi`，按提示完成安装。
4. 完全退出 Zotero（macOS：`⌘Q`），然后重新打开。

## 写笔记

1. 在 PDF 阅读器选中一段文字。
2. 点击选区工具条中的“📝 写笔记”，打开编辑器。
3. 输入 Markdown，在右侧查看实时预览。
4. 点击保存，或按 `⌘ Enter` / `Ctrl Enter`。
5. 再次点击原文高亮可查看渲染结果，点击“笔记详情 / 编辑”可修改。

支持标题、粗体、斜体、删除线、链接、引用、列表、任务列表、表格、行内公式、块级公式、行内代码和围栏代码块。

````markdown
## 关键结论

行内公式：$E=mc^2$。

$$
\frac{d\mathrm{DM}}{dt} = \langle n_e \rangle v_r
$$

```python
def hello():
    print("Hello, Zotero!")
```
````

## 导出论文和笔记（2.0.4）

在 PDF 顶部点击“⇩ 导出笔记”，或在 PDF 空白处右键选择“导出 PDF + 笔记…”，然后选择目标文件夹。

每次导出会创建独立的时间戳文件夹，其中包含：

- 原论文的带高亮、批注 PDF 副本；
- `*.rendered-notes.pdf`：原论文后追加已排版的笔记附录；
- `*.notes.html`：可离线阅读的渲染版笔记；
- `*.notes.md`：可继续编辑的 Markdown 源文件。

**使用其他 PDF 阅读器查看公式时，请打开 `.rendered-notes.pdf` 的末尾附录。** PDF 通用批注评论是纯文本，其他阅读器中的高亮弹窗仍可能显示 Markdown/LaTeX 源码。Zotero 的“文件 → 另存为”使用原生导出，不会生成这个笔记包。

笔记附录以图像形式写入 PDF 页面，能保留排版，但附录文字不可像普通文本那样选择。需要复制或编辑时请使用配套 HTML / Markdown。

## 数据与兼容性

- 笔记源码保存在 Zotero 原生批注的 `comment` 字段中；同步由 Zotero 管理。
- 编辑、渲染及导出在本机完成，无需上传论文或笔记。
- KaTeX 和 PDF 组件随安装包提供，可离线使用。
- 原始 HTML 不会执行，代码块只作展示。
- 当前仅声明支持 Zotero 9.0.x；Windows、Linux 及其他 Zotero 大版本尚未验证。
- 锚点采用 Zotero 原生高亮，“笔记详情 / 编辑”按钮显示在点击高亮后出现的批注弹窗内。
- 内置 Markdown 和代码着色覆盖常用语法，并非完整 CommonMark 或语言解析器。

## 从源码构建

需要 Node.js 18+、npm 和系统 `zip`。下载或检出所需版本的源码后运行：

```sh
npm ci
npm run build
npm run check
npm test
```

安装包生成在 `dist/`。`addon/content/vendor/` 中的依赖由构建脚本生成，依赖版本记录在 `package-lock.json` 中。

在安装了 Zotero 的 macOS 上，还可运行本地 API 检查：

```sh
node scripts/verify-zotero.mjs
```

2.0.4 的 `scripts/gecko-export-smoke.js` 提供实际 Zotero 渲染测试。运行方式见该文件开头；它读取当前打开的 PDF 与批注，并将测试副本写入项目的 `tmp/` 目录。

## 开源许可

本项目使用 [MIT License](LICENSE)。KaTeX 和 pdf-lib 均使用 MIT License，其许可证随构建后的安装包一同分发。第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## AI 辅助开发声明

本项目在开发过程中使用了 **OpenAI GPT / Codex** 辅助编写代码、调试问题和整理文档。项目的功能需求与发布决定由维护者确定。

This project was developed with assistance from OpenAI GPT / Codex for coding, debugging, and documentation.
