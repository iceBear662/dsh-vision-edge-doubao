# dsh-vision-edge-doubao

**"带上她的眼睛"**

大肥鱼：终于找到眼睛捐赠者了，豆包，会是谁呢？

豆包：恭喜啊！

————手术很成功————

DSH（DeepSeek Harness）视觉插件：通过 **Edge + 豆包网页版** 给纯文本 DeepSeek 模型提供识图能力。

起因是我在做数学建模题目时，发现 Deepseek 模型的识图能力不太理想，于是在插件市场尝试了几个识图插件，发现现有的插件大多依赖于 Chrome + Gemini，使用起来有些麻烦，所以用大 D 老师写了一个自己用着方便的插件。由于是第一次尝试，还有很多不足，但已勉强能用，也有一些亮点：

- 🧮 **数学建模图专项**（`mode=math`）：几何图形 / 流程图 / 数据图表 / 表格 / 公式 的深度结构化识别
- 💬 **澄清闭环**：识别有不确定项时，插件会列出问题问你，你回答后重新识别更精确
- 🖼 **通用识图**：照片、截图、OCR 文字识别、区域细查、多图对比
- 🔁 **免维护登录**：豆包登录态保存在独立浏览器配置里，一次登录长期使用
- 💰 **零成本**：复用浏览器登录态，无需 API Key

---

## 环境要求

- Windows（需要 Edge浏览器）
- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI
- Node.js ≥ 18（桥接组件需要）

---

## 安装

### 方式一：从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:iceBear662/dsh-vision-edge-doubao
```

### 方式二：从 npm 安装

```sh
dsh plugin --profile web add dsh-vision-edge-doubao
```

### 方式三：tarball 安装

```sh
dsh plugin --profile web add ./dsh-vision-edge-doubao-0.1.0.tgz
```

> 安装后重启 `dsh web` 生效（插件在启动时加载）。

---

## 首次使用配置（只需一次）

### 1. 运行一键启动脚本

```powershell
powershell -ExecutionPolicy Bypass -File <插件目录>\start-vision-edge.ps1
```

脚本会自动完成：启动 Edge 调试实例（独立配置，不影响你日常浏览器）→ 启动豆包桥接 → 验证环境。

> GitHub/npm 安装后脚本在 `node_modules\dsh-vision-edge-doubao\start-vision-edge.ps1`。

### 2. 登录豆包（仅首次）

在弹出的 Edge 窗口里打开 [doubao.com](https://www.doubao.com)，扫码或手机号登录一次。
登录态保存在独立配置中，之后重启电脑也不用再登。

### 3. 开始使用

在 DSH 会话里直接发图片给模型，或说"看看这张图"即可——模型会自动调用 vision 工具。

---

## 使用说明

### 数学建模图专项（`mode=math`）

对数学建模竞赛常见的图做了专项优化，识别时会按图型输出结构化要点：

| 图型 | 识别内容 |
|---|---|
| 几何图形 | 形状、顶点字母及方位、实线/虚线分类、辅助线、角度标记、坐标系 |
| 流程图 | 节点类型与文字、分支条件、循环结构、层级关系 |
| 数据图表 | 图表类型、坐标轴/刻度、趋势与极值、关键数值、图例 |
| 表格 | 行列结构、表头、全部数值、异常值 |
| 公式 | LaTeX 转录（分数/根号/上下标/求和等） |

### 澄清闭环（不确定项提问）

识别遇到看不清或影响结论的点时，插件会在结果中返回 `clarify` 问题，模型会主动问你（如"点 D 是否为 BC 的中点？"），你回答后它会带着补充信息重新识别，得到更精确的结果。

### 参数速查

- `mode`：`glance`（通用）/ `ocr`（文字转录）/ `region`（区域细查）/ `compare`（多图对比）/ `math`（数学建模专项）
- `detail`：`auto`（自动）/ `fast` / `standard` / `deep`（auto 会自动升级复杂图）

---

## 常见问题

| 问题 | 解决 |
|---|---|
| 识别超时 | 多半是 Edge 被关闭过：重新运行 `start-vision-edge.ps1` 即可恢复 |
| 偶发失败 | 豆包偶发人机验证，稍等重试即可 |
| 相同图片返回相同结果 | 插件有缓存（省流量），换一种问法即可重新识别 |
| 想重装/卸载 | `dsh plugin --profile web remove dsh-vision-edge-doubao` |

---

## 许可证

[MIT](./LICENSE)
