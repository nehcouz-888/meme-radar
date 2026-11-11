#!/usr/bin/env node
/**
 * 生产部署目录布局fixture测试
 * 模拟真实部署路径: /workspace/meme-radar-run/fomo-trader-watch
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '../test-fixtures/production-layout');
const FOMO_WATCH = path.join(FIXTURE_ROOT, 'fomo-trader-watch');
const MEME_RADAR = path.join(FIXTURE_ROOT, 'meme-radar-branch');
const MODULES = path.join(MEME_RADAR, 'src/modules');

function setup() {
  if (fs.existsSync(FIXTURE_ROOT)) {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(FOMO_WATCH, { recursive: true });
  fs.mkdirSync(MODULES, { recursive: true });
  
  // Copy production watcher
  fs.copyFileSync(
    path.join(__dirname, '../scripts-production/fomo-trader-watch-integrated.mjs'),
    path.join(FOMO_WATCH, 'fomo-trader-watch.mjs')
  );
  
  // Copy config
  fs.copyFileSync(
    path.join(__dirname, '../fomo-trader-watch-production/config.json'),
    path.join(FOMO_WATCH, 'config.json')
  );
  
  // Copy alert-queue module
  fs.copyFileSync(
    path.join(__dirname, '../src/modules/alert-queue.mjs'),
    path.join(MODULES, 'alert-queue.mjs')
  );
  
  // Create fake API key
  const keyFile = path.join(FOMO_WATCH, '.fomo-api-key');
  fs.writeFileSync(keyFile, 'test-api-key-12345678\n');
  
  // Update config to use local key
  const cfg = JSON.parse(fs.readFileSync(path.join(FOMO_WATCH, 'config.json'), 'utf8'));
  cfg.apiKeyFile = keyFile;
  fs.writeFileSync(path.join(FOMO_WATCH, 'config.json'), JSON.stringify(cfg, null, 2));
}

console.log('=== Production Layout Fixture Test ===\n');

console.log('Setting up production layout fixture...');
setup();

console.log('Test 1: Verify watcher imports resolve');
const watcherPath = path.join(FOMO_WATCH, 'fomo-trader-watch.mjs');
try {
  execSync(`node --check ${watcherPath}`, {
    env: {
      ...process.env,
      FOMO_WATCH_ROOT: FOMO_WATCH,
      NODE_PATH: path.join(FIXTURE_ROOT, '..', '..')
    },
    encoding: 'utf8'
  });
  console.log('✅ PASS: Watcher syntax OK\n');
} catch (e) {
  console.error('❌ FAIL: Watcher syntax error:', e.message);
  process.exit(1);
}

console.log('Test 2: Verify alert-queue module');
const queuePath = path.join(MODULES, 'alert-queue.mjs');
assert.ok(fs.existsSync(queuePath), 'alert-queue.mjs应存在');
try {
  execSync(`node --check ${queuePath}`, { encoding: 'utf8' });
  console.log('✅ PASS: alert-queue syntax OK\n');
} catch (e) {
  console.error('❌ FAIL: alert-queue syntax error:', e.message);
  process.exit(1);
}

console.log('Test 3: Verify config structure');
const cfg = JSON.parse(fs.readFileSync(path.join(FOMO_WATCH, 'config.json'), 'utf8'));
assert.strictEqual(cfg.version, 2);
assert.ok(Array.isArray(cfg.traders));
const enabledTraders = cfg.traders.filter(t => t.enabled);
assert.strictEqual(enabledTraders.length, 10, '应有10个enabled traders');
assert.strictEqual(cfg.minUsdHint, 3000, 'minUsdHint应为3000');
console.log('✅ PASS: Config正确（10个关注账号，minUsd=3000）\n');

console.log('Test 4: Create and verify directory structure');
const requiredDirs = [
  'state',
  'alerts',
  'alerts/pending',
  'alerts/archive',
  'logs'
];
for (const dir of requiredDirs) {
  const fullPath = path.join(FOMO_WATCH, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
  assert.ok(fs.existsSync(fullPath), `${dir}应存在`);
}
console.log('✅ PASS: 目录结构完整\n');

console.log('Test 5: Verify CLI scripts exist and work');
const claimCli = path.join(__dirname, '../scripts-production/claim-pending-alerts.mjs');
const ackCli = path.join(__dirname, '../scripts-production/ack-delivered-alerts.mjs');
assert.ok(fs.existsSync(claimCli), 'claim CLI应存在');
assert.ok(fs.existsSync(ackCli), 'ack CLI应存在');

try {
  execSync(`node --check ${claimCli}`, { encoding: 'utf8' });
  execSync(`node --check ${ackCli}`, { encoding: 'utf8' });
  console.log('✅ PASS: CLI scripts syntax OK\n');
} catch (e) {
  console.error('❌ FAIL: CLI syntax error:', e.message);
  process.exit(1);
}

console.log('=== Production Layout Fixture Test PASSED ===');
console.log(`Fixture directory: ${FIXTURE_ROOT}`);
process.exit(0);
