# Mods 统一组件（Robot / Drone / Microcontroller）

> 本文档对应 `mods.lua`（v1.0.0），由 `oc-emulator.lua` 在启动时加载并注册为 `mods` 组件。

---

## 1. 这是什么

OpenComputers 原版把移动自动化拆成了三个组件：

- `robot`：机器人，按格子移动、挖掘、放置、管理物品栏与储罐。
- `drone`：无人机，按三维偏移飞行，带速度/加速度/状态文本。
- `microcontroller`：单片机，提供启动/停止/方向开放/最近错误等控制接口。

本项目把三者**合并为一个 `mods` 组件**：共用同一份设备状态（位置、朝向、物品栏、工具、储罐、灯光、能量），
同名同义的 API 只实现一次；`robot.move(direction)` 与 `drone.move(dx,dy,dz)` 通过**参数个数重载**共存。

三种访问方式完全等价：

```lua
local mods = require("mods")      -- 推荐
-- 也可以直接使用全局 mods
-- 也可以用 component.mods / component.proxy(component.list("mods")())
print(mods.getVersion())
```

Mods 默认对每台虚拟机启用。若要关闭，在对应 `vms/<名称>/config.json` 的 `hardware` 中加入：

```json
"mods": false
```

关闭后 `component.list("mods")` 与 `require("mods")` 都不会提供该组件。

---

## 2. 快速开始

```lua
local mods = require("mods")

print(mods.name(), mods.getVersion())      -- Mods  1.0.0

-- 在正前方放一块石头，再尝试移动
mods.world.setBlock(0, 0, 1, "stone")
print(mods.detect(3))                      -- true  solid
print(mods.move(3))                        -- nil   impossible move: blocked by stone
mods.world.removeBlock(0, 0, 1)
print(mods.move(3))                        -- true

-- 物品栏 / 放置 / 挖掘
mods.give("stone", 64)
print(mods.place(3))                       -- true
print(mods.compare(3))                     -- true
print(mods.swing(3))                       -- true  block_activated

-- 机器人高层写法
print(mods.robot.forward())
print(mods.robot.turnRight())

-- 查看全部映射（可直接 print）
print(mods.help())
```

---

## 3. 设计说明与差异

### 3.1 `move` 重载

| 调用 | 含义 |
|------|------|
| `mods.move(direction)` | 机器人按 side 编号移动一格（0=下 1=上 2=后 3=前 4=右 5=左） |
| `mods.move(dx, dy, dz)` | 无人机设置目标偏移，按速度/加速度飞行 |
| `mods.robot.move(direction)` | 同机器人 |
| `mods.drone.move(dx, dy, dz)` | 同无人机 |

### 3.2 side 编号

| 编号 | 名称 | 别名 |
|------|------|------|
| 0 | bottom | down / negy |
| 1 | top | up / posy |
| 2 | back | north / negz |
| 3 | front | south / posz / forward |
| 4 | right | west / negx |
| 5 | left | east / posx |

所有接受 side 的接口同时接受数字或上述字符串，例如 `mods.detect("front")`。

### 3.3 共用状态

`mods.robot`、`mods.drone`、`mods.mcu` 只是同一设备的三个视图：

- 位置、朝向、物品栏、选中格、工具、储罐、灯光、能量全部共享。
- `mods.mcu.stop()` 之后，移动/挖掘/放置/丢弃/吸取/流体等**动作类 API** 会返回 `nil, "microcontroller is stopped"`；查询类 API 仍可用。
- `mods.mcu.start()` 恢复运行并清除 `lastError`。

### 3.4 与真实 OC 的差异

- 模拟器没有 Minecraft 世界，因此内置虚拟世界 `mods.world`。方块、液体、容器、实体、掉落物都由脚本创建。
- 机器人移动不做重力/飞行高度限制，只检查目标格是否被实体或实心方块阻挡，以及是否超出世界边界（默认 ±256）。
- `detect` 统一采用机器人语义：`air` / `solid` / `liquid` / `replaceable` / `passable` / `entity`。真实 OC 中无人机对可穿过方块也返回 `true`，这里不区分设备。
- `swing` 不检查方块硬度与工具等级；装备工具时每次消耗 1 点耐久。
- 物品栏固定 16 格，没有工具腰带。外部 `getInventory(side)` 在左/右侧返回空表。
- 流体采用简化模型：默认 1000mB 容量，储罐默认容量 16000mB。
- 世界与设备状态**不跨 VM 重启持久化**。
- 无人机飞行进度依赖 `os.clock()`（VM 的 CPU 时间），查询 `getOffset()`/`getVelocity()` 时会自动推进。

### 3.5 机器人高层 API 的参数含义

`mods.robot.*` 采用 OpenOS `require("robot")` 的直觉写法：

- `detect/compare/place/swing/use/drop/suck` 默认作用在**正前方**。
- `placeUp/dropDown/...` 作用在正上/正下方。
- `place/swing/use` 的第一个参数是**作用面**，不是机器人侧。
- 对应地，扁平 `mods.place(side, face, sneaky)` / `mods.swing(side, face, sneaky)` 采用**组件语义**：第一个参数是机器人侧。

---

## 4. 完整 API 映射表

表中“原版 API”指 OpenComputers 的组件/高层 API，“Mods 目标”是等价的 `mods` 调用。

### 4.1 机器人组件 (component robot)

