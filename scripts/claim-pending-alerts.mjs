#!/usr/bin/env node
/**
 * Claim pending alerts from queue
 * Real production script for alert delivery pipeline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_ROOT = process.env.MODULES_ROOT || path.join(__dirname, '../src/modules');

const { claimPendingAlerts, loadQueue } = await import(path.join(MODULES_ROOT, 'alert-queue.mjs'));

const QUEUE_FILE = process.env.ALERT_QUEUE_FILE || '/workspace/meme-radar-run/meme-radar-branch/exit-monitoring/alert-queue.jsonl';
const MAX_CLAIMS = Number(process.env.MAX_CLAIMS || 10);
const TTL_MS = Number(process.env.ALERT_TTL_MS || 24 * 60 * 60 * 1000); // 24h for exit monitoring

if (!fs.existsSync(QUEUE_FILE)) {
  console.log(JSON.stringify({ error: 'queue_not_found', queueFile: QUEUE_FILE }));
  process.exit(1);
}

try {
  const result = claimPendingAlerts(QUEUE_FILE, {
    maxClaims: MAX_CLAIMS,
    ttlMs: TTL_MS,
    now: Date.now()
  });
  
  if (result.reason) {
    console.log(JSON.stringify({ claimed: 0, reason: result.reason, ...result }));
  } else {
    console.log(JSON.stringify({
      claimed: result.claimed.length,
      total: result.total,
      alerts: result.claimed.map(a => ({
        eventId: a.eventId,
        type: a.type,
        chain: a.chain,
        symbol: a.symbol,
        leaseId: a.leaseId,
        leaseExpiry: a.leaseExpiry
      }))
    }));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }));
  process.exit(1);
}
