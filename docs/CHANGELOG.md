# ClaudePet 改动记录（滚动）

> 本文档把项目的每一轮排查、修复与新功能集中放在一处，避免散在多个文件里翻不到。按章节阅读即可，新增改动追加到文末。

**目录**

- 一、真凶：拖动时窗口持续横向放大
- 二、拖动时的"奔跑"动画（已重新启用）
- 三、应用菜单中文化
- 三点五、通知体系改造（A. hooks 没装 / B. 增强 maybeNotify / C. 启动清理 stale state）
- 四、已知遗留问题：切换 Claude Code 会话时显示旧目录的内容
- 五、整体验证清单
- 六、项目重命名（ClaudePet → ClaudePet2）：迁移与 install bug 修复
- 七、Windows 上 legacy statusLine 兼容（Git Bash 检测）
- 八、自定义通知提示音

---

## 一、真凶：拖动时窗口持续横向放大

### 现象

在 Windows 11 + 系统缩放（DPI 125% / 150%）下，拖动宠物时：

- **悬浮窗口本身在变大**（横向尤其明显）；
- 因为宠物 sprite 大小受 `applyFrame({ fit: true })` 限制基本不变，窗口越大，宠物相对位置就显得"距离边缘越来越远"；
- 气泡框（speech bubble）填充窗口的右侧栅格列，窗口宽了气泡也跟着横向拉宽。

> 一开始误判过两次：先以为是 `run` 奔跑动画把宠物姿势"撑大"，后来又怀疑是 `setPosition` 的 DPI 漂移。把这两条线索排除后才定位到真因——**反馈循环式的尺寸漂移**。

### 根因

第一版拖动实现位于 `src/main/main.js`：

```js
// 旧实现 1
const [x, y] = petWindow.getPosition();
petWindow.setPosition(x + dx, y + dy, false);
```

`setPosition` 不显式带宽高，在 HiDPI 屏上会经过 DIP → 物理像素 → DIP 的换算，每次会有亚像素误差。再叠加 `resizable: true`，每次拖动累积几像素放大。

第二版尝试改成 `setBounds` 但仍然有问题：

```js
// 旧实现 2 —— 仍然错误！
const bounds = petWindow.getBounds();
petWindow.setBounds(
  { x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height },
  false
);
```

致命点在 `bounds.width` / `bounds.height` 是从 `getBounds()` 回读出来的。HiDPI 下 `getBounds()` 返回的值可能是 438.x 这种亚像素，写回 `setBounds` 时被 Electron 取整为 439，下一次再读就成了 439 → 440 → …，**形成"每次拖动横向放大几像素"的反馈循环**。`maxWidth: 438` 这种构造期约束并不能阻止运行期通过 `setBounds` 推过去的值。

### 最终修复

`src/main/main.js`：

1. **在文件顶部固化窗口尺寸常量**，作为全场唯一真相：
   ```js
   const PET_WINDOW_WIDTH = 438;
   const PET_WINDOW_HEIGHT = 338;
   ```
2. **`createPetWindow()`** 用常量声明窗口尺寸，同时把窗口锁成不可缩放（双重保险）：
   ```js
   petWindow = new BrowserWindow({
     width: PET_WINDOW_WIDTH,
     height: PET_WINDOW_HEIGHT,
     minWidth: PET_WINDOW_WIDTH,
     minHeight: PET_WINDOW_HEIGHT,
     maxWidth: PET_WINDOW_WIDTH,
     maxHeight: PET_WINDOW_HEIGHT,
     frame: false,
     transparent: true,
     resizable: false,
     // ...
   });
   ```
3. **`claudepet:drag-window` 处理器改用硬编码常量做宽高**，绝不从 `getBounds()` 回读：
   ```js
   ipcMain.handle("claudepet:drag-window", (_event, delta) => {
     if (!petWindow || petWindow.isDestroyed()) return false;
     const dx = Math.round(Number(delta && delta.dx) || 0);
     const dy = Math.round(Number(delta && delta.dy) || 0);
     if (!dx && !dy) return true;
     const [x, y] = petWindow.getPosition();
     petWindow.setBounds(
       {
         x: x + dx,
         y: y + dy,
         width: PET_WINDOW_WIDTH,
         height: PET_WINDOW_HEIGHT
       },
       false
     );
     return true;
   });
   ```
   要点：
   - **只回读 position（x, y）**，因为位置确实需要相对累加。
   - **宽高用常量**，断掉反馈循环。
