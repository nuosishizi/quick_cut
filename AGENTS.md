# 快剪系统核心架构与执行规范（永久不可篡改）

## 一、 达芬奇字幕同步严密执行流程：AutoSubs 宏 5 步时序闭环

在 `快剪.lua` 中将字幕写入达芬奇时间线时，必须严格按照以下 5 步顺序执行，绝不可颠倒或省略：

### 1. 严格裁剪时间线片段区间（set_clip_span）
- 必须首先通过 `set_clip_span(item, clip_start, clip_end, root)` 确保时间线上每个字幕片段的入点、出点和时长与音频语音毫秒级 1:1 对齐。

### 2. 深度同步真实文本到所有子节点（清除旧文本残留）
- 必须同时向 `AutoSubs`（Macro）、`Template`（TextPlus）和 `CharacterLevelStyling1` 写入当前字幕的真实文本：
  - `autosubsTool:SetInput("Text", plainText)`
  - `autosubsTool:SetInput("StyledText", plainText)`
  - `templateTool:SetInput("Text", plainText)`
  - `templateTool:SetInput("StyledText", plainText)`
  - `clsTool:SetInput("Text", plainText)`
  - `clsTool:SetInput("StyledText", plainText)`
- **严禁**留有任何母版自带的 `"Subtitle Example Text"` 残留！

### 3. 提前注入当前句精准单调递增 WordTiming
- 必须在执行样式注入前，将计算好的单调递增单词时间戳存入宏数据池：
  - `autosubsTool:SetData("WordTiming", wordTiming)`
- 保证后续内部动画引擎直接读取真实数据，避免基于旧例句计算关键帧。

### 4. 注入爆款视觉样式与 0 延迟配置
- 通过 `SetInputValues(comp, autosubsTool, presetSettings)` 一次性注入：
  - `FillColor`：黄色填充（#FFD200）；
  - `Outline`：纯黑描边（Thickness: 0.082，Round Join 模式）；
  - `HighlightColor`：聚焦高亮色；
  - `AnimationLevel = 0`, `AnimationLength = 0`：彻底清空字符位置延迟，保证整句全开。

### 5. 驱动内部高亮引擎生成关键帧
- 通过 `ApplyWordTiming(comp, autosubsTool, wordTiming)` 驱动生成每个单词精确起止帧的变色关键帧。

### 6. 整句背景必须写在 Text+ Element 5（禁止占用 AutoSubs 1–4）
- AutoSubs 通道占用：`1=Fill`、`2=Outline`、`3=Shadow`、`4=逐词高亮 Bubble`。
- `ApplyHighlight` 会在高亮样式不是 Bubble 时强制 `Enabled4 = 0`，因此整句背景绝不能写在 Element 4。
- 必须在第 5 步 `ApplyWordTiming` **之后**，对 `Template` 调用 `apply_quickcut_caption_look`。
- Fusion Text+ 整句底只能是 **Appearance=Border Fill（Type 1）+ Level=Text（0）**。Type 0 是字填充，Level 2 是逐词气泡。
- AutoSubs 母版 Follower 默认 Softness=1，且卡拉 OK 不能再开 Fade：Fade + Duration 0 + Mode Both 会把整段字淡出，看起来像半透明。
- 写底之前必须把 Template/Follower 的 Opacity1–5 断开 stretcher 并设为 1，Softness 归 0。
- **严禁**在 AutoSubs 成功路径上调用 `apply_style()` 去画背景（会覆盖描边与逐词高亮）。
- **严禁**把快剪预览背景映射成 AutoSubs 的 `BubbleEnabled` 当整句底用。`Bubble` 只服务于当前词高亮框。
- 发送任务的母版名是 `快剪字幕`。媒体池里若仍是 `AutoSubs Caption`，导入后必须改名为 `快剪字幕`，引擎仍走同一套宏 5 步。

---
## 二、 ASR 语音听写与文稿对齐铁律（严禁擅自过滤）

