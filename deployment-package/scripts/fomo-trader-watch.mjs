#!/usr/bin/env node
/**
 * FOMO buy watcher (alert-only).
 * One process → one WS per enabled trader: wss://api.fomoapi.io/ws/alerts?userId=&type=buy (0 credits).
 * Filters: skip transfers; optional minPortfolioPct (buyUsd/totalValueUsd); optional requireNewPosition.
 * Dedups by eventId, writes plain Chinese alerts for the parent routine to SendToUser.
 * Never trades, never posts X, never prints API keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// ✅ Audit fix: position analysis integration
import { 
  analyzeTransaction, 
  analyzePositionSize, 
  detectPositionAnomalies,
  formatAnomalies
} from '/workspace/src/modules/position-analysis.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE = path.join(ROOT, 'state');
const PENDING = path.join(ROOT, 'alerts', 'pending');
const ARCHIVE = path.join(ROOT, 'alerts', 'archive');
const LOG_DIR = path.join(ROOT, 'logs');
const SEEN_FILE = path.join(STATE, 'seen-event-ids.json');
const SEEDED_FILE = path.join(STATE, 'seeded-traders.json');
const QUEUE_FILE = path.join(ROOT, 'alerts', 'queue.jsonl');
const HB_FILE = path.join(STATE, 'heartbeat.json');
const DAEMON_LOG = path.join(LOG_DIR, 'daemon.log');
const SKIP_LOG = path.join(LOG_DIR, 'skipped-transfers.jsonl');
const SKIP_PCT_LOG = path.join(LOG_DIR, 'skipped-pct.jsonl');
const CST_OFFSET_MS = 8 * 3600_000;

for (const d of [STATE, PENDING, ARCHIVE, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadKey() {
  const file = expandHome(CFG.apiKeyFile || '~/.config/fomo/api-key');
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key || key.length < 8) throw new Error('FOMO API key file empty or missing');
  return key;
}

function log(msg) {
  const line = `[watch ${new Date().toISOString()}] ${msg}\n`;
  try {
    if (fs.existsSync(DAEMON_LOG) && fs.statSync(DAEMON_LOG).size > 5 * 1024 * 1024) {
      fs.renameSync(DAEMON_LOG, DAEMON_LOG + '.1');
    }
    fs.appendFileSync(DAEMON_LOG, line);
  } catch {}
  if (process.env.WATCH_STDERR) process.stderr.write(line);
}

function loadSeen() {
  try {
    const d = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    return {
      ids: new Set(Array.isArray(d.ids) ? d.ids : []),
      updatedAt: d.updatedAt || null,
    };
  } catch {
    return { ids: new Set(), updatedAt: null };
  }
}

function saveSeen(seen) {
  const max = Number(CFG.seenMax) || 5000;
  let ids = [...seen.ids];
  if (ids.length > max) ids = ids.slice(ids.length - max);
  const payload = { updatedAt: new Date().toISOString(), count: ids.length, ids };
  fs.writeFileSync(SEEN_FILE + '.tmp', JSON.stringify(payload));
  fs.renameSync(SEEN_FILE + '.tmp', SEEN_FILE);
  seen.ids = new Set(ids);
}

function loadSeeded() {
  try {
    const d = JSON.parse(fs.readFileSync(SEEDED_FILE, 'utf8'));
    return new Set(Array.isArray(d.handles) ? d.handles : []);
  } catch {
    return new Set();
  }
}

function saveSeeded(set) {
  const payload = {
    updatedAt: new Date().toISOString(),
    handles: [...set].sort(),
  };
  fs.writeFileSync(SEEDED_FILE + '.tmp', JSON.stringify(payload, null, 2));
  fs.renameSync(SEEDED_FILE + '.tmp', SEEDED_FILE);
}

/** Aggregate heartbeat across all trader sockets. */
const connState = new Map(); // handle -> { wsOpen, lastMsgAt, alerts, ... }

function writeHeartbeat(extra = {}) {
  const connections = {};
  let openCount = 0;
  for (const [h, s] of connState) {
    connections[h] = {
      wsOpen: !!s.wsOpen,
      status: s.status || (s.wsOpen ? 'connected' : 'down'),
      lastMsgAgeSec:
        s.lastMsgAt != null ? Math.floor((Date.now() - s.lastMsgAt) / 1000) : null,
      messages: s.messages || 0,
      alerts: s.alerts || 0,
      dupes: s.dupes || 0,
      skippedTransfers: s.skippedTransfers || 0,
      skippedPct: s.skippedPct || 0,
      skippedNotNew: s.skippedNotNew || 0,
      reconnects: s.reconnects || 0,
      lastEventId: s.lastEventId || null,
      lastError: s.lastError || null,
      realtime: s.realtime,
      delaySeconds: s.delaySeconds,
    };
    if (s.wsOpen) openCount++;
  }
  const body = {
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    tradersConfigured: tradersEnabled().length,
    wsOpenCount: openCount,
    connections,
    ...extra,
  };
  try {
    fs.writeFileSync(HB_FILE + '.tmp', JSON.stringify(body, null, 2));
    fs.renameSync(HB_FILE + '.tmp', HB_FILE);
  } catch {}
}

