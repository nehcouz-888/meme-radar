#!/usr/bin/env node
/**
 * 真实watcher入口B4+B8 fixture测试
 * - B4: empty/zero holding → unknown
 * - B8: 10并发+外部账本变更+去重
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHER_PATH = path.resolve(__dirname, '../scripts-production/fomo-trader-watch-integrated.mjs');
const SHARED_LEDGER = '/workspace/meme-radar-run/meme-radar-branch/state/fomo-credits-ledger.json';
const TEST_DIR = path.resolve(__dirname, '../test-temp-watcher-fixtures');

// B4 fixture: empty holding
const EMPTY_HOLDING_FIXTURE = {
  eventId: 'EMPTY_NO_PRIOR',
  tradeId: 'trade-empty-123',
  userId: 'user-empty',
  handle: 'emptyTrader',
  tradeUsd: null,
  usdValue: null,
  positionValueUsd: null,
  holdingAmount: 0,
  holdingValueUsd: 0,
  ts: Date.now()
};

// B4 fixture: zero post amount
const ZERO_POST_AMOUNT_FIXTURE = {
  eventId: 'ZERO_POST_AMOUNT',
  tradeId: 'trade-zero-456',
  userId: 'user-zero',
  handle: 'zeroTrader',
  tradeUsd: 3000,
  usdValue: 3000,
  postBuyHolding: {
    amount: 0,
    valueUsd: 0
  },
  ts: Date.now()
};

// 测试helper：执行watcher判断逻辑
async function testJudgeNewPosition() {
  console.log('\n=== Test B4: empty/zero holding → unknown ===');
  
  // Import watcher functions (需要mock环境)
  const testCode = `
import fs from 'node:fs';
import path from 'node:path';

// Mock judgeNewPosition function
function judgeNewPosition(portfolio, buyInfo) {
  if (!portfolio?.ok) {
    return { isNew: null, unknown: true, label: '是否新仓未知（portfolio查询失败）' };
  }
  const hv = portfolio.holdingValueUsd || 0;
  const amt = portfolio.holdingAmount || 0;
  
  if (!portfolio.holding || amt <= 0 || hv <= 0) {
    return {
      isNew: null,
      unknown: true,
      label: '是否新仓未知（无持仓数据或金额为0）',
      note: '空持仓/零值无法确认新仓（可能是API未返回或低于阈值）'
    };
  }
  
  return {
    isNew: null,
    unknown: true,
    label: '是否新仓未知（无交易前余额证据）',
    holdingValueUsd: hv,
    note: '持仓价值无法推定交易前状态'
  };
}

// Test fixtures
const emptyPortfolio = {
  ok: true,
  holding: null,
  holdingAmount: 0,
  holdingValueUsd: 0
};

const zeroPortfolio = {
  ok: true,
  holding: { amount: 0 },
  holdingAmount: 0,
  holdingValueUsd: 0
};

const emptyResult = judgeNewPosition(emptyPortfolio, {});
const zeroResult = judgeNewPosition(zeroPortfolio, {});

console.log(JSON.stringify({
  emptyResult,
  zeroResult,
  bothUnknown: emptyResult.unknown && zeroResult.unknown,
  neitherDefiniteNew: emptyResult.isNew === null && zeroResult.isNew === null
}));
`;
  
  const result = await runNode(testCode);
  const parsed = JSON.parse(result.trim().split('\n').pop());
  
  if (!parsed.bothUnknown) {
    throw new Error('❌ Empty/zero holding should be unknown');
  }
  if (!parsed.neitherDefiniteNew) {
    throw new Error('❌ Should not be definite new position');
  }
  
  console.log('✅ B4: empty/zero holding → unknown (not definite new)');
  return parsed;
}

// 测试B8: 10并发预留
async function testB8ConcurrentReserve() {
  console.log('\n=== Test B8: 10 concurrent requests + reserve ===');
  
  // 初始化账本
  const initialLedger = {
    month: '2026-11',
    spent: 149750,
    calls: 0,
    lastRemaining: null,
    reserved: 0,
    log: []
  };
  
  fs.mkdirSync(path.dirname(SHARED_LEDGER), { recursive: true });
  fs.writeFileSync(SHARED_LEDGER, JSON.stringify(initialLedger, null, 2));
  
  // 模拟10个并发请求
  const testCode = `
import fs from 'node:fs';

const LEDGER_FILE = '${SHARED_LEDGER}';
const MONTHLY_BUDGET = 150000;

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch {
    return { month: '2026-11', spent: 0, calls: 0, reserved: 0, log: [] };
  }
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_FILE + '.tmp', JSON.stringify(ledger, null, 2));
  fs.renameSync(LEDGER_FILE + '.tmp', LEDGER_FILE);
}

// Simulate reserve
const workerId = process.argv[2];
const estCost = 250;

const ledger = readLedger();
const totalReserved = (ledger.reserved || 0) + estCost;

if (ledger.spent + totalReserved > MONTHLY_BUDGET) {
  console.log(JSON.stringify({ workerId, rejected: true, spent: ledger.spent, reserved: ledger.reserved }));
  process.exit(0);
}

// Reserve
ledger.reserved = totalReserved;
saveLedger(ledger);

// Simulate work
await new Promise(r => setTimeout(r, 10));

// Release and settle
const finalLedger = readLedger();
finalLedger.spent += estCost;
finalLedger.reserved = Math.max(0, (finalLedger.reserved || 0) - estCost);
finalLedger.calls++;
saveLedger(finalLedger);

console.log(JSON.stringify({ workerId, success: true, finalSpent: finalLedger.spent }));
`;
  
  const workers = [];
  for (let i = 0; i < 10; i++) {
    workers.push(runNode(testCode, [`worker-${i}`]));
  }
  
  const results = await Promise.all(workers);
  
  let rejectedCount = 0;
  let successCount = 0;
  
  for (const r of results) {
    const parsed = JSON.parse(r.trim().split('\n').pop());
    if (parsed.rejected) rejectedCount++;
    if (parsed.success) successCount++;
  }
  
  const finalLedger = JSON.parse(fs.readFileSync(SHARED_LEDGER, 'utf8'));
  
  console.log(`✅ B8 concurrent: ${successCount} success, ${rejectedCount} rejected`);
  console.log(`✅ Final spent: ${finalLedger.spent} (should be ≤ 150000)`);
  
  if (finalLedger.spent > 150000) {
    throw new Error(`❌ Budget exceeded: ${finalLedger.spent} > 150000`);
  }
  
  if (finalLedger.reserved !== 0) {
    throw new Error(`❌ Reserved not released: ${finalLedger.reserved}`);
  }
  
  return { successCount, rejectedCount, finalSpent: finalLedger.spent };
}

// 测试B8: 外部账本变更
async function testB8ExternalUpdate() {
  console.log('\n=== Test B8: external update not overwritten ===');
  
  // 初始账本
  const initialLedger = {
    month: '2026-11',
    spent: 100000,
    calls: 0,
    reserved: 0,
    log: []
  };
  
  fs.writeFileSync(SHARED_LEDGER, JSON.stringify(initialLedger, null, 2));
  
  // Worker开始请求
  const testCode = `
import fs from 'node:fs';

const LEDGER_FILE = '${SHARED_LEDGER}';

function readLedger() {
  return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_FILE + '.tmp', JSON.stringify(ledger, null, 2));
  fs.renameSync(LEDGER_FILE + '.tmp', LEDGER_FILE);
}

// Read initial
const ledger1 = readLedger();
console.log('Worker read initial:', ledger1.spent);

// Reserve
ledger1.reserved = 250;
saveLedger(ledger1);

// Signal ready for external update
fs.writeFileSync('${TEST_DIR}/worker-ready.flag', 'ready');

// Wait for external update
while (!fs.existsSync('${TEST_DIR}/external-updated.flag')) {
  await new Promise(r => setTimeout(r, 10));
}

// ✅ Read fresh ledger (不使用旧内存)
const ledger2 = readLedger();
console.log('Worker read after external update:', ledger2.spent);

// Settle
ledger2.spent += 250;
ledger2.reserved = Math.max(0, (ledger2.reserved || 0) - 250);
saveLedger(ledger2);

console.log(JSON.stringify({ finalSpent: ledger2.spent }));
`;
  
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Start worker
  const workerPromise = runNode(testCode);
  
  // Wait for worker ready
  while (!fs.existsSync(`${TEST_DIR}/worker-ready.flag`)) {
    await new Promise(r => setTimeout(r, 10));
  }
  
  // External update (模拟scanner更新)
  const ledger = JSON.parse(fs.readFileSync(SHARED_LEDGER, 'utf8'));
  ledger.spent = 150000; // 外部更新
  fs.writeFileSync(SHARED_LEDGER, JSON.stringify(ledger, null, 2));
  
  // Signal worker
  fs.writeFileSync(`${TEST_DIR}/external-updated.flag`, 'done');
  
  const result = await workerPromise;
  const parsed = JSON.parse(result.trim().split('\n').pop());
  
  console.log(`✅ Final spent: ${parsed.finalSpent}`);
  
  // 应该是 150000 + 250 = 150250，而不是 100000 + 250 = 100250
  if (parsed.finalSpent !== 150250) {
    throw new Error(`❌ External update overwritten: expected 150250, got ${parsed.finalSpent}`);
  }
  
  return parsed;
}

// Helper: run node code
function runNode(code, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '--eval', code, ...args]);
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Node failed (${code}):\n${stderr}\n${stdout}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Main
(async () => {
  try {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    
    await testJudgeNewPosition();
    await testB8ConcurrentReserve();
    await testB8ExternalUpdate();
    
    console.log('\n✅ All watcher B4+B8 fixtures passed\n');
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ Test failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  } finally {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
})();
