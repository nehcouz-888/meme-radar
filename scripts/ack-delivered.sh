#!/usr/bin/env bash
# Acknowledge delivered alerts
# Usage: ./ack-delivered.sh <eventId1> [eventId2] [eventId3] ...
# 或: cat event-ids.txt | xargs ./ack-delivered.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE_FILE="${FOMO_QUEUE_FILE:-/workspace/meme-radar-run/fomo-trader-watch/alerts/queue.jsonl}"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <eventId1> [eventId2] ..."
  echo "或: echo 'eventId1 eventId2' | xargs $0"
  exit 1
fi

# 收集所有eventId
EVENT_IDS=("$@")

# Run ack script
node - <<EOF
import { acknowledgeDelivered } from '${SCRIPT_DIR}/../src/modules/alert-queue.mjs';

const queueFile = '${QUEUE_FILE}';
const eventIds = ${JSON.stringify(EVENT_IDS)};

const result = acknowledgeDelivered(queueFile, eventIds, {
  now: Date.now()
});

if (result.error) {
  console.error(JSON.stringify({ ok: false, error: result.error }));
  process.exit(1);
}

console.log(JSON.stringify({ 
  ok: true, 
  acked: result.acked,
  eventIds: result.eventIds
}, null, 2));
EOF
