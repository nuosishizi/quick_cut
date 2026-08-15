# 达芬奇字幕同步规范与核心架构原则

## 核心原则：100% 必须使用原生 TextPlus + CharacterLevelStyling

1. **严禁使用 AutoSubs MacroOperator 或第三方宏封装**：
   - AutoSubs 宏包含内部修改器（如 Follower1、DelaySpline）以及 SetInputValues、UpdateHighlight 等 Lua 回调脚本。
   - 在达芬奇时间线播放、刷新或导出时，宏内部脚本会反复强制执行，覆盖快剪设置的样式（导致黄色变成白字、黑色描边变成青色/细边）并引入字符累加延迟（导致单词高亮滞后、卡在词间）。
   
2. **标准实现方案**：
   - **节点类型**：官方内置纯净 TextPlus 节点，直接连接 MediaOut1.Input。
   - **文字样式**：
     - Element 1（主文字填充）：纯黄 #FFD200 或用户指定色；
     - Element 2（外部描边）：纯黑 #000000，Thickness: 0.082（Round Join 模式）；
     - Element 3 / Element 4：立体投影与背景色块（按需）。
   - **逐字高亮**：
     - 通过 templateTool.StyledText:AddModifier("CharacterLevelStyling", "CharacterLevelStyling") 挂载字符级样式修改器；
     - 挂载 BezierSpline 曲线并在每个单词的精确起始帧将 [startIndex, endIndex] 切换为高亮色（白色/亮青色），在词尾复原或交接给下一词；
     - 杜绝任何第三方 Follower 延时干扰，确保 60fps 实时流畅与字字咬合。
