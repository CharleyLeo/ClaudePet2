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
- 八、自定义通知提示音（含 Web Audio 改造 + wav 峰值归一化脚本）
- 九、批量优化（CSS 变量、sound manifest、滑条美化、Manager 懒加载、cwd 切换 reset）
- 十、开关桌宠 + 关闭即真退出（paused 标记，命令行手动重启）
- 十一、只藏桌宠不静音（关闭后台节流 + soundWhenHidden 开关）
- 十二、state.json 并发损坏修复（原子写 + 坏文件自愈）

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

### 后续：响度问题与两段优化

第一版上线后用户反馈"100% 音量还是太轻"。诊断 + 修复分两步：

#### 1) 实现层：HTML5 `Audio` → Web Audio API

`<audio>` 元素的 `volume` 硬性 clamp 在 0~1，没法软件放大。改用 Web Audio：

```js
function ensureAudioContext() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioContext = new Ctx();
  }
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

async function loadBuffer(preset) { /* fetch + decodeAudioData，结果缓存到 bufferCache Map */ }

function playPresetSound(preset, volume) {
  const ctx = ensureAudioContext();
  const gainValue = Math.max(0, Math.min(3, Number(volume ?? 0.6)));
  loadBuffer(preset).then((buffer) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = gainValue;          // 可以 > 1，最大软件放大 3×
    source.connect(gain).connect(ctx.destination);
    source.start(0);
  });
}
```

要点：
- `AudioBuffer` 解码一次后缓存，连点不重复 fetch；
- `bufferPending` Map 用来去重并发请求（首次 preview 还没解码完时第二次点）；
- `activeSoundSource.stop()` 处理切预设时的旧音源截断；
- UI 滑条 `max` 从 1 提到 2（200%）；`playPresetSound` 内 clamp 到 3，给后续手动改 `max=3` 留余地；
- field-hint 文字加上"超过 150% 可能轻微失真"提示。

> Autoplay 策略：浏览器要求 AudioContext 在用户手势之后才能 resume。Electron 渲染进程同样遵守。预览按钮算手势，所以预览过一次后通知触发也能稳定播放。

#### 2) 内容层：原始 wav 太轻 → 峰值归一化

继续诊断发现 5 个 wav 的**原始峰值只到 -10 ~ -12 dBFS**（用了 int16 范围的 ~25-30%），怪不得放大也吃力。新增 `scripts/normalize-sounds.js`：

```bash
node scripts/normalize-sounds.js              # 默认目标 -0.5 dBFS
node scripts/normalize-sounds.js --target=-1  # 更保守
node scripts/normalize-sounds.js --restore    # 还原
```

或通过 npm scripts：

```bash
npm run sounds:normalize
npm run sounds:restore
```

实现细节：
- 不依赖 ffmpeg/sox，纯 Node 直接读写 16-bit PCM WAV；
- 容错解析 RIFF chunk（跳过 LIST/JUNK 等非 fmt/data 块）；
- 首次运行把原版备份到 `assets/sounds/original/`，后续每次都从备份重算 → 幂等，可反复调 target；
- 只支持 `audioFormat=1`（PCM）和 `bitsPerSample=16`，遇到其它格式会报错跳过当前文件。

归一化结果：

| 文件 | 原峰值 | 放大倍数 | 新峰值 |
| --- | --- | --- | --- |
| bell.wav | -12.38 dBFS | ×3.93 | -0.5 dBFS |
| ding.wav | -12.04 dBFS | ×3.78 | -0.5 dBFS |
| chime.wav | -10.46 dBFS | ×3.15 | -0.5 dBFS |
| success.wav | -10.46 dBFS | ×3.15 | -0.5 dBFS |
| task-complete.wav | -10.46 dBFS | ×3.15 | -0.5 dBFS |

#### 综合效果

| 阶段 | 100% 滑条响度 | 滑到顶 | 失真 |
| --- | --- | --- | --- |
| 第一版（HTML5 Audio + 原始 wav） | 1.0× 原版 | 1.0×（卡死在 100%） | 无 |
| 第二版（Web Audio + GainNode） | 1.0× 原版 | 2.0× | 150%+ 略明显 |
| **当前（归一化后 + Web Audio）** | **≈ 3.5× 原版** | **≈ 7× 原版** | 软件放大段同上，归一化段无失真 |

通常 100% 已经够用，不需要再开 GainNode 软件放大，也就回避了失真。要进一步提升只需在脚本里把 `--target` 调到接近 0（比如 `0 dBFS` = 几乎贴满），不过没必要。