4. **`applyWindowConfig()`** 里启动时还原配置位置的那段也统一用常量，并改 `setPosition` → `setBounds`：
   ```js
   if (config.position && Number.isFinite(config.position.x) && Number.isFinite(config.position.y)) {
     const display = screen.getDisplayMatching({
       x: Math.round(config.position.x),
       y: Math.round(config.position.y),
       width: PET_WINDOW_WIDTH,
       height: PET_WINDOW_HEIGHT
     });
     const work = display.workArea;
     const x = Math.min(Math.max(work.x + 8, Math.round(config.position.x)), work.x + work.width - PET_WINDOW_WIDTH - 8);
     const y = Math.min(Math.max(work.y + 8, Math.round(config.position.y)), work.y + work.height - PET_WINDOW_HEIGHT - 8);
     petWindow.setBounds({ x, y, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT }, false);
   }
   ```

> 这一步把所有可能写入窗口宽高的路径都统一到 `PET_WINDOW_WIDTH / PET_WINDOW_HEIGHT`，从此窗口尺寸不再依赖于"回读 → 再写"。

### 验证

1. 托盘 → 退出，再重新启动 ClaudePet。
2. 把宠物从屏幕一角拖到对角，再拖回来；重复几十次。
3. 期望：
   - 窗口宽高始终不变（用任务管理器或截图比对一下边缘）；
   - 宠物与气泡的相对距离恒定；
   - 在 125% / 150% DPI 缩放下均如此。

### 将来如果想让窗口可缩放

- `createPetWindow()` 里去掉 `minWidth/minHeight/maxWidth/maxHeight`，把 `resizable` 改回 `true`。
- 拖动处理器里仍要**保留** "宽高用常量、只回读 x/y" 的写法 —— 那是 HiDPI 反馈循环的真正修复，与可缩放无关。
- 同时为渲染层做自适应（HP 条、气泡的最大宽度、`fit: true` 等都要复查）。

---

## 二、拖动时的"奔跑"动画（已重新启用）

### 状态

经验证窗口"变大"与 `run` 动画无关，奔跑功能恢复，默认开启。

| 文件 | 状态 |
| --- | --- |
| `src/shared/config.js` | `runOnDrag: true`（默认开启） |
| `src/renderer/renderer.js` → `animationFor()` | 拖动时切到 `pet.animations.run` 的逻辑已生效 |
| `src/renderer/renderer.js` → `drawCurrentFrame()` | 拖动时给宠物加 `.flip` / `.running` 类已生效 |
| `src/renderer/renderer.js` → `renderAppearanceTab()` | 「显示设置」里的"拖动时播放奔跑动画"开关已显示 |

### 关键代码

**a. `src/shared/config.js`**

```js
const DEFAULT_CONFIG = {
  // ...
  runOnDrag: true,   // 拖动桌宠时播放 run 奔跑动画
  // ...
};
```

**b. `src/renderer/renderer.js` — `animationFor`**

```js
function animationFor(pet) {
  if (model.drag.active && model.config && model.config.runOnDrag) {
    return (pet.animations && pet.animations.run) || pet.animations.tool || pet.animations.idle;
  }
  const status = model.state.status || {};
  return (pet.animations && pet.animations[status.animation]) || pet.animations.idle;
}
```

**c. `src/renderer/renderer.js` — `drawCurrentFrame`**

```js
if (petElement) {
  const runActive = model.drag.active && Boolean(model.config && model.config.runOnDrag);
  petElement.classList.toggle("flip", runActive && model.drag.direction === "left");
  petElement.classList.toggle("running", runActive);
}
```

**d. `src/renderer/renderer.js` — `renderAppearanceTab`**

```html
<label class="toggle with-toggle-icon">
  ${icon("play")}
  <input type="checkbox" ${config.runOnDrag ? "checked" : ""} data-config-bool="runOnDrag">
  <span>拖动时播放奔跑动画</span>
</label>
```

### 使用方式

- 设置中心 → 「显示设置」 → 「拖动时播放奔跑动画」可手动关闭 / 开启。
- 各宠物的 `run` 动画帧序、fps、是否循环可在 「宠物」标签 → 选中宠物 → 编辑 `run 奔跑` 区块后点底部「保存 manifest」。

### 顺手修复：pointer capture 调用

