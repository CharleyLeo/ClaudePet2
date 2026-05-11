# 拖动桌宠相关问题修复记录

> 本文档记录三个相关问题的完整排查与修复过程：
> 1. 拖动时窗口"横向越来越大、宠物离窗口边缘越来越远"（真凶）
> 2. 拖动时的奔跑（run）动画开关 —— 已重新启用
> 3. 应用菜单中文化 —— 见末尾章节
> 4. 已知遗留问题：切换 Claude Code 会话窗口时桌宠仍显示旧目录的聊天

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
