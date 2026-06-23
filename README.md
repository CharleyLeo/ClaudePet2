# ClaudePet

> 让 Claude Code 长出一只桌宠 — 实时显示会话状态、上下文消耗、token、花费,完成时弹通知响提示音。

![桌宠主视图](png/zhuye.png)

支持 Windows / macOS / Linux。

详细改动记录见 [`docs/CHANGELOG.md`](docs/CHANGELOG.md)。

---

## ✨ 核心能力

- **桌面常驻悬浮宠物** — 实时显示 Claude Code 状态:idle / thinking / running tool / waiting permission / done / error
- **HP 上下文条** — 当前 context window 用量可视化,临近爆仓变黄变红
- **展开详情面板** — 输入 / 输出 token、缓存读写、会话 id、git 分支、本次花费一栏看完
- **三类通知 × 自定义提示音** — 完成 / 等权限 / 出错 各自独立开关,5 种音色 + 音量软放大到 200%
- **使用统计** — 今日 / 7 天 / 30 天 / 全部,按项目维度 + 日期维度 token 与花费汇总
- **5 只内置宠物 + 自定义** — IKun / 蜡笔小新 / 豆豆豆豆 / Clawd / Nimbus,可随时切换;支持从 codex-pets.net 下载更多
- **玻璃拟态 + 霓虹设计** — Indigo → Cyan 渐变主色调,backdrop-filter 玻璃质感
- **零侵入集成** — 通过 Claude Code 官方 `statusLine` + `hooks` 机制接入,卸载自动还原原配置

---

## 📸 截图

| | |
|---|---|
| ![桌宠主视图](png/zhuye.png) | ![展开详情](png/gengduo.png) |
| **桌宠常驻** — 桌宠 + HP 条 + 实时气泡 | **展开面板** — token / git / 花费 一目了然 |
| ![宠物管理](png/petset.png) | ![使用统计](png/tongji.png) |
| **设置中心 · 宠物** — 切换、预览、可视化编辑 manifest | **设置中心 · 使用统计** — 多维度汇总 |

---

## 🚀 5 分钟上手

### 前置要求

- Node.js **18+**(Electron 42 要求)
- Claude Code(CLI / Desktop / IDE 扩展任一)

### 1. 克隆 + 安装依赖

```bash
git clone https://github.com/CharleyLeo/ClaudePet.git
cd ClaudePet
npm install
```

> `npm install` 只安装到当前目录的 `node_modules`,**不做任何全局动作**。装完不要再挪 ClaudePet 文件夹,集成时会把绝对路径写进 Claude Code 配置。

### 2. 验证桌宠能独立启动

```bash
npm start
```

桌宠应该出现在屏幕上。从系统托盘 → 退出 关掉即可(此时还没和 Claude Code 集成)。

### 3. 集成到 Claude Code

```bash
npm run install:user
```

写入 `~/.claude/settings.json`,**所有项目**都会自动唤起桌宠。原文件备份到 `settings.json.claudepet-backup-<时间戳>`。

> 只想对当前项目生效:用 `npm run install:local`,写到当前目录的 `.claude/settings.local.json`。

### 4. 起飞

任何 Claude Code 终端跑起来,桌宠会自动唤起并显示当前会话状态。也可以在 PowerShell 里加快捷:

```powershell
function claudepet { node D:\path\to\ClaudePet\bin\claudepet.js @args }
```

之后 `claudepet doctor` / `claudepet start` 等命令直接用。

---

## 🎨 宠物

5 只内置,**托盘 → 打开设置 → 「宠物」tab** 一键切换:

| 宠物 | 名 | 简介 |
|---|---|---|
| `clawd` | Clawd | Claude Code 御用红色机甲小蜘蛛,八只眼盯紧你写的每一行代码 |
| `doudoudoudou` | 豆豆豆豆 | 戴粉兔耳帽的话痨小豆,唠叨 / 摸鱼 / 抓Bug / 庆功 一条龙 |
| `ikkun` | IKun | 练习两年半的练习生,喜欢唱跳 RAP 篮球 |
| `nimbus` | Nimbus | 龙之子卡卡罗特,座驾筋斗云,饭量是程序员的三倍 |
| `shinchan` | 蜡笔小新 | 春日部最强 5 岁幼儿园大班生,擅长大象舞、模仿动感超人 |