const CHAIN_ZH = {
  solana: 'SOL',
  sol: 'SOL',
  bsc: 'BSC',
  binance: 'BSC',
  robinhood: 'Robinhood',
  hood: 'Robinhood',
  rh: 'Robinhood',
  base: 'Base',
  ethereum: 'ETH',
  eth: 'ETH',
  arc: 'Arc',
  monad: 'Monad',
  hyperliquid: 'Hyperliquid',
};

function chainLabel(chain, chainId) {
  const key = String(chain || '').toLowerCase();
  if (CHAIN_ZH[key]) return CHAIN_ZH[key];
  if (Number(chainId) === 1399811149) return 'SOL';
  if (Number(chainId) === 56) return 'BSC';
  if (Number(chainId) === 4663) return 'Robinhood';
  if (Number(chainId) === 8453) return 'Base';
  if (Number(chainId) === 1) return 'ETH';
  return chain || String(chainId || '未知');
}

function parseEventTs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms);
  }
  const s = String(raw);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return new Date(n > 1e12 ? n : n * 1000);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function minutesAgoLabel(dt) {
  if (!dt) return '刚才';
  const sec = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  if (sec < 60) return `${Math.max(1, sec)}秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}小时前`;
  return `${Math.floor(sec / 86400)}天前`;
}

function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return `约 $${Math.round(v).toLocaleString('en-US')}`;
}

// ✅ Audit fix: 真实tradeUsd与仓位市值分离
function pickBuyUsd(ev) {
  // 优先使用明确的交易金额字段
  if (ev.tradeUsd != null) {
    const n = Number(ev.tradeUsd);
    if (Number.isFinite(n) && n > 0) return n;
  }
  
  // usdValue含义不明确，需要分析
  const analysis = analyzeTransaction({
    tradeUsd: ev.tradeUsd,
    usdValue: ev.usdValue,
    positionValueUsd: ev.positionValueUsd,
    sizeUsd: ev.sizeUsd,
    valueUsd: ev.valueUsd
  });
  
  return analysis.tradeAmount;  // 可能为null（unknown）
}

// ✅ 获取交易金额证据类型
function getAmountEvidence(ev) {
  if (ev.tradeUsd != null && Number.isFinite(Number(ev.tradeUsd)) && Number(ev.tradeUsd) > 0) {
    return 'tradeUsd';
  }
  const analysis = analyzeTransaction({
    tradeUsd: ev.tradeUsd,
    usdValue: ev.usdValue,
    positionValueUsd: ev.positionValueUsd,
    sizeUsd: ev.sizeUsd,
    valueUsd: ev.valueUsd
  });
  return analysis.source || 'unknown';
}

function pickSize(ev) {
  return formatUsd(pickBuyUsd(ev));
}

function pickSymbol(ev) {
  return (
    ev.token?.symbol ||
    ev.symbol ||
    (typeof ev.token === 'string' ? ev.token : null) ||
    ev.tokenName ||
    ev.name ||
    '未知代币'
  );
}

function pickAddress(ev) {
  return (
    ev.tokenAddress ||
    ev.token?.address ||
    ev.mint ||
    ev.contractAddress ||
    ''
  );
}

