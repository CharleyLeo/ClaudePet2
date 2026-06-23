// 从 pet/ikkun/spritesheet.webp 第 0 帧抠出 IKun 形象,生成全套任务栏图标
//
// 用法:
//   node scripts/generate-app-icon.js
//
// 依赖(devDependencies):sharp + png-to-ico
//
// 输出到 src/renderer/assets/:
//   app-icon-16.png ... app-icon-256.png  (7 个尺寸,任务栏 / 标题栏 各场景按需取)
//   app-icon.png                          (256×256 主图标,macOS / Linux)
//   app-icon.ico                          (Windows 任务栏 / 窗口标题栏,内含全部 7 个尺寸)

const sharp = require("sharp");

/**
 * 把多张 PNG buffer 拼成单个 ICO 文件
 * ICO 容器格式:
 *   ICONDIR header (6 bytes): reserved(2)=0, type(2)=1, count(2)
 *   ICONDIRENTRY × N (16 bytes each):
 *     width(1), height(1), colors(1)=0, reserved(1)=0,
 *     planes(2)=1, bitcount(2)=32, bytes(4), offset(4)
 *   PNG data × N
 *   (width/height 字段是 1 byte,256 用 0 表示)
 */
function buildIco(entries) {
  const sorted = [...entries].sort((a, b) => a.width - b.width);
  const count = sorted.length;
  const headerLen = 6 + 16 * count;
  const header = Buffer.alloc(headerLen);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let dataOffset = headerLen;
  for (let i = 0; i < count; i += 1) {
    const { width, data } = sorted[i];
    const entry = 6 + 16 * i;
    const w = width >= 256 ? 0 : width;
    header.writeUInt8(w, entry + 0);
    header.writeUInt8(w, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(dataOffset, entry + 12);
    dataOffset += data.length;
  }

  return Buffer.concat([header, ...sorted.map((e) => e.data)]);
}
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "pet", "ikkun", "spritesheet.webp");
const OUT_DIR = path.join(ROOT, "src", "renderer", "assets");

// IKun spritesheet: 1536×1872, 8×9 grid, 192×208 per frame
// 第 0 帧 = idle 起始姿势(标志的"练习两年半"姿势)
const FRAME_X = 0;
const FRAME_Y = 0;
const FRAME_W = 192;
const FRAME_H = 208;

// 直接强制 192×208 → size×size resize(横向拉伸 ~8%)
// 这样 IKun 完全填满图标方框,看起来更"胖嘟嘟",不在小图标里显得瘦长
// 拉伸幅度极小(2.08:2.56 ≈ 0.81 倍 vs 等比),视觉上几乎察觉不到变形,但识别度大幅提升
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`Source spritesheet missing: ${SOURCE}`);
  }
  if (!fs.existsSync(OUT_DIR)) {
    throw new Error(`Output dir missing: ${OUT_DIR}`);
  }

  console.log(`Source: ${path.relative(ROOT, SOURCE)}`);
  console.log(`Frame:  x=${FRAME_X} y=${FRAME_Y} w=${FRAME_W} h=${FRAME_H}`);
  console.log(`Mode:   强制 ${FRAME_W}×${FRAME_H} → size×size 填满\n`);

  const entries = [];
  for (const size of ICO_SIZES) {
    const buf = await sharp(SOURCE)
      .extract({ left: FRAME_X, top: FRAME_Y, width: FRAME_W, height: FRAME_H })
      .resize(size, size, { kernel: "lanczos3", fit: "fill" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const outPath = path.join(OUT_DIR, `app-icon-${size}.png`);
    fs.writeFileSync(outPath, buf);
    console.log(`  ✓ app-icon-${size}.png (${buf.length.toLocaleString()} bytes)`);
    entries.push({ width: size, data: buf });
  }

  // 主 PNG (供 macOS / Linux / Electron windowIconPath 在非 Windows 时使用)
  // 复用 256×256 那张,避免重复 resize
  fs.copyFileSync(
    path.join(OUT_DIR, "app-icon-256.png"),
    path.join(OUT_DIR, "app-icon.png")
  );
  console.log("  ✓ app-icon.png  (= app-icon-256.png 副本)");

  // 合成 ICO (内含全部 7 个尺寸)
  const ico = buildIco(entries);
  fs.writeFileSync(path.join(OUT_DIR, "app-icon.ico"), ico);
  console.log(`  ✓ app-icon.ico (${ico.length.toLocaleString()} bytes, ${ICO_SIZES.length} sizes)`);

  console.log("\n✓ IKun 任务栏图标已生成");
}

main().catch((error) => {
  console.error("✗ ERROR:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