| 原版 API | 参数签名 | Mods 目标 | 扁平别名 | 说明 |
|----------|----------|-----------|----------|------|
| `robot.durability()` | - | `mods.durability` | `mods.robot_durability` | 返回工具耐久度比例、剩余耐久、最大耐久；无工具时返回 nil 与原因。 |
| `robot.move(direction)` | `direction:number` | `mods.move` | `mods.robot_move` | 按 side 编号移动；0=下 1=上 2=后 3=前 4=右 5=左。与无人机 move 通过参数个数重载共存。 |
| `robot.turn(clockwise)` | `clockwise:boolean` | `mods.turn` | `mods.robot_turn` | true 顺时针、false 逆时针转向。 |
| `robot.name()` | - | `mods.name` | `mods.robot_name` | 返回设备名称（可通过 setName 修改）。 |
| `robot.swing(side[,face[,sneaky]])` | `side:number` | `mods.swing` | `mods.robot_swing` | 左键挖掘/攻击指定方向；成功返回 true 与结果描述。 |
| `robot.use(side[,face[,sneaky[,duration]]])` | `side:number` | `mods.use` | `mods.robot_use` | 右键使用物品；成功返回 true 与结果描述。 |
| `robot.place(side[,face[,sneaky]])` | `side:number` | `mods.place` | `mods.robot_place` | 把选中格物品放到指定方向。 |
| `robot.placeInInventory(side[,sneaky])` | `side:number` | `mods.placeInInventory` | `mods.robot_placeInInventory` | 把选中格物品放入相邻容器。 |
| `robot.getLightColor()` | - | `mods.getLightColor` | `mods.robot_getLightColor` | 读取灯光颜色（0xRRGGBB）。 |
| `robot.setLightColor(value)` | `value:number` | `mods.setLightColor` | `mods.robot_setLightColor` | 设置灯光颜色（0xRRGGBB）。 |
| `robot.inventorySize()` | - | `mods.inventorySize` | `mods.robot_inventorySize` | 内部物品栏格数。 |
| `robot.select([slot])` | `slot:number` | `mods.select` | `mods.robot_select` | 读取或切换当前选中格。 |
| `robot.count([slot])` | `slot:number` | `mods.count` | `mods.robot_count` | 指定格（默认选中格）的物品数量。 |
| `robot.space([slot])` | `slot:number` | `mods.space` | `mods.robot_space` | 指定格剩余空间。 |
| `robot.compareTo(otherSlot[,checkNBT])` | `otherSlot:number` | `mods.compareTo` | `mods.robot_compareTo` | 比较选中格与目标格的物品。 |
| `robot.transferTo(toSlot[,amount])` | `toSlot:number` | `mods.transferTo` | `mods.robot_transferTo` | 把选中格物品转移到目标格。 |
| `robot.tankCount()` | - | `mods.tankCount` | `mods.robot_tankCount` | 储罐数量。 |
| `robot.selectTank([tank])` | `tank:number` | `mods.selectTank` | `mods.robot_selectTank` | 读取或切换当前储罐。 |
| `robot.tankLevel([tank])` | `tank:number` | `mods.tankLevel` | `mods.robot_tankLevel` | 储罐液位。 |
| `robot.tankSpace([tank])` | `tank:number` | `mods.tankSpace` | `mods.robot_tankSpace` | 储罐剩余容量。 |
| `robot.compareFluidTo(tank)` | `tank:number` | `mods.compareFluidTo` | `mods.robot_compareFluidTo` | 比较选中储罐与指定储罐的液体。 |
| `robot.transferFluidTo(tank[,count])` | `tank:number` | `mods.transferFluidTo` | `mods.robot_transferFluidTo` | 把选中储罐液体转移到指定储罐。 |
| `robot.detect(side)` | `side:number` | `mods.detect` | `mods.robot_detect` | 检测相邻方块/实体，返回是否阻挡与类型（air/solid/liquid/replaceable/passable/entity）。 |
| `robot.compareFluid(side[,tank])` | `side:number` | `mods.compareFluid` | `mods.robot_compareFluid` | 比较相邻液体与选中储罐。 |
| `robot.drain(side[,amount])` | `side:number` | `mods.drain` | `mods.robot_drain` | 从相邻方块/储罐抽取液体到选中储罐。 |
| `robot.fill(side[,amount])` | `side:number` | `mods.fill` | `mods.robot_fill` | 把选中储罐液体注入相邻方块/储罐。 |
| `robot.compare(side[,fuzzy])` | `side:number` | `mods.compare` | `mods.robot_compare` | 比较相邻方块与选中物品。 |
| `robot.drop(side[,count])` | `side:number` | `mods.drop` | `mods.robot_drop` | 把选中格物品丢到指定方向或容器；默认方向为前。 |
| `robot.suck(side[,count])` | `side:number` | `mods.suck` | `mods.robot_suck` | 从指定方向吸取掉落物或容器物品。 |

### 4.2 无人机组件 (component drone)

