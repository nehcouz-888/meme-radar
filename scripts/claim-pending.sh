#!/usr/bin/env bash
# Claim pending alerts from fomo-trader-watch queue
# Usage: ./claim-pending.sh [--max N] [--ttl-minutes M] [--lease-minutes L]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE_FILE="${FOMO_QUEUE_FILE:-/workspace/meme-radar-run/fomo-trader-watch/alerts/queue.jsonl}"
MAX_CLAIMS="${1:-10}"
TTL_MINUTES="${2:-10}"
LEASE_MINUTES="${3:-10}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --max)
      MAX_CLAIMS="$2"
      shift 2
      ;;
    --ttl-minutes)
      TTL_MINUTES="$2"
      shift 2
      ;;
    --lease-minutes)
      LEASE_MINUTES="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Run claim script
node - <<EOF
import { claimPendingAlerts, formatHistoricalAlert } from '${SCRIPT_DIR}/../src/modules/alert-queue.mjs';

const queueFile = '${QUEUE_FILE}';
const result = claimPendingAlerts(queueFile, {
  maxClaims: ${MAX_CLAIMS},
  ttlMs: ${TTL_MINUTES} * 60 * 1000,
  leaseDurationMs: ${LEASE_MINUTES} * 60 * 1000,
  now: Date.now()
});

if (result.reason === 'quiet_hours') {
  console.error(JSON.stringify({ 
    ok: false, 
    reason: 'quiet_hours', 
    message: '01:00-06:00 CST静默时段，不claim' 
  }));
  process.exit(0);
}

if (result.error) {
  console.error(JSON.stringify({ ok: false, error: result.error }));
  process.exit(1);
}

// 输出claimed alerts
const now = Date.now();
for (const alert of result.claimed || []) {
  const eventTime = alert.whenIso ? new Date(alert.whenIso).getTime() : now;
  const ageMinutes = Math.floor((now - eventTime) / 60_000);
  
  // ✅ TTL内为即时，超过为历史
  if (ageMinutes > ${TTL_MINUTES}) {
    console.log('---HISTORICAL---');
    console.log(formatHistoricalAlert(alert, now));
  } else {
    console.log('---ALERT---');
    console.log(alert.text || '');
    console.log(\`事件时间: \${alert.whenIso || '未知'}\`);
    console.log(\`延迟: \${ageMinutes}分钟\`);
  }
  console.log(\`eventId: \${alert.eventId}\`);
  console.log(\`leaseId: \${alert.leaseId}\`);
  console.log(\`leaseExpiry: \${alert.leaseExpiry}\`);
  console.log('');
}

console.error(JSON.stringify({ 
  ok: true, 
  claimed: result.claimed.length, 
  total: result.total 
}));
EOF
