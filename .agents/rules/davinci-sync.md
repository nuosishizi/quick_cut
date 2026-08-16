# 达芬奇字幕同步严密执行流程与规范（永久不可篡改）

## 核心架构原则：AutoSubs 宏 5 步严密时序闭环

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

### 6. 整句背景走 快剪Text，不要占用 AutoSubs 1–4
- AutoSubs 通道占用：`1=Fill`、`2=Outline`、`3=Shadow`、`4=逐词高亮 Bubble`。Element 5 在 Template 上不存在。
- `ApplyHighlight` 会在高亮样式不是 Bubble 时强制 `Enabled4 = 0`，并在播放时改写 Template，所以整句底不能画在 AutoSubs Template 上。
- 快剪自己的母版和 AutoSubs 一样走媒体池：`caption-bin.drb` 里的生成器名叫 `快剪Text+`（普通 Fusion Title / Text+，不是 AutoSubs 宏）。铺条只用 `AppendToTimeline` + `recordFrame`。
- `快剪字幕.setting` 仍装到 Fusion Titles，只作备用。禁止把逐条 `InsertFusionTitleIntoTimeline` 当主路径。
- 字色 Element 1、描边 Element 2、整句底 Element 4（`Type4=1` Border Fill）。三者写在**同一个** Text+ 上。
- 逐词高亮必须走 `StyledTextCLS`（Text+ 的 Character Level Styling 修改器），关键帧 `SetKeyFrames(kf, true)`，每一帧写全句每个词的填充色（Index 0）。禁止 `AddTool("CharacterLevelStyling")`，那个工具 ID 不存在。
- 有 AutoSubs 宏的旧合成才另建 `快剪Text` 并断开宏。新母版不要导入 `caption-bin.drb`。
- AutoSubs 5 步只留给「没有快剪标题、也没有整句底」的旧回退。
- **严禁**在 AutoSubs 成功路径上调用 `apply_style()` 去画背景（会覆盖描边与逐词高亮）。
- **严禁**把快剪预览背景映射成 AutoSubs 的 `BubbleEnabled` 当整句底用。`Bubble` 只服务于当前词高亮框。
- **严禁**有底时改走逐条 `insert_title` 当主路径（默认 5 秒标题会互相挤压成碎条）。
- 发送任务的母版名是 `快剪字幕`。媒体池里若仍是 `AutoSubs Caption`，导入后必须改名为 `快剪字幕`，无底时引擎仍走同一套宏 5 步。

---
## 永久禁令：
1. 严禁颠倒第 2、3 步的时序（必须先写文本与 WordTiming，再调用 SetInputValues 与 ApplyWordTiming）；
2. 严禁改动 `to_word_timing` 的单调递增校准；
3. 严禁随意删除或破坏宏与 TextPlus 的数据绑定链；
4. 严禁用 AutoSubs Element 2 / Element 4 画整句字幕背景；整句底只写在独立的 `快剪Text` Element 4，词色只用 CLS 填充。