#### 还原路径

如果哪天觉得现在太响、或者想换一组源文件：

1. `npm run sounds:restore` 回到原版 wav；
2. 若想完全去掉 Web Audio 改造，回退 `src/renderer/renderer.js` 里 `playPresetSound` 那段到 git 历史里的 HTML5 `Audio` 版本即可，preload / main / config schema 都不需要动。

---

## 九、批量优化：CSS 变量、sound manifest、滑条美化、Manager 懒加载、cwd 切换 reset

> 集中处理一批"性价比高但散在各处"的小优化，一次提交完成。

### 9.1 HP / badge 几何参数 → CSS 变量

之前为微调 HP 条与 badge 的相对位置改了 N 次魔数（25 / 71 / 77 / 99 / 103 …）。每次都要重新口算 `HP-bottom + HP-height + gap` 这种公式，容易错。提成 `:root` 变量：

```css
:root {
  --stage-padding-bottom: 12px;     /* 与 .pet-stage padding 保持一致 */
  --hp-pet-gap: 13px;               /* HP 条底 ↔ 宠物顶 的间距 */
  --hp-block-height: 26px;          /* HP 块自身高度（含 padding+border，校准值） */
  --hp-badge-gap: 26px;             /* HP 顶 ↔ badge 底 的间距 */
}
```

`.hp` 和 `.complete-burst, .attention-badge, .error-badge` 改用 `calc()` 引用：

```css
.hp {
  bottom: calc(var(--stage-padding-bottom) + var(--hp-pet-gap) + var(--pet-render-height, 100px));
}
.complete-burst, .attention-badge, .error-badge {
  bottom: calc(var(--stage-padding-bottom) + var(--hp-pet-gap) + var(--hp-block-height) + var(--hp-badge-gap) + var(--pet-render-height, 100px));
}
```

数值兼容性：
- 旧 `25 = 12 + 13` ✓
- 旧 `77 = 12 + 13 + 26 + 26` ✓

后续要改"badge 上飘多远"或"HP 与宠物的呼吸距离"，改一行变量即可，不用动公式。

> 注：`--hp-block-height` 是手动校准值。如果以后改 HP 内部 padding/字号导致它的实际渲染高度变了，需要重新量一下并更新这个变量。要做到全自动可以用 JS 测量 `getBoundingClientRect()` 后 `setProperty`，但目前手动维护的成本比"加一段 ResizeObserver"低。

### 9.2 Sound preset → JSON manifest

之前 `SOUND_PRESETS` 数组写死在 `renderer.js`。和 pets 系统对齐，改成数据驱动：

新建 `src/renderer/assets/sounds/manifest.json`：

```json
[
  { "id": "ding", "label": "叮咚", "file": "ding.wav" },
  { "id": "bell", "label": "铃声", "file": "bell.wav" },
  ...
]
```

`renderer.js`：