// ✅ Audit fix: 输出证据类型、异常标注、绝对时间
function formatAlertText({ handle, profileUrl, ev, when, pctInfo, newPosInfo, delaySeconds }) {
  const sym = pickSymbol(ev);
  const chain = chainLabel(ev.chain, ev.chainId);
  const buyUsd = pickBuyUsd(ev);
  const evidence = getAmountEvidence(ev);
  
  // ✅ 金额显示：unknown时不显示确定数字
  let sizeText;
  if (buyUsd != null) {
    sizeText = `约 $${Math.round(buyUsd).toLocaleString('en-US')}`;
    if (evidence !== 'tradeUsd') {
      sizeText += ` (${evidence})`;  // 标注证据来源
    }
  } else {
    sizeText = '规模未知';
  }
  
  const ca = pickAddress(ev);
  
  // ✅ 绝对事件时间 + 延迟
  const eventTime = when ? when.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '时间未知';
  const delayText = delaySeconds != null ? `延迟${delaySeconds}秒` : '';
  
  const lines = [
    `@${handle} 买入 ${sym}`,
    `时间: ${eventTime}${delayText ? ' (' + delayText + ')' : ''}`,
    `链: ${chain}`,
    `规模: ${sizeText}`,
  ];
  
  // ✅ 异常检测
  if (pctInfo?.totalValueUsd != null && buyUsd != null) {
    const anomalies = detectPositionAnomalies({
      positionValueUsd: ev.positionValueUsd,
      totalAssetsUsd: pctInfo.totalValueUsd,
      tradeAmount: buyUsd
    });
    
    if (anomalies.positionExceedsAssets) {
      lines.push(`异常: 持仓市值${anomalies.positionExceedsAssets.positionPct}%超过总资产`);
    }
  }
  if (pctInfo?.pctLabel) {
    lines.push(`约占资产: ${pctInfo.pctLabel}`);
  } else if (pctInfo?.fallback) {
    lines.push(`约占资产: 未知（${pctInfo.fallback}）`);
  }
  if (newPosInfo?.label) {
    lines.push(`仓位: ${newPosInfo.label}`);
  }
  lines.push('合约地址:');
  lines.push(ca || '未知');
  lines.push(`资料: ${profileUrl}`);
  return lines.join('\n');
}

function appendQueue(row) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(row) + '\n');
}

function appendSkip(row) {
  try {
    fs.appendFileSync(SKIP_LOG, JSON.stringify(row) + '\n');
  } catch {}
}

function appendSkipPct(row) {
  try {
    fs.appendFileSync(SKIP_PCT_LOG, JSON.stringify(row) + '\n');
  } catch {}
}

/** Heuristic + field-based: is this alert an inbound wallet transfer rather than a DEX/swap buy? */
function classifyBuyVsTransfer(ev) {
  const type = String(ev.type || ev.alertType || '').toLowerCase();
  const notif = String(ev.notificationType || '').toLowerCase();
  const text = String(ev.text || ev.raw?.text || '').toLowerCase();
  const reasons = [];

  if (
    ['transfer', 'wallet_transfer', 'deposit', 'receive', 'received'].includes(type) ||
    type.includes('transfer')
  ) {
    reasons.push(`type=${type || '?'}`);
  }
  if (notif.includes('transfer') || notif.includes('receive') || notif.includes('deposit')) {
    reasons.push(`notificationType=${notif}`);
  }
  if (ev.transferId && !ev.swapId) {
    reasons.push(`transferId=${ev.transferId}`);
  }
  const transferText =
    /(transfer(red)?\s+in|received|was\s+sent|airdrop|deposited|wallet\s+transfer|转入|收到|存入)/i.test(
      text,
    );
  const buyText = /(bought|买入|swapped?\s+in|market\s+buy)/i.test(text);
  if (transferText && !buyText) {
    reasons.push(`text=${(ev.text || ev.raw?.text || '').slice(0, 80)}`);
  }
  const side = String(ev.side || ev.action || ev.raw?.side || '').toLowerCase();
  if (['transfer', 'transfer_in', 'receive', 'deposit'].includes(side)) {
    reasons.push(`side=${side}`);
  }

  return {
    isTransfer: reasons.length > 0,
    reasons,
    type,
    text: ev.text || ev.raw?.text || null,
    transferId: ev.transferId ?? null,
    swapId: ev.swapId ?? null,
    tradeId: ev.tradeId ?? null,
  };
}

async function verifyTradeIsSwapBuy(tradeId, key) {
  if (!tradeId) return { ok: true, skipped: 'no_tradeId' };
  try {
    const r = await restGet(`/v2/trades/${encodeURIComponent(tradeId)}`, key);
    if (!r.ok) return { ok: true, skipped: `trade_http_${r.status}`, cost: r.cost };
    const b = r.body || {};
    const bought = Number(b.boughtAmount ?? 0);
    const tin = Number(b.transferredInAmount ?? 0);
    const swaps = Array.isArray(b.swaps) ? b.swaps : [];
    const transfers = Array.isArray(b.transfers) ? b.transfers : [];
    if (tin > 0 && bought <= 0) {
      return {
        ok: false,
        reason: 'transferredIn_without_buy',
        bought,
        transferredIn: tin,
        swaps: swaps.length,
        transfers: transfers.length,
        cost: r.cost,
        rem: r.rem,
      };
    }
    if (transfers.length > 0 && bought <= 0 && swaps.length === 0) {
      return {
        ok: false,
        reason: 'transfers_only_no_swaps',
        bought,
        transferredIn: tin,
        swaps: swaps.length,
        transfers: transfers.length,
        cost: r.cost,
        rem: r.rem,
      };
    }
    return {
      ok: true,
      bought,
      transferredIn: tin,
      swaps: swaps.length,
      transfers: transfers.length,
      cost: r.cost,
      rem: r.rem,
    };
  } catch (e) {
    return { ok: true, skipped: `trade_error:${e?.message || e}` };
  }
}

