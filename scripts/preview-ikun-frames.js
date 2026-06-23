// 把 ikkun spritesheet 的所有动画第 1 行/前 2 行抠出来转成 PNG,方便人眼挑选最佳图标帧
// 用法: node scripts/preview-ikun-frames.js
// 输出: png/ikkun-frames-preview.png (一张大图,展示前 16 帧)

const sharp = require("sharp");
const path = require("node:path");
const fs = require("node:fs");

const SOURCE = path.resolve(__dirname, "..", "pet", "ikkun", "spritesheet.webp");
const OUT = path.resolve(__dirname, "..", "png", "ikkun-frames-preview.png");

async function main() {
  // 8 列 × 2 行 = 16 帧,覆盖 idle (0-5) 和后续动画起始几帧
  const buf = await sharp(SOURCE)
    .extract({ left: 0, top: 0, width: 192 * 8, height: 208 * 2 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  fs.writeFileSync(OUT, buf);
  console.log("OK:", OUT, `(${buf.length.toLocaleString()} bytes)`);
}

main().catch((e) => { console.error("ERR:", e.message); process.exitCode = 1; });