```js
const SOUND_FALLBACK = [{ id: "ding", label: "叮咚", file: "./assets/sounds/ding.wav" }];
let SOUND_PRESETS = SOUND_FALLBACK;

async function loadSoundPresets() {
  try {
    const res = await fetch("./assets/sounds/manifest.json");
    if (!res.ok) throw new Error(`manifest http ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) throw new Error("manifest empty");
    SOUND_PRESETS = list.map((entry) => ({
      id: String(entry.id),
      label: String(entry.label || entry.id),
      file: `./assets/sounds/${entry.file}`
    }));
  } catch (_) {
    SOUND_PRESETS = SOUND_FALLBACK;
  }
}
```

`init()` 里 `Promise.all([getInitial, loadSoundPresets])` 并发等待，第一次 render 前 `SOUND_PRESETS` 已就绪。

加新音色现在的流程：

1. wav 丢进 `src/renderer/assets/sounds/`
2. 跑一次 `npm run sounds:normalize`（自动备份原版 + 归一化）
3. `manifest.json` 加一行 `{ "id": "xxx", "label": "中文名", "file": "xxx.wav" }`

完全不用动 JS。

### 9.3 滑条（range slider）美化

#### 现状

之前所有 `<input type="range">` 用浏览器默认样式，平庸；并且"当前 X%"hint 是渲染时算的静态文本，**拖动滑条不会更新数字**，让人困惑。

#### 设计

- 轨道（track）：6px 高、圆角 999、带内阴影；填充段用 `mint → cyan` 渐变，未填充段是半透明白
- 拇指（thumb）：18px 圆形，叠加 `radial-gradient` 左上高光 + `linear-gradient` 主体青色，带 cyan 发光阴影
- 状态：hover 放大 1.16，active 缩到 1.08（按下手感），focus-visible 加绿色 outline
- WebKit 和 Firefox 双重 vendor prefix（`::-webkit-slider-runnable-track` / `::-moz-range-track` / `::-webkit-slider-thumb` / `::-moz-range-thumb`）

#### 填充进度的 CSS-only 实现

range input 没有原生"已填充段"伪元素（Firefox 有 `::-moz-range-progress`，Chromium 没有）。Chromium 这边用 `--value` CSS 自定义属性 + 双 layer 背景：

```css
.range-field input[type="range"]::-webkit-slider-runnable-track {
  background:
    linear-gradient(90deg, var(--range-track-rest), var(--range-track-rest)),
    var(--range-track-fill);
  background-size: calc(100% - var(--value)) 100%, var(--value) 100%;
  background-position: right center, left center;
  background-repeat: no-repeat, no-repeat;
}
```

JS 同步更新 `--value`：

```js
function updateRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const val = Number(input.value);
  const span = max - min;
  const trackPct = span > 0 ? Math.max(0, Math.min(100, ((val - min) / span) * 100)) : 0;
  input.style.setProperty("--value", `${trackPct.toFixed(2)}%`);
  // 顺带把 .field-hint 里"当前 X%"改成实时值（解决之前 hint 不动的 bug）
  const wrapper = input.closest(".range-field");
  const hint = wrapper && wrapper.querySelector(".field-hint");
  if (hint) {
    hint.textContent = hint.textContent.replace(/当前\s*-?\d+%/, `当前 ${Math.round(val * 100)}%`);
  }
}
```

调用时机：在 `attachManagerEvents` 的 `data-config-number` 输入循环里，初次 render 调一次设置初始 `--value`，input 事件触发时再调一次（input 事件先于 `await updateConfig` 跑，保证 UI 即时反馈）。

#### 影响范围

3 个 range 全部受益：

- 音量（`notifications.customSound.volume`，max=2）
- 桌宠大小（`scale`，min=0.32 max=1.1）
- 窗口不透明度（`opacity`，min=0.35 max=1）

注意 trackPct（用于填充长度）和 `Math.round(val * 100)`（用于"当前 X%"hint 文本）是两个不同的算式：scale 在 0.5 时填充 ≈ 23%（落在 0.32~1.1 区间内的位置），但 hint 显示"当前 50%"。这是有意的——填充反映"在可调范围内的位置"，hint 反映"配置项的语义百分比"。

### 9.4 Manager 窗口懒加载

之前 `boot()` 里同时 `createPetWindow()` + `createManagerWindow()`，即便用户从不打开设置，BrowserWindow + preload + renderer 全部加载。Electron 一个空窗口大约 30-50MB。

#### 改动

`boot()` 里去掉 `createManagerWindow()`，让 `showManager()` 自己懒创建。同时 `showManager` 修一下"首次打开闪一下白屏"问题——createWindow 后 loadFile 是异步的，立刻 show 时内容还没渲染完：

```js
function showManager() {
  if (!managerWindow) {
    createManagerWindow();
    managerWindow.once("ready-to-show", () => {
      if (!managerWindow || managerWindow.isDestroyed()) return;
      managerWindow.show();
      managerWindow.focus();
    });
    return;
  }
  managerWindow.show();
  managerWindow.focus();
}
```

#### 行为差异

- 启动时少一个 BrowserWindow，启动更快、内存占用更低
- 第一次"打开设置"会有几百毫秒的加载延迟（loadFile + initial render）
- 第二次起跟之前一样秒开（窗口仍 hide-on-close 缓存）
- 关闭策略不变（`close` 事件转成 `hide()`）

如果将来想更激进——关闭就 destroy 不留缓存——把 `close` 处理器里的 `hide()` 改成 `null` + destroy 即可，但每次开都要等 loadFile，体验会变重。

### 9.5 多会话切换：cwd 变化时重置 status

#### 现象

CHANGELOG 第四节描述的老遗留：用户在多个 Claude Code 终端窗口（不同 `cwd`）间 alt-tab，桌宠气泡里**仍显示之前那个项目的最后一次输出**，直到新会话主动 fire 一次 statusline / hook 才覆盖。中间空窗期非常迷惑。

#### 实现：方案 C（hook 内联检测）

`updateStateFromEvent` 入口加一个 cwd 比对，发现 cwd 变了就先把 status 清回 idle，然后再让事件正常 merge：

```js
function incomingCwd(event) {
  if (event.type === "statusline") {
    return event.state && event.state.session && event.state.session.cwd;
  }
  if (event.type === "hook") {
    const raw = event.raw || {};
    return raw.cwd || (raw.workspace && raw.workspace.current_dir) || null;
  }
  return null;
}