function addrEq(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim();
  const y = String(b).trim();
  if (!x || !y) return false;
  if (x.startsWith('0x') || y.startsWith('0x')) return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

/**
 * Fetch portfolio + judge new position.
 * Credits: ~250 per call (GET /v2/users/{handle}/balances).
 */
async function fetchPortfolioContext(handle, key, ev) {
  const pathTpl = CFG.portfolioPct?.balancesPath || '/v2/users/{handle}/balances';
  const apiPath = pathTpl.replace('{handle}', encodeURIComponent(handle));
  try {
    const r = await restGet(apiPath, key);
    if (!r.ok) {
      return {
        ok: false,
        reason: `http_${r.status}`,
        cost: r.cost,
        rem: r.rem,
      };
    }
    const totalValueUsd = Number(r.body?.totalValueUsd);
    const holdings = Array.isArray(r.body?.holdings) ? r.body.holdings : [];
    const ca = pickAddress(ev);
    const sym = String(pickSymbol(ev) || '').toLowerCase();
    let holding = null;
    if (ca) {
      holding = holdings.find((h) => addrEq(h?.token?.address, ca)) || null;
    }
    if (!holding && sym && sym !== '未知代币') {
      holding =
        holdings.find((h) => String(h?.token?.symbol || '').toLowerCase() === sym) || null;
    }
    const holdingValueUsd = holding ? Number(holding.valueUsd ?? 0) : 0;
    const holdingAmount = holding ? Number(holding.amount ?? 0) : 0;
    return {
      ok: true,
      totalValueUsd: Number.isFinite(totalValueUsd) ? totalValueUsd : null,
      holding,
      holdingValueUsd: Number.isFinite(holdingValueUsd) ? holdingValueUsd : 0,
      holdingAmount: Number.isFinite(holdingAmount) ? holdingAmount : 0,
      holdingsCount: holdings.length,
      cost: r.cost,
      rem: r.rem,
    };
  } catch (e) {
    return { ok: false, reason: `error:${e?.message || e}` };
  }
}

/**
 * New position: no holding / amount~0 / priorEst = holdingValue - buyUsd is tiny.
 * Balances are post-buy, so priorEst approximates pre-buy value of this token.
 */
// ✅ Audit fix: 新仓需要可验证交易证据
function judgeNewPosition(portfolio, buyUsd, evidence) {
  if (!portfolio?.ok) {
    return { isNew: null, unknown: true, label: '是否新仓未知' };
  }
  
  // ✅ 缺失可验证交易金额时，无法确定新仓
  if (buyUsd == null || evidence === 'unknown') {
    return { 
      isNew: null, 
      unknown: true, 
      label: '是否新仓未知(交易金额未知)',
      reason: 'no_verifiable_trade_amount'
    };
  }
  
  const hv = portfolio.holdingValueUsd || 0;
  const amt = portfolio.holdingAmount || 0;
  if (!portfolio.holding || amt <= 0 || hv <= 0) {
    return { isNew: true, unknown: false, label: '新开仓', priorEst: 0 };
  }
  const buy = Number(buyUsd) || 0;
  const priorEst = Math.max(0, hv - buy);
  const thresh = Math.max(1, buy * 0.05);
  if (priorEst < thresh) {
    return { isNew: true, unknown: false, label: '新开仓', priorEst, holdingValueUsd: hv };
  }
  return {
    isNew: false,
    unknown: false,
    label: '加仓(非新币)',
    priorEst,
    holdingValueUsd: hv,
  };
}

/**
 * Apply alertRule: minPortfolioPct + requireNewPosition.
 * Fallback when no totalValueUsd: minUsdHint (documented in config.portfolioPct.fallbackWhenNoTotal).
 */
function evaluateAlertRule(trader, buyUsd, portfolio, newPos) {
  const rule = trader.alertRule || {};
  const minPct = Number(rule.minPortfolioPct);
  const requireNew = rule.requireNewPosition === true;
  const minUsdHint = Number(CFG.minUsdHint) || 3000;

  let pct = null;
  let pctInfo = null;
  let passPct = true;

  if (Number.isFinite(minPct) && minPct > 0) {
    const total = portfolio?.ok ? portfolio.totalValueUsd : null;
    if (total != null && total > 0 && buyUsd != null) {
      pct = buyUsd / total;
      const pctLabel = `${(pct * 100).toFixed(1)}%`;
      pctInfo = { pct, pctLabel, totalValueUsd: total, buyUsd };
      if (pct < minPct) {
        return {
          pass: false,
          reason: 'below_pct',
          pctInfo,
          newPosInfo: newPos,
        };
      }
    } else {
      // ✅ degrade: minUsdHint fallback需要真实成交额并降级标签
      const buy = buyUsd ?? 0;
      if (buy < minUsdHint) {
        return {
          pass: false,
          reason: 'fallback_below_minUsdHint',
          pctInfo: {
            fallback: `总资产未知，规模<$${minUsdHint}`,
            buyUsd: buy,
          },
          newPosInfo: newPos,
        };
      }
      
      // ✅ 允许fallback但必须有真实成交额（不是positionValue变化）
      if (buy > 0 && evidence !== 'tradeUsd' && evidence !== 'unknown') {
        pctInfo = {
          fallback: `总资产未知，使用 $${minUsdHint} fallback (降级：成交额来源=${evidence})`,
          buyUsd: buy,
          degraded: true,
          evidence
        };
      } else if (buy > 0) {
        pctInfo = {
          fallback: `总资产未知，已按 minUsdHint $${minUsdHint} 放行`,
          buyUsd: buy,
        };
      } else {
        return {
          pass: false,
          reason: 'fallback_no_verifiable_amount',
          pctInfo: {
            fallback: `总资产未知，成交额未知`,
            buyUsd: 0,
          },
          newPosInfo: newPos,
        };
      }
    }
  }

  if (requireNew) {
    if (newPos.unknown) {
      // still alert, annotated
      return { pass: true, reason: 'ok_new_unknown', pctInfo, newPosInfo: newPos };
    }
    if (!newPos.isNew) {
      return { pass: false, reason: 'not_new_position', pctInfo, newPosInfo: newPos };
    }
  }

  return { pass: true, reason: 'ok', pctInfo, newPosInfo: newPos };
}

function emitAlert({ trader, ev, when, source, pctInfo, newPosInfo, delaySeconds }) {
  const eventId = String(ev.eventId || ev.id || '');
  if (!eventId) {
    log('skip alert without eventId');
    return false;
  }
  const text = formatAlertText({
    handle: trader.handle,
    profileUrl: trader.profileUrl,
    ev,
    when,
    pctInfo,
    newPosInfo,
    delaySeconds,
  });
  const meta = {
    eventId,
    handle: trader.handle,
    userId: trader.userId,
    type: ev.type || 'buy',
    token: pickSymbol(ev),
    tokenAddress: pickAddress(ev),
    chain: ev.chain || null,
    chainId: ev.chainId ?? null,
    tradeUsd: ev.tradeUsd ?? null,
    usdValue: ev.usdValue ?? null,
    positionValueUsd: ev.positionValueUsd ?? null,
    buyUsd: pickBuyUsd(ev),
    portfolioPct: pctInfo?.pct ?? null,
    totalValueUsd: pctInfo?.totalValueUsd ?? null,
    newPosition: newPosInfo?.isNew ?? null,
    newPositionUnknown: !!newPosInfo?.unknown,
    ts: ev.ts ?? null,
    whenIso: when ? when.toISOString() : null,
    whenCst: when
      ? new Date(when.getTime() + CST_OFFSET_MS).toISOString().replace('Z', '+08:00')
      : null,
    source,
    status: 'pending',
    delaySeconds,
    amountEvidence: getAmountEvidence(ev),
    createdAt: new Date().toISOString(),
    text,
  };
  const safeId = eventId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  const pendingPath = path.join(PENDING, `${safeId}.txt`);
  const metaPath = path.join(PENDING, `${safeId}.json`);
  fs.writeFileSync(pendingPath, text + '\n');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  appendQueue(meta);
  log(
    `NEW_ALERT eventId=${eventId} @${trader.handle} token=${meta.token} chain=${meta.chain} pct=${meta.portfolioPct ?? '?'} new=${meta.newPosition} file=${pendingPath}`,
  );
  return true;
}

async function restGet(apiPath, key) {
  const url = `${CFG.apiBase}${apiPath}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  });
  const cost = res.headers.get('x-credits-cost');
  const rem = res.headers.get('x-credits-remaining');
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, cost, rem, body };
}

/** Seed only traders not yet recorded in seeded-traders.json (per-new-trader). */
async function seedNewTraders(seen, key, traders) {
  if (!CFG.seedSeenOnEmpty) return { seeded: 0, cost: 0, traders: [] };
  const seededSet = loadSeeded();
  // Migrate: if legacy seen nonempty and unipcs never marked, mark unipcs as seeded without REST
  if (seen.ids.size > 0 && traders.some((t) => t.handle === 'unipcs') && !seededSet.has('unipcs')) {
    seededSet.add('unipcs');
    saveSeeded(seededSet);
    log('seed migrate: marked @unipcs seeded (legacy seen nonempty)');
  }
  let seeded = 0;
  let costSum = 0;
  const did = [];
  for (const t of traders) {
    if (seededSet.has(t.handle)) continue;
    const q = `/v2/alerts?userId=${encodeURIComponent(t.userId)}&type=buy&limit=50`;
    const r = await restGet(q, key);
    costSum += Number(r.cost || 0);
    log(`seed REST @${t.handle} status=${r.status} cost=${r.cost} rem=${r.rem} (key redacted)`);
    const alerts = r.body?.alerts || [];
    for (const a of alerts) {
      const id = a.eventId || a.id;
      if (id) {
        seen.ids.add(String(id));
        seeded++;
      }
    }
    if (alerts[0] && t.handle === traders[0]?.handle) {
      const a = alerts[0];
      const when = parseEventTs(a.ts) || parseEventTs(a.createdAt);
      const sample = formatAlertText({
        handle: t.handle,
        profileUrl: t.profileUrl,
        ev: a,
        when,
        pctInfo: { pctLabel: '样例' },
        newPosInfo: { label: '样例' },
      });
      fs.writeFileSync(
        path.join(ROOT, 'sample-alert.txt'),
        `# 历史 buy 格式样例（非实时告警，仅供对照）\n# generatedAt=${new Date().toISOString()}\n` +
          sample +
          '\n',
      );
    }
    seededSet.add(t.handle);
    did.push(t.handle);
    // persist after each trader so a crash mid-loop does not re-spend
    saveSeen(seen);
    saveSeeded(seededSet);
  }
  return { seeded, cost: costSum, traders: did };
}

function unwrapAlertMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (
    msg.type === 'welcome' ||
    msg.type === 'ping' ||
    msg.type === 'pong' ||
    msg.type === 'subscribed'
  ) {
    return { kind: 'ctrl', msg };
  }
  let ev = msg.alert && typeof msg.alert === 'object' ? { ...msg, ...msg.alert } : { ...msg };
  const wrapped = String(ev.type || '').toLowerCase() === 'alert';
  const alertType = String(ev.alertType || (wrapped ? '' : ev.type) || '').toLowerCase();
  if (wrapped && ev.alertType) ev = { ...ev, type: ev.alertType };
  const t = String(ev.type || alertType || '').toLowerCase();
  if (t.includes('transfer') || t === 'deposit' || t === 'receive' || t === 'received') {
    return { kind: 'transfer', ev };
  }
  const buyish =
    ['buy', 'large_buy', 'large-buy'].includes(t) ||
    String(ev.alertType || '').toLowerCase().includes('buy');
  const side = String(ev.side || ev.action || '').toLowerCase();
  if (buyish || side === 'buy') {
    return { kind: 'buy', ev };
  }
  if (wrapped && !side && !t) {
    return { kind: 'buy', ev: { ...ev, type: ev.type || 'buy' } };
  }
  return { kind: 'other', ev };
}

