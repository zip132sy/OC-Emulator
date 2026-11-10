# OC Emulator

> 一个在本地运行的 **OpenComputers 模拟器**，附带浏览器 Web 控制面板。
> Node.js 负责进程、磁盘与网络，Lua 在本地运行 OpenOS（兼容 MineOS），前端用 Canvas 逐像素还原 OpenComputers 的屏幕渲染。

> ⚠️ **声明**：本项目由 **AI 制作**，仅供学习与交流使用。能力所限，难免有不足之处，**不喜勿喷**。
>
> 开源协议：[AGPL-3.0 or later](./LICENSE)

---

## 📦 仓库地址

| 平台 | 地址 | 说明 |
|------|------|------|
| GitHub | https://github.com/zip132sy/OC-Emulator | 主仓库，Issue 在此汇总 |
| Gitee | https://gitee.com/zip132sy/OC-Emulator | 国内镜像，代码与发布内容保持同步 |

两个仓库内容一致，按访问速度任选其一。启动脚本会在两者之间测速，并自动选择更快的更新源。

---

## 🧭 项目说明

OC Emulator 用一个独立的 Lua 进程模拟整台 OpenComputers 计算机：磁盘、屏幕、GPU、键盘、网卡、红石等都以组件形式暴露给系统，因此可以直接安装并运行真实的 OpenOS、MineOS、Plan9k 等系统，而不是脚本模拟的假界面。

主要能力：

- **真实 Lua 运行时**：每台虚拟机是独立进程，运行 `oc-emulator.lua` 内核，可安装 / 启动 OpenOS、MineOS、Plan9k 等系统。
- **Web 控制面板**：新建 / 导入 / 删除虚拟机，多标签页同时运行多台机器，VMware Workstation 风格界面。
- **磁盘编辑器**：可视化浏览、上传（带进度）、下载（带进度）、新建文件与文件夹；文件树支持右键菜单（打开、复制、剪切、粘贴、下载、新建、删除，文件夹连同内容一并删除）；支持镜像模式挂载宿主目录，支持新建、OpenOS 模板与导入磁盘。
- **软盘与磁盘**：软盘使用 `.ocf` 格式，磁盘使用 `.ocd` 格式。
- **位图字体渲染**：使用 GNU Unifont `.hex` 位图字体逐像素渲染，支持宽字符（中文）与调色板 16 色模式。
- **组件模拟**：GPU（Tier 分级、调色板与离屏缓冲 API）、Screen（Tier 分辨率）、键盘 / 鼠标（含精确模式）、文件系统、网卡、数据卡、EEPROM、Internet 代理等。
- **Mods 统一组件**：把 OpenComputers 的机器人（Robot）、无人机（Drone）、单片机（Microcontroller）合并为一个 `mods` 组件，提供完整的中文 API 映射与虚拟世界模拟，可像原版一样移动、挖掘、放置、管理物品栏与储罐。
- **Mods 设备面板**：左侧列表可在「虚拟机 / Mods」之间切换；计算机类设备是独立 VM，带 3D 坐标场景、物品 / 状态标签页与内置 EFI 启动日志，可通过 T1 / T2 无线网卡远程控制。
- **IC2 核电站**：机器类设备，通过红石 I/O 端口接入所选计算机，提供只读 `reactor_chamber`、`redstone` 与 `transposer` 组件，兼容 MineOS 的 IC2Reactors.app 与 reactor++.lua 这类程序。
- **系统信息联动**：读取宿主机内存占用与电量，映射给虚拟机内的 `computer.freeMemory()` / `computer.energy()`。
- **自动更新**：启动脚本可自动从 GitHub / Gitee 拉取最新版本（默认开启，可在设置中关闭）。
- **错误反馈**：前端出现异常时弹出错误面板，自动匹配常见错误并给出原因与解决步骤，支持一键复制完整错误信息。

Mods 的完整 API 映射、与原版的差异说明、API 快捷索引与调用示例见 [MODS.md](./MODS.md)（`Mods/` 文件夹格式、3D 标记点与无线协议也在其中）。

---

## 🧩 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+ | 启动脚本会在缺失时尝试自动安装 |
| Lua | 5.3 / 5.4 | 需在 PATH 中（`lua5.3` / `lua53` / `lua5.4` / `lua54` / `lua`）；缺失或版本过低时自动安装 Lua 5.3.6 |
| LuaFileSystem (lfs) | 可选 | 缺失时自动回退到 shell 命令，功能一致、性能略低 |
| npm 依赖 | `ws` | 首次启动自动安装 |

---

## 🚀 使用教程

### 1. Windows

下载后直接双击 `run.bat`。脚本会依次完成：

1. 检查 / 安装 Node.js；
2. 检查 npm 依赖与 Lua（缺失自动安装；需要 Lua 5.3 或 5.4）；
3. 校验强依赖文件，缺失时联网下载修复（GitHub 优先，Gitee 回退）；
4. 检查并拉取仓库更新（可在设置中关闭）；
5. 带看门狗启动服务器（崩溃 / 卡死自动重启，端口被占用自动切换）。

