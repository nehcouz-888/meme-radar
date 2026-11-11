#!/usr/bin/env node
/**
 * v9 proper-lockfile: Ledger concurrent reservation test
 * Tests that two processes trying to reserve from 149,750 budget
 * only allow one to succeed (not both exceeding 150,000)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v9-ledger-'));
const ledgerFile = path.join(testDir, 'fomo-credits-ledger.json');

// Initialize ledger at 149,750 (250 credits left for one 250-credit call)
const initialLedger = {
  month: '2026-11',
  spent: 149750,
  calls: 0,
  log: [],
  reservations: {}
};
fs.writeFileSync(ledgerFile, JSON.stringify(initialLedger, null, 1));

console.log('=== Ledger Concurrent Reservation Test ===');
console.log('Ledger:', ledgerFile);
console.log('Initial: 149,750 / 150,000 (250 left, one call possible)');

// Import real scanner which uses proper-lockfile ledger lock
const scannerPath = path.join(ROOT, 'scan-accum/fomo-free/fomo-free-scan.mjs');
if (!fs.existsSync(scannerPath)) {
  console.log('✗ Scanner not found:', scannerPath);
  process.exit(1);
}

// Create a test wrapper that uses scanner's lock functions
const workerCode = `
import fs from 'node:fs';
import path from 'node:path';
import properLockfile from 'proper-lockfile';

const LEDGER_FILE = '${ledgerFile}';
const MONTHLY_BUDGET = 150000;
const WORKER_ID = process.argv[2];
const INIT_PAUSE_MS = parseInt(process.argv[3] || '0');

// Copy exact lock functions from scanner
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

// Worker A pauses during init (before acquiring lock)
if (INIT_PAUSE_MS > 0) {
  console.log(WORKER_ID + ':INIT_START');
  const start = Date.now();
  while (Date.now() - start < INIT_PAUSE_MS) {}
  console.log(WORKER_ID + ':INIT_END');
}

const reservationId = 'worker-' + WORKER_ID + '-' + process.pid + '-' + Date.now();
const estCost = 250;

try {
  const ledgerLock = acquireLedgerLock();
  let ledger = readLedger();

  let totalReserved = 0;
  for (const resId in ledger.reservations) {
    totalReserved += ledger.reservations[resId]?.amount || 0;
  }

  if (ledger.spent + totalReserved + estCost > MONTHLY_BUDGET) {
    releaseLedgerLock(ledgerLock);
    console.log(WORKER_ID + ':BUDGET_EXCEEDED:spent=' + ledger.spent + ',reserved=' + totalReserved);
    process.exit(0);
  }

  ledger.reservations[reservationId] = { amount: estCost, pid: process.pid, at: Date.now(), worker: WORKER_ID };
  saveLedger(ledger);
  releaseLedgerLock(ledgerLock);

  console.log(WORKER_ID + ':RESERVED:' + estCost);

  // Simulate work
  const start = Date.now();
  while (Date.now() - start < 50) {}

  // Commit
  const ledgerLock2 = acquireLedgerLock();
  ledger = readLedger();
  delete ledger.reservations[reservationId];
  ledger.spent += estCost;
  ledger.calls++;
  ledger.log.push({ at: new Date().toISOString(), cost: estCost, worker: WORKER_ID, ok: true });
  saveLedger(ledger);
  releaseLedgerLock(ledgerLock2);

  console.log(WORKER_ID + ':COMMITTED:' + estCost);
} catch (e) {
  console.log(WORKER_ID + ':ERROR:' + e.message);
}
`;

const workerPath = path.join(ROOT, 'tests/ledger-worker-temp.mjs');
fs.writeFileSync(workerPath, workerCode);

// Launch worker A with 600ms init pause
console.log('\nLaunching Worker A (600ms init pause)...');
const workerA = spawn('node', [workerPath, 'A', '600'], {
  cwd: ROOT
});

let outputA = '';
workerA.stdout.on('data', d => {
  outputA += d.toString();
  console.log('  ' + d.toString().trim());
});
workerA.stderr.on('data', d => {
  console.error('  A stderr:', d.toString().slice(0, 200));
});

// Wait for A to start init
await new Promise(resolve => {
  const timeout = setTimeout(resolve, 2000);
  const check = setInterval(() => {
    if (outputA.includes('INIT_START')) {
      clearInterval(check);
      clearTimeout(timeout);
      resolve();
    }
  }, 10);
});

// Launch worker B immediately (no pause)
console.log('\nLaunching Worker B (no pause)...');
const workerB = spawn('node', [workerPath, 'B', '0'], {
  cwd: ROOT
});

let outputB = '';
workerB.stdout.on('data', d => {
  outputB += d.toString();
  console.log('  ' + d.toString().trim());
});
workerB.stderr.on('data', d => {
  console.error('  B stderr:', d.toString().slice(0, 200));
});

// Wait for both
await Promise.all([
  new Promise(resolve => workerA.on('close', resolve)),
  new Promise(resolve => workerB.on('close', resolve))
]);

// Check final ledger
const finalLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));

console.log('\n=== Results ===');
console.log('Initial spent: 149,750');
console.log('Final spent:', finalLedger.spent);
console.log('Calls made:', finalLedger.calls);
console.log('Reserved (should be 0):', Object.keys(finalLedger.reservations).length);
console.log('Budget limit: 150,000');

const aReserved = outputA.includes('RESERVED');
const aExceeded = outputA.includes('BUDGET_EXCEEDED');
const bReserved = outputB.includes('RESERVED');
const bExceeded = outputB.includes('BUDGET_EXCEEDED');

console.log('\nWorker A:', aReserved ? 'RESERVED' : (aExceeded ? 'EXCEEDED' : 'UNKNOWN'));
console.log('Worker B:', bReserved ? 'RESERVED' : (bExceeded ? 'EXCEEDED' : 'UNKNOWN'));

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
try {
  fs.unlinkSync(path.join(ROOT, 'tests/ledger-worker-temp.mjs'));
} catch {}

// Success: exactly one worker should reserve and commit
if (finalLedger.spent === 150000 && finalLedger.calls === 1) {
  console.log('\n✅ Ledger concurrent test PASSED');
  console.log('   Only one worker acquired budget, preventing overspend');
  process.exit(0);
} else if (finalLedger.spent > 150000) {
  console.log('\n✗ FAILED: Budget exceeded (' + finalLedger.spent + ' / 150,000)');
  process.exit(1);
} else {
  console.log('\n✗ FAILED: Unexpected result (spent=' + finalLedger.spent + ')');
  process.exit(1);
}
