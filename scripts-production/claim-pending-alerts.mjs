#!/usr/bin/env node
/**
 * Claim pending alerts CLI
 * Usage: node claim-pending-alerts.mjs <queueFile> [--max=N] [--lease-min=N]
 */
import { claimPendingAlerts } from '../src/modules/alert-queue.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const queueFile = args[0] || '/workspace/meme-radar-run/fomo-trader-watch/alerts/queue.jsonl';
const maxClaims = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1]) || 10;
const leaseMin = parseInt(args.find(a => a.startsWith('--lease-min='))?.split('=')[1]) || 10;

if (!fs.existsSync(queueFile)) {
  console.error(`Queue file not found: ${queueFile}`);
  process.exit(1);
}

const result = claimPendingAlerts(queueFile, {
  leaseDurationMs: leaseMin * 60 * 1000,
  ttlMs: 10 * 60 * 1000,
  maxClaims
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.claimed?.length > 0 ? 0 : 1);