### 2. Linux / macOS

```bash
chmod +x run.sh
./run.sh
```

行为与 `run.bat` 一致。Android 上的 Termux 可参照这一方式，先安装 Node.js 与 Lua，再执行 `./run.sh`。

### 3. 打开控制面板

服务器启动后，浏览器访问：

```
http://127.0.0.1:8080
```

若 8080 被占用，服务器会自动切换到后续端口，实际地址会打印在启动日志中。

### 4. 新建并启动虚拟机

1. 点击 **New VM**；
2. 选择磁盘 1 / 磁盘 2 / 软盘 / EEPROM，以及屏幕与 GPU 等级；
3. 创建后在左侧列表中选择虚拟机，启动即可在画布中看到系统输出；
4. 磁盘可以选择 OpenOS 模板，也可以留空后自行安装系统。

右键虚拟机（手机端点击竖排三个点）可重命名、编辑磁盘、删除等。

### 5. 导入已有的虚拟机或磁盘

- **Import VM**：导入现有的虚拟机目录；
- **磁盘编辑器**：导入 `.ocd` / `.ocf` 镜像，或直接浏览、修改磁盘内容。

磁盘有多个时，「编辑磁盘」会先询问编辑哪一个，并可勾选「记住选项」；记住后右键菜单会多出「取消记住磁盘」。

### 6. 常用操作

- **⚙ Settings**：设置 Lua 路径、界面语言、日志级别、命令行窗口显示、滚轮兼容模式、自动更新开关、跳过完整性检测。
  日志级别为「完全 / 仅错误 / 关闭」，默认仅错误；「完全」会额外输出渲染帧统计、输入事件等调试信息。
- **Restart / Stop service**：从面板重启或停止后台服务。
- 标签页支持磁盘编辑器、控制台、Mods 设备视图并存，可拖动调整。

### 7. 手机 / 平板访问

服务默认只监听 `127.0.0.1`，同一局域网内的其他设备无法直接连接。需要手机访问时：

1. 关闭服务，编辑项目根目录的 `settings.json`，把 `"host"` 改为 `"0.0.0.0"`；
2. 重新启动服务，记下启动日志中打印的端口；
3. 在手机浏览器打开 `http://<电脑的局域网 IP>:<端口>`。

修改 host 会让同网段内的设备都能访问控制面板，仅在可信网络下这样做。

### 8. Mods 设备

控制面板左侧切到「Mods」列表：

- 点击「＋ New Mod」创建无人机 / 机器人 / 单片机 / 核电站 / 自定义机器；也可以把 Mod 文件夹放进项目根目录的 `Mods/` 后刷新。
- 计算机类设备（机器人 / 无人机 / 单片机）可切换 **3D 场景**、**物品 / 状态**、**控制台 / EFI** 三个标签页。
- 计算机类设备自动安装内置 EFI 与启动盘，不需要手动准备固件。
- 「⚙ 配置」可编辑 EFI 程序与硬件（APU / 内存 / 屏幕 / 扩展卡 / 无线强度），保存后可自动重启生效。
- 电脑使用扩展卡中的无线网卡（T1 / T2 均可）连接计算机类设备的 7777 端口即可远程控制。
- 自定义机器用 `machine.lua` 定义组件、属性、`tick`、只读方法与动作，保存后自动重启脚本。

核电站的组件 API、热量与冷却规则、红石通道含义见 [MODS.md](./MODS.md)。

---

## 📁 目录结构

```
OC-Emulator/
├── server.js                 # 主服务端入口 (HTTP + WebSocket, 端口探测, 静态资源)
├── oc-emulator.lua           # 核心 VM 运行时 (OpenComputers 组件 / 屏幕 / 事件模型)
├── mods.lua                  # Mods 统一组件 (机器人 / 无人机 / 单片机 + 虚拟世界)
├── mods-efi.lua              # Mods 设备的 EFI
├── machine-host.lua          # 自定义脚本机器的宿主 (加载 machine.lua 并执行 tick)
├── disk.lua                  # .ocd 磁盘格式读写模块
├── json.lua                  # Lua JSON 编解码
├── lua_check.lua             # Lua 环境检测脚本
├── package.json              # npm 配置（依赖: ws）
│
├── lib/                      # Node.js 服务端模块
│   ├── vmManager.js              # VM 进程管理（启动 / 暂停 / 重启 / 消息路由）
│   ├── diskIO.js                 # 磁盘 / 软盘 I/O（.ocd / .ocf）
│   ├── luaCheck.js               # Lua 解释器检测与缓存
│   ├── deviceBus.js              # 外部设备总线 (核电站 / 自定义机器以组件形式暴露给虚拟机)
│   ├── modemHub.js               # 网卡 / 调制解调器信号路由
│   ├── modsManager.js            # Mods 设备管理 (创建 / 启动 / 状态 / 无线桥接)
│   ├── machineHost.js            # 自定义脚本机器的 Lua 宿主进程管理
│   ├── reactor.js                # IC2 核电站网格 / 组件 / EU 与热量计算
│   ├── internetProxy.js          # Internet 组件 HTTP/HTTPS 代理
│   ├── floppyTemplates.js        # 软盘模板读取
│   ├── setupLua.js               # 跨平台 Lua 自动安装（下载 / 编译 / 包管理器）
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
│   ├── machineView.js            # 自定义机器的通用控制面板
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
├── LICENSE                   # AGPL-3.0 or later 许可协议
└── README.md                 # 本文件
```

