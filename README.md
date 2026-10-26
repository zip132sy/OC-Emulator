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
- **Mods 统一组件**：把 OpenComputers 的机器人（Robot）、无人机（Drone）、单片机（Microcontroller）合并为一个 `mods` 组件，提供完整的中文 API 映射与虚拟世界模拟，可像原版一样移动、挖掘、放置、管理物品栏与储罐。
- **Mods 设备面板**：左侧列表可在「虚拟机 / Mods」之间切换；计算机类设备（机器人 / 无人机 / 单片机）是独立 VM，带 3D 坐标场景、物品/状态标签页、内置 EFI 启动日志，并可通过 T1/T2 无线网卡远程控制。
- **IC2 核电站**：核电站是机器类设备，不跑程序也没有 EFI/硬盘，通过红石 I/O 端口接入所选计算机，并提供一个只读 `reactor_chamber` 组件与一个 `redstone` 控制组件（兼容 MineOS IC2Reactors.app）。配置中使用 IC2 原版风格的灰色反应堆 GUI，燃料棒分铀/MOX 与单联/双联/四联，冷却单元分 10k/30k/60k，冷凝模块分 20k/100k；可调整 3~9 列大小，实时查看 EU/t、热量、吸热容量与安全时间。设备页用 2D 反应堆面板逐格显示组件等级、脉冲、产电、发热、吸热与生效状态。
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
- **⚙ Settings**：设置 Lua 路径、界面语言、日志级别、命令行窗口显示、滚轮兼容模式、**自动更新开关**、**跳过完整性检测**。
  日志级别为「完全 / 仅错误 / 关闭」，默认仅错误；「完全」会额外输出虚拟机渲染帧统计、输入事件等调试信息。
- **Restart / Stop service**：从面板重启或停止后台服务。

### Mods 统一组件与 Mods 设备

每台虚拟机默认带一个 `mods` 组件（机器人 / 无人机 / 单片机三合一），在系统里直接使用：

```lua
local mods = require("mods")
print(mods.getVersion())
print(mods.help())          -- 查看完整的 OC 原版 API 映射
```

控制面板左侧新增「Mods」列表：

- 点击「＋ New Mod」创建无人机 / 机器人 / 单片机 / 核电站；也可以把 Mod 文件夹放进项目根目录的 `Mods/` 后点刷新。
- 计算机类设备（机器人 / 无人机 / 单片机）可切换 **3D 场景**、**物品 / 状态**、**控制台 / EFI** 三个标签页。
- 3D 场景显示坐标轴、网格、设备位置、目标点、朝向、速度与 `mod.json` 中配置的标记点。
- 计算机类设备自动安装内置 EFI 和启动盘，不需要手动准备固件。
- 「⚙ 配置」对计算机类设备可编辑 EFI 程序和硬件（APU / 内存 / 屏幕 / 扩展卡 / 无线强度），保存后可自动重启生效。
- 机器人和无人机各有专属配置页：机器人可设置主手 / 副手工具、物品栏格数与内部储罐；无人机可设置最大速度、加速度与物品栏格数。
- 电脑使用扩展卡中的无线网卡（T1 / T2 均可）连接计算机类设备的 7777 端口即可远程控制；双击工具栏中的无线地址即可复制。
- 核电站是机器类设备：没有 EFI / 硬盘，只有 **☢ 反应堆** 与 **物品 / 状态** 两个页签；面板与顶部工具栏都提供启动 / 停止。点击「连接到虚拟机」选择一台虚拟机后，它通过**红石 I/O 端口**接到那台计算机，同时提供一个只读的 `reactor_chamber` 组件（兼容 MineOS 的 IC2Reactors.app）。控制与遥测示例：

  ```lua
  local component = require("component")
  local chamber = component.reactor_chamber
  local redstone = component.redstone
  print(chamber.getHeat(), chamber.getMaxHeat(), chamber.getReactorEUOutput())
  redstone.setOutput(3, 15) -- 任意通道均可：> 0 启动，0 停止
  ```

完整的映射表、Mods 文件夹格式、3D 标记点与无线协议见 [MODS.md](./MODS.md)。

---

## 📁 目录结构