### 1. Deepgram Nova-3 强制保留完整卡壳与口吃（Disfluency Protection）
- 调用 Deepgram API 时，**必须永远携带 `url.searchParams.set("filler_words", "true")`**；
- **绝对禁止**让 Deepgram `smart_format` 自动过滤口吃、重复词、倒吸气短句或卡壳半句！所有发音必须 100% 完整带毫秒时间戳返回，交由快剪对齐引擎精准捕捉。

### 2. 重录与卡壳前缀识别（False Start / Repeat 宽幅重检）
- 前缀重检窗口必须覆盖至少 24 个词（`offset <= 24`）；
- 录音人若发生“卡壳读错若干词后，重新起句重录”（如 `Save this for the next time he's... Save this for the time He feels silent`），只要起句相同，**必须 100% 精准判定为【重复阅读 (repeat / confirmedCut)】**，绝不能误判为“口语补充”；
- AI 优化时必须**自动全轨道波纹切除第 1 遍废音频与废画面**，绝不能留下废音频在时间线上播放。

### 3. 口语补充完整显形（Zero Ghost Speech）
- 当录音人口播了文稿以外的内容时，顶部待处理轨道（红色/橙色）**必须完整呈现 Whisper / Deepgram 实际识别出的真实文字（`spokenText`）**，严禁显示为空白或“未识别出文字”；
- 允许用户一键转为绿字幕（`Ctrl+点击`）或一键切除（`Shift+点击`）。

### 4. 经文与神的话语绝对保护
- 经文只要有口语化或字句差异，一律 100% 标红锁定在顶部轨道，**严禁 AI 擅自自动切除**，必须由人工点击复核。

---
## 三、 时间线波纹切除（Ripple Cut）安全边界铁律

### 1. 严禁向后贪婪拉伸切除终点
- 切除红条或废音频时，剪切终点 `end` 必须严格锁定在该片段自身的结束时间，**绝对禁止**将 `end` 贪婪拉伸至下一句字幕；
- 必须强制设置下一句合法字幕前置安全防火墙：`end = Math.min(end, Math.max(start + 0.04, nextKept - 0.05))`。

### 2. 严禁误删后续合法字幕
- 后续所有正常字幕（如 `my family, my career, my`）受 100% 免疫保护，只跟随时间线向前波纹平移对齐，**绝对不可被波纹删除误吞**。

---
## 四、 渲染与音画导出铁律（Audio & Visual Sync）

### 1. 导出音频无缝时序拼接（消除重音叠加与回声）
- 多剪辑切片导出音频必须采用样本级 `concat=n=N:v=0:a=1` 顺序拼接；
- **绝对禁止**使用 `apad + amix` 暴力全长混音造成相邻切片毫秒级重叠与梳状回声重音；
- 混音 external audio 时显式添加 `:normalize=0`，保证动态不衰减。

### 2. 字幕背景贝塞尔圆角与胶囊药丸（Bezier Curves）
- ASS 绘图层必须使用三次贝塞尔曲线（`b x1 y1 x2 y2 x3 y3`，控制点 $k = r \times 0.55228475$）渲染真正的平滑圆角；
- 达芬奇与导出渲染中圆角参数（`Round`）必须支持达到 1.0 满级胶囊圆角，**绝对禁止**导出为生硬直角长方形。

---
## 五、 永久禁令与防退化原则：
1. 严禁颠倒达芬奇 AutoSubs 宏 5 步时序闭环；
2. 严禁关闭 Deepgram 的 `filler_words` 参数；
3. 严禁在 `cutScriptIssue` / `cutReviewSegment` 中添加破坏性的 `end = nextKept` 贪婪外扩；
4. 严禁破坏 ASS 贝塞尔圆角绘图与音频 `concat` 导出图架构；
5. 严禁用 AutoSubs Element 2 / Element 4 画整句字幕背景；整句底只能写在 Element 5，且必须在 ApplyWordTiming 之后。

