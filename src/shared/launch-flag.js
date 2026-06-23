const fs = require("node:fs");
const path = require("node:path");
const { pausedFlagPath } = require("./paths");

/**
 * "暂停自动启动"标记。用户点关闭按钮退出桌宠时写入；命令行 `claudepet start` 时清除。
 *
 * 作用：Claude Code 每次 hook / statusline 事件都会经 sendEventWithLaunch 尝试投递，
 * 投递失败（app 没在跑）时默认会自动拉起 Electron。写入此标记后，自动拉起被跳过，
 * 于是"点关闭=彻底退出，只能用命令重新启动"。
 */

function isPaused() {
  try {
    return fs.existsSync(pausedFlagPath());
  } catch (_) {
    return false;
  }
}

function setPaused() {
  try {
    const file = pausedFlagPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString());
    return true;
  } catch (_) {
    return false;
  }
}

function clearPaused() {
  try {
    fs.rmSync(pausedFlagPath(), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  isPaused,
  setPaused,
  clearPaused
};
