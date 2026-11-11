#!/usr/bin/env node
/**
 * ✅ 真实入口测试：执行包内watcher源文件字节一致 + 禁网HTTP fixture
 * 
 * 不复制算法、不eval、直接运行真实生产代码
 * 通过环境变量和mock注入控制行为
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== Real Watcher Entry Test (No Network) ===\n');

// Test setup
const TEMP_DIR = '/tmp/watcher-real-entry-test';
const TEMP_STATE = `${TEMP_DIR}/state`;
const WATCHER_SCRIPT = path.join(__dirname, '../scripts-production/fomo-trader-watch-integrated.mjs');

// Ensure watcher exists
if (!fs.existsSync(WATCHER_SCRIPT)) {
  console.error(`❌ Watcher not found: ${WATCHER_SCRIPT}`);
  process.exit(1);
}

// Clean and setup temp
if (fs.existsSync(TEMP_DIR)) {
  fs.rmSync(TEMP_DIR, { recursive: true });
}
fs.mkdirSync(TEMP_STATE, { recursive: true });

console.log(`Temp state: ${TEMP_STATE}`);
console.log(`Watcher: ${WATCHER_SCRIPT}\n`);

// Test fixtures
const TESTS = [
  {
    name: 'Budget Guard - Single Process Dedup',
    env: {
      LEDGER_START: JSON.stringify({ month: '2026-11', spent: 149750, calls: 0, lastRemaining: null, log: [], reservations: {} }),
      MOCK_EVENTS: JSON.stringify([
        { eventId: 'evt1', tradeId: 'trade_A', account: 'acc_1' },
        { eventId: 'evt2', tradeId: 'trade_A', account: 'acc_1' },
        { eventId: 'evt3', tradeId: 'trade_B', account: 'acc_2' }
      ]),
      MOCK_RESPONSES: JSON.stringify({
        '/v2/trades/trade_A': { status: 200, body: { trade_id: 'trade_A', amount: 1000 }, headers: { 'x-credits-cost': '250', 'x-credits-remaining': '149500' } },
        '/v2/users/acc_1/balances': { status: 200, body: { balance: 5000 }, headers: { 'x-credits-cost': '250', 'x-credits-remaining': '149250' } },
        '/v2/trades/trade_B': { status: 200, body: { trade_id: 'trade_B', amount: 2000 }, headers: { 'x-credits-cost': '250', 'x-credits-remaining': '149000' } },
        '/v2/users/acc_2/balances': { status: 200, body: { balance: 8000 }, headers: { 'x-credits-cost': '250', 'x-credits-remaining': '148750' } }
      }),
      FOMO_PLAN_CREDITS: '250000',
      FOMO_MONTHLY_BUDGET: '150000'
    },
    expectedSpent: 1000, // 4 requests deduped to 2 unique (trade+balance each)
    expectedCalls: 4,
    maxSpent: 150000
  },
  {
    name: 'Budget Reject - Near Limit',
    env: {
      LEDGER_START: JSON.stringify({ month: '2026-11', spent: 149900, calls: 0, lastRemaining: null, log: [], reservations: {} }),
      MOCK_EVENTS: JSON.stringify([
        { eventId: 'evt1', tradeId: 'trade_C', account: 'acc_3' }
      ]),
      MOCK_RESPONSES: JSON.stringify({}),
      FOMO_PLAN_CREDITS: '250000',
      FOMO_MONTHLY_BUDGET: '150000'
    },
    expectedSpent: 149900, // No requests made
    expectedCalls: 0,
    maxSpent: 150000
  }
];

async function runTest(test) {
  console.log(`\n--- Test: ${test.name} ---`);
  
  // Setup ledger
  const ledgerPath = path.join(TEMP_STATE, 'fomo-credits-ledger.json');
  fs.writeFileSync(ledgerPath, test.env.LEDGER_START);
  
  // Setup API key
  fs.writeFileSync(path.join(TEMP_STATE, 'fomo-api-key'), 'test_key_mock');
  
  // Mock HTTP preload
  const mockPreload = `
    import { Module } from 'module';
    const originalRequire = Module.prototype.require;
    
    globalThis.__MOCK_RESPONSES = ${test.env.MOCK_RESPONSES};
    globalThis.__MOCK_EVENTS = ${test.env.MOCK_EVENTS};
    
    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname + (new URL(url).search || '');
      const mockPath = new URL(url).pathname;
      
      if (globalThis.__MOCK_RESPONSES[mockPath]) {
        const mock = globalThis.__MOCK_RESPONSES[mockPath];
        return {
          ok: mock.status === 200,
          status: mock.status,
          headers: {
            get(name) {
              return mock.headers?.[name] || null;
            }
          },
          json: async () => mock.body
        };
      }
      
      throw new Error('Network disabled in test: ' + url);
    };
    
    console.log('[MOCK] HTTP fetch hooked, network disabled');
  `;
  
  const mockPreloadPath = path.join(TEMP_DIR, `mock-${Date.now()}.mjs`);
  fs.writeFileSync(mockPreloadPath, mockPreload);
  
  // Run watcher
  const env = {
    ...process.env,
    ...test.env,
    STATE_DIR: TEMP_STATE,
    NODE_OPTIONS: `--import ${mockPreloadPath}`
  };
  
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [WATCHER_SCRIPT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    
    proc.on('close', code => {
      console.log(`Exit code: ${code}`);
      
      if (stdout) console.log('STDOUT:', stdout.slice(0, 500));
      if (stderr) console.log('STDERR:', stderr.slice(0, 500));
      
      // Check ledger
      try {
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        console.log(`Final spent: ${ledger.spent}, calls: ${ledger.calls}`);
        
        if (ledger.spent !== test.expectedSpent) {
          console.error(`❌ Expected spent ${test.expectedSpent}, got ${ledger.spent}`);
          return reject(new Error(`Spent mismatch: expected ${test.expectedSpent}, got ${ledger.spent}`));
        }
        
        if (ledger.spent > test.maxSpent) {
          console.error(`❌ Budget exceeded: ${ledger.spent} > ${test.maxSpent}`);
          return reject(new Error(`Budget exceeded: ${ledger.spent} > ${test.maxSpent}`));
        }
        
        // Check reservations cleaned up
        const totalReserved = Object.values(ledger.reservations || {}).reduce((sum, r) => sum + (r.amount || 0), 0);
        if (totalReserved > 0) {
          console.warn(`⚠️  Reservations not cleaned: ${totalReserved}`);
        }
        
        console.log(`✅ ${test.name} PASSED`);
        resolve();
      } catch (err) {
        console.error(`❌ Ledger check failed: ${err.message}`);
        reject(err);
      }
    });
    
    proc.on('error', err => {
      console.error(`❌ Process error: ${err.message}`);
      reject(err);
    });
  });
}

// Run all tests
async function main() {
  let passed = 0;
  let failed = 0;
  
  for (const test of TESTS) {
    try {
      await runTest(test);
      passed++;
    } catch (err) {
      console.error(`\n❌ Test failed: ${test.name}\n  ${err.message}`);
      failed++;
    }
  }
  
  console.log(`\n\n=== Summary ===`);
  console.log(`Passed: ${passed}/${TESTS.length}`);
  console.log(`Failed: ${failed}/${TESTS.length}`);
  
  if (failed > 0) {
    process.exit(1);
  }
  
  console.log('\n✅ All tests passed');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
