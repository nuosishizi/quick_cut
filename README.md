# 快剪 QuickCut

> 🎬 专为口播创作者与影视后期量身打造的 **AI 智能粗剪与录音棚级声学母带工作台**。

---

## 🌟 核心特性

- **✨ 录音棚人声母带净化（UVR5 架构）**：
  - 48kHz 全频神经网络深度去噪，彻底消除空调、风扇、键盘与电流底噪；
  - 2-Pole 次低频非稳态车流轰鸣过滤与去房间空旷回声（De-Reverb）；
  - 185Hz 暖音磁性 + 3.3kHz 通透穿透 + 高频空气感重塑 + 齿音柔化 + 防爆音限制器。
- **🚀 Meta Demucs 深度时域降噪**：
  - 支持 Alexandre Défossez 深度时域 Raw Waveform U-Net 去噪；
  - 支持全自动一键后台部署，界面实时显示进度条。
- **⏱️ 达芬奇式原地非破坏修剪（Zero-Fragmentation Ripple Trim）**：
  - 原地非破坏拖拽拉伸与切片边界安全防火墙，彻底杜绝碎片与误吞后段合法字幕；
  - 联动与非联动音视频轨道独立编辑点保护。
- **📝 智能文稿对齐与排版**：
  - 冒号引语、引号状态机跨词配对与悬挂全面修复；
  - 经文章节（如 `Jude 1:7`）、时间、货币、百分比作为不可拆分整体换行，严格遵守避头尾法则。
- **🎬 达芬奇 Resolve 5 步时序闭环**：
  - 原生支持 XML / TTML / FCPXML / ASS 导出及一键推送到达芬奇时间线。

---

## 📦 下载与安装

请前往 [Releases 页面](https://github.com/nuosishizi/quick_cut/releases) 下载最新版本：

| 系统平台 | 构建产物 | 运行说明 |
| :--- | :--- | :--- |
| **🪟 Windows (x64)** | `快剪-Windows-x.x.xx-测试包.zip` | 解压后双击 `启动快剪.bat` 即可开箱即用（内置便携 Node.js 22 + FFmpeg 8.0） |
| **🍎 macOS (Apple Silicon)** | `快剪-macOS-x.x.xx-测试包.zip` | 原生 arm64 架构，解压后双击 `启动快剪.command` 即可运行 |

---

## 🛡️ 软件来源与安全验证 (Artifact Attestation)

本软件的所有正式 Release 产物均由官方 GitHub Actions CI 自动化构建，并严格签署加密 **Artifact Attestation (SLSA Provenance)** 凭证。

下载安装包后，您可以使用 [GitHub CLI (`gh`)](https://cli.github.com/) 验证构建产物未被任何第三方篡改且确由官方 CI 产出：

```bash
# 验证 Windows 安装包
gh attestation verify ./快剪-Windows-2.7.41-测试包.zip --repo nuosishizi/quick_cut

# 验证 macOS 安装包
gh attestation verify ./快剪-macOS-2.7.41-测试包.zip --repo nuosishizi/quick_cut
```

> ✅ 验证成功即代表该文件 100% 由 GitHub Actions 官方编译机生成，数字签名与源码提交完全吻合。

---

## 🛠️ 本地开发与测试

### 1. 运行环境
- Node.js >= 20.0.0
- FFmpeg 6.0+

### 2. 启动开发服务器
```bash
cd Modules/EditorRuntime/editor-desktop
npm start
```

### 3. 运行全量自动化测试
```bash
cd Modules/EditorRuntime/editor-desktop
node --test tests/*.test.mjs
```

### 4. 本地打包发布
```powershell
# 打包 Windows 版本
powershell -ExecutionPolicy Bypass -File .\pack-windows.ps1

# 打包 macOS 版本
powershell -ExecutionPolicy Bypass -File .\pack-macos.ps1
```

---

## 📄 开源许可证

本项目基于 MIT 许可证开源。
