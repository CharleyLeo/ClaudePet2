#!/usr/bin/env node
// 并发写入压测：模拟 Claude Code 高频 hook + statusline 同时调用 writeJson 的场景。
// 用法：node scripts/concurrent-write-test.js [workers] [iterations]
//   workers     默认 8
//   iterations  默认 200
// 检验点：跑完后 readJson 能拿到合法 JSON、不产生 .broken.* 文件。

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { readJson, writeJson } = require("../src/shared/json-file");

const FILE = path.join(__dirname, "..", ".tmp-concurrent-test.json");
const ARGS = process.argv.slice(2);
const WORKERS = Number(ARGS[0]) || 8;
const ITERATIONS = Number(ARGS[1]) || 200;

function workerMain(workerId, iterations) {
  // 模拟 cli.js 的 mergeStatePatch：read → mutate → write
  for (let i = 0; i < iterations; i += 1) {
    const cur = readJson(FILE, {}) || {};
    cur[`w${workerId}`] = { i, ts: Date.now() };
    cur.updatedAt = new Date().toISOString();
    // 撑大 payload 模拟真实 state.json
    cur.padding = "x".repeat(800 + (i % 50));
    writeJson(FILE, cur);
  }
}

function isWorker() {
  return process.env.CLAUDEPET_CONC_WORKER === "1";
}

if (isWorker()) {
  const workerId = Number(process.env.CLAUDEPET_CONC_WORKER_ID || 0);
  const iterations = Number(process.env.CLAUDEPET_CONC_WORKER_ITER || 100);
  try {
    workerMain(workerId, iterations);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`worker ${workerId} failed: ${error && error.message}\n`);
    process.exit(1);
  }
}

async function main() {
  try { fs.rmSync(FILE, { force: true }); } catch (_) {}
  // 清掉之前残留的 broken 备份
  const dir = path.dirname(FILE);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".tmp-concurrent-test.json.broken.") || name.startsWith(".tmp-concurrent-test.json.tmp.")) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch (_) {}
    }
  }

  writeJson(FILE, { init: true });

  const t0 = Date.now();
  const children = [];
  for (let id = 0; id < WORKERS; id += 1) {
    const child = spawn(process.execPath, [__filename], {
      env: {
        ...process.env,
        CLAUDEPET_CONC_WORKER: "1",
        CLAUDEPET_CONC_WORKER_ID: String(id),
        CLAUDEPET_CONC_WORKER_ITER: String(ITERATIONS)
      },
      stdio: ["ignore", "ignore", "inherit"]
    });
    children.push(new Promise((resolve) => {
      child.on("close", (code) => resolve({ id, code }));
    }));
  }
  const results = await Promise.all(children);
  const elapsed = Date.now() - t0;
  const failed = results.filter((r) => r.code !== 0);
  const brokenFiles = fs.readdirSync(dir).filter((n) => n.startsWith(".tmp-concurrent-test.json.broken."));
  const orphanTmps = fs.readdirSync(dir).filter((n) => n.startsWith(".tmp-concurrent-test.json.tmp."));

  // 最终能否读出合法 JSON？
  let finalReadOk = false;
  let finalKeys = [];
  try {
    const final = readJson(FILE, null);
    finalReadOk = final && typeof final === "object";
    if (finalReadOk) finalKeys = Object.keys(final).sort();
  } catch (e) {
    process.stderr.write(`final readJson threw: ${e.message}\n`);
  }

  console.log(`workers=${WORKERS} iterations=${ITERATIONS}  elapsed=${elapsed}ms`);
  console.log(`worker failures: ${failed.length}`);
  console.log(`final readJson OK: ${finalReadOk}`);
  console.log(`final top-level keys: ${finalKeys.join(", ")}`);
  console.log(`.broken.* files produced: ${brokenFiles.length}`);
  console.log(`.tmp.* orphan files: ${orphanTmps.length}`);

  const pass = failed.length === 0 && finalReadOk && brokenFiles.length === 0 && orphanTmps.length === 0;
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  // 清理
  try { fs.rmSync(FILE, { force: true }); } catch (_) {}
  process.exit(pass ? 0 : 1);
}

main();
