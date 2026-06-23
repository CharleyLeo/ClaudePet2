const path = require("node:path");
const { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, Tray } = require("electron");
const { startBridgeServer } = require("./bridge-server");
const { loadConfig, saveConfig } = require("../shared/config");
const { listPets, savePetManifest } = require("../shared/pets");
const { loadRuntimeState, saveRuntimeState, appendHistory } = require("../shared/runtime-state");
const { recordSnapshot, snapshotFromState, projectKeyFrom, pruneOldData, getUsageOverview } = require("../shared/usage");
const { setPaused, clearPaused } = require("../shared/launch-flag");

const APP_NAME = "ClaudePet";
const APP_USER_MODEL_ID = "com.liuchenlili.ClaudePet";
const PET_WINDOW_WIDTH = 438;
const PET_WINDOW_HEIGHT = 338;

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let petWindow = null;
let managerWindow = null;
let tray = null;
let bridge = null;
let config = loadConfig();
let state = loadRuntimeState();
let savePositionTimer = null;
let didBoot = false;

function rendererPayload() {
  return {
    state,
    config,
    pets: listPets(),
    appVersion: app.getVersion()
  };
}

function broadcast(channel = "claudepet:update") {
  const payload = rendererPayload();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function isRecentActiveStatus(status) {
  if (!status || status.kind === "idle") return false;
  const updatedAt = Date.parse(status.updatedAt || 0);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < 30000;
}

function recordUsageFromEvent(event) {
  if (!config.stats || config.stats.enabled === false) return;
  if (event.type !== "statusline") return;
  const eventState = event.state || {};
  const sessionId = eventState.session && eventState.session.id;
  if (!sessionId) return;
  const snapshot = snapshotFromState(eventState);
  if (!snapshot) return;
  const projectKey = projectKeyFrom(event.raw || {}) || (eventState.session && eventState.session.cwdName) || "unknown";
  const model = (eventState.session && eventState.session.model && (eventState.session.model.id || eventState.session.model.display_name)) || "";
  try {
    recordSnapshot({ sessionId, projectKey, model, snapshot });
  } catch (error) {
    // Avoid breaking the bridge on stats failures.
    if (process.env.CLAUDEPET_DEBUG) console.error("[claudepet] usage record failed", error);
  }
}

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
  // 用户在多个 Claude Code 终端窗口（不同 cwd）间切换时，旧会话的最后一条 detail 会
  // 一直挂在桌宠气泡里直到新会话主动 fire 一次事件覆盖。这里检测到 cwd 变化时立刻把
  // status 清回 idle，避免"切到新项目还看见旧项目的输出"。
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
      kind: "idle",
      label: "Claude Code is ready",
      detail: "",
      severity: "info",
      attention: false,
      animation: "idle",
      updatedAt: new Date().toISOString()
    },
    activeSubagent: null
  };
}

function updateStateFromEvent(event) {
  maybeResetForCwdChange(event);
  if (event.type === "statusline") {
    const incoming = event.state.status || null;
    const activeStatus = isRecentActiveStatus(state.status) ? state.status : null;
    let mergedStatus;
    if (activeStatus) {
      // Keep the sticky hook kind/label/animation, but always pull the freshest
      // assistant output (detail) from the latest statusline event.
      mergedStatus = incoming && incoming.detail !== undefined
        ? { ...activeStatus, detail: incoming.detail, updatedAt: activeStatus.updatedAt }
        : activeStatus;
    } else {
      mergedStatus = incoming || state.status;
    }
    state = {
      ...state,
      ...event.state,
      status: mergedStatus,
      activeSubagent: state.activeSubagent || null
    };
  } else if (event.type === "hook") {
    const status = event.status || {};
    let activeSubagent = state.activeSubagent || null;
    if (status.kind === "subagent-running") {
      activeSubagent = {
        type: status.subagentType || "agent",
        since: status.updatedAt || new Date().toISOString()
      };
    } else if (status.kind === "subagent-complete" || status.subagentEnded) {
      activeSubagent = null;
    }
    state = {
      ...state,
      status,
      history: appendHistory(state, status),
      activeSubagent
    };
  }
  state.updatedAt = new Date().toISOString();
  saveRuntimeState(state);
}

