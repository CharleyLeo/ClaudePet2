# ClaudePet2 state.json 损坏问题修复总结

> 日期：2026/06/23
> 受影响项目：ClaudePet2（路径 `D:\tools\ClaudePet2`），作为 Claude Code statusLine 的 wrapper

## 1. 优化背景

### 1.1 现象

- Claude Code 输入框下方状态栏**完全空白**
- 用户原本配置：ClaudePet2 作 wrapper，内部通过 `legacyStatusLine` 转发到 claude-hud，**桌宠 + 文字状态栏「两个并行」**

### 1.2 排查路径

`~/.claude/settings.json` 里 `statusLine.command` 指向：

```
"C:\Program Files\nodejs\node.exe" "D:\tools\ClaudePet2\bin\claudepet.js" "statusline"
```

手动跑这条命令复现，立刻抛错：

```
[claudepet] SyntaxError: Unexpected non-whitespace character after JSON at position 16105 (line 442 column 1)
    at JSON.parse (<anonymous>)
    at readJson (D:\tools\ClaudePet2\src\shared\json-file.js:10:17)
    at loadRuntimeState (D:\tools\ClaudePet2\src\shared\runtime-state.js:27:35)
    at mergeStatePatch (D:\tools\ClaudePet2\src\cli.js:79:19)
    at statusLineCommand (D:\tools\ClaudePet2\src\cli.js:109:3)
```

## 2. 根因

`~/.claudepet/state.json` 文件**损坏**：

- 文件预期长度约 16105 字符，实际 16364 字符
- **JSON 正常结束后被追加了 Claude Code 传给 ClaudePet2 hook 的 raw stdin 内容**（包含对话文本）
- 损坏位置示例：

```
"...statusline"\n}\nr.py、专用浏览器登录完成、dump 出 boss_recommend_dump.html...
```

正确的 JSON 应在 `"...statusline"\n}` 处闭合，但后面被拼接了一段会话中出现过的文本。

## 3. Bug 性质 —— ClaudePet2 自身缺陷

**写文件存在 race condition / 非原子写**。Claude Code 高频触发 hook + statusline，多个 `claudepet.js` 子进程并发写同一个 `state.json`，导致：

1. 进程 A 写完整 JSON 到 state.json
2. 进程 B 以错误模式（疑似 append 模式，或没拿独占锁的覆盖写）二次写入，把它自己拿到的 raw stdin 拼到了文件末尾
3. 后续任何进程 `JSON.parse` 直接挂掉，整个 statusline 链路断了，**claude-hud 也跟着不显示**

## 4. 关键代码定位（待修复点）

| 文件 | 行号/函数 | 问题 |
| --- | --- | --- |
| `src/shared/json-file.js` | `readJson`（第 10 行附近） | 没有 try/catch，JSON.parse 失败直接抛出，导致一次写坏 → 永久不可用 |
| `src/shared/runtime-state.js` | `loadRuntimeState` / `saveRuntimeState`（第 24-30 行附近） | 没并发保护，没原子写 |
| `src/cli.js` | `statusLineCommand`（第 90-115 行）、`hookCommand`（第 118 行起）、`mergeStatePatch`（第 79 行调用） | statusline 与 hook 路径都会写 state，两条路径并发即互踩 |

## 5. 修复建议

### 5.1 短期防御性修复（必做）

1. **`readJson` 加 try/catch**：JSON.parse 失败时返回默认值并把坏文件 rename 成 `.broken.<ts>` 备份，避免一次写坏永久挂掉。
2. **`writeJson` 改原子写**：写到 `state.json.tmp` 再 `fs.rename` 到 `state.json`（同盘 rename 在 Windows/Linux 上都是原子操作）。

参考实现要点：

```js
// readJson 防御
function readJson(p, fallback) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) {
      // 坏文件留证据再重置
      try { fs.renameSync(p, `${p}.broken.${Date.now()}`); } catch {}
    }
    return fallback;
  }
}

// writeJson 原子写
function writeJson(p, obj) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
```

### 5.2 根治（建议做）

3. **加文件锁**（[`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile)）防止并发写互踩。
4. 或改成 **append-only 事件日志 + 启动时折叠**，避免每次都覆盖大 JSON。

## 6. 临时处理记录（本次会话已完成）

| 动作 | 路径 |
| --- | --- |
| 损坏文件备份 | `~/.claudepet/state.json.broken.20260623-104658` |
| 重置 state.json | `echo '{}' > ~/.claudepet/state.json` |
| 验证 | 重新跑 statusline 命令，输出 claude-hud 的样式行，链路恢复 |

## 7. 与本次会话操作的关系

**无因果**。Claude Code 本次会话**没改过** `~/.claude/settings.json`（只按 claude-hud:setup 规范做了备份 `settings.json.bak.20260622-151531`，可保留也可删除）。state.json 损坏是 ClaudePet2 自己在 hook 写入时发生的，今天恰好触发到。

## 8. 注意事项

- 本文件**记录给另一个窗口修 ClaudePet2 用**，不修改本项目（Boss 自动化爬虫）的任何代码。
- 修复后建议保留 `~/.claudepet/state.json.broken.*` 作为复现样本，跑通防御性 readJson 单测后再删。
- claude-hud 本身没有问题，0.1.0 / 0.3.0 两个版本都在缓存里，statusline 链路恢复后会自动通过 ClaudePet2 的 `legacyStatusLine` 转发。