| 原版 API | 参数签名 | Mods 目标 | 扁平别名 | 说明 |
|----------|----------|-----------|----------|------|
| `drone.getStatusText()` | - | `mods.getStatusText` | `mods.drone_getStatusText` | 读取无人机状态文本。 |
| `drone.setStatusText(value)` | `value:string` | `mods.setStatusText` | `mods.drone_setStatusText` | 设置无人机状态文本。 |
| `drone.move(dx,dy,dz)` | `dx,dy,dz:number` | `mods.move` | `mods.drone_move` | 设置无人机目标偏移；三个数字参数触发无人机形态。 |
| `drone.getOffset()` | - | `mods.getOffset` | `mods.drone_getOffset` | 当前位置到目标位置的距离。 |
| `drone.getVelocity()` | - | `mods.getVelocity` | `mods.drone_getVelocity` | 当前速度（格/秒）。 |
| `drone.getMaxVelocity()` | - | `mods.getMaxVelocity` | `mods.drone_getMaxVelocity` | 最大速度。 |
| `drone.getAcceleration()` | - | `mods.getAcceleration` | `mods.drone_getAcceleration` | 当前加速度。 |
| `drone.setAcceleration(value)` | `value:number` | `mods.setAcceleration` | `mods.drone_setAcceleration` | 设置加速度并返回新值。 |
| `drone.name()` | - | `mods.name` | `mods.drone_name` | 返回设备名称。 |
| `drone.swing(side[,face[,sneaky]])` | `side:number` | `mods.swing` | `mods.drone_swing` | 与机器人 swing 共用实现。 |
| `drone.use(side[,face[,sneaky[,duration]]])` | `side:number` | `mods.use` | `mods.drone_use` | 与机器人 use 共用实现。 |
| `drone.place(side[,face[,sneaky]])` | `side:number` | `mods.place` | `mods.drone_place` | 与机器人 place 共用实现。 |
| `drone.placeInInventory(side[,sneaky])` | `side:number` | `mods.placeInInventory` | `mods.drone_placeInInventory` | 与机器人 placeInInventory 共用实现。 |
| `drone.getLightColor()` | - | `mods.getLightColor` | `mods.drone_getLightColor` | 与机器人 getLightColor 共用实现。 |
| `drone.setLightColor(value)` | `value:number` | `mods.setLightColor` | `mods.drone_setLightColor` | 与机器人 setLightColor 共用实现。 |
| `drone.inventorySize()` | - | `mods.inventorySize` | `mods.drone_inventorySize` | 与机器人 inventorySize 共用实现。 |
| `drone.select([slot])` | `slot:number` | `mods.select` | `mods.drone_select` | 与机器人 select 共用实现。 |
| `drone.count([slot])` | `slot:number` | `mods.count` | `mods.drone_count` | 与机器人 count 共用实现。 |
| `drone.space([slot])` | `slot:number` | `mods.space` | `mods.drone_space` | 与机器人 space 共用实现。 |
| `drone.compareTo(otherSlot[,checkNBT])` | `otherSlot:number` | `mods.compareTo` | `mods.drone_compareTo` | 与机器人 compareTo 共用实现。 |
| `drone.transferTo(toSlot[,amount])` | `toSlot:number` | `mods.transferTo` | `mods.drone_transferTo` | 与机器人 transferTo 共用实现。 |
| `drone.tankCount()` | - | `mods.tankCount` | `mods.drone_tankCount` | 与机器人 tankCount 共用实现。 |
| `drone.selectTank([tank])` | `tank:number` | `mods.selectTank` | `mods.drone_selectTank` | 与机器人 selectTank 共用实现。 |
| `drone.tankLevel([tank])` | `tank:number` | `mods.tankLevel` | `mods.drone_tankLevel` | 与机器人 tankLevel 共用实现。 |
| `drone.tankSpace([tank])` | `tank:number` | `mods.tankSpace` | `mods.drone_tankSpace` | 与机器人 tankSpace 共用实现。 |
| `drone.compareFluidTo(tank)` | `tank:number` | `mods.compareFluidTo` | `mods.drone_compareFluidTo` | 与机器人 compareFluidTo 共用实现。 |
| `drone.transferFluidTo(tank[,count])` | `tank:number` | `mods.transferFluidTo` | `mods.drone_transferFluidTo` | 与机器人 transferFluidTo 共用实现。 |
| `drone.detect(side)` | `side:number` | `mods.detect` | `mods.drone_detect` | 与机器人 detect 共用实现。 |
| `drone.compareFluid(side[,tank])` | `side:number` | `mods.compareFluid` | `mods.drone_compareFluid` | 与机器人 compareFluid 共用实现。 |
| `drone.drain(side[,amount])` | `side:number` | `mods.drain` | `mods.drone_drain` | 与机器人 drain 共用实现。 |
| `drone.fill(side[,amount])` | `side:number` | `mods.fill` | `mods.drone_fill` | 与机器人 fill 共用实现。 |
| `drone.compare(side[,fuzzy])` | `side:number` | `mods.compare` | `mods.drone_compare` | 与机器人 compare 共用实现。 |
| `drone.drop(side[,count])` | `side:number` | `mods.drop` | `mods.drone_drop` | 与机器人 drop 共用实现。 |
| `drone.suck(side[,count])` | `side:number` | `mods.suck` | `mods.drone_suck` | 与机器人 suck 共用实现。 |

### 4.3 单片机组件 (component microcontroller)

| 原版 API | 参数签名 | Mods 目标 | 扁平别名 | 说明 |
|----------|----------|-----------|----------|------|
| `microcontroller.setSideOpen(side,open)` | `side:number, open:boolean` | `mods.setSideOpen` | `mods.mcu_setSideOpen` | 设置指定方向是否开放（状态记录）。 |
| `microcontroller.start()` | - | `mods.start` | `mods.mcu_start` | 启动设备；状态改变时返回 true。 |
| `microcontroller.isRunning()` | - | `mods.isRunning` | `mods.mcu_isRunning` | 设备是否处于运行状态。 |
| `microcontroller.isSideOpen(side)` | `side:number` | `mods.isSideOpen` | `mods.mcu_isSideOpen` | 查询指定方向是否开放。 |
| `microcontroller.lastError()` | - | `mods.lastError` | `mods.mcu_lastError` | 最近一次上报的错误（可由 reportError 写入，VM 崩溃时自动记录）。 |
| `microcontroller.stop()` | - | `mods.stop` | `mods.mcu_stop` | 停止设备；停止后动作类 API 返回 microcontroller is stopped。 |

### 4.4 机器人高层 API (require("robot") 风格)