function notificationCategory(status) {
  if (!status) return null;
  const kind = status.kind;
  if (kind === "completed") return "onComplete";
  if (
    kind === "waiting-permission" ||
    kind === "waiting-input" ||
    kind === "notification"
  ) return "onPermission";
  if (
    kind === "error" ||
    kind === "tool-error" ||
    status.severity === "error"
  ) return "onError";
  // 兜底：有 attention 但不属于上面三类（少数 hook 事件），按通用通知处理
  if (status.attention) return "onPermission";
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
    n.on("click", () => {
      if (petWindow && !petWindow.isDestroyed()) {
        if (config.petVisible === false) setPetVisible(true);
        else if (!petWindow.isVisible()) petWindow.showInactive();
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
  playNotificationSound(category);
}

function playNotificationSound(category) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const settings = (config.notifications && config.notifications.customSound) || {};
  if (!settings.enabled) return;
  // 桌宠被隐藏时是否继续播放提示音：soundWhenHidden=false 则随桌宠一起静音（旧的"全关"行为）
  if (config.petVisible === false && config.soundWhenHidden === false) return;
  petWindow.webContents.send("claudepet:play-sound", {
    preset: settings.preset || "ding",
    volume: typeof settings.volume === "number" ? settings.volume : 0.6,
    category
  });
}

async function handleBridgeEvent(event) {
  recordUsageFromEvent(event);
  updateStateFromEvent(event);
  broadcast();
  maybeNotify(event.status);
  // 用户在「显示设置」里关掉桌宠（petVisible=false）时，事件来了也不自动弹出。
  if (config.petVisible === false) return;
  if (petWindow && !petWindow.isVisible()) petWindow.showInactive();
}

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

function assetPath(name) {
  return path.join(__dirname, "..", "renderer", "assets", name);
}

function windowIconPath() {
  return process.platform === "win32" ? assetPath("app-icon.ico") : assetPath("app-icon.png");
}

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function relaunchCommand() {
  if (!process.defaultApp) return quoteCommandArg(process.execPath);
  return `${quoteCommandArg(process.execPath)} ${quoteCommandArg(app.getAppPath())}`;
}

function applyWindowAppDetails(window) {
  if (process.platform !== "win32" || !window || window.isDestroyed()) return;
  window.setIcon(windowIconPath());
  window.setAppDetails({
    appId: APP_USER_MODEL_ID,
    appIconPath: windowIconPath(),
    relaunchCommand: relaunchCommand(),
    relaunchDisplayName: APP_NAME
  });
}

function trayIconImage() {
  return nativeImage.createFromPath(process.platform === "win32" ? assetPath("app-icon.ico") : assetPath("app-icon-32.png"));
}

function menuIconImage() {
  return nativeImage.createFromPath(assetPath("app-icon-16.png"));
}

function applyWindowConfig() {
  if (!petWindow) return;
  petWindow.setAlwaysOnTop(Boolean(config.alwaysOnTop), "screen-saver");
  petWindow.setOpacity(Number(config.opacity || 1));
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
    // 用 setBounds 显式固定宽高，防止任何启动路径意外把窗口拉大。
    petWindow.setBounds({ x, y, width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT }, false);
  }
  applyPetVisibility();
}

function schedulePositionSave() {
  if (!petWindow || petWindow.isDestroyed()) return;
  clearTimeout(savePositionTimer);
  savePositionTimer = setTimeout(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const [x, y] = petWindow.getPosition();
    config = saveConfig({ position: { x, y } });
    broadcast();
  }, 180);
}

function createPetWindow() {
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
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    icon: windowIconPath(),
    title: APP_NAME,
    alwaysOnTop: Boolean(config.alwaysOnTop),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏桌宠后仍需播放提示音：关闭后台节流，避免窗口 hide() 后渲染进程被挂起、
      // Web Audio 的 AudioContext 随之停摆。隐藏时 rAF 本就不触发，CPU 开销可忽略。
      backgroundThrottling: false
    }
  });
  applyWindowAppDetails(petWindow);
  petWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: { view: "pet" } });
  petWindow.once("ready-to-show", () => {
    applyWindowConfig();
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    // 启动时若配置为"关闭桌宠"，保持隐藏（applyWindowConfig 里的 applyPetVisibility
    // 已处理，这里仅在可见时显示）。
    if (config.petVisible !== false) petWindow.showInactive();
  });
  petWindow.on("moved", schedulePositionSave);
}

