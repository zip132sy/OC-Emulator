# OC Emulator

> 一个在本地运行的 **OpenComputers 模拟器**，配套一套浏览器 Web 控制面板。
> 用 Node.js 负责进程 / 磁盘 / 网络，用 Lua 在本地运行 OpenOS (兼容MineOS) 系统，前端用 Canvas 逐像素还原 OpenComputers 的屏幕渲染。

- GitHub：https://github.com/zip132sy/OC-Emulator
- Gitee：https://gitee.com/zip132sy/OC-Emulator

> ⚠️ **声明**：本项目由 **AI 制作**，仅供学习与交流使用。能力所限，难免有不足之处，**不喜勿喷**。
>
> 开源协议：[MIT](./LICENSE)

---

## ✨ 功能特性

- **真实 Lua 运行时**：每个虚拟机是独立进程，运行真正的 `oc-emulator.lua` 内核，可安装 / 启动 OpenOS、MineOS、Plan9k 等系统。
- **Web 控制面板**：新建 / 导入 / 删除虚拟机，多标签页同时运行多台机器，VMware Workstation 风格界面。
- **磁盘编辑器**：可视化浏览 / 上传 / 新建文件与文件夹，支持镜像模式挂载宿主目录，支持新建、OpenOS 模板、导入磁盘。
- **软盘与磁盘**：磁盘为 `.ocd` 格式，软盘为独立的 `.ocf` 格式；软盘模板从官方 loot 目录同步。
- **位图字体渲染**：使用 GNU Unifont `.hex` 位图字体逐像素渲染，支持宽字符（中文）与调色板 16 色模式。
- **组件模拟**：GPU（含 Tier 分级与调色板）、Screen（Tier 分辨率）、键盘 / 鼠标（含精确模式）、文件系统、网卡、数据卡、EEPROM、Internet 代理等。
- **系统信息联动**：读取宿主机的内存占用与电量，映射给虚拟机内的 `computer.freeMemory()` / `computer.energy()`。
- **自动更新**：启动脚本可自动从 GitHub / Gitee 拉取最新版本（默认开启，可在设置中关闭）。
- **错误反馈**：前端出现异常时会弹出错误面板，支持一键复制错误信息并跳转 GitHub / Gitee 提交 Issue。

---

## 🧩 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+ | 启动脚本会在缺失时尝试自动安装 |
| Lua | 5.3（固定版本） | 需在 PATH 中（`lua5.3` / `lua53` / `lua`）；缺失或版本不符时自动安装 Lua 5.3.6 |
| LuaFileSystem (lfs) | 可选 | 缺失时自动回退到 shell 命令，功能一致、性能略低 |
| npm 依赖 | `ws` | 首次启动自动安装 |

---

## 🚀 使用方法

### Windows

下载后直接双击 `run.bat`。脚本会自动完成：

1. 检查 / 安装 Node.js；
2. 检查 npm 依赖与 Lua（缺失自动安装；Lua 固定为 5.3.x）；
3. 校验强依赖文件，缺失时**联网下载修复**（GitHub 优先，Gitee 回退）；
4. **检查并拉取仓库更新**（可在设置中关闭）；
5. 带看门狗启动服务器（崩溃 / 卡死自动重启，端口被占用自动切换）。

### Linux / macOS

```bash
chmod +x run.sh
./run.sh
```

行为与 `run.bat` 一致。

### 打开控制面板

服务器启动后，浏览器访问：

```
http://127.0.0.1:8080
```

若 8080 被占用，服务器会自动切换到后续端口，启动日志中会打印实际地址。

### 控制面板常用操作

- **New VM**：新建虚拟机，选择磁盘 1 / 磁盘 2 / 软盘 / EEPROM / 屏幕与 GPU 等级。
- **Import VM / 磁盘编辑器**：导入现有磁盘镜像，或直接编辑磁盘内容。
- **⚙ Settings**：设置 Lua 路径、界面语言、日志级别、命令行窗口显示、滚轮兼容模式、**自动更新开关**。
- **Restart / Stop service**：从面板重启或停止后台服务。

---

## 📁 目录结构

