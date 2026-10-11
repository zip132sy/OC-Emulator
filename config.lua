-- ============================================================
-- OC Emulator 配置文件
-- 修改此文件来调整模拟器配置
-- ============================================================
return {
  -- 内存大小 (字节)
  -- Tier 3.5 内存 = 384KB, 2条 = 768KB
  -- 可自定义: 例如 1024*1024 = 1MB
  ramSize = 768 * 1024,

  -- 硬盘大小 (字节)
  -- Tier 3 HDD = 4MB
  hddSize = 4096 * 1024,

  -- 屏幕分辨率 (Tier 3 GPU + Tier 3 Screen 最大值)
  screenWidth = 160,
  screenHeight = 50,

  -- GPU 等级 (1-3)
  gpuTier = 3,

  -- Screen 等级 (1-3)
  screenTier = 3,

  -- 默认启动的磁盘镜像 (相对于 disks/ 目录)
  defaultDisk = "openos.ocd",

  -- 磁盘镜像目录
  disksDir = "disks",

  -- 默认 EEPROM 文件 (相对于 disks/ 目录, 留空则使用磁盘内的 BIOS)
  defaultEEPROM = "",

  -- Lua 解释器路径
  luaExe = "lua",
}
