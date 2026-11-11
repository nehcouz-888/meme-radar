// Wash-trade template HARD_REJECT (added 2026-10-17, user-approved). Pure, read-only, no I/O.
// Pattern: created==graduated (instant graduation), Jupiter organic ~0, tiny avg trade with huge
// trade count, holders >> real traders, RugCheck "High holder correlation", no socials.
// Reject only when the organic signal is present (mandatory) AND >= WASH_MIN_SIGNALS signals hit.
// Switch: WASH_REJECT=0 disables (default on). All thresholds env-tunable.
const n = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))) ? null : Number(v);
const E = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
export const WASH_REASON = 'wash_trade_template';
export function washConfig() {
  return {
    enabled: process.env.WASH_REJECT !== '0',
    instantGradSec: E('WASH_INSTANT_GRAD_SEC', 60),
    organicMax: E('WASH_ORGANIC_MAX', 5),
    organicVolRatioMax: E('WASH_ORGANIC_VOL_RATIO_MAX', 0.005),
    holderTraderRatio: E('WASH_HOLDER_TRADER_RATIO', 3),
    avgTradeMaxUsd: E('WASH_AVG_TRADE_MAX_USD', 10),
    minTxns: E('WASH_MIN_TXNS', 1000),
    minSignals: E('WASH_MIN_SIGNALS', 3)
  };
}
// input: { organicScore, createdAt, graduatedAt, holders, traders, buyVol, sellVol, buyOrganicVol,
//          sellOrganicVol, volume, txns, rugRisks:[names], hasSocials(bool|null) }
export function washTemplateCheck(x = {}, cfg = washConfig()) {
  const sig = [], miss = [];
  if (!cfg.enabled) return { enabled: false, reject: false, signals: sig, missing: miss };
  const c = Date.parse(x.createdAt || ''), g = Date.parse(x.graduatedAt || '');
  if (Number.isFinite(c) && Number.isFinite(g)) { if (Math.abs(g - c) <= cfg.instantGradSec * 1000) sig.push('instant_graduation'); } else miss.push('graduatedAt');
  const org = n(x.organicScore), tv = (n(x.buyVol) || 0) + (n(x.sellVol) || 0), ov = (n(x.buyOrganicVol) || 0) + (n(x.sellOrganicVol) || 0);
  const ovr = tv > 0 && (x.buyVol != null) ? ov / tv : null;
  const organicHit = (org !== null && org <= cfg.organicMax) || (ovr !== null && tv >= 5000 && ovr <= cfg.organicVolRatioMax);
  if (organicHit) sig.push(`organic_low(score=${org ?? '?'},orgVol=${ovr == null ? '?' : (ovr * 100).toFixed(3) + '%'})`); else if (org === null && ovr === null) miss.push('organic');
  const h = n(x.holders), t = n(x.traders);
  if (h !== null && t) { if (h / t >= cfg.holderTraderRatio) sig.push(`holders>>traders(${h}/${t})`); } else miss.push('holders/traders');
  const v = n(x.volume), tx = n(x.txns);
  if (v !== null && tx) { const avg = v / tx; if (tx >= cfg.minTxns && avg <= cfg.avgTradeMaxUsd) sig.push(`tiny_avg_trade($${avg.toFixed(2)}x${tx})`); } else miss.push('avgTrade');
  if (Array.isArray(x.rugRisks)) { if (x.rugRisks.some(r => /holder correlation/i.test(String(r)))) sig.push('rugcheck_holder_correlation'); } else miss.push('rugcheck');
  if (x.hasSocials === false) sig.push('no_socials'); else if (x.hasSocials == null) miss.push('socials');
  const reject = organicHit && sig.length >= cfg.minSignals;
  return { enabled: true, reject, reason: reject ? WASH_REASON : null, signals: sig, missing: miss };
}
// Helper: build input from raw Jupiter v2 token + DexScreener pair + RugCheck summary (any may be null).
export function washInputFromRaw(jup, ds, rug) {
  const s = jup?.stats24h || {};
  const socials = ds ? ((ds.info?.socials || []).length + (ds.info?.websites || []).length) > 0 : null;
  const jSoc = jup ? Boolean(jup.twitter || jup.website || jup.telegram) : null;
  return {
    organicScore: jup?.organicScore, createdAt: jup?.createdAt || jup?.firstPool?.createdAt, graduatedAt: jup?.graduatedAt,
    holders: jup?.holderCount, traders: s.numTraders, buyVol: s.buyVolume, sellVol: s.sellVolume,
    buyOrganicVol: s.buyOrganicVolume, sellOrganicVol: s.sellOrganicVolume,
    volume: ds?.volume?.h24, txns: ds ? (n(ds.txns?.h24?.buys) || 0) + (n(ds.txns?.h24?.sells) || 0) : null,
    rugRisks: rug ? (rug.risks || []).map(r => r.name ?? r) : null,
    hasSocials: socials === true || jSoc === true ? true : (socials === false || jSoc === false ? false : null)
  };
}