function maybeResetForCwdChange(event) {
  const newCwd = incomingCwd(event);
  const oldCwd = state.session && state.session.cwd;
  if (!newCwd || !oldCwd || newCwd === oldCwd) return;
  state = {
    ...state,
    session: {
      ...(state.session || {}),
      cwd: newCwd,
      cwdName: path.basename(newCwd) || newCwd,
      id: ""
    },
    status: {
      kind: "idle", label: "Claude Code is ready", detail: "",
      severity: "info", attention: false, animation: "idle",
      updatedAt: new Date().toISOString()
    },
    activeSubagent: null
  };
}

function updateStateFromEvent(event) {
  maybeResetForCwdChange(event);
  // ... 原有的 statusline / hook 分支
}
```

要点：
- 仅在 `oldCwd && newCwd && oldCwd !== newCwd` 时触发，避免初次冷启动 oldCwd 为空时也被 reset
- reset 后立刻把 `session.cwd` 改成新值，下一次同 cwd 的事件就不会再误触发
- session.id 一并清空（旧 session id 跟旧 cwd 绑定，留着会让 detail row 显示错误的 8 字符摘要）

#### 与方案 A/B 的差异

CHANGELOG 第四节列了三种方案：

- A：按 session.id 分通道存储 + UI 切换器 → 数据结构改动大，UI 也要加
- B：探测前台进程匹配 cwd → Windows 要 native 调用，跨平台不一致
- **C（本次实现）：hook 内联检测 cwd** → 简单、跨平台、零额外依赖

C 的代价：切到新 Claude Code 窗口后，必须**触发一次事件**（敲键盘、跑工具、statusline 自然 refresh）才会 reset。最快也要等 ~2 秒（statusline refreshInterval=2s）。但比起原来"永远不更新"已经强很多，且不需要任何架构改动。

如果以后想做到"切焦点立即 reset"，再考虑做 B；目前 C 够用。

---

## 十、开关桌宠 + 关闭即真退出

> 两个关联需求：(1) 在「显示设置」加一个开关随时显示/隐藏桌宠；(2) 点关闭按钮就彻底退出，不要再被 Claude Code 事件自动拉起，重启只走命令行。

### 10.1 关闭即真退出：根因与 paused 标记

#### 根因

Claude Code 每次 hook / statusline 事件都经 `src/shared/bridge-client.js` 的 `sendEventWithLaunch` 投递。投递失败（桌宠没在跑）时，它默认会 `launchApp()` 自动把 Electron 拉起：

```js
async function sendEventWithLaunch(payload) {
  if (await sendEvent(payload)) return true;
  if (process.env.CLAUDEPET_NO_AUTO_LAUNCH === "1") return false;
  if (!launchApp()) return false;   // ← 这里把刚关掉的桌宠又拉起来了
  ...
}
```

所以"点关闭 → app 退出 → 下一个事件把它又拉起来"，表现为"关不掉、自动重启"。原本有个 `CLAUDEPET_NO_AUTO_LAUNCH` 环境变量能关，但那是临时的、不持久，也不适合给普通用户用。

#### 方案：持久标记文件 `~/.claudepet/paused.flag`

新增 `src/shared/launch-flag.js`：

```js
const { pausedFlagPath } = require("./paths");

