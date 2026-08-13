# ClaudePet 优化记录

> 日期：2026/08/13　环境：Windows 11 / Node v24.13.0 / Git Bash(msys2)

## 1. 优化背景

用户反馈「打开浏览器就卡、并弹出大量空白 `bash.exe` 窗口」。实测复现 + 进程创建监控定位到：**根本不是浏览器或病毒问题，而是 ClaudePet 状态栏经 Git Bash 调用 claude-hud 时，在 Windows 上泄漏了大量孤儿进程。**

关键现场数据：

- 45 秒内狂拉 **742 个进程**（bash 542 / node 116 / git 84），约 16 个/秒。
- 当时存活 **93 个** bash/node，其中 **51 个是卡死的 claude-hud node**，最老的已存活 **≈16 天**不退出。
- 这些孤儿进程的父进程几乎全部为 `(gone)`——父进程早退出，它们却还活着。
- 项目根目录留有 `bash.exe.stackdump`（msys/bash 崩溃转储），是这条调用链崩溃的痕迹。

现象成因：几十个僵尸进程占内存/句柄 → 卡；每个卡死的 bash 各自分配一个空白控制台窗口 → 屏幕上堆叠的 `bash.exe` 弹窗。

## 2. 改动内容

改动文件：`src/cli.js` 的 `runLegacyStatusLine`（并新增两个辅助函数）。

**根因**：`legacyStatusLine.command` 是 `bash -c "…; exec node …/claude-hud/dist/index.js"`。原代码用 `spawn(bash, ["-c", command], { windowsHide, ... })` + 2.2s 超时 `child.kill()` + `child.stdin.end(input)`，逻辑本身规范，但在 Windows(msys) 下 `exec` 触发三个坑：

1. **msys 的 `exec` 是「假 exec」**：它把 node 派生为一个新的 Windows 进程，而 Node 侧的 `child` 句柄仍指向那个已退出的 bash 空壳。→ 超时时 `child.kill()` 杀的是空壳，**杀不到真正的 node**，node 变孤儿长期堆积。
2. **`exec` 切断了 stdin 管道**：claude-hud 的 node 读不到 Claude Code 传入的 JSON，**挂死在读 stdin 上永不退出**。
3. **`windowsHide` 传不到派生出的 node**：于是**弹出空白控制台窗口**。

**解决思路**：Windows + claude-hud 场景下**绕开 Git Bash，直接用 node 运行 claude-hud 入口脚本**。这样 `child` 就是真正的 node 子进程——`windowsHide` 生效（不弹窗）、stdin 管道正常（不挂死）、`child.kill()` 能真杀（不留孤儿）。同时新增 `taskkill /T` 进程树兜底，防止任何 shell 派生进程残留。

新增/修改的关键函数：

- `resolveHudIndex()`：用 Node 解析 `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/*/claude-hud/*/dist/index.js`，按版本号取最高版（与原命令 `sort -V | tail -1` 等价）。
- `killProcessTree(child)`：`child.kill()` + Windows 下 `taskkill /pid <pid> /T /F` 兜底杀进程树。
- `runLegacyStatusLine(command, input, timeoutMs)`：Windows 且命令含 `claude-hud` 时走 `spawn(process.execPath, [hudIndex], { windowsHide:true, env:{COLUMNS} })`；否则回退原 bash 路径。超时统一用 `killProcessTree`。

## 3. 改动前后对比

改动前（问题路径）：

```js
const child = bash
  ? spawn(bash, ["-c", command], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  : spawn(command, [], { shell: true, ... });
// 超时：
child.kill();   // Windows 下杀不到 msys exec 派生的 node → 孤儿泄漏
```

改动后（Windows + claude-hud 直连 node）：

```js
const hudIndex =
  process.platform === "win32" && /claude-hud/.test(command) ? resolveHudIndex() : null;
let child;
if (hudIndex) {
  child = spawn(process.execPath, [hudIndex], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: { ...process.env, COLUMNS: process.env.COLUMNS || "120" }
  });
} else {
  const bash = findBashShell();
  child = bash ? spawn(bash, ["-c", command], { ... }) : spawn(command, [], { shell: true, ... });
}
// 超时：
killProcessTree(child);   // child.kill() + taskkill /T 兜底
```

实测验证：

| 项 | 改动前 | 改动后 |
|---|---|---|
| claude-hud 渲染 | 挂死无输出 | ✅ 正常（`[Opus 4.8] │ work / 上下文 / 7 MCPs...`） |
| 单次耗时 | 永久卡住 | 387 ms |
| 跑一次后新增孤儿 | +1（永不退） | **0** |
| 存量僵尸清理 | 93 个进程 | 清理 53 个 → 25 个（仅剩正常 MCP/会话进程） |

## 4. 注意事项

- **claude-hud 完整保留**，只是改了它的拉起方式；桌宠、Electron 主进程逻辑未动。
- 无需重启：statusLine 每次刷新都是新起 node，下次刷新即走新代码。
- COLUMNS 传 `120` 与原命令在无 tty 时的回退值一致，宽度表现无回归。
- 回退分支（非 Windows / 非 claude-hud 的自定义 legacyStatusLine）保持原 bash 行为，仅超时杀进程升级为进程树兜底，更稳。
- 可选进一步降耗：`~/.claude/settings.json` 的 `statusLine.refreshInterval: 2` 偏激进，且 15 个 hook 每次工具调用都会触发；泄漏已根治后二者仅剩少量 CPU 开销，如需更省可调大刷新间隔或精简 hook。