原代码 `window.setPointerCapture?.(event.pointerId)` 实际是空操作（`Window` 上没有该方法）。已修正为：

```js
if (event.target && typeof event.target.setPointerCapture === "function") {
  try { event.target.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
}
```

副作用是：拖动时若鼠标短暂滑出窗口，pointer 事件仍能继续派发到原元素，避免 `lastScreenX/Y` 漂移导致的跳动。

---

## 三、应用菜单中文化

### 背景

之前主进程没注册自定义菜单，Electron 默认弹出英文菜单（File / Edit / View / Window / Help → Minimize / Zoom / Close 等）。

### 改动

`src/main/main.js`：

1. 新增 `buildAppMenu()`，按平台（mac / 非 mac）分别构建模板：
   - 「文件」：打开设置中心 / 退出
   - 「编辑」：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 删除 / 全选
   - 「视图」：重新加载 / 强制重新加载 / 切换开发者工具 / 实际大小 / 放大 / 缩小 / 切换全屏
   - 「窗口」：最小化 / 缩放 / 关闭（mac 下额外有"前置全部窗口"等）
   - 「帮助」：打开项目主页（外链）
   - mac 平台额外有以 `APP_NAME` 命名的应用菜单（关于 / 隐藏 / 退出 等）。
2. 在 `boot()` 里 `registerIpc()` 之后调用 `Menu.setApplicationMenu(buildAppMenu())`。

> 实现要点：用 Electron 的 `role` 字段获取标准行为（剪切 / 粘贴 / 缩放等），同时通过 `label` 覆写显示文本来实现汉化。

### 如何回退到英文默认菜单

`src/main/main.js → boot()` 中注释或删除：

```js
Menu.setApplicationMenu(buildAppMenu());
```

`buildAppMenu` 函数本身可以保留。

---

## 三点五、通知体系改造（A + B + C）

> 用户反馈：「气泡平时是关的，真正想要的是 Claude 完成 / 等待权限 / 出错时弹通知。之前一直收不到通知。」

### A. 根因：hooks 没装

诊断发现 `~/.claude/settings.json` 里 **完全没有 `hooks` 字段**，statusline 是 `claude-hud` 插件。也就是说之前 ClaudePet 的钩子从没在 user scope 装过；旧项目 `D:\work\2025-06-19(qiandao_spider)` 装过 local hooks，事件投递后冻在 `state.json` 里。

执行：

```bash
npm run install:user
```

它会写入 hooks（UserPromptSubmit / PreToolUse / PostToolUse / Stop / Notification / SubagentStart ... 一整套）。脚本带 `--preserve-statusline` 只是**备份原 statusline 到 `config.legacyStatusLine` 以便 uninstall 时还原**，并不能阻止它覆盖 `statusLine` 字段本身。

因此安装后**手动恢复 statusLine** 为 `claude-hud`（用 install 自动生成的 backup 文件 `~/.claude/settings.json.claudepet-backup-<时间戳>`）。这样：
- statusline 仍是用户偏好的 `claude-hud`；
- hooks 是 ClaudePet 的，事件能正常进 bridge。

> 如果你重新执行 `install:user`，记得再手动恢复一次 statusLine。或者在 install 流程里加一个 `--hooks-only` 开关（后续 TODO）。

### B. 通知体系增强（代码改动）

**1. 配置项扩展 `src/shared/config.js`：**

```js
notifications: {
  system: true,         // 总开关
  sound: false,         // 通知声音
  flashWindow: true,    // 闪烁任务栏
  onComplete: true,     // Claude 完成时通知
  onPermission: true,   // 等待权限 / 输入时通知
  onError: true         // 出错时通知
}
```

**2. `src/main/main.js` 的 `maybeNotify` 重写：**