| 原版 API | 参数签名 | Mods 目标 | 扁平别名 | 说明 |
|----------|----------|-----------|----------|------|
| `robot.forward()` | - | `mods.robot.forward` | `modsforward` | 向前移动一格。 |
| `robot.back()` | - | `mods.robot.back` | `modsback` | 向后移动一格。 |
| `robot.up()` | - | `mods.robot.up` | `modsup` | 向上移动一格。 |
| `robot.down()` | - | `mods.robot.down` | `modsdown` | 向下移动一格。 |
| `robot.turnLeft()` | - | `mods.robot.turnLeft` | `modsturnLeft` | 左转 90 度。 |
| `robot.turnRight()` | - | `mods.robot.turnRight` | `modsturnRight` | 右转 90 度。 |
| `robot.detect()` | - | `mods.robot.detect` | `modsdetect` | 检测正前方。 |
| `robot.detectUp()` | - | `mods.robot.detectUp` | `modsdetectUp` | 检测正上方。 |
| `robot.detectDown()` | - | `mods.robot.detectDown` | `modsdetectDown` | 检测正下方。 |
| `robot.compare()` | - | `mods.robot.compare` | `modscompare` | 比较正前方方块与选中物品。 |
| `robot.compareUp()` | - | `mods.robot.compareUp` | `modscompareUp` | 比较正上方方块与选中物品。 |
| `robot.compareDown()` | - | `mods.robot.compareDown` | `modscompareDown` | 比较正下方方块与选中物品。 |
| `robot.drop([count])` | `count:number` | `mods.robot.drop` | `modsdrop` | 把选中格物品丢到正前方。 |
| `robot.dropUp([count])` | `count:number` | `mods.robot.dropUp` | `modsdropUp` | 丢到正上方。 |
| `robot.dropDown([count])` | `count:number` | `mods.robot.dropDown` | `modsdropDown` | 丢到正下方。 |
| `robot.suck([count])` | `count:number` | `mods.robot.suck` | `modssuck` | 从正前方吸取物品。 |
| `robot.suckUp([count])` | `count:number` | `mods.robot.suckUp` | `modssuckUp` | 从正上方吸取物品。 |
| `robot.suckDown([count])` | `count:number` | `mods.robot.suckDown` | `modssuckDown` | 从正下方吸取物品。 |
| `robot.place([side[,sneaky]])` | `side:number` | `mods.robot.place` | `modsplace` | 把选中物品放到正前方；side 是放置面。 |
| `robot.placeUp([side[,sneaky]])` | `side:number` | `mods.robot.placeUp` | `modsplaceUp` | 放到正上方。 |
| `robot.placeDown([side[,sneaky]])` | `side:number` | `mods.robot.placeDown` | `modsplaceDown` | 放到正下方。 |
| `robot.swing([side[,sneaky]])` | `side:number` | `mods.robot.swing` | `modsswing` | 挖掘正前方；side 是作用面。 |
| `robot.swingUp([side[,sneaky]])` | `side:number` | `mods.robot.swingUp` | `modsswingUp` | 挖掘正上方。 |
| `robot.swingDown([side[,sneaky]])` | `side:number` | `mods.robot.swingDown` | `modsswingDown` | 挖掘正下方。 |
| `robot.use([side[,sneaky]])` | `side:number` | `mods.robot.use` | `modsuse` | 使用正前方；side 是作用面。 |
| `robot.useUp([side[,sneaky]])` | `side:number` | `mods.robot.useUp` | `modsuseUp` | 使用正上方。 |
| `robot.useDown([side[,sneaky]])` | `side:number` | `mods.robot.useDown` | `modsuseDown` | 使用正下方。 |
| `robot.equip(name[,maxDurability])` | `name:string` | `mods.robot.equip` | `modsequip` | 装备工具（扩展）。 |
| `robot.unequip()` | - | `mods.robot.unequip` | `modsunequip` | 卸下工具（扩展）。 |

### 4.5 Mods 扩展 API

| 原版 API | 参数签名 | Mods 目标 | 扁平别名 | 说明 |
|----------|----------|-----------|----------|------|
| `mods.getVersion()` | - | `mods.getVersion()` | - | - |
| `mods.getType()` | - | `mods.getType()` | - | - |
| `mods.getDeviceType()` | - | `mods.getDeviceType()` | - | - |
| `mods.setDeviceType(type)` | - | `mods.setDeviceType(type)` | - | - |
| `mods.setClock(fn)` | - | `mods.setClock(fn)` | - | - |
| `mods.getPosition()` | - | `mods.getPosition()` | - | - |
| `mods.setPosition(x,y,z)` | - | `mods.setPosition(x,y,z)` | - | - |
| `mods.getFacing()` | - | `mods.getFacing()` | - | - |
| `mods.give(name[,count[,meta]])` | - | `mods.give(name[,count[,meta]])` | - | - |
| `mods.take(name[,count])` | - | `mods.take(name[,count])` | - | - |
| `mods.clearInventory()` | - | `mods.clearInventory()` | - | - |
| `mods.getInventory([side])` | - | `mods.getInventory([side])` | - | - |
| `mods.equip(name[,maxDurability])` | - | `mods.equip(name[,maxDurability])` | - | - |
| `mods.unequip()` | - | `mods.unequip()` | - | - |
| `mods.getEquipped()` | - | `mods.getEquipped()` | - | - |
| `mods.equipOffhand(name[,maxDurability])` | - | `mods.equipOffhand(name[,maxDurability])` | - | 副手工具 |
| `mods.unequipOffhand()` | - | `mods.unequipOffhand()` | - | 卸下副手工具 |
| `mods.getOffhand()` | - | `mods.getOffhand()` | - | 副手工具名称与耐久 |
| `mods.getProfile()` | - | `mods.getProfile()` | - | 控制面板里的设备专属参数 |
| `mods.setProfile(profile)` | - | `mods.setProfile(profile)` | - | 套用设备专属参数 |
| `mods.addTank([capacity])` | - | `mods.addTank([capacity])` | - | - |
| `mods.getTank([tank])` | - | `mods.getTank([tank])` | - | - |
| `mods.setTank([tank],fluid,amount)` | - | `mods.setTank([tank],fluid,amount)` | - | - |
| `mods.tankCapacity([tank])` | - | `mods.tankCapacity([tank])` | - | - |
| `mods.getState()` | - | `mods.getState()` | - | - |
| `mods.getInfo()` | - | `mods.getInfo()` | - | - |
| `mods.reset([keepWorld])` | - | `mods.reset([keepWorld])` | - | - |
| `mods.reportError(message)` | - | `mods.reportError(message)` | - | - |
| `mods.getEnergy()` | - | `mods.getEnergy()` | - | - |
| `mods.setEnergy(value)` | - | `mods.setEnergy(value)` | - | - |
| `mods.world.setLimit(n)` | - | `mods.world.setLimit(n)` | - | - |
| `mods.world.setBlock(x,y,z,name[,meta])` | - | `mods.world.setBlock(x,y,z,name[,meta])` | - | - |
| `mods.world.getBlock(x,y,z)` | - | `mods.world.getBlock(x,y,z)` | - | - |
| `mods.world.removeBlock(x,y,z)` | - | `mods.world.removeBlock(x,y,z)` | - | - |
| `mods.world.setFluid(x,y,z,fluid[,amount[,capacity]])` | - | `mods.world.setFluid(x,y,z,fluid[,amount[,capacity]])` | - | - |
| `mods.world.getFluid(x,y,z)` | - | `mods.world.getFluid(x,y,z)` | - | - |
| `mods.world.setChest(x,y,z[,size])` | - | `mods.world.setChest(x,y,z[,size])` | - | - |
| `mods.world.getChest(x,y,z)` | - | `mods.world.getChest(x,y,z)` | - | - |
| `mods.world.addItem(x,y,z,name[,count[,meta]])` | - | `mods.world.addItem(x,y,z,name[,count[,meta]])` | - | - |
| `mods.world.getItems(x,y,z)` | - | `mods.world.getItems(x,y,z)` | - | - |
| `mods.world.addEntity(x,y,z[,name])` | - | `mods.world.addEntity(x,y,z[,name])` | - | - |
| `mods.world.removeEntity(x,y,z)` | - | `mods.world.removeEntity(x,y,z)` | - | - |
| `mods.world.clear()` | - | `mods.world.clear()` | - | - |
| `mods.world.stats()` | - | `mods.world.stats()` | - | - |
| `mods.world.dump()` | - | `mods.world.dump()` | - | - |
| `mods.setBlock(...)` | - | `mods.setBlock(...)` | - | - |
| `mods.getBlock(...)` | - | `mods.getBlock(...)` | - | - |
| `mods.removeBlock(...)` | - | `mods.removeBlock(...)` | - | - |
| `mods.clearWorld()` | - | `mods.clearWorld()` | - | - |
| `mods.getStatusText()` | - | `mods.getStatusText()` | - | - |
| `mods.setStatusText(value)` | - | `mods.setStatusText(value)` | - | - |
| `mods.getLightColor()` | - | `mods.getLightColor()` | - | - |
| `mods.setLightColor(value)` | - | `mods.setLightColor(value)` | - | - |
| `mods.getOffset()` | - | `mods.getOffset()` | - | - |
| `mods.getVelocity()` | - | `mods.getVelocity()` | - | - |
| `mods.setMaxVelocity(value)` | - | `mods.setMaxVelocity(value)` | - | - |
| `mods.setAcceleration(value)` | - | `mods.setAcceleration(value)` | - | - |
| `mods.forward()/back()/up()/down()` | - | `mods.forward()/back()/up()/down()` | - | - |
| `mods.turnLeft()/turnRight()` | - | `mods.turnLeft()/turnRight()` | - | - |
| `mods.detectUp()/detectDown()` | - | `mods.detectUp()/detectDown()` | - | - |
| `mods.compareUp()/compareDown()` | - | `mods.compareUp()/compareDown()` | - | - |
| `mods.dropUp()/dropDown()/suckUp()/suckDown()` | - | `mods.dropUp()/dropDown()/suckUp()/suckDown()` | - | - |
| `mods.placeUp()/placeDown()/swingUp()/swingDown()/useUp()/useDown()` | - | `mods.placeUp()/placeDown()/swingUp()/swingDown()/useUp()/useDown()` | - | - |
| `mods.apiMap([kind])` | - | `mods.apiMap([kind])` | - | - |
| `mods.map(name)` | - | `mods.map(name)` | - | - |
| `mods.help([kind])` | - | `mods.help([kind])` | - | - |
| `mods.listAPIs()` | - | `mods.listAPIs()` | - | - |