function createManagerWindow() {
  // 从 config 读上次窗口尺寸,首次启动用默认 960×700
  const stored = (config && config.managerWindow) || {};
  const initialWidth = Math.max(820, Number(stored.width) || 960);
  const initialHeight = Math.max(600, Number(stored.height) || 700);

  managerWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 820,
    minHeight: 600,
    show: false,
    title: "ClaudePet 设置中心",
    icon: windowIconPath(),
    // 让 Windows 11 的 min/max/close 按钮直接画在我们的玻璃 header 上,
    // 标题栏跟 header 视觉融合(再也没有那条突兀的白色系统栏)
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "win32" ? {
      color: "#0a0e1a",
      symbolColor: "#c8d0e8",
      height: 40
    } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyWindowAppDetails(managerWindow);
  managerWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: { view: "manager" } });

  // 防抖持久化窗口尺寸:用户拖完边框 300ms 后才写盘,避免 resize 期间频繁 IO
  let resizeTimer = null;
  managerWindow.on("resize", () => {
    if (!managerWindow || managerWindow.isDestroyed()) return;
    if (managerWindow.isMaximized() || managerWindow.isMinimized() || managerWindow.isFullScreen()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!managerWindow || managerWindow.isDestroyed()) return;
      const [width, height] = managerWindow.getSize();
      config = saveConfig({ managerWindow: { width, height } });
    }, 300);
  });

  managerWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      managerWindow.hide();
    }
  });
}

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

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: "about", label: "关于 ClaudePet" },
            { type: "separator" },
            { role: "services", label: "服务" },
            { type: "separator" },
            { role: "hide", label: "隐藏 ClaudePet" },
            { role: "hideOthers", label: "隐藏其他" },
            { role: "unhide", label: "显示全部" },
            { type: "separator" },
            { role: "quit", label: "退出 ClaudePet" }
          ]
        }]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "打开设置中心", click: () => showManager() },
        { type: "separator" },
        isMac ? { role: "close", label: "关闭窗口" } : { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
              { role: "delete", label: "删除" },
              { role: "selectAll", label: "全选" }
            ]
          : [
              { role: "delete", label: "删除" },
              { type: "separator" },
              { role: "selectAll", label: "全选" }
            ])
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "切换开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front", label: "前置全部窗口" },
              { type: "separator" },
              { role: "window", label: "窗口" }
            ]
          : [{ role: "close", label: "关闭" }])
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "打开项目主页",
          click: async () => {
            const { shell } = require("electron");
            await shell.openExternal("https://github.com/liuchenlili/ClaudePet");
          }
        }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

function createTray() {
  tray = new Tray(trayIconImage());
  tray.setToolTip("ClaudePet Claude Code 桌宠");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示桌宠",
        click: () => setPetVisible(true)
      },
      {
        label: "隐藏桌宠",
        click: () => setPetVisible(false)
      },
      { label: "打开设置", icon: menuIconImage(), click: showManager },
      { type: "separator" },
      {
        label: "总在最前",
        type: "checkbox",
        checked: Boolean(config.alwaysOnTop),
        click: (item) => {
          config = saveConfig({ alwaysOnTop: item.checked });
          applyWindowConfig();
          broadcast();
        }
      },
      { label: "退出", click: () => app.quit() }
    ])
  );
  tray.on("double-click", showManager);
}

function registerIpc() {
  ipcMain.handle("claudepet:get-initial", () => rendererPayload());
  ipcMain.handle("claudepet:update-config", (_event, patch) => {
    config = saveConfig(patch || {});
    applyWindowConfig();
    broadcast();
    return rendererPayload();
  });
  ipcMain.handle("claudepet:save-pet-manifest", (_event, petId, patch) => {
    const pet = savePetManifest(petId, patch || {});
    broadcast();
    return pet;
  });
  ipcMain.handle("claudepet:open-manager", () => {
    showManager();
    return true;
  });
  ipcMain.handle("claudepet:hide-pet", () => {
    setPetVisible(false);
    return true;
  });
  ipcMain.handle("claudepet:drag-window", (_event, delta) => {
    if (!petWindow || petWindow.isDestroyed()) return false;
    const dx = Math.round(Number(delta && delta.dx) || 0);
    const dy = Math.round(Number(delta && delta.dy) || 0);
    if (!dx && !dy) return true;
    // 关键：使用硬编码的常量宽高，不要回读 getBounds().width/height。
    // 在 Windows HiDPI 下 getBounds 可能返回 438.x 的亚像素值，
    // 写回 setBounds 时会被取整为 439，再读 → 440 → ...，
    // 形成"每次拖动窗口横向变大几像素"的反馈循环。
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
  ipcMain.handle("claudepet:set-passthrough", (_event, ignore) => {
    if (!petWindow || petWindow.isDestroyed()) return false;
    if (ignore) petWindow.setIgnoreMouseEvents(true, { forward: true });
    else petWindow.setIgnoreMouseEvents(false);
    return true;
  });
  ipcMain.handle("claudepet:quit-app", () => {
    app.quit();
    return true;
  });
  ipcMain.handle("claudepet:test-notification", (_event, category) => {
    const cat = category || "onComplete";
    const mockStatus = {
      kind:
        cat === "onPermission" ? "waiting-permission" :
        cat === "onError" ? "error" : "completed",
      label:
        cat === "onPermission" ? "Claude 等待你的确认" :
        cat === "onError" ? "Claude 出错了" :
        "Claude 完成了一轮回复",
      detail: "这是一条测试通知。点击应当激活桌宠 / 设置中心。",
      attention: true,
      severity: cat === "onError" ? "error" : "info"
    };
    maybeNotify(mockStatus);
    return true;
  });
  ipcMain.handle("claudepet:reset-status", () => {
    state = {
      ...state,
      session: { ...(state.session || {}), cwd: "", cwdName: "", id: "" },
      status: {
        kind: "idle",
        label: "Claude Code is ready",
        detail: "",
        severity: "info",
        attention: false,
        animation: "idle",
        updatedAt: new Date().toISOString()
      },
      activeSubagent: null
    };
    state.updatedAt = new Date().toISOString();
    saveRuntimeState(state);
    broadcast();
    return rendererPayload();
  });
  ipcMain.handle("claudepet:get-usage", () => {
    try {
      return getUsageOverview();
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) };
    }
  });
}