```js
function notificationCategory(status) {
  if (!status) return null;
  const kind = status.kind;
  if (kind === "completed") return "onComplete";
  if (kind === "waiting-permission" || kind === "waiting-input" || kind === "notification") return "onPermission";
  if (kind === "error" || kind === "tool-error" || status.severity === "error") return "onError";
  if (status.attention) return "onPermission"; // 兜底
  return null;
}

function maybeNotify(status) {
  if (!status) return;
  const category = notificationCategory(status);
  if (!category) return;
  const notif = config.notifications || {};
  if (notif.system === false) return;
  if (notif[category] === false) return;
  if (Notification.isSupported()) {
    const titlePrefix =
      category === "onComplete" ? "[完成] " :
      category === "onPermission" ? "[需要交互] " :
      category === "onError" ? "[出错] " : "";
    const n = new Notification({
      title: titlePrefix + (status.label || "Claude Code"),
      body: status.detail || "打开 Claude Code 继续",
      icon: windowIconPath(),
      silent: !notif.sound
    });
    n.on("click", () => {                  // 点通知后激活桌宠 + 设置中心
      if (petWindow && !petWindow.isDestroyed()) {
        userHidden = false;
        if (!petWindow.isVisible()) petWindow.showInactive();
        petWindow.focus();
      }
      showManager();
    });
    n.show();
  }
  if (petWindow && notif.flashWindow) {
    petWindow.flashFrame(true);
    setTimeout(() => {
      if (petWindow && !petWindow.isDestroyed()) petWindow.flashFrame(false);
    }, 2500);
  }
}
```

**3. 新增 IPC：**

- `claudepet:test-notification(category)` — 在主进程构造一个伪状态对象走 `maybeNotify`，让用户在设置里就能验证通知通道；
- `claudepet:reset-status` — 把 `state.session.cwd / status` 等会话字段清空回 idle，保留 cost / usage 等统计；

**4. preload：** 暴露 `testNotification` / `resetStatus`。

**5. 「显示设置」UI 改造（`renderAppearanceTab`）：**

- 把"系统通知 / 闪烁窗口"两个开关拆到一个独立的「通知设置」section；
- 新增三个分类开关：「完成时通知」「需要权限 / 输入时通知」「出错时通知」；
- 加四个按钮：「测试：完成通知」「测试：权限通知」「测试：出错通知」「重置当前显示」；
- 一行 section-hint 提示通知依赖 hooks 已安装。

### C. 启动时清理 stale state

`src/main/main.js` 新增 `clearStaleState()`，在 `boot()` 最前面调用：

```js
function clearStaleState() {
  try {
    const updatedAt = Date.parse(state.updatedAt || 0);
    const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Infinity;
    const STALE_AFTER_MS = 30 * 60 * 1000; // 30 分钟无更新视为过期
    const cwd = state.session && state.session.cwd;
    let cwdMissing = false;
    if (cwd) {
      try { cwdMissing = !require("node:fs").existsSync(cwd); } catch (_) {}
    }
    if (ageMs > STALE_AFTER_MS || cwdMissing) {
      state = {
        ...state,
        session: { ...(state.session || {}), cwd: "", cwdName: "", id: "" },
        status: {
          kind: "idle", label: "Claude Code is ready", detail: "",
          severity: "info", attention: false, animation: "idle",
          updatedAt: new Date().toISOString()
        },
        activeSubagent: null
      };
      state.updatedAt = new Date().toISOString();
      saveRuntimeState(state);
    }
  } catch (_) { /* swallow */ }
}
```

判定条件：
- `state.updatedAt` > 30 分钟前 → 视为过期；
- 或者 `session.cwd` 指向的目录已不存在 → 视为残留；
- 满足任意一条就把会话相关字段重置成 idle，**保留** `cost / context / tokens / git / usage / history` 等统计类数据。

### 使用方式（重启 ClaudePet 后）

1. 打开任意项目跑一段 Claude Code 任务，到完成时桌面应弹出 **「[完成] Claude finished」** 通知，任务栏图标闪烁。
2. Claude 索要权限（PreToolUse 拦截 / Notification 事件）时弹 **「[需要交互]」** 通知。
3. 工具失败 / Claude 报错时弹 **「[出错]」** 通知。
4. 点击通知 → 桌宠激活并显示设置中心，立刻看到详情。
5. 三类通知都可以在「显示设置 → 通知设置」里单独开关；不想要任何通知时关闭总开关「启用系统通知」。
6. 设置里有三个「测试」按钮，按一下就能确认通道是否畅通——不需要专门跑一个 Claude 任务来验证。
7. 启动时若桌宠还显示着之前那个项目的旧目录 / 旧 detail，clearStaleState 会自动清理；若它没识别到，也可以手动点「重置当前显示」按钮。

## 四、已知遗留问题：切换 Claude Code 会话时显示旧目录的内容

### 现象

用户切换到另一个 Claude Code 终端窗口（不同目录 / 不同 session）后，桌宠气泡里**仍显示之前那个项目的最后一次输出**。

### 原因

