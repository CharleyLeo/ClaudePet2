#!/usr/bin/env node
/**
 * 一次性脚本：把 src/renderer/assets/sounds/*.wav 做峰值归一化（peak normalization）。
 *
 * - 仅支持 16-bit PCM WAV（这是当前 5 个内置音色的格式）。
 * - 首次运行会把原始文件备份到 sounds/original/，之后每次都从备份重算，幂等。
 * - 默认目标峰值 -0.5 dBFS（约 31070/32767）。可用 --target=-1 之类参数调整。
 *
 * 用法：
 *   node scripts/normalize-sounds.js
 *   node scripts/normalize-sounds.js --target=-1     # 更保守
 *   node scripts/normalize-sounds.js --target=0      # 不留余量，最响（不推荐）
 *   node scripts/normalize-sounds.js --restore       # 把 sounds/ 恢复到 sounds/original/ 的原版
 */

const fs = require("node:fs");
const path = require("node:path");

const SOUNDS_DIR = path.resolve(__dirname, "..", "src", "renderer", "assets", "sounds");
const BACKUP_DIR = path.join(SOUNDS_DIR, "original");
const FILES = ["bell.wav", "chime.wav", "ding.wav", "success.wav", "task-complete.wav"];

function parseArgs(argv) {
  const args = { target: -0.5, restore: false };
  for (const item of argv.slice(2)) {
    if (item === "--restore") args.restore = true;
    else if (item.startsWith("--target=")) args.target = Number(item.slice("--target=".length));
  }
  return args;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path.basename(file)} 不是 RIFF/WAVE 文件`);
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = null;
  let dataLength = null;
  while (offset + 8 <= buf.length) {
    const tag = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (tag === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22)
      };
    } else if (tag === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || dataOffset === null) throw new Error(`${path.basename(file)} 缺少 fmt 或 data 块`);
  if (fmt.audioFormat !== 1) throw new Error(`${path.basename(file)} 不是 PCM (audioFormat=${fmt.audioFormat})`);
  if (fmt.bitsPerSample !== 16) throw new Error(`${path.basename(file)} 不是 16-bit (bits=${fmt.bitsPerSample})`);
  return { buf, fmt, dataOffset, dataLength };
}

function findPeak(buf, dataOffset, dataLength) {
  let peak = 0;
  const end = dataOffset + dataLength;
  for (let i = dataOffset; i < end; i += 2) {
    const sample = buf.readInt16LE(i);
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

function applyGain(buf, dataOffset, dataLength, gain) {
  const end = dataOffset + dataLength;
  const out = Buffer.from(buf);
  for (let i = dataOffset; i < end; i += 2) {
    const sample = buf.readInt16LE(i);
    let scaled = Math.round(sample * gain);
    if (scaled > 32767) scaled = 32767;
    else if (scaled < -32768) scaled = -32768;
    out.writeInt16LE(scaled, i);
  }
  return out;
}

function ensureBackups() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const name of FILES) {
    const src = path.join(SOUNDS_DIR, name);
    const dst = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      process.stdout.write(`  备份 ${name} → original/\n`);
    }
  }
}

function restore() {
  for (const name of FILES) {
    const src = path.join(BACKUP_DIR, name);
    const dst = path.join(SOUNDS_DIR, name);
    if (!fs.existsSync(src)) {
      process.stderr.write(`  跳过：${name} 没有备份\n`);
      continue;
    }
    fs.copyFileSync(src, dst);
    process.stdout.write(`  恢复 ${name}\n`);
  }
}

function dbfsToLinear(db) {
  return Math.pow(10, db / 20);
}

function linearToDbfs(value) {
  if (value <= 0) return -Infinity;
  return 20 * Math.log10(value);
}

function normalizeOne(name, targetDbfs) {
  const sourcePath = path.join(BACKUP_DIR, name);
  const targetPath = path.join(SOUNDS_DIR, name);
  const { buf, fmt, dataOffset, dataLength } = readWav(sourcePath);
  const peak = findPeak(buf, dataOffset, dataLength);
  if (peak === 0) {
    process.stdout.write(`  ${name}: 全静音，跳过\n`);
    return;
  }
  const peakDbfs = linearToDbfs(peak / 32768);
  const targetPeak = dbfsToLinear(targetDbfs) * 32767;
  const gain = targetPeak / peak;
  const out = applyGain(buf, dataOffset, dataLength, gain);
  fs.writeFileSync(targetPath, out);
  process.stdout.write(
    `  ${name.padEnd(20)} 原始峰值 ${peakDbfs.toFixed(2)} dBFS → 放大 ×${gain.toFixed(2)} → ${targetDbfs.toFixed(1)} dBFS  ` +
      `(${fmt.sampleRate}Hz/${fmt.channels}ch)\n`
  );
}

function main() {
  const args = parseArgs(process.argv);
  if (args.restore) {
    process.stdout.write("恢复原始 wav：\n");
    restore();
    return;
  }
  if (!Number.isFinite(args.target) || args.target > 0) {
    process.stderr.write("错误：--target 必须是 ≤ 0 的 dBFS 值（推荐 -0.5 ~ -3）\n");
    process.exit(1);
  }
  process.stdout.write(`目标峰值：${args.target} dBFS\n备份原始文件：\n`);
  ensureBackups();
  process.stdout.write("\n归一化：\n");
  for (const name of FILES) {
    try {
      normalizeOne(name, args.target);
    } catch (error) {
      process.stderr.write(`  ${name}: 失败 — ${error.message}\n`);
    }
  }
  process.stdout.write("\n完成。已备份在 src/renderer/assets/sounds/original/，可用 --restore 还原。\n");
}

main();
