# dsh-vision-edge-doubao

DSH（DeepSeek Harness）视觉插件：通过 **Edge + 豆包网页版** 给纯文本 DeepSeek 模型提供识图能力。

- **零成本**：复用浏览器登录态，无需 API Key
- **数学建模图专项**（`mode=math`）：几何图形 / 流程图 / 数据图表 / 表格 / 公式 的深度结构化识别
- **澄清闭环**：识别出不确定项时输出 `clarify` 问题，模型可向用户提问后带补充信息重识别
- **通用识图**：`mode=glance|ocr|region|compare`，`detail=auto|fast|standard|deep`

---

## 架构

```
vision 工具（DSH 插件 host）
   │  队列 :9340（submit/pending/result/job/cancel）
   ▼
bridge-edge.mjs（Windows 桥接，轮询队列）
   │  CDP（:9333）
   ▼
Edge 调试实例（独立 profile ~/.vision-edge-profile，豆包登录态持久保存）
   │
   ▼
豆包网页版识图 → 回复文本回传
```

| 组件 | 说明 |
|---|---|
| `lib/index.js` | 插件 host：vision 工具注册、附件/本地图读取、缓存、evidence 记录 |
| `lib/prompt.js` | 提示词构造（v4）+ 回复解析（fallback/JSON/clarify 提取） |
| `lib/queue.js` | 本地队列服务（懒启动，首次识图才监听 :9340） |
| `bridge-edge.mjs` | Edge 桥接：发图 → 输入提示词 → 发送 → 提取回复 |
| `start-vision-edge.ps1` | 一键启动（Edge 调试实例 + 桥接 + 验证） |

---

## 快速开始

```powershell
# 1. 启动环境（Edge 调试实例 + 桥接，幂等可重复执行）
powershell -ExecutionPolicy Bypass -File C:\Users\icebe\dsh-vision-edge-doubao\start-vision-edge.ps1

# 2. 首次使用时在弹窗的 Edge 窗口登录一次豆包（登录态保存在独立 profile，之后不用再登）

# 3. 重启 dsh web 使插件加载（若尚未加载）
#    终端 Ctrl+C → npx @deepseek-ai/dsh web → 刷新页面
```

插件加载后，模型会话中自动出现 `vision` 工具（无需手动安装）。

---

## 用法

### 模型侧（DSH 会话内）
模型看到图片附件时自动调用 vision 工具；用户也可直接要求"看图/识别图片"。

### 关键参数
| 参数 | 取值 | 说明 |
|---|---|---|
| `mode` | `glance` / `ocr` / `region` / `compare` / `math` | math=数学建模图专项（几何/流程图/图表/表格/公式） |
| `detail` | `auto` / `fast` / `standard` / `deep` | auto 自动升级：识别为复杂图时自动用 deep 再查一遍 |
| `channel` | `auto` / `web` | 固定豆包 Web 通道 |
| `prompt` | 用户原话 | 完整传入；可附带用户补充信息（澄清闭环） |

### clarify 澄清闭环
1. 豆包识别后输出「需要向用户确认的问题」（最多 3 个，仅影响结论的关键不确定点）
2. 插件提取为工具返回的 `clarify` 字段
3. 模型看到非空 `clarify` → 用 `ask_user_question` 向用户提问
4. 用户回答 → 模型把补充信息带进新 prompt 重新调 vision → 精确识别

---

## 常见问题与排查（实测经验）

> 💡 **队列 :9340 未监听是正常现象**：队列是懒启动设计（首次识图任务才监听）。
> 启动脚本里"队列不可达"的提示在空闲状态下会误报，不影响使用；只要识图时能工作就正常。

### 1. 识别超时 / 返回错误内容
- **Edge 被关闭或重启过**：页面回到 `/chat/`（无会话 ID），旧桥接连不上 → 重新运行 `start-vision-edge.ps1`（自动拉起 Edge 调试实例与桥接）
- **豆包人机验证**：偶发拦截，等待后重试即可（非插件问题）
- **桥接日志不可见**：脚本启动的桥接日志在隐藏窗口。排查时用前台方式：
  ```powershell
  cd C:\Users\icebe\dsh-vision-edge-doubao
  node bridge-edge.mjs   # 前台运行，日志可见；另开终端操作
  ```

### 2. 回复提取的原理与注意事项（虚拟滚动）
- 豆包消息列表是**虚拟滚动**：只渲染视口附近行，必须**滚动到底部**才能看到新消息/回复（桥接已自动处理）
- 提取策略：发送前记录最后一行 → 等新内容出现（≠发送前）→ 等稳定（连续 2 次相同）→ 返回
- 用户消息（任务提示词）特征：「你是视觉识别专家」/「用户要求：」——桥接会跳过，避免把用户消息当回复

### 3. 缓存说明
- 相同图片 + 相同 prompt + 相同参数命中缓存（会话持久缓存 + 内存 LRU）
- 需要重测时**换一个提问方式**即可绕过缓存
- 修改提示词后请**递增 `lib/prompt.js` 的 `VISION_PROMPT_VERSION`**（缓存键组成部分），并**重启 dsh web**（插件 host 的 ESM 模块缓存）

### 4. 豆包输出格式相关的防御（已内建）
| 问题 | 处理 |
|---|---|
| markdown 表格渲染丢失内容 | 提示词强制"不要使用表格，用列表"（v3+） |
| 回复被拆成多个 DOM 分段/字符碎片换行 | 提取时合并碎片再解析 |
| 豆包先写"无"再列澄清问题 | 提取时剔除"无"前缀 |
| 长回复流式未完成 | 稳定判断（连续 2 次相同） |

### 5. 修改代码后生效
- `lib/*.js`（host 侧）：**重启 dsh web** 生效
- `bridge-edge.mjs`：**重启桥接**生效（kill 进程后重跑）
- 语法检查：`node --check <file>`

### 6. 卸载
```powershell
dsh plugin --profile web remove dsh-vision-edge-doubao
```

---

## 文件地图

```
dsh-vision-edge-doubao/
├── lib/
│   ├── index.js      # host：工具注册、缓存、evidence
│   ├── prompt.js     # 提示词 v4、回复解析、clarify 提取
│   └── queue.js      # 队列 :9340（懒启动）
├── bridge-edge.mjs   # Edge 桥接
├── start-vision-edge.ps1  # 一键启动
├── cordis.patch.yml  # DSH bundle 注册（id: vision-edge-doubao）
└── package.json      # 插件清单（main: lib/index.js）
```

---

## 版本历史

| 版本 | 变更 |
|---|---|
| v0.1.0 | 首个可用版本：Edge 桥接 + math 专项 + clarify 闭环 |
| 提示词 v4 | 澄清节（需要向用户确认的问题）、禁表格、回答优先 |