ClaudePet 的渲染状态由 `src/main/main.js` 里的全局 `state` 维护：

- 每个 Claude Code 进程通过 statusLine / hook 向 `bridge-server` 投递事件。
- `updateStateFromEvent()` 直接把 `event.state` 展开覆盖到全局 `state`：
  ```js
  state = { ...state, ...event.state, status: mergedStatus, activeSubagent: ... };
  ```

也就是说，桌宠**只在收到新 statusLine 事件时更新**，并不知道用户当前 OS 焦点在哪个 Claude Code 窗口。切焦点本身不会触发事件，旧内容因此保留在气泡里。

### 暂未实施修复的原因

要真正解决需要做下面其中一种：

| 方案 | 思路 | 代价 |
| --- | --- | --- |
| A. 按 `session.id` 分通道存储 | bridge 收事件时按会话存一份；按"最近活跃 / 手动选择"切换显示 | 改 `runtime-state.js` 数据结构，UI 加切换器 |
| B. 检测前台进程 / 终端 | 用 OS API 拿当前前台窗口，匹配到对应 `session.cwd` | Windows 端要用 `node-ffi` / `active-win` 之类依赖，跨平台不一致 |
| C. 在 stop hook 里发"清空"事件 | Claude Code 退出会话时主动 POST 一条 reset 刷掉旧 detail | 简单，但只解决"会话结束"那一刻；切焦点仍停留 |

建议先讨论选型再动手。本文档先记录现状与可选方向。

---

## 五、整体验证清单

启动应用后建议依次确认：

1. **拖动稳定性**：把宠物来回拖几十次，窗口宽高不变、宠物与气泡相对位置不变。
2. **奔跑动画**：开启 `runOnDrag` 时拖动会切到 `run` 动画；关闭后保持当前 idle / 工作姿势。
3. **拖动时 pointer 滑出窗口**：快速把鼠标滑到屏外再滑回，不应出现明显跳跃。
4. **应用菜单**：设置中心顶部菜单显示为中文（文件 / 编辑 / 视图 / 窗口 / 帮助），「窗口」下拉为「最小化 / 缩放 / 关闭」。
5. **多 Claude Code 窗口**：当前为已知限制（见第四节），切焦点不会刷新桌宠气泡。
6. **路径迁移自愈**（见第六节）：在新目录跑 `claudepet install --scope user` 后，`~/.claude/settings.json` 里 14 个 hook 全部指向新路径，HP 进度条能随 token 用量爬升。
7. **命令行 statusLine**（见第七节）：Claude Code 终端底部状态行仍由 claude-hud 渲染（而非 claudepet 的 fallback `Opus 4.x | <项目> | ctx ...`）。
8. **通知提示音**（见第八节）：设置中心 → 「显示设置」→ 「提示音」预览能听到所选音色；点「测试：完成通知」时系统通知 + wav 同时响一次。

---

## 六、项目重命名（ClaudePet → ClaudePet2）：迁移与 install bug 修复

### 现象

用户把项目文件夹从 `D:\tools\ClaudePet` 改名为 `D:\tools\ClaudePet2` 后，出现一连串问题：

- 桌宠 HP 进度条不更新；
- `claude --continue` 在新目录下找不到旧会话历史；
- `claudepet start` 跑的还是旧目录的代码（虽然新代码在跑，但行为像旧版）；
- 重新执行 `claudepet install --scope user --preserve-statusline` 之后，settings.json 的 statusLine 字段被正确更新到新路径，**hooks 字段依然指向旧路径**。

### 根因有四条互相耦合

1. **PowerShell `$PROFILE` 里的 shim 写死了旧路径**：
   `C:\Users\charley\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1` 里有
   ```powershell
   function claudepet { node D:\tools\ClaudePet\bin\claudepet.js @args }
   ```
   于是终端敲的 `claudepet ...` 都走旧目录的代码。

2. **`~/.claude/settings.json` 的 14 个 hook 项仍指向旧路径**。Claude Code 触发事件时调用的是旧仓库里的 `bin/claudepet.js`，事件不会进新版的 bridge。

3. **statusLine 被 `claude-hud` 插件占用**（非 claudepet）。但 HP 条的 `usedPercentage` 是 `buildStatusLineState`（`src/shared/state.js`）解析 statusLine 输入里 `context_window` 字段得到的——claudepet 拿不到这个数据流，HP 就停在历史快照上。