function isPaused()  { try { return fs.existsSync(pausedFlagPath()); } catch { return false; } }
function setPaused() { /* mkdir -p + writeFile 时间戳 */ }
function clearPaused() { /* rmSync force */ }
```

`paths.js` 加 `pausedFlagPath() → appHome()/paused.flag`。

各处接线：

| 时机 | 行为 | 位置 |
| --- | --- | --- |
| 用户主动退出（关闭按钮 / 托盘退出 / 菜单退出） | `before-quit` → `setPaused()` 写标记 | `main.js` |
| Claude Code 事件投递失败 | `sendEventWithLaunch` 见 `isPaused()` → 直接 return，不拉起 | `bridge-client.js` |
| `claudepet start` | cli 先 `clearPaused()` 再 `launchApp()` | `cli.js` |
| app 正常 boot | `clearPaused()` 自愈遗留标记 | `main.js boot()` |

`sendEventWithLaunch` 改动：

```js
if (process.env.CLAUDEPET_NO_AUTO_LAUNCH === "1") return false;
if (isPaused()) return false;   // ← 新增：用户已主动退出，不自动拉起
if (!launchApp()) return false;
```

#### 关键边界：第二实例不能误写标记

`main.js` 用 `requestSingleInstanceLock()` 做单例。当桌宠已在运行、又跑一次 `claudepet start` 时，新进程抢锁失败会立即 `app.quit()` —— 这会触发 `before-quit`，如果无条件 `setPaused()`，第二实例就会**误写**标记。

虽然"运行中存在标记"本身无害（`isPaused` 只在 app 不可达、要走 launch 时才被检查），但有个真实坏场景：app 此后**崩溃**（非用户退出）→ 标记还在 → 下一个事件因 `isPaused()` 为真而拒绝自动拉起 → 用户没主动暂停却被卡住。

修复：加 `didBoot` 守卫，只有真正 `boot()` 过的主实例退出才写标记：

```js
let didBoot = false;
async function boot() { didBoot = true; clearPaused(); ... }
app.on("before-quit", () => {
  app.isQuitting = true;
  if (didBoot) setPaused();   // 抢锁失败而 quit 的第二实例 didBoot=false，不写
  if (bridge) bridge.close();
});
```

抢锁失败的第二实例从不进 `boot()`，`didBoot` 保持 false，于是不写标记。

### 10.2 开关桌宠：config.petVisible 统一显隐

#### 配置

`config.js` 加 `petVisible: true`（默认显示）。

#### 统一显隐入口

原先用一个运行时变量 `userHidden` 管隐藏状态，散落在多个地方（hidePet IPC、托盘显示/隐藏、通知点击、second-instance），且不持久。这次**删掉 `userHidden`**，全部统一到 `config.petVisible`：

```js
function applyPetVisibility() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (config.petVisible === false) {
    if (petWindow.isVisible()) petWindow.hide();
  } else if (!petWindow.isVisible()) {
    petWindow.showInactive();
  }
}

function setPetVisible(visible) {
  config = saveConfig({ petVisible: Boolean(visible) });
  applyPetVisibility();
  broadcast();
}
```

接线点：

| 入口 | 改动 |
| --- | --- |
| `applyWindowConfig()` 末尾 | 调 `applyPetVisibility()`，让设置面板里的开关（走 update-config IPC）即时生效 |
| `handleBridgeEvent` | `if (config.petVisible === false) return;` —— 隐藏时事件来了也不自动弹出 |
| `hidePet` IPC / 托盘"隐藏桌宠" | → `setPetVisible(false)` |
| 托盘"显示桌宠" / 通知点击 / second-instance | → `setPetVisible(true)`（或可见性判断） |
| `createPetWindow` 的 `ready-to-show` | `if (config.petVisible !== false) petWindow.showInactive();` —— 启动时若配置为隐藏则保持隐藏 |

#### UI

「显示设置」开关区第一项新增：

```html
<label class="toggle with-toggle-icon">
  ${icon("power")}
  <input type="checkbox" ${config.petVisible !== false ? "checked" : ""} data-config-bool="petVisible">
  <span>显示桌宠（关闭即隐藏窗口）</span>