```
OC-Emulator/
├── server.js                 # 主服务端入口 (HTTP + WebSocket, 端口探测, 静态资源)
├── oc-emulator.lua           # 核心 VM 运行时 (OpenComputers 组件 / 屏幕 / 事件模型)
├── disk.lua                  # .ocd 磁盘格式读写模块
├── json.lua                  # Lua JSON 编解码
├── lua_check.lua             # Lua 环境检测脚本
├── package.json              # npm 配置（依赖: ws）
│
├── lib/                      # Node.js 服务端模块
│   ├── vmManager.js              # VM 进程管理（启动 / 暂停 / 重启 / 消息路由）
│   ├── diskIO.js                 # 磁盘 / 软盘 I/O（.ocd / .ocf）
│   ├── luaCheck.js               # Lua 解释器检测与缓存
│   ├── modemHub.js               # 网卡 / 调制解调器信号路由
│   ├── internetProxy.js          # Internet 组件 HTTP/HTTPS 代理
│   ├── floppyTemplates.js        # 软盘模板读取
│   ├── setupLua.js               # 跨平台 Lua 5.3 自动安装
│   ├── sysInfo.js                # 宿主机内存 / 电量采集
│   ├── crypto-helper.js          # 数据卡加解密桥接
│   ├── ensureDeps.js             # 启动前依赖检查（npm 依赖 + Lua）
│   └── repair.js                 # 依赖文件缺失时的联网修复
│
├── web/                      # 浏览器前端（控制面板）
│   ├── index.html                # 页面骨架与脚本入口
│   ├── styles.css                # 样式
│   ├── app.js                    # 主应用：VM 列表 / WebSocket / 标签页 / 设置
│   ├── console.js                # 屏幕渲染（位图字体 / 脏更新 / 输入事件 / 滚轮兼容）
│   ├── diskEditor.js             # 磁盘编辑器
│   ├── wizard.js                 # 新建虚拟机向导
│   ├── exportWizard.js           # 导入 / 导出向导
│   ├── i18n.js                   # 中英文文案
│   ├── errorReporter.js          # 全局错误捕获（复制 + 反馈链接）
│   └── fonts/
│       ├── font.hex              # GNU Unifont 位图字体（屏幕渲染用）
│       └── unifont.ttf           # Unifont TTF（面板 UI 用）
│
├── disks/                    # 磁盘模板
│   └── openos.ocd                # OpenOS 模板磁盘
│
├── run.bat                   # Windows 启动脚本（看门狗 + 自动更新）
├── run.sh                    # Linux / macOS 启动脚本（看门狗 + 自动更新）
├── .gitignore                # 忽略规则
├── LICENSE                   # MIT 开源协议
└── README.md                 # 本文件
```

---

## 🔄 自动更新

`run.bat` / `run.sh` 在启动服务器之前会自动检查远端仓库，若存在新提交则执行 `git pull` 拉取更新（仅本地为 git 仓库且能访问远端时生效）。

- **默认开启**，无需配置。
- 可在控制面板 **⚙ Settings → 自动更新** 中关闭；关闭后启动脚本不再执行任何拉取动作，完全离线运行。
- 点击 **⟳ 检查更新** 手动检查：结果在弹窗中展示并附带更新日志（发现新版本时显示本次更新内容，已是最新时显示当前版本更新日志）。
- 更新完成后会询问是否重启后端，不会自动重启（避免中断正在运行的虚拟机）。
- 在 **⚙ Settings → 版本回退** 中可选择回退到历史版本（回退同样由你确认是否重启后端）。

---

## 🐞 遇到问题时

- 前端出现异常时会在页面右下角弹出**错误面板**，显示错误摘要与调用栈。
- 面板提供：
  - **复制错误信息**：一键把完整错误写入剪贴板；
  - **反馈链接**：直接跳转 GitHub / Gitee 的 Issue 提交页。
- 请把复制到的信息粘贴到 Issue 中，并简单描述复现步骤，方便定位。

反馈入口：

- GitHub Issues：https://github.com/zip132sy/OC-Emulator/issues
- Gitee Issues：https://gitee.com/zip132sy/OC-Emulator/issues

---

## 📄 开源协议

本项目采用 [MIT](./LICENSE) 协议开源，可自由使用、修改与分发。

> 本项目由 **AI 制作**，仅供学习与交流使用；如有不足之处，**不喜勿喷**。