4. **`src/shared/install.js` 的 `mergeHooks` 有一个老 bug**：
   ```js
   if (!existing.some(hasCcpetHook)) existing.push(buildHookEntry(matcher, hookCommand));
   ```
   检测到已存在含 `claudepet.js` 的 hook 就直接跳过，**不会把旧路径换成新路径**。所以哪怕重新跑 `install`，hook 路径也不刷新。

5. **Claude Code 按 cwd 路径分项目存会话**（`~/.claude/projects/<打平的路径>/`）。`D--tools-ClaudePet` 和 `D--tools-ClaudePet2` 是两个独立 project key，重命名后 `claude --continue` 在新 key 下找不到任何会话。

### 修复

#### 1. `src/shared/install.js` — `mergeHooks` 改成会刷新已有路径

新增 `refreshCcpetCommands(entry, hookCommand)`：

```js
function refreshCcpetCommands(entry, hookCommand) {
  if (!entry || !Array.isArray(entry.hooks)) return entry;
  const hooks = entry.hooks.map((hook) => {
    if (hook && hook.type === "command" && isClaudepetCommand(hook.command) && hook.command !== hookCommand) {
      return { ...hook, command: hookCommand };
    }
    return hook;
  });
  return { ...entry, hooks };
}

function mergeHooks(settings, hookCommand) {
  const hooks = { ...(settings.hooks || {}) };
  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
    const refreshed = existing.map((entry) => (hasCcpetHook(entry) ? refreshCcpetCommands(entry, hookCommand) : entry));
    if (!refreshed.some(hasCcpetHook)) refreshed.push(buildHookEntry(matcher, hookCommand));
    hooks[event] = refreshed;
  }
  return hooks;
}
```

要点：
- **先对所有已有 entry 做一次 refresh**（把旧 path 覆写成新 path），再判断要不要 append。
- 用 `hook.command !== hookCommand` 跳过已经是最新值的 hook，避免无谓的对象重建。
- 不动其他非 claudepet 的 hook（比如用户自己装的其它工具）。

#### 2. 一次性迁移（手动 + 命令）

| 步骤 | 操作 |
| --- | --- |
| a. PROFILE 函数指向新路径 | 把 `Microsoft.PowerShell_profile.ps1` 里的 `D:\tools\ClaudePet` 改成 `D:\tools\ClaudePet2`，下次开 PowerShell 或 `. $PROFILE` 生效 |
| b. 恢复旧会话 | `cp ~/.claude/projects/D--tools-ClaudePet/*.jsonl ~/.claude/projects/D--tools-ClaudePet2/` |
| c. 让 claudepet 接管 statusLine 同时保留 claude-hud 渲染 | 在 `D:\tools\ClaudePet2` 下跑 `node bin/claudepet.js install --scope user --preserve-statusline` |
| d. 修复 hooks 旧路径残留 | `mergeHooks` 修了之后再跑一次 install 即可；修之前需要手动 grep + 替换 settings.json |

#### 3. 验证

- `~/.claude/settings.json` 里 `grep ClaudePet`，只应出现 `ClaudePet2`；
- 打开 Claude Code 跑一段对话，HP 条会随着 token 用量爬升；
- `claude --continue` 在新目录下能恢复之前那条历史会话；
- 终端 `claudepet doctor` 输出指向 `~/.claudepet/`，且 Electron 路径可见。

### 将来再次改项目目录怎么办

修好 `mergeHooks` 之后流程极简：

1. PROFILE 函数路径同步；
2. 旧 project 目录的 `.jsonl` 搬过来（如要保留会话）；
3. 跑 `claudepet install --scope user [--preserve-statusline]` —— 一次同步 statusLine + 14 个 hook + backup。

---

## 七、Windows 上 legacy statusLine 兼容（Git Bash 检测）

### 现象

执行 `install --preserve-statusline` 后，`~/.claudepet/config.json` 里有 `legacyStatusLine.command`（claude-hud 的命令），按理 cli.js 在最后会调用它并把输出写回 stdout 给 Claude Code 显示。可是 Claude Code 终端 statusLine 显示的是 ClaudePet 的 fallback 文本（`Opus 4.7 | ClaudePet2 | ctx 9% | in ...`），不是 claude-hud 的样式。

### 根因

`src/cli.js` 的 `runLegacyStatusLine` 用 `spawn(command, [], { shell: true, ... })`。在 Node.js Windows 上 `shell: true` 默认使用 `cmd.exe`。而 claude-hud 的 statusLine 命令是 bash 语法：