---

## 5. 命名空间与扁平别名

- `mods.robot`：机器人组件 + 高层移动快捷方式。
- `mods.drone`：无人机组件（`move(dx,dy,dz)` 已固定为无人机形态）。
- `mods.mcu` / `mods.microcontroller`：单片机接口。
- `mods.robot_<name>`：机器人方法的扁平别名，例如 `mods.robot_move(3)`。
- `mods.drone_<name>`：无人机方法的扁平别名，例如 `mods.drone_move(1,0,0)`。
- `mods.mcu_<name>` / `mods.microcontroller_<name>`：单片机方法的扁平别名。
- `mods.forward/back/up/down/turnLeft/turnRight/detectUp/...`：机器人高层方法的扁平别名。

`mods.listAPIs()` 会返回全部可调用名称（当前共 267 项）。

---

## 6. 扩展 API 速查

### 6.1 物品栏

| API | 说明 |
|-----|------|
| `mods.give(name[, count[, meta]])` | 放入物品，返回实际放入数量 |
| `mods.take(name[, count])` | 取出物品，返回实际取出数量 |
| `mods.clearInventory()` | 清空物品栏 |
| `mods.getInventory([side])` | 返回物品栏快照数组 |
| `mods.equip(name[, maxDurability])` | 装备工具 |
| `mods.unequip()` / `mods.getEquipped()` | 卸下 / 查询工具 |

### 6.2 储罐与流体

| API | 说明 |
|-----|------|
| `mods.addTank([capacity])` | 安装储罐，返回编号 |
| `mods.getTank([tank])` | 返回液体名、液位、容量 |
| `mods.setTank([tank], fluid, amount)` | 直接设置储罐内容 |
| `mods.tankCapacity([tank])` | 储罐容量 |
| `mods.drain(side[, amount])` | 抽取相邻液体 |
| `mods.fill(side[, amount])` | 注入相邻液体 |

### 6.3 虚拟世界

| API | 说明 |
|-----|------|
| `mods.world.setLimit(n)` | 设置坐标边界（默认 256） |
| `mods.world.setBlock(x,y,z,name[,meta])` | 放置方块；name 为 `"air"`/`nil` 时移除 |
| `mods.world.getBlock(x,y,z)` | 读取方块名称与 meta |
| `mods.world.removeBlock(x,y,z)` | 移除方块 |
| `mods.world.setFluid(x,y,z,fluid[,amount[,capacity]])` | 放置液体 |
| `mods.world.getFluid(x,y,z)` | 读取液体名称/数量/容量 |
| `mods.world.setChest(x,y,z[,size])` | 创建容器 |
| `mods.world.getChest(x,y,z)` | 读取容器内容 |
| `mods.world.addItem(x,y,z,name[,count[,meta]])` | 生成掉落物 |
| `mods.world.getItems(x,y,z)` | 读取掉落物 |
| `mods.world.addEntity(x,y,z[,name])` / `removeEntity` | 实体标记 |
| `mods.world.clear()` / `stats()` / `dump()` | 清空 / 统计 / 导出 |
| `mods.setBlock/getBlock/removeBlock/clearWorld` | 顶层快捷方式 |