</label>
```

因为 `data-config-bool` → update-config → `applyWindowConfig` → `applyPetVisibility` 这条链已经打通，开关直接用通用绑定即可，不需要专门的 IPC。

### 改动文件一览

| 文件 | 改动 |
| --- | --- |
| `src/shared/launch-flag.js`（新增） | isPaused / setPaused / clearPaused |
| `src/shared/paths.js` | 加 `pausedFlagPath()` |
| `src/shared/bridge-client.js` | `sendEventWithLaunch` 加 `isPaused()` 门控 |
| `src/cli.js` | `start` 命令先 `clearPaused()` |
| `src/shared/config.js` | 加 `petVisible: true` |
| `src/main/main.js` | 删 `userHidden`；加 `applyPetVisibility` / `setPetVisible` / `didBoot`；before-quit 写标记；boot 清标记；ready-to-show 尊重 petVisible |
| `src/renderer/renderer.js` | 显示设置加"显示桌宠"开关 |

### 验证

1. **开关桌宠**：设置 → 显示设置 → 取消"显示桌宠"，窗口立即消失；隐藏状态下让 Claude 跑任务，桌宠不自动冒出；重新勾选 → 窗口回来。
2. **真退出**：点桌宠"关闭"按钮 → app 退出；让 Claude Code 继续跑，桌宠**不再**自动重启（`~/.claudepet/paused.flag` 此时存在）。
3. **命令重启**：终端 `claudepet start` → 桌宠回来，标记被清除，自动拉起能力恢复。
4. **第二实例不误暂停**：桌宠运行中再跑一次 `claudepet start` → 只是把现有窗口唤到前台，不会写 paused 标记。

### 单元验证

`launch-flag` 的读/写/清/幂等用临时 `CLAUDEPET_HOME` 跑过断言，全部通过；`config.petVisible` 默认值确认为 `true`。

---

## 十一、只藏桌宠不静音（关闭后台节流 + soundWhenHidden 开关）

> 第十节做了"开关桌宠"，但隐藏桌宠后**提示音也一起没了**。本节让"只藏桌宠、保留提示音"成为可选项。

### 现象

在「显示设置」取消勾选"显示桌宠"后，窗口消失，同时 Claude 完成 / 出错时的自定义提示音也不再响——表现为"一关全关"。用户希望能"只把桌宠藏起来，但提示音照常"。

### 根因：不是逻辑挡的，是后台节流挂起了 Web Audio

很容易误判成"`petVisible === false` 的分支把声音 return 掉了"。但看 `handleBridgeEvent` 的实际顺序，`maybeNotify`（内部已调用 `playNotificationSound`）是在 `petVisible` 判断**之前**就执行的：

```js
async function handleBridgeEvent(event) {
  recordUsageFromEvent(event);
  updateStateFromEvent(event);
  broadcast();
  maybeNotify(event.status);        // ← 播放声音在这里，早于下面的 return
  if (config.petVisible === false) return;   // 只是跳过"自动弹出桌宠"
  if (petWindow && !petWindow.isVisible()) petWindow.showInactive();
}
```

所以逻辑上隐藏并不会拦掉声音。真凶是 Electron 的 **`backgroundThrottling`（默认 `true`）**：`petWindow.hide()` 后，这个隐藏窗口的渲染进程被整体节流 / 挂起，渲染进程里的 `AudioContext` 随之停摆，`source.start(0)` 出不了声。表现就成了"隐藏桌宠 = 连声音都没了"。

> 副带知识点：窗口隐藏时 `requestAnimationFrame` 本就不触发（rAF 绑定到合成器/显示），所以关掉 `backgroundThrottling` 不会让桌宠动画在后台空转，CPU 开销可忽略；它主要影响的是定时器与音频，正是我们要保住的。

### 方案：两步

#### 1) 关掉隐藏窗口的后台节流

`src/main/main.js` 的 `createPetWindow()` 给 `webPreferences` 加一行：

```js
webPreferences: {
  preload: path.join(__dirname, "..", "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  // 隐藏桌宠后仍需播放提示音：关闭后台节流，避免窗口 hide() 后渲染进程被挂起、
  // Web Audio 的 AudioContext 随之停摆。隐藏时 rAF 本就不触发，CPU 开销可忽略。
  backgroundThrottling: false
}
```

> 这是窗口**创建期**参数，对正在运行的实例不生效——需要退出后用 `claudepet start` 重新拉起才会带上。

#### 2) 加显式开关 `soundWhenHidden`

光关节流会让"隐藏时永远有声"，但用户可能也想要旧的"全关"。于是加一个可选开关，默认保留声音：

`src/shared/config.js` 顶层新增：

```js
runOnDrag: true,
petVisible: true,
soundWhenHidden: true,   // 隐藏桌宠时是否仍播放提示音（默认是）
position: null,
```

`src/main/main.js` 的 `playNotificationSound` 加门控：

```js
function playNotificationSound(category) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const settings = (config.notifications && config.notifications.customSound) || {};
  if (!settings.enabled) return;
  // 桌宠被隐藏时是否继续播放提示音：soundWhenHidden=false 则随桌宠一起静音（旧的"全关"行为）
  if (config.petVisible === false && config.soundWhenHidden === false) return;
  petWindow.webContents.send("claudepet:play-sound", { ... });
}
```

### UI

「显示设置」开关区，"显示桌宠"下方新增一项：

```html
<label class="toggle with-toggle-icon">
  ${icon("bell")}
  <input type="checkbox" ${config.soundWhenHidden !== false ? "checked" : ""} data-config-bool="soundWhenHidden">
  <span>隐藏桌宠时仍播放提示音</span>