```bash
cols=$(stty size </dev/tty 2>/dev/null | awk '{print $2}')
export COLUMNS=$(( ${cols:-120} > 4 ? ${cols:-120} - 4 : 1 ))
plugin_dir=$(ls -1d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-hud/*/ 2>/dev/null | sort -V | tail -1)
exec "/c/Program Files/nodejs/node" "${plugin_dir}dist/index.js"
```

`$(...)` / `${var:-default}` / `/c/Program Files/...` / `exec` 在 cmd.exe 下全部解析失败，子进程直接挂掉返回空字符串 → 触发 cli.js 的 fallback。

> Claude Code 本身没问题——它自己的 statusLine 执行环境是 bash（Git Bash），所以原配置可以正常工作。问题只出现在 claudepet 转发的那一层。

### 修复

`src/cli.js` 新增 `findBashShell()`：

```js
function findBashShell() {
  if (process.platform !== "win32") return null;
  const candidates = [
    process.env.CLAUDEPET_LEGACY_SHELL,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe"
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}
```

`runLegacyStatusLine` 改用动态 spawn：

```js
const bash = findBashShell();
const child = bash
  ? spawn(bash, ["-c", command], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  : spawn(command, [], { shell: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
```

要点：
- 优先用 Git Bash 跑 `bash -c <command>`；
- 找不到 bash 才退回 `shell: true`（适用于 macOS / Linux，以及命令本身就兼容 cmd 的边缘情况）；
- 支持 `CLAUDEPET_LEGACY_SHELL` 环境变量自定义 shell 路径，方便用 WSL bash / MSYS2 等。

### 验证

```bash
echo '{"context_window":{"used_percentage":9,...}}' | node bin/claudepet.js statusline
```

应输出 `[claude-hud] 正在初始化...` 这类 claude-hud 的产物（首次启动）或正式 statusLine 行，而不是 `Opus 4.7 | ClaudePet2 | ctx ... | ...` 的 fallback。

实际使用上：等 2 秒（Claude Code statusLine refreshInterval = 2），命令行 statusLine 会自动恢复 claude-hud 样式；桌宠仍能拿到 `context_window` 数据正常更新 HP。

---

## 八、自定义通知提示音

### 背景