### 6.4 状态与诊断

| API | 说明 |
|-----|------|
| `mods.getPosition()` / `setPosition(x,y,z)` | 位置 |
| `mods.getFacing()` | 朝向编号与名称 |
| `mods.getState()` / `getInfo()` | 完整状态快照 |
| `mods.reset([keepWorld])` | 重置设备（可选保留世界） |
| `mods.reportError(message)` / `mods.lastError()` | 单片机最近错误 |
| `mods.getEnergy()` / `setEnergy(v)` / `getMaxEnergy()` | 扩展能量状态 |
| `mods.apiMap([kind])` | 返回映射表数据 |
| `mods.map(name)` | 按原版名称查询目标，如 `mods.map("robot.move")` |
| `mods.help([kind])` | 返回中文映射帮助 |
| `mods.listAPIs()` | 列出全部 API 名称 |

---

## 7. 示例

### 7.1 建一面 3×3 石墙

```lua
local mods = require("mods")
mods.give("stone", 64)
mods.select(1)
mods.robot.turnRight()          -- 面向 east (+x)
for i = 1, 3 do
  for h = 0, 2 do
    mods.place(3)               -- 在正前方放一块
    mods.move(1)                -- 上升一格
  end
  for h = 1, 3 do mods.move(0) end
  mods.robot.forward()          -- 前进一格
end
```

### 7.2 无人机飞行

```lua
local mods = require("mods")
mods.setAcceleration(4)
mods.setMaxVelocity(8)
mods.drone.move(10, 5, -3)
while mods.getOffset() > 0.01 do
  os.sleep(0.05)
  print(string.format("offset=%.2f velocity=%.2f", mods.getOffset(), mods.getVelocity()))
end
print("arrived", mods.getPosition())
```

### 7.3 单片机启停

```lua
local mods = require("mods")
print(mods.mcu.isRunning())     -- true
print(mods.mcu.stop())          -- true
print(mods.move(3))             -- nil  microcontroller is stopped
print(mods.mcu.start())         -- true
print(mods.move(3))             -- true
```

### 7.4 容器与流体

```lua
local mods = require("mods")
mods.world.setChest(0, 0, 1, 27)
mods.give("stone", 10)
mods.drop(3, 4)                 -- 放入正前方容器
print(#mods.world.getChest(0, 0, 1))

mods.addTank(16000)
mods.world.setFluid(0, 0, 2, "water", 1000, 1000)
print(mods.drain(3, 500))       -- true  500
print(mods.tankLevel(1))        -- 500
```

### 7.5 查询某个原版 API 被映射到哪里

```lua
local mods = require("mods")
print(mods.map("robot.move"))            -- mods.move
print(mods.map("drone.getVelocity"))     -- mods.getVelocity
print(mods.map("microcontroller.stop"))  -- mods.stop
for _, row in ipairs(mods.apiMap("robot")) do
  print(row.source, "->", row.target)
end
```

---

## 8. 控制面板中的 Mods 设备

控制面板左侧现在有两个列表切换：「虚拟机」和「Mods」。

- 点击「＋ New Mod」可以创建机器人、无人机或核电站；也可以直接把一个 Mod 文件夹放进项目根目录的 `Mods/` 中，然后点「⟳ 刷新」。
- 每个 Mod 会在 `Mods/<名称>/` 下自动生成完整运行环境，并作为**独立的 Lua VM 进程**运行，因此拥有真实的启动流程、EFI 输出和运行状态。
- 打开某个 Mod 后会显示三个标签页：
  - **3D 场景**：坐标轴、网格、设备位置、目标位置、朝向箭头、无人机速度矢量、标记点。
    核电站没有 3D 场景，这个标签页会换成 **☢ 反应堆** 的只读 2D 面板（见 9.2）。
  - **物品 / 状态**：位置、朝向、目标、能量、物品栏、工具、储罐、最近错误。
  - **控制台 / EFI**：内置 EFI 启动日志、无线连接信息、每条控制命令的执行结果。
- 工具栏提供「启动 / 停止 / 重启 / 刷新」，并显示无线地址和「内置 EFI」状态；**双击无线地址即可复制**。
- 「⚙ 配置」打开配置弹窗，可编辑 EFI 程序和硬件；保存时可选择是否立即重启 Mod。

## 9. Mods 文件夹与内置 EFI

每个 Mod 是一个文件夹：

```
Mods/
└── Drone-01/
    ├── mod.json       # 元数据 (类型 / 描述 / 3D 标记点)
    ├── config.json    # 自动生成的 VM 配置
    ├── efi.lua        # 自动安装的内置 EFI
    └── disk.ocd       # 自动生成的空启动盘
```

- **不需要手动寻找或制作 EFI**。创建 Mod 时，`mods-efi.lua` 会被自动复制为 `efi.lua`，并生成一份 1MB 的空启动盘。
- 如果 `efi.lua` 或 `disk.ocd` 被删除，下一次启动会自动重新生成。
- 修改 `mod.json` 后，在控制面板点一次「⟳ 刷新」即可更新列表和 3D 标记点。

`mod.json` 示例：

```json
{
  "name": "Drone-01",
  "type": "drone",
  "description": "巡检无人机",
  "markers": [
    { "x": 0, "y": 0, "z": 0, "label": "起点", "color": "#c084fc" },
    { "x": 8, "y": 3, "z": -4, "label": "巡检点 A", "color": "#f6ad55" },
    { "x": -5, "y": 6, "z": 2, "label": "巡检点 B", "color": "#68d391" }
  ]
}
```

内置 EFI 的启动流程：

1. 加载 `mods` 组件并读取设备类型（机器人 / 无人机）。
2. 打开无线网卡的 7777 端口。
3. 每隔 0.2 秒向控制面板上报一次完整状态。
4. 持续处理电脑发来的无线命令，以及控制面板发来的本地命令。

