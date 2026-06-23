const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

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
      // statusline 链路永久阻断。详见 docs/优化记录_ClaudePet2_state_json损坏_20260623.md
      try {
        const backup = `${file}.broken.${Date.now()}`;
        fs.renameSync(file, backup);
        process.stderr.write(`[claudepet] corrupted JSON at ${file} moved to ${backup}\n`);
      } catch (_) { /* 备份失败不阻塞主流程，继续返回 fallback */ }
      return fallback;
    }
    throw error;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const content = `${JSON.stringify(data, null, 2)}\n`;
  // 原子写：先写唯一 tmp 文件再 rename 覆盖目标，避免多 hook 子进程并发 truncate+write 互踩。
  // tmp 名包含 pid + 时间戳 + 随机数，确保跨进程、同进程多次写都不会撞名。
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch (renameError) {
      // Windows 下目标若被其它进程短暂打开（reader 或并发 writer 的 tmp rename）可能
      // EBUSY/EPERM/EACCES，短窗口重试，仍失败则向上抛。
      const transient = renameError && (renameError.code === "EBUSY" || renameError.code === "EPERM" || renameError.code === "EACCES");
      if (!transient) throw renameError;
      const deadline = Date.now() + 250;
      let lastError = renameError;
      while (Date.now() < deadline) {
        try {
          fs.renameSync(tmp, file);
          lastError = null;
          break;
        } catch (retry) {
          lastError = retry;
        }
      }
      if (lastError) throw lastError;
    }
  } catch (error) {
    // 写入或 rename 失败：清理 tmp 文件，避免目录里堆积孤儿
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    throw error;
  }
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const output = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = mergeDeep(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  mergeDeep
};