</label>
```

仍走通用的 `data-config-bool` → `update-config` 绑定：`update-config` 把 `config` 整体替换为合并后的新配置，所以下一次事件的 `playNotificationSound` 立刻读到最新的 `soundWhenHidden`，无需专门 IPC。

### 三种组合一览

| 显示桌宠 | 隐藏时仍播放提示音 | 效果 |
| --- | --- | --- |
| ✓ | —— | 正常显示 + 声音 |
| ✗ | ✓（默认） | **只藏桌宠，提示音照响** ← 本节新增 |
| ✗ | ✗ | 全关（第十节的旧行为，想要还能切回去） |

> 提示音本身的总开关仍是「通知设置」里的 `customSound.enabled`，与本开关互不冲突：`enabled=false` 时无论桌宠显隐都不响。

### 改动文件一览

| 文件 | 改动 |
| --- | --- |
| `src/shared/config.js` | 顶层加 `soundWhenHidden: true` |
| `src/main/main.js` | `createPetWindow` 加 `backgroundThrottling: false`；`playNotificationSound` 加 `petVisible===false && soundWhenHidden===false` 静音门控 |
| `src/renderer/renderer.js` | 「显示设置」加"隐藏桌宠时仍播放提示音"开关 |

### 验证

1. 退出桌宠，`claudepet start` 重新拉起（让 `backgroundThrottling: false` 生效）。
2. 设置 → 显示设置 → 取消"显示桌宠"、保持勾选"隐藏桌宠时仍播放提示音"。
3. 让 Claude 跑到完成 / 出错：窗口不出现，但提示音正常响。
4. 再取消"隐藏桌宠时仍播放提示音"，重复任务：窗口不出现且不再响（回到旧的全关行为）。
5. `node --check` 对 `config.js` / `main.js` / `renderer.js` 三个文件语法自检通过。

---

## 十二、state.json 并发损坏修复（原子写 + 坏文件自愈）

> 来源问题报告：`docs/优化记录_ClaudePet2_state_json损坏_20260623.md`。
> 现象是 Claude Code 状态栏整条**完全空白**——claude-hud 也被连带卡住，根因在 ClaudePet2 自己。

### 现象与根因

`~/.claudepet/state.json` 实际长度 16364 字符，预期约 16105 字符，**JSON 正常结束后被追加了一段 hook 的 raw stdin 文本**（对话内容片段）。再读时 `JSON.parse` 抛 `SyntaxError`，`readJson` 没接住直接向上抛，整个 statusline 链路死掉——而 statusLine 命令是 claude-hud 的转发入口，于是 claude-hud 也无内容输出，状态栏空白。

```
[claudepet] SyntaxError: Unexpected non-whitespace character after JSON at position 16105 (line 442 column 1)
    at JSON.parse (<anonymous>)
    at readJson (src/shared/json-file.js:10:17)
    at loadRuntimeState (src/shared/runtime-state.js:27:35)
    at mergeStatePatch (src/cli.js:79:19)
    at statusLineCommand (src/cli.js:109:3)