### 9.1 配置弹窗（EFI / 硬件）

点击 Mod 工具栏的「⚙ 配置」：

- **EFI 程序**：直接编辑 `efi.lua`，也就是 Mod 的启动程序。
  - 上限为 EEPROM 的 4096 字节，编辑时会实时显示字节数。
  - 「恢复内置 EFI」可把编辑器内容还原为 `mods-efi.lua` 模板，再保存即可恢复出厂固件。
  - 保存会立即写入 `Mods/<名称>/efi.lua`；关机时模拟器不会再写回旧的内存内容，因此不会覆盖刚保存的版本。
  - 自定义 EFI 中可直接使用：`component`、`computer`、`mods`（统一组件代理）、`modsEmit(payload)`（向控制面板发送 `mod_state` / `mod_log`）、`modWallTime()`（服务端墙钟秒数）以及 `computer.pullSignal(timeout)`。
  - 最小示例：

    ```lua
    local m = component.proxy(component.list("mods")())
    modsEmit({ type = "mod_log", level = "info", msg = "hello from custom EFI" })
    modsEmit({
      type = "mod_state",
      state = m.getState(),
      deviceType = m.getDeviceType(),
      address = component.modem and component.modem.address or nil,
    })
    ```

  - 内置 EFI 就是一份完整参考实现，包含状态上报、7777 端口监听、无线命令处理和关机信号处理。
- **硬件**：参照原版虚拟机硬件编辑器，可修改：
  - APU 等级（T1 / T2 / T3 / Creative）
  - 内存容量（1 / 1.5 / 2 / 2.5 / 3 / 3.5）
  - 屏幕等级（T1 50×16 / T2 80×25 / T3 160×50）
  - 三个扩展卡槽（空槽 / Internet / 数据卡 T1-T3 / 无线网卡 T1-T2）
  - 无线信号强度（自动 / 1-16）
  - EEPROM 固定为 `efi.lua`，启动盘固定为 `disk.ocd`，由系统维护
- **机器人 / 无人机**：只有对应类型才出现的专属参数标签页，详见 9.3。
- 保存时可以勾选「保存后重启 Mod」，让新的 EFI 和硬件立即生效；不勾选则在下一次手动启动时生效。

### 9.2 核电站（reactor）

创建 Mod 时类型选择 **核电站**，或在 `mod.json` 中设置 `"type": "reactor"`。

- 配置弹窗的第一个标签页是 **反应堆**，显示 IC2 原版风格的灰色反应堆 GUI。
- 设备页第一个标签页同样是 **☢ 反应堆**（取代机器人/无人机的 3D 场景）：只读 2D 面板，展示每个格子的组件、等级、脉冲、产电、发热、吸热与生效状态，点击格子可查看该位置的完整信息；下方还有一张全部组件的明细表。
- 网格尺寸与原版一致：**固定 6 行，3 ~ 9 列**；每增加一列相当于增加一个 Reactor Chamber，可用格子从 18 格增加到 54 格。
- 点击组件后点击格子放置，右键清除；缩小列数时会提示将移除超出范围的组件。
- 组件按等级区分：
  - 铀燃料棒（☢）：单联 / 双联 / 四联，每根棒 5 EU/t、4 heat/t；相邻格子里的燃料棒会互相增加脉冲。
  - MOX 燃料棒（☢）：单联 / 双联 / 四联，产电与铀棒相同，但每根棒发热 6 heat/t。
  - 冷却单元（❄）：10k / 30k / 60k 吸热容量，只有与燃料棒相邻时才计入有效容量。
  - 冷凝模块（🔋）：RSH 20k / LZH 100k 吸热容量，放在任意位置都生效。
- 脉冲计算：单根棒的脉冲 = 1 + 相邻格子中的燃料棒总根数，所以两个四联棒相邻时是 5 脉冲。
- GUI 实时显示 EU/t、热量/t、有效吸热容量、预计安全时间和状态（稳定 / 注意 / 危险 / 待机 / 已停机）。
- 「反应堆运行」开关控制是否计算 EU 与热量；「示例布局」会放入一个可直接使用的安全布局。
- 「保存反应堆」立即写入 `reactor.json`，不需要重启 Mod 设备；布局也会出现在 Mod 列表的 `EU/t` 摘要和「物品 / 状态」标签页中。
- 设备启动后运行时开始计时，面板每秒刷新：
  - 堆芯热量（当前 / 外壳上限）、剩余吸热（当前 / 总容量）、累计发电（EU）、运行时长、已吸收热量。
  - 冷却单元与冷凝模块会被消耗；吸热容量耗尽后堆芯开始升温，状态变为「危险」。
  - 停止设备或启动失败时数值冻结；重新启动会重置运行时。
- 「复位堆芯」按钮相当于更换全部冷却单元并把堆芯热量清零，不必重启设备；对应 `POST /api/mods/:name/reactor`。

`reactor.json` 示例（5 列 × 6 行）：

```json
{
  "version": 2,
  "columns": 5,
  "rows": 6,
  "active": true,
  "grid": [
    ["uranium_2x", "coolant_30k", "condensator_20k", null, null],
    ["uranium_1x", "coolant_10k", null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null]
  ]
}
```

旧布局里的 `fuel_rod` / `coolant_cell` / `condensator` 会在读取时自动升级为 `uranium_1x` / `coolant_10k` / `condensator_20k`。

相关 API：`GET/PUT /api/mods/:name/reactor`，响应中的 `stats.cells` 是逐格信息、`runtime` 是运行时快照；`POST /api/mods/:name/reactor` 复位堆芯。计算采用适合模拟器的简化规则，用于配置验证和状态展示；真实 IC2 的完整热传导/脉冲公式更复杂。

### 9.3 设备专属配置（机器人 / 无人机）

有些参数只对特定设备类型有意义，因此配置弹窗只在对应类型下显示这个标签页：

- **机器人**（`🤖 机器人`）
  - 主手工具 / 副手工具：空手、钻石钻头、钻石镐、钻石斧、钻石铲、钻石剑、钻石锄、扳手、剪刀、打火石。
    启动时自动装备，耐久取自原版数值（例如钻石钻头 2400、扳手 250）。
  - 物品栏格数：4 ~ 32，默认 16。
  - 内部储罐：0 ~ 4，默认 1（每个 16,000 mB）。
