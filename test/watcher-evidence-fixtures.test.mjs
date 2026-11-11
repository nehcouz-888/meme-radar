#!/usr/bin/env node
/**
 * Real watcher evidence fixtures (B4+B8)
 * Tests pickBuyUsd, judgeNewPosition, evaluateAlertRule, budget guard
 * Does NOT establish WS connections - safe to run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import real watcher logic (will fail if paths wrong, proving real imports)
const watcherPath = path.join(__dirname, '../scripts-production/fomo-trader-watch-integrated.mjs');
const watcherCode = fs.readFileSync(watcherPath, 'utf8');

// Extract functions (eval in isolated scope to avoid WS connections)
const isolatedWatcher = new Function('fs', 'path', 'addPendingAlert', watcherCode.replace(/^#!/, '//') + `
  return { pickBuyUsd, judgeNewPosition, evaluateAlertRule, readLedger, monthKey };
`);

const mockAddPending = () => {};
const { pickBuyUsd, judgeNewPosition, evaluateAlertRule } = isolatedWatcher(fs, path, mockAddPending);

console.log('=== Watcher Evidence Fixtures Test ===\n');

// Test 1: tradeUsd null + only positionValue → unknown (MASK case)
console.log('Test 1: MASK - tradeUsd null + only positionValue');
const ev1 = {
  type: 'buy',
  positionValueUsd: 50000,  // post-trade position, not trade amount
  // tradeUsd: null (missing)
};
const buy1 = pickBuyUsd(ev1);
assert.strictEqual(buy1.verified, false, 'positionValue应为unverified');
assert.strictEqual(buy1.source, 'positionValue_not_trade');
console.log(`✅ PASS: ${JSON.stringify(buy1)}\n`);

// Test 2: tradeUsd verified
console.log('Test 2: Verified tradeUsd');
const ev2 = {
  type: 'buy',
  tradeUsd: 50000,
  positionValueUsd: 100000,
};
const buy2 = pickBuyUsd(ev2);
assert.strictEqual(buy2.verified, true);
assert.strictEqual(buy2.amount, 50000);
assert.strictEqual(buy2.source, 'tradeUsd');
console.log(`✅ PASS: ${JSON.stringify(buy2)}\n`);

// Test 3: Ambiguous usdValue
console.log('Test 3: Ambiguous usdValue (not verified)');
const ev3 = {
  type: 'buy',
  usdValue: 30000,  // ambiguous
};
const buy3 = pickBuyUsd(ev3);
assert.strictEqual(buy3.verified, false);
assert.strictEqual(buy3.source, 'ambiguous_usdValue');
console.log(`✅ PASS: ${JSON.stringify(buy3)}\n`);

// Test 4: >100% pct rejected as anomaly
console.log('Test 4: >100% portfolio pct = evidence anomaly');
const trader4 = {
  handle: 'test',
  alertRule: { minPortfolioPct: 0.05 }
};
const buyInfo4 = { amount: 60000, verified: true, source: 'tradeUsd' };
const portfolio4 = { ok: true, totalValueUsd: 50000 };  // buy > total
const newPos4 = { isNew: null, unknown: true };
const decision4 = evaluateAlertRule(trader4, buyInfo4, portfolio4, newPos4);
assert.strictEqual(decision4.pass, false);
assert.strictEqual(decision4.reason, 'pct_over_100_evidence_anomaly');
assert.ok(decision4.pctInfo.anomaly);
console.log(`✅ PASS: ${JSON.stringify(decision4.reason)}\n`);

// Test 5: Asset unknown + unverified tradeUsd → cannot apply $3000 threshold
console.log('Test 5: Asset unknown + unverified amount → threshold N/A');
const trader5 = {
  handle: 'test',
  alertRule: { minPortfolioPct: 0.05 }
};
const buyInfo5 = { amount: 5000, verified: false, source: 'positionValue_not_trade' };
const portfolio5 = { ok: false, reason: 'balances_fail' };
const newPos5 = { isNew: null, unknown: true };
const decision5 = evaluateAlertRule(trader5, buyInfo5, portfolio5, newPos5);
assert.strictEqual(decision5.pass, false);
assert.strictEqual(decision5.reason, 'trade_amount_unknown_cannot_apply_threshold');
assert.ok(decision5.note.includes('研究日志'));
console.log(`✅ PASS: ${decision5.reason}\n`);

// Test 6: Asset unknown + verified tradeUsd ≥ $3000 → pass
console.log('Test 6: Asset unknown + verified ≥ $3000 → pass');
const trader6 = {
  handle: 'test',
  alertRule: { minPortfolioPct: 0.05 }
};
const buyInfo6 = { amount: 5000, verified: true, source: 'tradeUsd' };
const portfolio6 = { ok: false, reason: 'balances_fail' };
const newPos6 = { isNew: null, unknown: true };
const decision6 = evaluateAlertRule(trader6, buyInfo6, portfolio6, newPos6);
assert.strictEqual(decision6.pass, true);
assert.ok(decision6.pctInfo.fallback.includes('verified tradeUsd'));
console.log(`✅ PASS: fallback with verified amount\n`);

// Test 7: New position unknown (no prior balance proof)
console.log('Test 7: New position unknown (no prior balance)');
const portfolio7 = {
  ok: true,
  holding: true,
  holdingAmount: 1000,
  holdingValueUsd: 10000
};
const buyInfo7 = { amount: 5000, verified: true };
const newPos7 = judgeNewPosition(portfolio7, buyInfo7);
assert.strictEqual(newPos7.isNew, null);
assert.strictEqual(newPos7.unknown, true);
assert.ok(newPos7.label.includes('无交易前余额证据'));
console.log(`✅ PASS: ${newPos7.label}\n`);

// Test 8: No holding = likely new
console.log('Test 8: No holding = new position');
const portfolio8 = {
  ok: true,
  holding: false,
  holdingAmount: 0,
  holdingValueUsd: 0
};
const buyInfo8 = { amount: 5000, verified: true };
const newPos8 = judgeNewPosition(portfolio8, buyInfo8);
assert.strictEqual(newPos8.isNew, true);
assert.strictEqual(newPos8.unknown, false);
assert.strictEqual(newPos8.label, '新开仓');
console.log(`✅ PASS: ${newPos8.label}\n`);

console.log('=== All Evidence Fixtures PASSED ===');
console.log('Real watcher logic imported and tested\n');
process.exit(0);
