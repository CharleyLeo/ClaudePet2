const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { loadConfig } = require("./shared/config");
const { installSettings, uninstallSettings } = require("./shared/install");
const { listPets } = require("./shared/pets");
const { buildStatusLineState, formatFallbackStatusLine, statusFromHook } = require("./shared/state");
const { saveRuntimeState, loadRuntimeState, appendHistory } = require("./shared/runtime-state");
const { sendEventWithLaunch, resolveElectronBinary, readRuntime, launchApp } = require("./shared/bridge-client");
const { appHome, claudeHome, configPath, runtimePath, statePath } = require("./shared/paths");
const { clearPaused } = require("./shared/launch-flag");

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

function parseJson(text) {
  if (!text || !text.trim()) return {};
  return JSON.parse(text);
}

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

function resolveHudIndex() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || claudeHome();
    const base = path.join(configDir, "plugins", "cache");
    if (!fs.existsSync(base)) return null;
    let best = null;
    for (const market of fs.readdirSync(base)) {
      const hudBase = path.join(base, market, "claude-hud");
      if (!fs.existsSync(hudBase)) continue;
      for (const version of fs.readdirSync(hudBase)) {
        const index = path.join(hudBase, version, "dist", "index.js");
        if (!fs.existsSync(index)) continue;
        // 与 claude-hud 原命令的 `sort -V | tail -1` 一致：取最高版本。
        if (!best || version.localeCompare(best.version, undefined, { numeric: true }) > 0) {
          best = { version, index };
        }
      }
    }
    return best ? best.index : null;
  } catch {
    return null;
  }
}

function killProcessTree(child) {
  try {
    child.kill();
  } catch {
    // 忽略：进程可能已退出。
  }
  // Windows 下 child.kill() 只杀直接子进程，杀不掉 msys/shell 派生的进程树；taskkill /T 兜底。
  if (process.platform === "win32" && child && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // 忽略：taskkill 不可用时无兜底手段。
    }
  }
}

function runLegacyStatusLine(command, input, timeoutMs = 2200) {
  return new Promise((resolve) => {
    if (!command) return resolve(null);
    // Windows + claude-hud：直接用 node 运行插件入口，绕过 Git Bash。
    // 原命令 `bash -c "…exec node …/dist/index.js"` 在 Windows(msys) 下有三个坑：
    // ① msys 的 exec 会把 node 派生成新进程，child.kill()/超时杀不到 → 孤儿进程长期堆积；
    // ② exec 切断 stdin 管道，node 读不到 JSON 而挂死；③ windowsHide 传不到派生进程 → 弹空白窗口。
    // 直接 spawn(node) 后 child 就是真正的 node 子进程，三个问题一并消除。
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
      child = bash
        ? spawn(bash, ["-c", command], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
        : spawn(command, [], { shell: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    }
    let stdout = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killProcessTree(child);
      resolve(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(stdout || null);
    });
    try {
      child.stdin.end(input);
    } catch {
      // 忽略：子进程未就绪或已退出时写 stdin 会抛错。
    }
  });
}

function mergeStatePatch(patch) {
  const current = loadRuntimeState();
  const next = {
    ...current,
    ...patch,
    status: patch.status || current.status,
    history: patch.status ? appendHistory(current, patch.status) : current.history
  };
  saveRuntimeState(next);
  return next;
}

async function statusLineCommand() {
  const raw = await readStdin();
  let parsed = {};
  let state;
  try {
    parsed = parseJson(raw);
    state = buildStatusLineState(parsed);
  } catch (error) {
    state = buildStatusLineState({});
    state.status = {
      kind: "error",
      label: "claudepet could not parse statusLine JSON",
      detail: String(error.message || error),
      severity: "error",
      attention: false,
      animation: "error",
      updatedAt: new Date().toISOString()
    };
  }
  mergeStatePatch(state);
  await sendEventWithLaunch({ type: "statusline", raw: parsed, state, receivedAt: new Date().toISOString() });

  const config = loadConfig();
  const legacyCommand = config.legacyStatusLine && config.legacyStatusLine.command;
  const legacyOutput = legacyCommand ? await runLegacyStatusLine(legacyCommand, raw) : null;
  process.stdout.write(legacyOutput || `${formatFallbackStatusLine(state)}\n`);
}

async function hookCommand() {
  const raw = await readStdin();
  const parsed = parseJson(raw);
  const status = statusFromHook(parsed);
  mergeStatePatch({ status });
  await sendEventWithLaunch({ type: "hook", raw: parsed, status, receivedAt: new Date().toISOString() });
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      flags._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

function printInstallResult(result) {
  process.stdout.write(`claudepet installed for ${result.scope}\n`);
  process.stdout.write(`settings: ${result.settingsFile}\n`);
  if (result.backupPath) process.stdout.write(`backup: ${result.backupPath}\n`);
  process.stdout.write(`statusLine: ${result.statuslineCommand}\n`);
}

function printDoctor() {
  const runtime = readRuntime();
  const electron = resolveElectronBinary();
  const pets = listPets();
  process.stdout.write(`claudepet home: ${appHome()}\n`);
  process.stdout.write(`Claude home: ${claudeHome()}\n`);
  process.stdout.write(`config: ${configPath()}\n`);
  process.stdout.write(`state: ${statePath()}\n`);
  process.stdout.write(`runtime: ${runtimePath()}${runtime ? ` (${runtime.port})` : " (not running)"}\n`);
  process.stdout.write(`Electron: ${electron || "not installed"}\n`);
  process.stdout.write(`Pets: ${pets.map((pet) => pet.id).join(", ") || "none"}\n`);
}

function printHelp() {
  process.stdout.write(`claudepet commands

  claudepet statusline              Claude Code statusLine bridge
  claudepet hook                    Claude Code hooks bridge
  claudepet install --scope local   Install current project .claude/settings.local.json
  claudepet install --scope user    Install global ~/.claude/settings.json
  claudepet uninstall --scope local Remove current project integration
  claudepet start                   Launch the desktop pet
  claudepet pets                    List available pets
  claudepet doctor                  Show runtime diagnostics
`);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "statusline":
      return statusLineCommand();
    case "hook":
      return hookCommand();
    case "install":
      return printInstallResult(
        installSettings({
          scope: flags.scope || "local",
          cwd: process.cwd(),
          preserveStatusLine: Boolean(flags["preserve-statusline"])
        })
      );
    case "uninstall": {
      const result = uninstallSettings({ scope: flags.scope || "local", cwd: process.cwd() });
      process.stdout.write(`claudepet uninstalled for ${result.scope}\nsettings: ${result.settingsFile}\n`);
      return;
    }
    case "start": {
      // 手动启动 → 清除"暂停自动启动"标记，恢复后续 hook 事件的自动拉起能力。
      clearPaused();
      if (!launchApp()) {
        process.stderr.write("Electron is not installed. Run npm install first.\n");
        process.exitCode = 1;
      }
      return;
    }
    case "pets": {
      for (const pet of listPets()) {
        process.stdout.write(`${pet.id}\t${pet.displayName}\t${pet.columns}x${pet.rows} frames\n`);
      }
      return;
    }
    case "doctor":
      return printDoctor();
    case undefined:
    case "-h":
    case "--help":
      return printHelp();
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printHelp();
      process.exitCode = 1;
  }
}

module.exports = {
  main,
  runLegacyStatusLine
};
