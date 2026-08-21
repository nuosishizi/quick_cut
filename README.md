# 快剪 QuickCut

> 🎬 专为口播创作者与影视后期打造的 **AI 智能粗剪与专业多级人声降噪工作台**。

---

## 🌟 核心特性

- **✨ 专业多级人声降噪**：
  - 自动检测 50/60 Hz 电流嗡声并对基频与谐波执行 De-Hum；
  - 依次处理风噪/低频轰鸣、飞机/空调等持续环境声、RNNoise 神经人声净化、蛐蛐等高频残留；
  - 最后通过温和二次清理、EQ、人声清晰度、齿音控制和限幅完成修复，全部阶段均可独立调节。
- **🚀 可选本地 AI 引擎**：
  - 检测到真实 DeepFilterNet 或 Demucs 可执行程序时可使用；
  - 未安装外部引擎时明确使用内置 RNNoise/频谱稳定链，不伪装安装状态。
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

请前往 [Releases 页面](https://github.com/secure-artifacts/quick_cut/releases) 下载最新安装包：

| 系统平台 | 安装包类型 | 运行说明 |
| :--- | :--- | :--- |
| **🪟 Windows (x64)** | `QuickCut-Windows-x.x.xx-Setup.exe` | **推荐**：一键安装程序，自动生成桌面图标与开始菜单，双击直接运行 |
| **🍎 macOS (Apple Silicon)** | `QuickCut-macOS-x.x.xx-Installer.dmg` | **推荐**：macOS 原生 DMG 镜像，双击打开后拖拽 `快剪.app` 到应用程序即可使用 |
| **🪟 Windows (绿色便携版)** | `QuickCut-Windows-x.x.xx-Portable.zip` | 免安装便携版，解压后双击 `快剪.exe` 或 `启动快剪.bat` 运行 |
| **🍎 macOS (开发测试版)** | `QuickCut-macOS-x.x.xx-Portable.zip` | 包含完整 Xcode 工程源码与测试脚本 |

> 🍎 **macOS 首次打开提示「已损坏或不完整」？**
> 由于本项目为开源免费软件，未购买 Apple 年费商业证书，macOS Gatekeeper 会对从浏览器下载的应用施加安全隔离限制。
> **解决方法（二选一）：**
> 1. 打开 DMG 后，双击运行里面的「**首次打开如果提示已损坏点我.command**」一键解除限制；
> 2. 或在终端运行一行命令解除隔离：`sudo xattr -rd com.apple.quarantine /Applications/快剪.app`。

---

## 🛡️ 软件来源与安全验证 (Artifact Attestation)

本软件的所有正式 Release 安装包均由官方 GitHub Actions CI 自动化构建，并严格签署加密 **Artifact Attestation (SLSA Provenance)** 凭证。

下载安装包后，您可以使用 [GitHub CLI (`gh`)](https://cli.github.com/) 验证安装包未被任何第三方篡改且确由官方 CI 产出：

```bash
# Windows
gh attestation verify ./QuickCut-Windows-2.7.47-Setup.exe --repo secure-artifacts/quick_cut

# macOS
gh attestation verify ./QuickCut-macOS-2.7.47-Installer.dmg --repo secure-artifacts/quick_cut
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