```

底下是两个独立的缺陷叠加：

1. **`writeJson` 不是原子写**：`fs.writeFileSync` 在 `O_WRONLY|O_CREAT|O_TRUNC` 下写大对象（state.json 十几 KB）并非单次 syscall。Claude Code 每次 hook + statusline 都会拉一个 `claudepet.js` 子进程；这些进程并发对同一个文件 truncate+write，会出现"进程 A 写 16105 字节 / 进程 B 同时 truncate 又只写到 16364 中段"这类混合产物，残留出一份长度不对、尾巴粘着另一个 payload 的坏文件。
2. **`readJson` 不容错**：`JSON.parse` 失败直接 `throw`，**一次写坏 = 永久死锁**——直到有人手动 `echo '{}' > state.json` 才能复活。

### 修复：`src/shared/json-file.js`

只动 `json-file.js` 一个文件就覆盖所有 JSON 持久化路径（state.json / config.json / pets manifest 全走它）。

#### 1) `writeJson` 改成 tmp + rename 原子写

```js
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const content = `${JSON.stringify(data, null, 2)}\n`;
  // tmp 名包含 pid + 时间戳 + 随机数，确保跨进程、同进程多次写都不会撞名
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch (renameError) {
      // Windows 下目标可能被瞬时打开（reader 或并发 writer 的 rename）→ EBUSY/EPERM/EACCES
      // 短窗口忙轮询 250ms 重试；最终失败才向上抛
      const transient = renameError && (renameError.code === "EBUSY" || renameError.code === "EPERM" || renameError.code === "EACCES");
      if (!transient) throw renameError;
      const deadline = Date.now() + 250;
      let lastError = renameError;
      while (Date.now() < deadline) {
        try { fs.renameSync(tmp, file); lastError = null; break; }
        catch (retry) { lastError = retry; }
      }
      if (lastError) throw lastError;
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    throw error;
  }
}
```

要点：

- **rename 本身在同盘是原子的**：POSIX `rename(2)`、Windows `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` 都保证目标要么完整旧、要么完整新，绝不可能停在"半新半旧"。这条性质把"高频并发写"从"互相覆盖"降级到"最后一个赢家说了算"——后者完全可接受。
- **tmp 名带 pid + ms + random**：同进程多次写串行没问题；不同进程同时写各用各的 tmp，不会撞名。
- **EBUSY 重试**：Windows 下若另一个 reader 进程正巧打开目标文件，rename 会瞬时失败；250ms 内忙轮询能覆盖几乎所有现实抖动。
- **失败清理 tmp**：避免 `.claudepet/` 目录里堆积孤儿 `.tmp.*` 文件。

#### 2) `readJson` 捕获 SyntaxError + 备份坏文件

```js
function readJson(file, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      // 坏 JSON 留证据再返回 fallback：避免一次写坏（如 hook 并发互踩）就把整条
      // statusline 链路永久阻断
      try {
        const backup = `${file}.broken.${Date.now()}`;
        fs.renameSync(file, backup);
        process.stderr.write(`[claudepet] corrupted JSON at ${file} moved to ${backup}\n`);
      } catch (_) { /* 备份失败不阻塞主流程 */ }
      return fallback;
    }
    throw error;
  }
}
```

要点：

- `ENOENT` 仍走 fallback（首次启动等正常路径）；
- 只对 `SyntaxError` 做自愈，其它 IO 异常向上抛；
- 坏文件 rename 成 `.broken.<时间戳>`——保留证据供事后排查，但不再阻塞链路；
- 提示信息写 stderr，运维能感知；写 stdout 会污染 statusline 的输出协议。

### 验证

新增并发压测脚本 `scripts/concurrent-write-test.js`，spawn N 个子进程同时反复 `readJson → mutate → writeJson` 同一文件，模拟 hook + statusline 并发：

```
$ node scripts/concurrent-write-test.js 8 200
workers=8 iterations=200  elapsed=1675ms
worker failures: 0
final readJson OK: true
final top-level keys: init, padding, updatedAt, w0, w1, w2, w3, w4, w5, w6, w7
.broken.* files produced: 0
.tmp.* orphan files: 0
RESULT: PASS
```

8 进程 × 200 次 = 1600 次跨进程写入,1.7 秒跑完;零损坏、零 broken 备份、零孤儿 tmp。

坏文件自愈路径单测（人为追加垃圾后再 readJson）:

```
corrupted file size: 141
[claudepet] corrupted JSON at .tmp-broken-test.json moved to .tmp-broken-test.json.broken.1782183442529
readJson result: {"recovered":true}        ← 返回 fallback,不再 throw
broken backup count: 1                      ← 坏文件留证据
second readJson: {"secondRead":true}        ← 第二次自然走 ENOENT → fallback
```

### 改动文件一览

| 文件 | 改动 |
| --- | --- |
| `src/shared/json-file.js` | `writeJson` 改 tmp+rename 原子写（含 EBUSY 重试 + tmp 清理）；`readJson` 捕获 SyntaxError，把坏文件 rename 成 `.broken.<ts>` 后返回 fallback |
| `scripts/concurrent-write-test.js`（新增） | 并发写入压测脚本，spawn 子进程模拟 hook + statusline 并发，断言无损坏 |

### 为什么没引入 `proper-lockfile`

问题报告里建议过文件锁。当前方案不引入额外依赖也能跑通是因为：

- rename 的原子性已经把"半新半旧"消除了，**最后写者获胜**就是预期语义（statusline 本就是高频覆盖的快照）；
- read 容错把"已损坏文件"降级成"读到 fallback"，配合主进程内存里的 in-flight 状态不会丢业务数据；
- 文件锁会引入跨进程协调成本，且在崩溃时锁残留是个新问题。

如果将来出现"并发写 + 业务上必须保留每次写入内容"的场景（不是覆盖快照而是累积日志），再考虑改成 append-only 事件日志 + 启动折叠，或者上 `proper-lockfile`。

### 相关历史

事故详情见 `docs/优化记录_ClaudePet2_state_json损坏_20260623.md`。当时的临时处理是把坏文件备份到 `~/.claudepet/state.json.broken.20260623-104658` 并 `echo '{}'` 重置——本节修复后这种手动复活流程不再需要，自动走 `.broken.<ts>` 备份 + fallback 返回。
