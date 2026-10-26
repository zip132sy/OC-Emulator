// ============================================================
// startupPrep.js - 启动前的依赖检查与自动更新
//
// 由 run.bat / run.sh 调用, 把两步合并成一个入口:
//   1. 依赖文件完整性检查 (可在前端设置里跳过, 总时长超时会跳过)
//   2. 自动更新 (首次测速选择更快的源, 之后复用缓存; 全程带超时)
//
// 除"依赖文件确实缺失且无法修复"外, 任何失败/超时都只记录日志并
// 继续启动, 避免网络问题把服务器卡在启动阶段。
// ============================================================

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const updateSource = require('./updateSource');

const PROJECT_DIR = path.dirname(__dirname);
const SETTINGS_FILE = path.join(PROJECT_DIR, 'settings.json');
const REPAIR_TIMEOUT = 90000;
const SPEED_TEST_TIMEOUT = 30000;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function runRepair() {
  const r = spawnSync(process.execPath, [path.join(PROJECT_DIR, 'lib', 'repair.js')], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    timeout: REPAIR_TIMEOUT,
    windowsHide: true,
  });
  if (r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ABORT_ERR')) return 'timeout';
  return r.status === 0 ? 'ok' : 'failed';
}

(async () => {
  const settings = loadSettings();

  if (settings.skipIntegrityCheck === true) {
    console.log('[INFO] 完整性检测已跳过 (前端设置)');
  } else {
    console.log('[INFO] 检查依赖文件完整性...');
    const result = runRepair();
    if (result === 'timeout') {
      console.log('[WARN] 完整性检测超时, 已跳过 (继续启动)');
    } else if (result === 'failed') {
      console.error('[ERROR] 依赖文件不完整, 服务器未启动。');
      process.exit(1);
    }
  }

  if (settings.autoUpdate === false) {
    console.log('[INFO] 自动更新已关闭 (可在前端设置中开启)');
    return;
  }

  const picked = await withTimeout(
    updateSource.pickSource({ log: console.log }),
    SPEED_TEST_TIMEOUT,
    { source: null, timedOut: true },
  );
  if (picked.timedOut) {
    console.log('[update] 测速超时, 跳过自动更新');
    return;
  }
  if (!picked.source) return;
  updateSource.pullUpdate(picked, { log: console.log });
})().then(
  // 测速超时后可能还挂着未关闭的请求, 强制退出避免拖慢启动
  () => process.exit(0),
  (err) => {
    console.error('[WARN] 启动前检查异常, 已跳过:', err && err.message ? err.message : err);
    process.exit(0);
  },
);
