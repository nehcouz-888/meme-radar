#!/usr/bin/env node
/**
 * Acknowledge delivered alerts
 * Real production script for alert delivery pipeline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_ROOT = process.env.MODULES_ROOT || path.join(__dirname, '../src/modules');

const { acknowledgeDelivered } = await import(path.join(MODULES_ROOT, 'alert-queue.mjs'));

const QUEUE_FILE = process.env.ALERT_QUEUE_FILE || '/workspace/meme-radar-run/meme-radar-branch/exit-monitoring/alert-queue.jsonl';
const eventIds = process.argv.slice(2);

if (eventIds.length === 0) {
  console.error('Usage: ack-delivered-alerts.mjs <eventId1> [eventId2] ...');
  console.error('Or pipe JSON: echo \'["id1","id2"]\' | node ack-delivered-alerts.mjs');
  process.exit(1);
}

if (!fs.existsSync(QUEUE_FILE)) {
  console.log(JSON.stringify({ error: 'queue_not_found', queueFile: QUEUE_FILE }));
  process.exit(1);
}

try {
  const result = acknowledgeDelivered(QUEUE_FILE, eventIds, {
    now: Date.now()
  });
  
  console.log(JSON.stringify({
    acked: result.acked,
    eventIds: result.eventIds || []
  }));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }));
  process.exit(1);
}