用户参考开源 IDE 插件 [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 的"任务完成提示音"功能希望加到桌宠里：通知发生时不仅响系统提示，还能播自定义音色，且可在设置里试听。

> 不要"仅在 IDE 未聚焦时播放"这个过滤——简化掉。

### 设计选择

- **声音文件**：直接复用 jetbrains-cc-gui 的 5 个 `.wav`（MIT 协议，仓库见 `src/main/resources/sounds/`）。下载到 `src/renderer/assets/sounds/`，加 README 标注来源。总 5 个文件约 ~200KB。
- **播放方式**：Electron 渲染进程的 HTML5 `Audio` 元素，缓存 `Audio` 实例避免反复初始化。
- **触发面**：沿用原有 `onComplete / onPermission / onError` 三个分类开关；再加一个总开关 `customSound.enabled`。
- **避免双响**：两扇 Electron 窗口（pet / manager）都会加载 `renderer.js`，但只在 `view === "pet"` 时注册 `onPlaySound` 监听，保证一次通知只响一遍。
- **预览按钮**：直接在当前 manager 渲染进程里播——不走主进程 IPC——所以即便 pet 窗口被隐藏也能试听。

### 改动一览

| 文件 | 改动 |
| --- | --- |
| `src/shared/config.js` | `notifications` 默认值新增 `customSound: { enabled: true, preset: "ding", volume: 0.6 }` |
| `src/main/main.js` | 新增 `playNotificationSound(category)`；`maybeNotify` 末尾调用一次，通过 `petWindow.webContents.send("claudepet:play-sound", payload)` 发给渲染进程 |
| `src/preload.js` | 暴露 `onPlaySound(callback)` |
| `src/renderer/renderer.js` | `SOUND_PRESETS` 常量、`playPresetSound(preset, volume)`、`renderSoundSection(config)` 区块、`data-config-string` 表单绑定、预览按钮事件、IPC 监听（仅 pet 视图） |
| `src/renderer/styles.css` | `.sound-picker` / `.sound-preview` 布局 |
| `src/renderer/assets/sounds/` | 5 个 wav + `README.md`（标 MIT + 来源） |

### 配置 schema

```json
{
  "notifications": {
    "system": true,
    "sound": false,
    "flashWindow": true,
    "onComplete": true,
    "onPermission": true,
    "onError": true,
    "customSound": {
      "enabled": true,
      "preset": "ding",
      "volume": 0.6
    }
  }
}
```

- `enabled`：自定义提示音总开关，关闭后无论哪类事件都不响 wav。
- `preset`：5 个预设之一：`ding` / `bell` / `chime` / `success` / `task-complete`。
- `volume`：0~1。

### 主进程播放路径

```js
function maybeNotify(status) {
  // ... 既有逻辑 ...
  playNotificationSound(category);   // <-- 新增
}

function playNotificationSound(category) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const settings = (config.notifications && config.notifications.customSound) || {};
  if (!settings.enabled) return;
  petWindow.webContents.send("claudepet:play-sound", {
    preset: settings.preset || "ding",
    volume: typeof settings.volume === "number" ? settings.volume : 0.6,
    category
  });
}
```

> 注意：`notif.system === false` 时连系统通知都没有，IPC 之前就已 return；`notif[category] === false`（onComplete/onPermission/onError 单类关闭）同理。也就是说自定义提示音会**继承**整套系统通知开关的过滤行为，**只在它们都通过时**才会响。

### 渲染进程播放路径

```js
const soundCache = new Map();
let activeSoundEl = null;

function getSoundEl(preset) {
  const found = SOUND_PRESETS.find((entry) => entry.id === preset) || SOUND_PRESETS[0];
  let el = soundCache.get(found.id);
  if (!el) {
    el = new Audio(found.file);
    el.preload = "auto";
    soundCache.set(found.id, el);
  }
  return el;
}

function playPresetSound(preset, volume) {
  const el = getSoundEl(preset);
  if (activeSoundEl && activeSoundEl !== el) {
    try { activeSoundEl.pause(); activeSoundEl.currentTime = 0; } catch (_) { /* ignore */ }
  }
  el.volume = Math.max(0, Math.min(1, Number(volume ?? 0.6)));
  el.currentTime = 0;
  activeSoundEl = el;
  el.play()?.catch?.(() => { /* autoplay blocked */ });
}
```

要点：
- 第一次播过的 `<audio>` 缓存到 `soundCache`，连点不爆。
- 切换预设时停掉上一条，避免叠音。
- `play()` 的 Promise 兜底 catch，防止极端情况下浏览器策略拒绝播放抛错。

### UI（显示设置 tab 新区块）

`renderSoundSection(config)` 渲染：

- 一个 toggle：「启用自定义提示音」
- 一行 picker：select 下拉（5 预设）+ 预览 ▶ 按钮
- 一个 range：音量 0~100%

绑定走 `data-config-string` / `data-config-bool` / `data-config-number`，统一 `setDeep(patch, key, value)` + `updateConfig(patch)`。

预览按钮：

```js
$("[data-action='preview-sound']")?.addEventListener("click", () => {
  const sound = (model.config && model.config.notifications && model.config.notifications.customSound) || {};
  playPresetSound(sound.preset || "ding", typeof sound.volume === "number" ? sound.volume : 0.6);
});
```

### 验证

1. 重启桌宠（托盘→退出，再 `claudepet start`）。
2. 打开设置中心 → 「显示设置」→ 「提示音」区块。
3. 切换预设 + 点 ▶，应当试听到对应音色。
4. 点既有的「测试：完成通知」/「测试：权限通知」/「测试：出错通知」按钮，应当同时收到系统通知 + 自定义 wav 响一声。
5. 把「启用自定义提示音」关掉再试，wav 不响，系统通知照常。
6. 把「启用系统通知」关掉再试，两者都不响（自定义提示音继承总开关）。

### 与原 jetbrains-cc-gui 的差异

- 不包含「仅在 IDE 未聚焦时播放」——按用户要求精简。
- 不分事件配单独音色——所有触发的事件共享同一个 preset；如果将来想分类配音，可把 schema 改成 `customSound: { onComplete: "success", onPermission: "chime", onError: "alert" }` 并在 `playNotificationSound` 里用 `category` 取对应 preset。
- 用 HTML5 `Audio` 而非 Web Audio API：实现简单、文件 wav 即用，但生成式音色得回到 Web Audio。
