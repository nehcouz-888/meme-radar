#!/usr/bin/env node
/**
 * Acknowledge delivered alerts CLI
 * Usage: node ack-delivered-alerts.mjs <queueFile> <leaseId> <eventId1> [eventId2...]
 */
import { acknowledgeDelivered } from '../src/modules/alert-queue.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const queueFile = args[0];
const leaseId = args[1];
const eventIds = args.slice(2);

if (!queueFile || !leaseId || eventIds.length === 0) {
  console.error('Usage: ack-delivered-alerts.mjs <queueFile> <leaseId> <eventId1> [eventId2...]');
  process.exit(1);
}

if (!fs.existsSync(queueFile)) {
  console.error(`Queue file not found: ${queueFile}`);
  process.exit(1);
}

const result = acknowledgeDelivered(queueFile, eventIds, { leaseId });

console.log(JSON.stringify(result, null, 2));
process.exit(result.acknowledged?.length > 0 ? 0 : 1);