```
OC-Emulator/
├── server.js                 # 主服务端入口 (HTTP + WebSocket, 端口探测, 静态资源)
├── oc-emulator.lua           # 核心 VM 运行时 (OpenComputers 组件 / 屏幕 / 事件模型)
├── mods.lua                  # Mods 统一组件 (机器人 / 无人机 / 单片机 + 虚拟世界)
├── mods-efi.lua              # Mods 设备内置 EFI 模板
├── disk.lua                  # .ocd 磁盘格式读写模块
├── json.lua                  # Lua JSON 编解码
├── lua_check.lua             # Lua 环境检测脚本
├── package.json              # npm 配置（依赖: ws）
│
├── lib/                      # Node.js 服务端模块
│   ├── vmManager.js              # VM 进程管理（启动 / 暂停 / 重启 / 消息路由）
│   ├── diskIO.js                 # 磁盘 / 软盘 I/O（.ocd / .ocf）
│   ├── luaCheck.js               # Lua 解释器检测与缓存
│   ├── deviceBus.js              # 外部设备总线 (核电站等以组件形式暴露给虚拟机)
│   ├── modemHub.js               # 网卡 / 调制解调器信号路由
│   ├── modsManager.js            # Mods 设备管理 (创建 / 启动 / 状态 / 无线桥接)
│   ├── reactor.js                # IC2 核电站网格 / 组件 / EU 与热量计算
│   ├── internetProxy.js          # Internet 组件 HTTP/HTTPS 代理
│   ├── floppyTemplates.js        # 软盘模板读取
│   ├── setupLua.js               # 跨平台 Lua 5.3 自动安装
│   ├── sysInfo.js                # 宿主机内存 / 电量采集
│   ├── crypto-helper.js          # 数据卡加解密桥接
│   ├── ensureDeps.js             # 启动前依赖检查（npm 依赖 + Lua）
│   ├── repair.js                 # 依赖文件缺失时的联网修复
│   └── gen-checksums.js          # 生成 / 校验 SHA256SUMS
│
├── web/                      # 浏览器前端（控制面板）
│   ├── index.html                # 页面骨架与脚本入口
│   ├── styles.css                # 样式
│   ├── app.js                    # 主应用：VM 列表 / WebSocket / 标签页 / 设置
│   ├── console.js                # 屏幕渲染（位图字体 / 脏更新 / 输入事件 / 滚轮兼容）
│   ├── modView.js                # Mods 设备视图（3D 场景 / 物品状态 / EFI 控制台）
│   ├── reactorView.js            # IC2 核电站配置 GUI
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
├── Mods/                     # Mods 设备数据 (运行时自动生成, 不入库)
│   └── <名称>/                   # mod.json / config.json / efi.lua / disk.ocd
│
├── run.bat                   # Windows 启动脚本（看门狗 + 自动更新）
├── run.sh                    # Linux / macOS 启动脚本（看门狗 + 自动更新）
├── SHA256SUMS                # 各文件的 SHA-256 清单（用于校验下载是否完整）
├── MODS.md                   # Mods 统一组件说明与完整 API 映射
├── .gitignore                # 忽略规则
├── LICENSE                   # MIT 开源协议
└── README.md                 # 本文件
```

---

## 🔄 自动更新

`run.bat` / `run.sh` 在启动服务器之前会自动检查远端仓库，若存在新提交则执行 `git pull` 拉取更新（仅本地为 git 仓库且能访问远端时生效）。

- **默认开启**，无需配置。
- 首次启动会同时测速 GitHub 与 Gitee，选择更快的源并缓存到 `cache/update-source.json`；之后的启动直接复用该结果。
- 所有网络步骤都带超时：测速、拉取或依赖检查超时会跳过并继续启动，不会把服务器卡在启动阶段。
- 可在控制面板 **⚙ Settings → 自动更新** 中关闭；关闭后启动脚本不再执行任何拉取动作，完全离线运行。
- 可在 **⚙ Settings → 跳过完整性检测** 中关闭启动前的依赖文件检查；网络较慢或文件较多时建议开启。
- 点击 **⟳ 检查更新** 手动检查：结果在弹窗中展示并附带更新日志（发现新版本时显示本次更新内容，已是最新时显示当前版本更新日志）。
- 更新完成后会询问是否重启后端，不会自动重启（避免中断正在运行的虚拟机）。
- 在 **⚙ Settings → 版本回退** 中可选择回退到历史版本（回退同样由你确认是否重启后端）。

---

## 🔐 文件校验

仓库根目录的 `SHA256SUMS` 记录了每个文件的 SHA-256，可用来确认下载是否完整、内容是否被改动。

**校验**（在仓库根目录执行其一即可）：

```bash
# Linux / macOS
sha256sum -c SHA256SUMS

# Windows：在 Git Bash 中执行同一条命令（Git 自带 sha256sum）
sha256sum -c SHA256SUMS
```

或者用仓库自带脚本校验：

```bash
node lib/gen-checksums.js --check
```

全部显示 `OK`（脚本输出「不一致 0, 缺失 0」）即为通过。若出现 `FAILED` / `不一致`，说明对应文件损坏或被改动，建议重新克隆仓库。

**重新生成**（修改过仓库文件后需要更新清单，否则校验会失败）：

```bash
node lib/gen-checksums.js
```

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