### 添加新宠物

到 <https://codex-pets.net/> 下载一个 ZIP,里面是一个含 `pet.json` + `spritesheet.webp` 的文件夹。直接解压到 `pet/` 目录下,重启桌宠 → 「宠物」tab 就能看到。

```
ClaudePet/
  pet/
    <你的宠物 id>/
      pet.json
      spritesheet.webp
```

### 自己做宠物

宠物 = 一张精灵图 + 一份 manifest。精灵图按网格切成 7 套动画帧:`idle / thinking / tool / waiting / success / error / run`。具体字段在「设置中心 → 宠物 → 选中宠物」里可视化编辑,改完保存自动写入 `pet/<id>/pet.json`。

---

## 🔔 通知与提示音

### 三类系统通知(可独立开关)

| 类型 | 触发 | 标题前缀 |
|---|---|---|
| `onComplete` | Claude 完成一轮回复 | `[完成]` |
| `onPermission` | 等待权限授予 / 输入回复 | `[需要交互]` |
| `onError` | 工具失败 / 会话出错 | `[出错]` |

点通知能直接唤起桌宠 + 打开设置中心。在「显示设置 → 通知设置」可以分别开关,还有"测试"按钮验证通道是否畅通。

### 自定义提示音

跟系统通知**同步触发**,5 种内置音色:

- `ding` 叮咚
- `bell` 铃声
- `chime` 钟声
- `success` 成功
- `task-complete` 任务完成

音量 0~200%(底层用 Web Audio + GainNode 软放大,超过 150% 可能略失真)。"显示设置 → 提示音"里有试听按钮。

### 藏桌宠但保留提示音

「显示设置」加了两个开关:

- **显示桌宠** — 关掉后窗口隐藏,但 Claude Code 事件仍会触发通知
- **隐藏桌宠时仍播放提示音** — 默认开,关掉则桌宠隐藏后连提示音也静音

---

## ⚙️ 设置 & 统计

「设置中心」三个 tab:

- **宠物** — 切换 / 自定义 / 编辑 manifest / 预览动画
- **显示设置** — 大小 / 透明度 / 总在最前 / 拖动奔跑动画 / 通知开关 / 提示音
- **使用统计** — 今日 / 7 天 / 30 天 / 全部,按项目和日期分组的 token 与花费

所有配置存在 `~/.claudepet/config.json`,手动改也行(重启生效)。

---

## 🛠️ 工作原理

ClaudePet 通过 Claude Code 官方机制集成,不打补丁、不拦截、不动 Claude 进程。`npm run install:user` 等价于:

1. 备份 `~/.claude/settings.json` 到 `.claudepet-backup-<时间戳>`
2. 把原 `statusLine`(如有,例如 `claude-hud`)保存为 ClaudePet 的 `legacyStatusLine`,桌宠收到 statusline 时会代为转发
3. 改写 `statusLine.command` 为 `node <ClaudePet>/bin/claudepet.js statusline`
4. 给以下 **15 个 hook** 各追加一条 `node <ClaudePet>/bin/claudepet.js hook` 命令:

   ```
   UserPromptSubmit, PermissionRequest, Notification,
   PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch,
   SubagentStart, SubagentStop, TaskCreated, TaskCompleted,
   Stop, StopFailure, PreCompact, PostCompact
   ```

   全部 `async: true`,不阻塞 Claude Code。

ClaudePet 自身的数据(配置 / 运行时状态 / 使用统计)在 `~/.claudepet/`(可用环境变量 `CLAUDEPET_HOME` 自定义)。

---

## 🧰 命令行工具

```bash
node bin/claudepet.js doctor       # 显示 home、runtime 端口、Electron 路径、可用宠物
node bin/claudepet.js pets         # 列出可用宠物
node bin/claudepet.js start        # 启动桌宠(=npm start)
node bin/claudepet.js --help       # 全部命令
```

