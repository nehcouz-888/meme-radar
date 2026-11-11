// Exit / downgrade alerts (direction 7). Alert-only — never auto-trades.
// Triggers: leader MC band hit, watched smart money reducing, sustained 1h net sell pressure.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const n = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))) ? null : Number(v);

export function exitDowngradeConfig(overrides = {}) {
  const bands = String(E('EXIT_LEADER_MC_BANDS', '1000000,5000000,10000000,50000000')).split(',').map(Number).filter(Number.isFinite);
  return {
    enabled: E('EXIT_DOWNGRADE', '1') !== '0',
    leaderMcBandsUsd: bands,
    smartMoneyReduceMin: Number(E('EXIT_SMART_REDUCE_MIN', 1)),
    netSell1hRatio: Number(E('EXIT_NET_SELL_1H_RATIO', 1.5)),
    netSell1hMinUsd: Number(E('EXIT_NET_SELL_1H_MIN_USD', 5000)),
    watchStateFile: E('EXIT_WATCH_STATE', '/workspace/meme-radar-run/scan-accum/narrative-early/state/watchlist.json'),
    alertsDir: E('EXIT_ALERTS_DIR', '/workspace/meme-radar-run/scan-accum/narrative-early/alerts/pending'),
    queueFile: E('EXIT_QUEUE_FILE', '/workspace/meme-radar-run/scan-accum/narrative-early/alerts/queue.jsonl'),
    ...overrides
  };
}

export function loadWatchlist(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { version: 1, items: [] }; }
}

export function saveWatchlist(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Which leader MC bands were newly crossed between prevMcap and mcap (ascending). */
export function crossedLeaderMcBands(prevMcap, mcap, bands) {
  const a = n(prevMcap), b = n(mcap);
  if (a == null || b == null || b <= a) return [];
  return (bands || []).filter(band => a < band && b >= band);
}

/**
 * snapshot: { chain, address, symbol, mcap, prevMcap?, smartHoldingCount, prevSmartHoldingCount?,
 *             buyVol1h?, sellVol1h?, isLeader?, tier? }
 */
export function evaluateExitDowngrade(snapshot = {}, cfg = exitDowngradeConfig()) {
  const out = { enabled: cfg.enabled, alerts: [], downgrade: false, reasons: [] };
  if (!cfg.enabled) return out;

  const bandsHit = crossedLeaderMcBands(snapshot.prevMcap, snapshot.mcap, cfg.leaderMcBandsUsd);
  if (bandsHit.length && snapshot.isLeader !== false) {
    for (const band of bandsHit) {
      out.alerts.push({
        type: 'leader_mc_band',
        band,
        mcap: snapshot.mcap,
        prevMcap: snapshot.prevMcap,
        message: `龙头市值带触及: ${snapshot.symbol || '?'} 现MC≈$${Math.round(snapshot.mcap)} 跨越 $${band.toLocaleString('en-US')} (前≈$${Math.round(snapshot.prevMcap)})`
      });
      out.reasons.push(`leader_mc_band_${band}`);
    }
  }

  const smart = n(snapshot.smartHoldingCount);
  const smartPrev = n(snapshot.prevSmartHoldingCount);
  if (smart != null && smartPrev != null && smartPrev - smart >= cfg.smartMoneyReduceMin) {
    out.alerts.push({
      type: 'smart_money_reducing',
      from: smartPrev,
      to: smart,
      message: `观察名单聪明钱减仓: ${snapshot.symbol || '?'} 仍持仓 ${smartPrev} → ${smart}`
    });
    out.downgrade = true;
    out.reasons.push('smart_money_reducing');
  }

  const buy = n(snapshot.buyVol1h), sell = n(snapshot.sellVol1h);
  if (buy != null && sell != null && sell >= cfg.netSell1hMinUsd && buy > 0 && sell / buy >= cfg.netSell1hRatio) {
    out.alerts.push({
      type: 'net_sell_1h',
      buyVol1h: buy,
      sellVol1h: sell,
      ratio: sell / buy,
      message: `1小时净卖压: ${snapshot.symbol || '?'} 卖≈$${Math.round(sell)} / 买≈$${Math.round(buy)} = ${(sell / buy).toFixed(2)}x`
    });
    out.downgrade = true;
    out.reasons.push('net_sell_1h');
  } else if (buy === 0 && sell != null && sell >= cfg.netSell1hMinUsd) {
    out.alerts.push({
      type: 'net_sell_1h',
      buyVol1h: buy,
      sellVol1h: sell,
      ratio: null,
      message: `1小时净卖压: ${snapshot.symbol || '?'} 卖≈$${Math.round(sell)} 且买量≈0`
    });
    out.downgrade = true;
    out.reasons.push('net_sell_1h');
  }

  return out;
}

export function formatExitAlertPlain(alert, snapshot = {}) {
  const lines = [
    '退出/降级提醒 (仅提醒，不自动交易)',
    `币: ${snapshot.symbol || '?'} (${snapshot.chain || '?'})`,
    `类型: ${alert.type}`,
    alert.message
  ];
  if (snapshot.address) lines.push(`CA: ${snapshot.address}`);
  if (snapshot.url) lines.push(String(snapshot.url));
  return lines.join('\n');
}

export function writePendingAlert(cfg, text, meta = {}) {
  fs.mkdirSync(cfg.alertsDir, { recursive: true });
  const id = meta.id || (`exit-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const file = path.join(cfg.alertsDir, `${id}.txt`);
  fs.writeFileSync(file, text);
  const q = { id, status: 'pending', at: new Date().toISOString(), type: meta.type || null, text, ...meta };
  fs.mkdirSync(path.dirname(cfg.queueFile), { recursive: true });
  fs.appendFileSync(cfg.queueFile, JSON.stringify(q) + '\n');
  return { id, file };
}

/** Apply downgrade flag onto watchlist item in memory. */
export function markWatchDowngrade(watch, key, reasons = []) {
  const items = watch.items || (watch.items = []);
  let item = items.find(x => x.key === key);
  if (!item) {
    item = { key, status: 'watch', history: [] };
    items.push(item);
  }
  if (!Array.isArray(item.history)) item.history = [];
  item.status = 'downgrade';
  item.downgradedAt = new Date().toISOString();
  item.reasons = [...new Set([...(item.reasons || []), ...reasons])];
  item.history.push({ at: item.downgradedAt, event: 'downgrade', reasons });
  return item;
}
