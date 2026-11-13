# CodeChasing 评委体验手册

适用版本：**0.27.0** · 预计完整体验时间：**15–30 分钟**

CodeChasing 是一个 VS Code 扩展，用于把**研究论文（PDF）和它的实现代码放在一起理解**：回答中的每一处论文引用 `[P…]` 和代码引用 `[C…]` 都是真实、可点击、可跳转高亮的锚点，而不是模型编造的页码或行号。

本手册按"安装 → 配置 → 论文问答 → 代码互证 → 高级功能"的顺序给出完整操作路径。只想快速过一遍核心亮点，可直接跳到 [第 12 节：15 分钟体验路线](#12-15-分钟体验路线)。

---

## 1. 准备清单

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| VS Code | ≥ 1.101（桌面版） | 不需要 Node.js；只有从源码构建时才需要 Node.js 22.13+ |
| 模型 API | 三选一即可 | OpenAI 兼容（含 DeepSeek、Qwen 兼容网关、Ollama、LM Studio）/ Anthropic / Gemini |
| 论文 PDF | 1 篇 | 每个 VS Code 工作区绑定 1 篇 PDF；扫描件也可（见下方视觉模型说明） |
| 代码仓库 | 1 个 | 建议与论文对应的开源实现；任何你熟悉的论文 + 代码组合都可以 |
| 视觉模型（可选但推荐） | 支持图像输入的模型 | 扫描版 PDF 的 OCR、图表/架构图类问题需要它；纯文本 PDF 的普通问答不需要 |

**推荐演示组合**（论文与代码一一对应，适合展示"论文 ↔ 代码互证"）：

- 论文：*Attention Is All You Need*（Transformer），PDF 可从 arXiv 下载：`https://arxiv.org/abs/1706.03762`
- 代码：`https://github.com/harvardnlp/annotated-transformer`（PyTorch 逐行实现，核心在 `model.py`）
- 可选：在 VS Code 中安装 Python 扩展，符号扫描会更完整；不安装也有语法级回退，不影响体验。

> 本地模型也可以：用 Ollama / LM Studio 起一个 OpenAI 兼容端点，API key 留空即可。此时论文与代码内容不出本机（模型推理在本地）。

## 2. 安装插件

1. 打开 GitHub Releases 页面：`https://github.com/Yikessa24/CodeChasing/releases`
2. 下载最新版本的 `CodeChasing-0.27.0.vsix`。
3. 安装（两种方式任选）：
   - 图形界面：VS Code → 扩展面板（`Cmd/Ctrl+Shift+X`）→ 右上角 `⋯` → **从 VSIX 安装…** → 选择下载的文件；
   - 命令行：`code --install-extension CodeChasing-0.27.0.vsix`
4. 安装后，左侧活动栏出现 **CodeChasing 图标**（无需重启；若未出现，重新加载窗口：`Cmd/Ctrl+Shift+P` → `Reload Window`）。

## 3. 打开助手与布局

1. **先用 VS Code 打开代码仓库文件夹**（文件 → 打开文件夹）。论文与对话都按工作区保存，所以建议一开始就打开最终要用的代码目录。
2. 点击活动栏的 CodeChasing 图标，打开研究助手。
3. 首次使用会提示布局：选择 **Move to right**，再在 VS Code 的位置选择器中选 **Secondary Side Bar**。
   - 效果：左侧资源管理器、中间代码/PDF、右侧助手，三者互不遮挡。
   - 之后随时可以用输入框下方的 **⇥** 按钮重新触发。

## 4. 配置模型

1. 点击输入框下方的 **⚙（Configure model）**，填写：
   - **协议**：`openai-compatible` / `anthropic` / `gemini`；
   - **Base URL**、**模型名**、**API key**。
2. 点击 **✓（Test model connection）** 测试连通性，会显示请求延迟。
3. 用 **◉ Auto** 按钮随时切换推理强度：`Auto / Minimal / Low / Medium / High / XHigh`。
   - `Auto` 使用服务商默认值，兼容性最好；显式档位需要模型支持，不支持时服务商会报错，切回 Auto 即可。

常见配置示例：

| 协议 | Base URL 示例 | 备注 |
| --- | --- | --- |
| openai-compatible | `https://api.openai.com/v1` | DeepSeek、Qwen 兼容网关、Ollama（`http://localhost:11434/v1`）、LM Studio 同理 |
| anthropic | `https://api.anthropic.com` | 原生 Messages API |
| gemini | `https://generativelanguage.googleapis.com` | 原生 generateContent API |

**隐私说明**：API key 保存在 VS Code SecretStorage 中，按"提供商 + 端点"隔离，不写入工作区设置或 Webview 存储。

## 5. 导入论文

1. 把 PDF **直接拖进助手对话区**（任意位置），或点击 **+（Import PDF）** 选择文件。
2. 输入框上方出现 PDF 附件卡片，显示**真实准备进度**；点 `×` 可取消并移除。
3. 准备在本地完成：提取文本、建立段落/标题/图表标签锚点、记录精确高亮坐标，**不需要打开阅读器**。
   - 扫描版/纯图片 PDF 会自动检测，并用你配置的视觉模型做 OCR，生成可搜索、可点击的页级证据（需要视觉模型；失败会给出可重试的明确错误）。
4. 准备完成后，这篇论文对**本次对话的所有后续提问**持续可用。
5. 点击 **▤（Open paper）** 可随时打开内置 PDF 阅读器（PDF.js 本地打包）：
   - 工具栏缩放、恢复适应宽度；任何缩放下都可选中复制文本；
   - 在页面中选中一段文字，会出现 **询问这段** 按钮，把该段连同页码和选区坐标作为证据提问。

## 6. 第一次提问：论文 grounded 问答

在输入框输入问题，**Enter 发送，Shift+Enter 换行**。建议依次尝试：

1. **中文问英文论文**（无需任何额外配置）：
   > 这篇论文解决了什么问题？核心贡献有哪些？
2. **细节原理题**：
   > 缩放点积注意力为什么要除以 sqrt(d_k)？论文是怎么论证的？
3. **图表题**（需要视觉模型）：
   > 解释 Figure 1 的模型架构，编码器与解码器各有哪些子层？

观察要点：

- 回答前出现持续的 **Thinking** 状态与动画状态卡片：模型会像编码代理一样**多轮检索全文**（默认最多 8 轮搜索/阅读），而不是只看一次检索结果；
- 回答中的 **`[P1]` `[P2]`… 引用芯片可直接点击**：自动打开 PDF 并高亮对应原文区域；
- 选中回答中的任意文字，会出现浮动 **询问这段**，可带上下文追问；追问论文位置时会自动打开并高亮对应证据；
- 公式以 KaTeX 本地渲染（行内与独立公式均可）；
- 若某句回答缺少可靠证据，会显示简洁的来源提示，而不是伪造引用。

## 7. 代码互证：从论文跳到实现

1. 确认当前窗口打开的是代码仓库文件夹（第 3 节已打开），点击 **⌕（Scan code structure）** 扫描工作区符号（优先使用已安装的语言服务器，另有语法回退）。
2. 在编辑器中**选中一个函数或代码段**（例如 `model.py` 里的注意力实现），四种方式任选：
   - 选区上方自动出现的 CodeLens：**CodeChasing：询问或追踪这段代码**；
   - 编辑器标题栏的 💬 按钮；
   - 右键菜单中的同名命令；
   - 快捷键 **`Cmd+Alt+P`（macOS）/ `Ctrl+Alt+P`（其他平台）**。
3. 弹出两个选项：
   - **针对选中代码提问**：把代码附到输入框，然后自由输入问题，例如：
     > 这段代码对应论文中的哪个公式？掩码是在哪一步起作用的？
   - **追踪示例与张量形状**：自动沿用贯穿对话的具体样例，追踪它流经当前代码时的状态，输出"变量｜进入前形状｜操作｜离开后形状｜依据"表格（见第 9 节）。
4. 回答中的 **`[C1]` `[C2]`… 引用芯片可直接点击**：打开对应文件并选中精确行范围。
5. 不选中代码也可以直接问代码问题（显式代码问题会自动检索相关代码）：
   > 多头注意力在这个仓库里是怎么实现的？和论文第 3.2 节一致吗？

> 选中代码还会自动展开当前问题相关的调用方/被调用方，帮助回答跨函数的问题。

## 8. 引导式精读 ▶

点击 **▶（按流程讲解论文与代码）**，或命令面板执行 `CodeChasing: Explain Paper and Code from Start to Finish`：

- 短论文直接通读全文；长论文按有序、保证据的分批摘要处理；
- 然后连接到项目符号地图与关键实现，**用一个具体例子从头到尾贯穿**论文流程与代码；
- 耗时较长，全程显示 Thinking；适合评委完整观看"论文 → 代码"的端到端讲解。

## 9. 贯穿示例与张量形状 ◇

1. 在引导式精读或形状类提问之后，点击 **◇（View running example and tensor trace）** 查看结构化的贯穿示例。
2. 每一步都保留论文/代码证据锚点，可点击跳转；后续提问会**增量合并**新的张量阶段，不丢失早期锚点。
3. 形状传播是保守的符号推导，覆盖常见构造、reshape、permute、squeeze、flatten、concat/stack、归约、广播、插值、Linear、Conv、Embedding、einsum、矩阵乘等操作；数据依赖的维度会明确写成符号或假设，不伪装成事实。
4. 配合第 7 节的"追踪示例与张量形状"，可以逐函数查看形状变化表格。

## 10. 调用图 ⑂

点击 **⑂（Open project call graph）**：

- 静态调用图，支持**过滤与缩放**；节点可点击跳转到代码；
- 区分高置信调用与低置信的歧义引用，显示子图覆盖率与未解析调用数；
- 适合快速看清"论文中的模块在代码里如何互相调用"。

## 11. 论文 ↔ 代码映射 ↔

点击 **↔（Review paper-code mappings）**：

- 映射**只从本地共引证据学习**：当某句回答同时引用了有效论文锚点和代码锚点时，才形成候选边；
- 在面板中**确认或拒绝**候选映射；已确认的映射按工作区持久保存；
- 之后选中论文锚点或重叠代码范围时，可**双向精确查找**对应实现/出处，不依赖提问措辞；
- 代码内容或论文锚点变化后，旧映射自动标记为 stale 并从有效计数中排除。

## 12. 15 分钟体验路线

按顺序做完以下 10 步，即可覆盖全部核心能力：

1. 安装 vsix，打开代码仓库文件夹，把助手移到右侧（第 2–3 节）。
2. ⚙ 配置模型 → ✓ 测试连接（第 4 节）。
3. 拖入论文 PDF，等待准备完成（第 5 节）。
4. 问："这篇论文的核心贡献是什么？"——观察 Thinking 与多轮检索（第 6 节）。
5. 点击回答中的 `[P1]`——观察 PDF 自动打开并高亮原文（第 6 节）。
6. ⌕ 扫描代码 → 选中一个核心函数 → `Cmd/Ctrl+Alt+P` → 针对选中代码提问："它对应论文哪个公式？"（第 7 节）。
7. 点击回答中的 `[C1]`——观察跳转到精确代码行（第 7 节）。
8. ▶ 引导式精读，观看论文到代码的端到端讲解（第 8 节，耗时最长，可后台进行）。
9. ◇ 查看贯穿示例与张量形状；⑂ 打开调用图；↔ 查看已学到的论文 ↔ 代码映射（第 9–11 节）。
10. ◷ 打开历史会话并恢复——引用依然可点击；↻ 新建空白对话（第 13 节）。

## 13. 对话与请求控制

- **■ Stop**：生成中随时停止，保留已输出内容与问题；
- **Ctrl+C**：在输出开始前撤回本次请求（正在复制选中文本时除外）；
- **◷（Conversation history）**：恢复已保存对话，连同其论文关联与可点击引用；每个工作区最多保存 50 条；
- **↻（New chat）**：开始空白新对话（不附带论文）；VS Code 重新加载后也总是从空白对话开始；
- 长对话自动进行**历史压缩**：保留最近对话窗口，更早内容增量合并为摘要，避免上下文溢出；
- **ⓘ（Context status）**：查看当前论文/代码/模型上下文；**⋯（Manage indexes）**：管理、取消、重试、替换、移除、刷新论文/代码索引。

## 14. 可选设置（VS Code 设置中搜索 `codeChasing`）

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `maxEvidenceChunks` | 6（2–12） | 每次提问携带的论文证据块上限 |
| `rerankEvidence` | true | 回答前用模型对候选证据做 listwise 重排；关闭则仅用词法排序 |
| `maxExplorationRounds` | 8（1–20） | 回答前模型自主搜索/阅读的最大轮数 |
| `maxVisualPages` | 6（1–12） | 一次视觉提问/精读发送的页面图像上限 |
| `sendCodeByDefault` | false | 普通聊天是否默认检索仓库代码（显式代码问题与选中代码不受此限） |
| `confirmContextBeforeSend` | false | 每次发送前是否弹出上下文确认 |
| `maxRepositoryFiles` | 5000 | 初始符号扫描的文件上限（模型文本搜索仍可覆盖全部非依赖文件） |

**隐私边界**：PDF 提取、证据检索、符号扫描、行范围解析全部在本地；只把检索到的证据与显式选中的代码发送给模型；自主探索会排除 `.env*`、私钥、云凭据目录等敏感文件；不执行仓库代码、不上传整个仓库、不建云端索引。

## 15. 常见问题

| 现象 | 处理 |
| --- | --- |
| 发送后报连接/鉴权错误 | 用 ✓ 测试连接；核对协议、Base URL、模型名与 key；本地端点 key 可留空 |
| 扫描版 PDF 准备失败 | 需要支持图像输入的模型与网关；换视觉模型后在 ⋯ 中重试准备 |
| 图表类问题效果差 | 同上；并可适当调大 `maxVisualPages` |
| 显式推理档位报错 | 模型不支持该档位，切回 ◉ Auto |
| 引用被提示来源不足 | 这是证据审计在起作用：无法确认的引用会被移除或提示，而不是伪造 |
| OCR 高亮框不如文字版精确 | 已知边界：原生文本锚点最精确，OCR 框为模型辅助结果 |
| 想换一篇论文 | ⋯ 索引管理中替换/移除；每个工作区绑定 1 篇 PDF |
| 符号扫描不完整 | 安装对应语言扩展（如 Python）后重新 ⌕ 扫描 |

## 附录：命令面板速查（`Cmd/Ctrl+Shift+P`）

| 命令 | 作用 |
| --- | --- |
| `CodeChasing: Import Research Paper` | 导入 PDF |
| `CodeChasing: Open Current Paper` | 打开论文阅读器 |
| `CodeChasing: Ask About Paper and Code` | 打开助手提问 |
| `CodeChasing: Ask or Trace Selected Code` | 询问/追踪选中代码（`Cmd/Ctrl+Alt+P`） |
| `CodeChasing: Index Workspace Symbols` | 扫描工作区符号 |
| `CodeChasing: Open Project Call Graph` | 打开调用图 |
| `CodeChasing: Review Paper-Code Mappings` | 审阅论文 ↔ 代码映射 |
| `CodeChasing: View Running Example and Tensor Trace` | 查看贯穿示例与张量轨迹 |
| `CodeChasing: Configure Model Provider` | 配置模型 |
| `CodeChasing: Test Model Connection` | 测试连接 |
| `CodeChasing: Explain Paper and Code from Start to Finish` | 引导式精读 |
| `CodeChasing: Manage Paper and Code Indexes` | 管理索引 |
| `CodeChasing: Open Conversation History` | 打开历史会话 |
| `CodeChasing: Move Assistant to Right Side` | 移到右侧副侧栏 |

---

展示站点（功能概览与截图）：`https://codechasing-7g1tq161nl3.qoder.zone`
仓库与安装包：`https://github.com/Yikessa24/CodeChasing`