如果你按 [5 分钟上手 / 步骤 4](#4-起飞) 设了 `claudepet` PowerShell 函数,前缀都可以省掉。

---

## 📁 项目结构

```
ClaudePet/
├─ bin/claudepet.js          # CLI 入口
├─ src/
│  ├─ cli.js                 # statusline / hook / install 等子命令
│  ├─ main/main.js           # Electron 主进程(窗口、托盘、菜单、通知)
│  ├─ preload.js             # 渲染层 IPC 桥
│  ├─ renderer/              # 桌宠 + 设置中心 UI
│  │  ├─ index.html
│  │  ├─ renderer.js
│  │  ├─ styles.css          # 玻璃拟态 + 霓虹设计系统
│  │  └─ assets/             # 应用图标、内置提示音 wav
│  └─ shared/                # 配置、宠物、状态、bridge、安装器等共享模块
├─ pet/                      # 内置宠物(每个目录一只:pet.json + spritesheet.webp)
├─ scripts/                  # 一次性工具(图标生成、wav 归一化、并发测试)
├─ docs/CHANGELOG.md         # 滚动更新的改动记录
└─ test/                     # 单元测试
```

---

## 🧯 故障排查

| 现象 | 检查 |
|---|---|
| 桌宠不出现 | `claudepet doctor` 看 `runtime` 字段;`not running` 就 `npm start` 手动起 |
| statusLine 没变化 | `~/.claude/settings.json` 的 `statusLine.command` 是否含 `claudepet.js`,被其他工具覆盖了就重装 |
| 状态长时间停在 idle | hook 没装齐;`settings.json` 的 `hooks` 块应该有 15 个事件每个含 claudepet 条目,重装即可 |
| 改了 ClaudePet 目录位置 | hook / statusLine 都是绝对路径;搬目录后重新跑 `npm run install:user` 即可自动覆写(详见 [`docs/CHANGELOG.md`](docs/CHANGELOG.md) 六节) |
| 多窗口 / 多项目重复弹窗 | 不会,单实例锁会让第二个进程立刻退出 |
| 切换项目后气泡显示旧目录内容 | 重启桌宠 → 自动 `clearStaleState` 清理;或「显示设置 → 通知设置 → 重置当前显示」 |
| 完成 / 权限 / 出错收不到通知 | 「显示设置 → 通知设置」按对应"测试"按钮验证,总开关「启用系统通知」要开;hooks 装到对的 scope |
| 关掉桌宠又自动重启 | 设计如此(被 Claude Code 事件唤起)。要彻底退出,关闭后下次重新 `claudepet start` 才会启动 |

---

## 🔌 卸载

```bash
npm run uninstall:user      # 移除全局集成
npm run uninstall:local     # 移除当前项目集成
```

卸载会:

- 从 settings.json 移除 ClaudePet 注入的 statusLine + hooks
- 尽量还原原 statusLine(如安装时保存过 `legacyStatusLine`)
- 备份文件保留在原位置不删

彻底清干净:再 `rm -rf ~/.claudepet/` 和那些 `*.claudepet-backup-*` 备份。

---

## 🛠️ 开发

```bash
npm test         # 运行所有单元测试(install/uninstall、状态机、manifest 解析等)
npm run dev      # Electron 开发模式
```

需要重新生成应用图标(基于 IKun 第 0 帧):

```bash
node scripts/generate-app-icon.js
```

需要把内置提示音重新归一化峰值(默认目标 -0.5 dBFS):

```bash
npm run sounds:normalize       # 归一化
npm run sounds:restore         # 还原备份
```

完整改动记录、bug 修复历史、设计决策 → [`docs/CHANGELOG.md`](docs/CHANGELOG.md)。

---

## 🤝 致谢

ClaudePet 基于 [**liuchenlili/ClaudePet**](https://github.com/liuchenlili/ClaudePet) 的原始架构延续开发。原作者建立了核心的 bridge / hook / statusLine / 宠物渲染 / 使用统计 等能力,本仓库在此基础上做了视觉重构、新功能扩展和长期维护。感兴趣的同学也欢迎去看看原版。

- [**liuchenlili**](https://github.com/liuchenlili) — 原作者
- [**Claude Code**](https://claude.com/claude-code) — 整套 statusLine / hooks 体系是 ClaudePet 存在的前提
- [**linux.do**](https://linux.do/) 社区 — 开发期反馈与讨论

---

## License

MIT — 见 [LICENSE](LICENSE)。



