---

## 🔄 自动更新

`run.bat` / `run.sh` 在启动服务器之前会检查远端仓库，若存在新提交则执行 `git pull`（仅本地为 git 仓库且能访问远端时生效）。

- 默认开启，无需配置。
- 首次启动会同时测速 GitHub 与 Gitee，选择更快的源并缓存到 `cache/update-source.json`；之后的启动直接复用该结果。
- 所有网络步骤都带超时：测速、拉取或依赖检查超时会跳过并继续启动，不会把服务器卡在启动阶段。
- 可在 **⚙ Settings → 自动更新** 中关闭；关闭后启动脚本不再执行任何拉取动作，完全离线运行。
- 可在 **⚙ Settings → 跳过完整性检测** 中关闭启动前的依赖文件检查；网络较慢或文件较多时建议开启。
- 点击 **⟳ 检查更新** 手动检查：结果在弹窗中展示并附带更新日志（发现新版本时显示本次更新内容，已是最新时显示当前版本更新日志）。
- 更新完成后会询问是否重启后端，不会自动重启（避免中断正在运行的虚拟机）。
- 在 **⚙ Settings → 版本回退** 中可选择回退到历史版本（同样由你确认是否重启后端）。

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

## 🐞 问题反馈

反馈分为两类，请按类型选择渠道。

### 一般问题：公开 Issue

功能异常、使用疑问、界面问题等，请提交到公开 Issue：

- GitHub：https://github.com/zip132sy/OC-Emulator/issues
- Gitee：https://gitee.com/zip132sy/OC-Emulator/issues

提交前请先搜索已有 Issue，避免重复。建议包含：

- 现象描述与复现步骤；
- 期望的行为；
- 错误面板中通过「复制错误信息」得到的完整内容；
- 下方「环境信息」中与问题相关的部分。

### 安全漏洞：必须私发

**凡是涉及安全的漏洞，一律不要发到公开 Issue、讨论区或群聊，请私发。**

安全漏洞指能让使用者突破模拟器边界、影响宿主机或其他用户的情况，例如：

- 虚拟机内程序越出沙箱，读写宿主机的任意文件或执行宿主命令；
- 通过磁盘、Mods 脚本、Internet 组件等途径绕过权限限制；
- 未授权访问控制面板或 WebSocket 接口，读写他人虚拟机；
- 远程代码执行、路径穿越、任意文件下载等。

私发渠道（任选其一）：

| 平台 | 方式 |
|------|------|
| GitHub | 仓库页 **Security → Advisories → Report a vulnerability**（仅维护者可见）；若该入口未开放，改用 Gitee 私信 |
| Gitee | 在 https://gitee.com/zip132sy 主页给作者发私信 |

私发时请说明漏洞类型、影响范围与复现方法。修复发布之前，请不要公开细节或利用代码。

### 安全报告需要附带的信息

为了让问题能复现，请一并提供 **系统** 与 **系统环境**：

| 项目 | 获取方式 / 示例 |
|------|-----------------|
| 操作系统与版本 | Windows 11 23H2 / Windows 10 22H2 / Ubuntu 24.04 / macOS 14 / Termux（附版本） |
| 运行方式 | 本地 `run.bat`、`run.sh`、还是手动 `node server.js` |
| Node.js 版本 | `node -v` |
| Lua 解释器 | 实际使用的路径与 `lua -v` 输出（或设置面板中显示的 Lua 路径） |
| 浏览器与版本 | 若与前端有关则提供，例如 Chrome 131 / Edge 131 / 手机浏览器型号 |
| 项目版本 | `git log -1 --format=%h` 或控制面板显示的版本 |
| 虚拟机系统 | OpenOS / MineOS / Plan9k 及大致版本 |
| 复现步骤 | 从启动服务到触发问题的完整步骤，越具体越好 |
| 相关日志 | 错误面板复制出的内容、服务端命令行输出、`logs/guardian.log` |
| 最小样本 | 若依赖特定磁盘或脚本，可提供脱敏后的最小镜像 |

私发前请先做基本脱敏：去掉日志与路径中的用户名、内网 IP、令牌等信息，不要附带个人数据。

---

## 📄 开源协议

本项目采用 [AGPL-3.0 or later](./LICENSE)（GNU Affero 通用公共许可证第 3 版或任意更新版本）许可协议：可自由使用、修改与分发，修改后的版本需以相同协议开放源代码；若通过网络向用户提供服务，需向这些用户提供对应的源代码。转发或二次开发时请保留原项目名称、作者署名与仓库链接。

> 本项目由 **AI 制作**，仅供学习与交流使用；如有不足之处，**不喜勿喷**。
