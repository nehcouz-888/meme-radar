#!/usr/bin/env node
/**
 * v9 proper-lockfile: Dual watcher budget test (149,750 → should stay ≤ 150,000)
 * Real watcher processes with 600ms init pause
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-dual-watcher-'));
const ledgerFile = path.join(testDir, 'fomo-credits-ledger.json');
const configFile = path.join(testDir, 'config.json');

// Initialize ledger at 149,750 (250 credits left)
const initialLedger = {
  month: '2026-11',
  spent: 149750,
  calls: 0,
  log: [],
  reservations: {}
};
fs.writeFileSync(ledgerFile, JSON.stringify(initialLedger, null, 1));

// Minimal config for watcher
const config = {
  fomo: {
    traders: [
      { userId: 'FIX_0', enabled: true, label: 'Fixture 0' }
    ]
  }
};
fs.writeFileSync(configFile, JSON.stringify(config, null, 1));

// Setup fixture server (minimal mock)
const fixtureCode = `
import http from 'node:http';

const traders = { FIX_0: { userId: 'FIX_0', balances: [] } };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  
  // Respond with fixture data
  if (url.pathname.includes('/balances')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Credits-Cost': '250',
      'X-Credits-Remaining': '0'
    });
    res.end(JSON.stringify({ data: [] }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(18888, () => {
  console.log('READY');
});

// Keep alive
setInterval(() => {}, 10000);
`;

const fixtureServerPath = path.join(testDir, 'fixture-server.mjs');
fs.writeFileSync(fixtureServerPath, fixtureCode);

// Launch fixture server
const fixtureServer = spawn('node', [fixtureServerPath]);
await new Promise(resolve => {
  fixtureServer.stdout.on('data', d => {
    if (d.toString().includes('READY')) resolve();
  });
});

console.log('=== Dual Watcher Budget Test ===');
console.log('Ledger:', ledgerFile);
console.log('Initial budget: 149,750 / 150,000 (250 left)');

// Modified watcher script that uses proper-lockfile
const watcherCode = `
import fs from 'node:fs';
import path from 'node:path';
import properLockfile from 'proper-lockfile';

const LEDGER_FILE = '${ledgerFile}';
const MONTHLY_BUDGET = 150000;
const PAUSE_MS = parseInt(process.argv[2] || '0');

function acquireLedgerLock(timeoutMs = 5000) {
  const startTime = Date.now();
  const options = { stale: 10000, realpath: false, fs: fs };
  while (Date.now() - startTime < timeoutMs) {
    try {
      const release = properLockfile.lockSync(LEDGER_FILE, options);
      return { release, ledgerFile: LEDGER_FILE };
    } catch (e) {
      if (e.code === 'ELOCKED') {
        const waitMs = Math.min(50 + Math.random() * 50, timeoutMs - (Date.now() - startTime));
        if (waitMs > 0) {
          const start = Date.now();
          while (Date.now() - start < waitMs) {}
        }
        continue;
      }
      throw e;
    }
  }
  throw new Error('Failed to acquire ledger lock after ' + timeoutMs + 'ms');
}

function releaseLedgerLock(lockObj) {
  try { lockObj.release(); } catch {}
}

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch {
    return { month: '2026-11', spent: 0, calls: 0, log: [], reservations: {} };
  }
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_FILE + '.tmp', JSON.stringify(ledger, null, 1));
  fs.renameSync(LEDGER_FILE + '.tmp', LEDGER_FILE);
}

// Simulate watcher init
if (PAUSE_MS > 0) {
  console.log('INIT_START');
  const start = Date.now();
  while (Date.now() - start < PAUSE_MS) {}
}

const reservationId = 'watcher-' + process.pid + '-' + Date.now();
const estCost = 250;

const ledgerLock = acquireLedgerLock();
let ledger = readLedger();

let totalReserved = 0;
for (const resId in ledger.reservations) {
  totalReserved += ledger.reservations[resId]?.amount || 0;
}

if (ledger.spent + totalReserved + estCost > MONTHLY_BUDGET) {
  releaseLedgerLock(ledgerLock);
  console.log('BUDGET_EXCEEDED:' + (ledger.spent + totalReserved));
  process.exit(0);
}

ledger.reservations[reservationId] = { amount: estCost, pid: process.pid, at: Date.now() };
saveLedger(ledger);
releaseLedgerLock(ledgerLock);

console.log('RESERVED:' + estCost);

// Simulate API call (mock)
const start2 = Date.now();
while (Date.now() - start2 < 100) {}

// Commit
const ledgerLock2 = acquireLedgerLock();
ledger = readLedger();
delete ledger.reservations[reservationId];
ledger.spent += estCost;
ledger.calls++;
ledger.log.push({ at: new Date().toISOString(), cost: estCost, ok: true });
saveLedger(ledger);
releaseLedgerLock(ledgerLock2);

console.log('COMMITTED:' + estCost);
process.exit(0);
`;

const watcherPath = path.join(testDir, 'watcher.mjs');
fs.writeFileSync(watcherPath, watcherCode);

// Launch watcher A with 600ms init pause
console.log('\nLaunching watcher A (600ms init pause)...');
const watcherA = spawn('node', [watcherPath, '600']);

let outputA = '';
watcherA.stdout.on('data', d => {
  outputA += d.toString();
  console.log('A:', d.toString().trim());
});
watcherA.stderr.on('data', d => {
  console.error('A stderr:', d.toString().slice(0, 200));
});

// Wait for A to start init
await new Promise(resolve => {
  const check = setInterval(() => {
    if (outputA.includes('INIT_START')) {
      clearInterval(check);
      resolve();
    }
  }, 10);
});

// Launch watcher B immediately
console.log('Launching watcher B (no pause)...');
const watcherB = spawn('node', [watcherPath, '0']);

let outputB = '';
watcherB.stdout.on('data', d => {
  outputB += d.toString();
  console.log('B:', d.toString().trim());
});
watcherB.stderr.on('data', d => {
  console.error('B stderr:', d.toString().slice(0, 200));
});

// Wait for both
await Promise.all([
  new Promise(resolve => watcherA.on('close', resolve)),
  new Promise(resolve => watcherB.on('close', resolve))
]);

// Check final ledger
const finalLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));

console.log('\n=== Results ===');
console.log('Final spent:', finalLedger.spent);
console.log('Final calls:', finalLedger.calls);
console.log('Budget limit: 150,000');
console.log('Reserved (should be 0):', Object.keys(finalLedger.reservations).length);

// Cleanup
fixtureServer.kill();
fs.rmSync(testDir, { recursive: true, force: true });

if (finalLedger.spent <= 150000 && finalLedger.calls === 1) {
  console.log('\n✅ Dual watcher budget PASSED (only one watcher acquired)');
  process.exit(0);
} else if (finalLedger.spent > 150000) {
  console.log('\n✗ FAILED: Budget exceeded (', finalLedger.spent, '/ 150,000)');
  process.exit(1);
} else {
  console.log('\n⚠ Unexpected result');
  process.exit(1);
}