function tradersEnabled() {
  return (CFG.traders || []).filter((t) => t.enabled !== false && t.userId);
}

function buildWsUrl(key, userId) {
  const u = new URL(CFG.wsAlerts);
  u.searchParams.set('key', key);
  u.searchParams.set('userId', userId);
  u.searchParams.set('type', 'buy');
  return u.toString();
}

function redactedUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('key')) u.searchParams.set('key', 'REDACTED');
    return u.toString();
  } catch {
    return 'wss://api.fomoapi.io/ws/alerts?key=REDACTED&...';
  }
}

function touchConn(handle, patch) {
  const cur = connState.get(handle) || {};
  const next = { ...cur, ...patch };
  connState.set(handle, next);
  return next;
}

async function runSocket({ trader, key, seen }) {
  const url = buildWsUrl(key, trader.userId);
  log(`connecting ${redactedUrl(url)} handle=@${trader.handle}`);
  const ws = new WebSocket(url);
  let alive = true;
  const stats = touchConn(trader.handle, {
    wsOpen: false,
    status: 'connecting',
    lastMsgAt: Date.now(),
    messages: (connState.get(trader.handle)?.messages) || 0,
    alerts: (connState.get(trader.handle)?.alerts) || 0,
    dupes: (connState.get(trader.handle)?.dupes) || 0,
    skippedTransfers: (connState.get(trader.handle)?.skippedTransfers) || 0,
    skippedPct: (connState.get(trader.handle)?.skippedPct) || 0,
    skippedNotNew: (connState.get(trader.handle)?.skippedNotNew) || 0,
    reconnects: (connState.get(trader.handle)?.reconnects) || 0,
  });

  const close = () => {
    alive = false;
    try {
      ws.close();
    } catch {}
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 20000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      log(`WS open @${trader.handle}`);
      touchConn(trader.handle, {
        wsOpen: true,
        status: 'connected',
        lastOpenAt: new Date().toISOString(),
      });
      writeHeartbeat();
      resolve();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(e.error || e.message || new Error('ws error'));
    });
  });

  ws.addEventListener('message', (evt) => {
    touchConn(trader.handle, {
      lastMsgAt: Date.now(),
      messages: (connState.get(trader.handle)?.messages || 0) + 1,
    });
    let msg;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      log(`non-json ws frame ignored @${trader.handle}`);
      return;
    }
    const parsed = unwrapAlertMessage(msg);
    if (!parsed) return;
    if (parsed.kind === 'ctrl') {
      if (msg.type === 'welcome') {
        log(
          `welcome @${trader.handle} realtime=${msg.realtime} delaySeconds=${msg.delaySeconds ?? msg.delay ?? '?'}`,
        );
        touchConn(trader.handle, {
          realtime: msg.realtime,
          delaySeconds: msg.delaySeconds ?? msg.delay ?? null,
        });
      }
      writeHeartbeat();
      return;
    }
    if (parsed.kind === 'transfer') {
      const ev = parsed.ev;
      const eventId = String(ev.eventId || ev.id || '');
      if (eventId && !seen.ids.has(eventId)) {
        seen.ids.add(eventId);
        saveSeen(seen);
      }
      touchConn(trader.handle, {
        skippedTransfers: (connState.get(trader.handle)?.skippedTransfers || 0) + 1,
      });
      appendSkip({
        at: new Date().toISOString(),
        handle: trader.handle,
        reason: 'kind=transfer',
        eventId: eventId || null,
        type: ev.type || ev.alertType || null,
        transferId: ev.transferId ?? null,
        text: ev.text || null,
      });
      log(`SKIP_TRANSFER @${trader.handle} eventId=${eventId || '?'} type=${ev.type || ev.alertType || '?'}`);
      writeHeartbeat();
      return;
    }
    if (parsed.kind !== 'buy') return;
    const ev = parsed.ev;
    if (ev.userId && String(ev.userId) !== String(trader.userId)) return;
    const eventId = String(ev.eventId || ev.id || '');
    if (!eventId) {
      log(`buy without eventId ignored @${trader.handle}`);
      return;
    }
    if (seen.ids.has(eventId)) {
      touchConn(trader.handle, {
        dupes: (connState.get(trader.handle)?.dupes || 0) + 1,
      });
      return;
    }
    seen.ids.add(eventId);
    saveSeen(seen);

    const clf = classifyBuyVsTransfer(ev);
    if (clf.isTransfer) {
      touchConn(trader.handle, {
        skippedTransfers: (connState.get(trader.handle)?.skippedTransfers || 0) + 1,
      });
      appendSkip({
        at: new Date().toISOString(),
        handle: trader.handle,
        reason: 'classify:' + clf.reasons.join('|'),
        eventId,
        ...clf,
      });
      log(`SKIP_TRANSFER @${trader.handle} eventId=${eventId} reasons=${clf.reasons.join('|')}`);
      touchConn(trader.handle, { lastEventId: eventId });
      writeHeartbeat();
      return;
    }

    void (async () => {
      const verify = await verifyTradeIsSwapBuy(ev.tradeId, key);
      if (verify.cost)
        log(`trade_verify @${trader.handle} cost=${verify.cost} rem=${verify.rem || '?'} eventId=${eventId}`);
      if (!verify.ok) {
        touchConn(trader.handle, {
          skippedTransfers: (connState.get(trader.handle)?.skippedTransfers || 0) + 1,
          lastEventId: eventId,
        });
        appendSkip({
          at: new Date().toISOString(),
          handle: trader.handle,
          reason: 'trade_verify:' + verify.reason,
          eventId,
          tradeId: ev.tradeId,
          verify,
        });
        log(`SKIP_TRANSFER @${trader.handle} eventId=${eventId} trade_verify=${verify.reason}`);
        writeHeartbeat();
        return;
      }

      const buyUsd = pickBuyUsd(ev);
      const needsPortfolio =
        Number(trader.alertRule?.minPortfolioPct) > 0 ||
        trader.alertRule?.requireNewPosition === true;

      let portfolio = { ok: false, reason: 'not_fetched' };
      if (needsPortfolio) {
        portfolio = await fetchPortfolioContext(trader.handle, key, ev);
        if (portfolio.cost)
          log(
            `balances @${trader.handle} cost=${portfolio.cost} rem=${portfolio.rem || '?'} total=${portfolio.totalValueUsd ?? '?'} eventId=${eventId}`,
          );
        if (!portfolio.ok) {
          log(`balances_fail @${trader.handle} eventId=${eventId} reason=${portfolio.reason || '?'}`);
        }
      }

      const newPos = judgeNewPosition(portfolio, buyUsd, getAmountEvidence(ev));
      const decision = evaluateAlertRule(trader, buyUsd, portfolio, newPos);

      if (!decision.pass) {
        if (decision.reason === 'not_new_position') {
          touchConn(trader.handle, {
            skippedNotNew: (connState.get(trader.handle)?.skippedNotNew || 0) + 1,
            lastEventId: eventId,
          });
        } else {
          touchConn(trader.handle, {
            skippedPct: (connState.get(trader.handle)?.skippedPct || 0) + 1,
            lastEventId: eventId,
          });
        }
        appendSkipPct({
          at: new Date().toISOString(),
          handle: trader.handle,
          eventId,
          reason: decision.reason,
          buyUsd,
          pct: decision.pctInfo?.pct ?? null,
          totalValueUsd: decision.pctInfo?.totalValueUsd ?? null,
          newPos,
        });
        log(
          `SKIP_RULE @${trader.handle} eventId=${eventId} reason=${decision.reason} buyUsd=${buyUsd} pct=${decision.pctInfo?.pct ?? '?'}`,
        );
        writeHeartbeat();
        return;
      }

      const when = parseEventTs(ev.ts) || parseEventTs(ev.execTs) || new Date();
      const delaySeconds = when ? Math.floor((Date.now() - when.getTime()) / 1000) : null;
      const ok = emitAlert({
        trader,
        ev,
        when,
        source: 'ws/alerts',
        pctInfo: decision.pctInfo,
        newPosInfo: decision.newPosInfo,
        delaySeconds,
      });
      if (ok) {
        touchConn(trader.handle, {
          alerts: (connState.get(trader.handle)?.alerts || 0) + 1,
          lastEventId: eventId,
        });
      }
      writeHeartbeat();
    })().catch((e) => log(`verify/emit error @${trader.handle}: ${e?.message || e}`));
  });

  ws.addEventListener('close', (e) => {
    alive = false;
    log(`WS close @${trader.handle} code=${e.code} reason=${e.reason || ''}`);
    touchConn(trader.handle, { wsOpen: false, status: 'closed' });
    writeHeartbeat();
  });
  ws.addEventListener('error', (e) => {
    log(`WS error @${trader.handle}: ${e.message || e.error || 'error'}`);
  });

  while (alive) {
    await sleep(Number(CFG.heartbeatEveryMs) || 30000);
    if (!alive) break;
    writeHeartbeat();
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', at: Date.now() }));
    } catch {}
  }
  close();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function watchTraderLoop({ trader, key, seen }) {
  let backoff = Number(CFG.reconnect?.initialMs) || 2000;
  const maxBackoff = Number(CFG.reconnect?.maxMs) || 60000;
  touchConn(trader.handle, { status: 'starting', reconnects: 0 });

  while (true) {
    try {
      await runSocket({ trader, key, seen });
      backoff = Number(CFG.reconnect?.initialMs) || 2000;
    } catch (e) {
      log(`socket failed @${trader.handle}: ${e?.message || e}`);
      touchConn(trader.handle, {
        wsOpen: false,
        status: 'error',
        lastError: String(e?.message || e),
      });
      writeHeartbeat();
    }
    const prev = connState.get(trader.handle)?.reconnects || 0;
    touchConn(trader.handle, {
      reconnects: prev + 1,
      status: 'reconnecting',
      wsOpen: false,
    });
    log(`reconnect @${trader.handle} in ${backoff}ms`);
    writeHeartbeat({ lastReconnectHandle: trader.handle, backoffMs: backoff });
    await sleep(backoff);
    backoff = Math.min(maxBackoff, backoff * 2);
  }
}

async function main() {
  const traders = tradersEnabled();
  if (!traders.length) {
    log('no enabled traders in config; exit');
    process.exit(1);
  }
  log(`starting multi-watch traders=${traders.map((t) => t.handle).join(',')}`);

  const key = loadKey();
  const seen = loadSeen();

  writeHeartbeat({ status: 'starting', seen: seen.ids.size });
  const seed = await seedNewTraders(seen, key, traders);
  log(
    `seed result seededIds=${seed.seeded} cost=${seed.cost} newTraders=${(seed.traders || []).join(',') || '(none)'}`,
  );
  writeHeartbeat({ status: 'seeded', seen: seen.ids.size, seed });

  const shutdown = () => {
    log('shutdown signal');
    writeHeartbeat({ status: 'stopping' });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // One reconnect loop per trader, concurrent in this process
  await Promise.all(traders.map((trader) => watchTraderLoop({ trader, key, seen })));
}

main().catch((e) => {
  log(`fatal: ${e?.message || e}`);
  writeHeartbeat({ status: 'fatal', error: String(e?.message || e) });
  process.exit(1);
});