function clearStaleState() {
  // 启动时若发现 state 是很久以前残留的（或者 session.cwd 已不存在），
  // 把会话/状态字段重置为空闲，避免气泡里一直挂着上一个项目的旧数据。
  // 保留 cost / usage / git 等历史统计，只清"当前会话内容"。
  try {
    const updatedAt = Date.parse(state.updatedAt || 0);
    const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Infinity;
    const STALE_AFTER_MS = 30 * 60 * 1000; // 30 分钟无更新即视为过期
    const cwd = state.session && state.session.cwd;
    let cwdMissing = false;
    if (cwd) {
      try {
        cwdMissing = !require("node:fs").existsSync(cwd);
      } catch (_) { cwdMissing = false; }
    }
    if (ageMs > STALE_AFTER_MS || cwdMissing) {
      state = {
        ...state,
        session: { ...(state.session || {}), cwd: "", cwdName: "", id: "" },
        status: {
          kind: "idle",
          label: "Claude Code is ready",
          detail: "",
          severity: "info",
          attention: false,
          animation: "idle",
          updatedAt: new Date().toISOString()
        },
        activeSubagent: null
      };
      state.updatedAt = new Date().toISOString();
      saveRuntimeState(state);
      if (process.env.CLAUDEPET_DEBUG) {
        console.log("[claudepet] cleared stale state", { ageMs, cwdMissing });
      }
    }
  } catch (error) {
    if (process.env.CLAUDEPET_DEBUG) console.error("[claudepet] clearStaleState failed", error);
  }
}

async function boot() {
  didBoot = true;
  // app 已经起来了，"暂停自动启动"标记没有意义了，清掉（自愈遗留标记）。
  clearPaused();
  try {
    const retention = Number(config.stats && config.stats.retentionDays);
    if (Number.isFinite(retention) && retention > 0) pruneOldData(retention);
  } catch (error) {
    if (process.env.CLAUDEPET_DEBUG) console.error("[claudepet] usage prune failed", error);
  }
  clearStaleState();
  registerIpc();
  // 桌宠 app 用不到 "文件/编辑/视图/窗口/帮助" 这套标准菜单,且白色 menubar
  // 跟玻璃 + 霓虹 header 视觉断层 —— 直接禁用应用菜单。
  // 如需恢复:Menu.setApplicationMenu(buildAppMenu())。
  Menu.setApplicationMenu(null);
  createPetWindow();
  // managerWindow 改为懒创建：首次 showManager() 时才会 createManagerWindow()，
  // 启动时不浪费内存（一个 BrowserWindow + preload + renderer 都不轻）。
  createTray();
  bridge = await startBridgeServer({
    getState: rendererPayload,
    onEvent: handleBridgeEvent,
    onConfig: (patch) => {
      config = saveConfig(patch || {});
      applyWindowConfig();
      broadcast();
      return rendererPayload();
    }
  });
  broadcast();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 再次执行 `claudepet start` 等于明确要求把桌宠唤回前台。
    if (petWindow && !petWindow.isDestroyed()) {
      if (config.petVisible === false) setPetVisible(true);
      else if (!petWindow.isVisible()) petWindow.showInactive();
      petWindow.focus();
    }
  });
  app.whenReady().then(boot);
}

app.on("before-quit", () => {
  app.isQuitting = true;
  // 用户主动退出（关闭按钮 / 托盘退出 / 菜单退出）→ 写"暂停自动启动"标记，
  // 之后 Claude Code 的 hook 事件不会再把桌宠自动拉起，只能 `claudepet start` 手动重启。
  // 仅在本实例真正 boot 过时才写：抢单例锁失败而 app.quit() 的"第二实例"不应写标记。
  if (didBoot) setPaused();
  if (bridge) bridge.close();
});

app.on("window-all-closed", (event) => {
  if (app.isQuitting) return;
  event.preventDefault();
});