- **无人机**（`🚁 无人机`）
  - 最大速度：1 ~ 32，默认 8。
  - 加速度：1 ~ 32，默认 4。
  - 物品栏格数：4 ~ 32，默认 16。

单片机与核电站不会出现该标签页（核电站使用 9.2 的反应堆标签页）。

保存后写入 `config.json` 的 `hardware.robot` / `hardware.drone`，重启 Mod 时由 `mods.setProfile()` 套用到组件状态：

```json
{
  "hardware": {
    "robot": {
      "toolMain": "diamond_drill",
      "toolOff": "wrench",
      "inventorySize": 16,
      "tankCount": 1
    }
  }
}
```

```json
{
  "hardware": {
    "drone": {
      "maxVelocity": 12,
      "acceleration": 6,
      "inventorySize": 16
    }
  }
}
```

Lua 侧读取方式：

```lua
local mods = require("mods")
local profile = mods.getProfile()   -- 当前生效的专属参数
print(mods.getEquipped())           -- 主手工具名称、耐久、最大耐久
print(mods.getOffhand())            -- 副手工具
```

相关接口：`GET /api/mods/:name` 返回 `profile`（`{ type, value, tools, limits }`），`PUT /api/mods/:name/config` 接受 `profile` 字段。

## 10. 无线控制协议（T1 / T2 均可）

电脑需要一张**无线网卡**（扩展卡槽中的 T1 或 T2 都可以），然后：

- 从控制面板的 Mod 工具栏复制「无线地址」（双击地址即可复制）。
- 在电脑上打开 7777 端口，向该地址发送表格式命令。
- Mod 会把结果作为 `modem_message` 发回发送者的地址和端口。
- Mod 重启后无线地址会重新分配，请在控制面板重新复制。

T1 / T2 的差异只影响它们与**普通虚拟机**之间的隔离规则；控制 Mods 设备时两种网卡都能连接。

最小示例：

```lua
local component = require("component")
local event = require("event")
local modem = component.modem
local PORT = 7777
local MOD_ADDR = "在控制面板 Mod 工具栏中复制的地址"

modem.open(PORT)

-- 查询状态
modem.send(MOD_ADDR, PORT, { op = "state" })
local _, _, from, port, _, reply = event.pull(5, "modem_message")
print("from", from, "port", port)
print("ok", reply.ok)
print("position", reply.state.position.x, reply.state.position.y, reply.state.position.z)

-- 无人机移动 (dx, dy, dz)
modem.send(MOD_ADDR, PORT, { op = "move", dx = 2, dy = 1, dz = 0 })

-- 机器人按方向移动 (3 = 前)
modem.send(MOD_ADDR, PORT, { op = "move", direction = 3 })

-- 通用调用：等价于在本机调用 mods.swing(3)
modem.send(MOD_ADDR, PORT, { op = "invoke", method = "swing", args = { 3 } })
```

广播发现（电脑需要先打开 7777 端口接收回复）：

```lua
modem.broadcast(PORT, { op = "discover" })
```

支持的便捷命令：

| `op` | 说明 |
|------|------|
| `state` | 返回完整 `state` |
| `discover` / `info` | 返回名称、类型、无线地址 |
| `move` | 机器人：`direction`；无人机：`dx/dy/dz` |
| `turn` | `clockwise = true/false` |
| `invoke` | `method` + `args`，可调用任意 `mods` API |
| `shutdown` / `reboot` | 关闭 / 重启 Mod 设备 |
| 其它 | 直接写方法名，例如 `{ op = "forward" }` 或 `{ op = "detect", side = 3 }` |

## 11. 3D 场景与标记点

- 红色 / 绿色 / 蓝色线条分别表示 X / Y / Z 轴，地面带网格。
- 设备当前位置显示为发光的圆点，旁边有名称和坐标。
- 目标位置显示为圆环，并用虚线连接到当前位置。
- 朝向箭头表示机器人 / 无人机的朝向；无人机的速度会额外显示为绿色虚线箭头。
- `mod.json` 中的 `markers` 会显示为彩色十字标记和标签。
- 鼠标拖动旋转视角，滚轮缩放，双击（或「重置视角」）恢复默认视角。
- 右侧控制区可以直接移动、转向、挖掘、放置、检测，也可以输入坐标传送；这些操作与无线命令使用同一套设备 API。

## 12. 实现与测试

- 组件实现：[`mods.lua`](./mods.lua)
- 内置 EFI：[`mods-efi.lua`](./mods-efi.lua)
- 设备管理：[`lib/modsManager.js`](./lib/modsManager.js)
- 核电站模型：[`lib/reactor.js`](./lib/reactor.js)
- 核电站 GUI：[`web/reactorView.js`](./web/reactorView.js)
- 加载与注册：[`oc-emulator.lua`](./oc-emulator.lua)（启动时 `require("mods")`，注册为 `mods` 组件，并预加载到 `package.loaded`）
- 控制面板：[`web/modView.js`](./web/modView.js)、[`web/app.js`](./web/app.js)
- 配置 API：`GET/PUT /api/mods/:name/efi`（EFI 读写）、`GET/PUT /api/mods/:name/config`（硬件读写）、`GET/PUT /api/mods/:name/reactor`（核电站布局）
- 依赖修复清单：[`lib/repair.js`](./lib/repair.js) 已加入 `mods.lua`、`mods-efi.lua`、`lib/modsManager.js`、`lib/reactor.js`、`web/modView.js`、`web/reactorView.js`
- 已通过 Lua 5.1 / Lua 5.3 语法检查、组件单元测试、Mod 设备端到端测试（创建 → 内置 EFI 启动 → 状态上报 → 本地命令 → T1 无线往返 → 停止/删除），以及浏览器中的 3D / 物品 / 控制台标签页验证。

> 提示：在虚拟机里执行 `print(require("mods").help())` 可查看与本文档一致的完整映射。