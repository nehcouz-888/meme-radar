// Age window 15–90 min early flags (direction 6). READ-ONLY pure helpers.
// Score/flag: holder growth vs trader count, second smart/KOL entry, socials appearing.
// wash_trade_template reject stays in wash-template.mjs (wired by scan).
const E = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
const n = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))) ? null : Number(v);

export function ageWindowConfig(overrides = {}) {
  return {
    enabled: process.env.AGE_WINDOW !== '0',
    minMinutes: E('AGE_WINDOW_MIN_MIN', 15),
    maxMinutes: E('AGE_WINDOW_MAX_MIN', 90),
    holderTraderGrowthFlagRatio: E('AGE_HOLDER_TRADER_RATIO', 1.5),
    secondSmartOrKolBonus: E('AGE_SECOND_SMART_BONUS', 4),
    socialsAppearBonus: E('AGE_SOCIALS_BONUS', 3),
    maxBonus: E('AGE_WINDOW_MAX_BONUS', 10),
    washReject: process.env.WASH_REJECT !== '0',
    ...overrides
  };
}

/** ageMinutes from ageH (hours) or createdMs. */
export function ageMinutesOf(c, nowMs = Date.now()) {
  if (c?.ageMinutes != null) return n(c.ageMinutes);
  if (c?.ageH != null) return n(c.ageH) * 60;
  if (c?.createdAt) {
    const t = Date.parse(c.createdAt);
    if (Number.isFinite(t)) return (nowMs - t) / 60e3;
  }
  if (c?.pairCreatedAt) {
    const t = Number(c.pairCreatedAt);
    if (Number.isFinite(t)) return (nowMs - t) / 60e3;
  }
  return null;
}

export function inAgeWindow(c, cfg = ageWindowConfig(), nowMs = Date.now()) {
  const m = ageMinutesOf(c, nowMs);
  if (m == null) return { inWindow: false, ageMinutes: null };
  return { inWindow: cfg.enabled && m >= cfg.minMinutes && m <= cfg.maxMinutes, ageMinutes: m };
}

/**
 * input: {
 *   holders, traders, holdersPrev?, tradersPrev?,
 *   smartHoldingCount, kolHoldingCount,
 *   hasSocials, hadSocialsPrev?,
 *   washReject? (bool from washTemplateCheck)
 * }
 */
export function evaluateAgeWindow(input = {}, cfg = ageWindowConfig(), nowMs = Date.now()) {
  const age = inAgeWindow(input, cfg, nowMs);
  const out = {
    enabled: cfg.enabled,
    inWindow: age.inWindow,
    ageMinutes: age.ageMinutes,
    flags: [],
    bonus: 0,
    why: [],
    reject: null
  };
  if (!cfg.enabled) return out;
  if (input.washReject) {
    out.reject = 'wash_trade_template';
    out.flags.push('wash_trade_template');
    return out;
  }
  if (!age.inWindow) {
    out.why.push(age.ageMinutes == null ? '年龄未知，跳过15-90分钟窗' : `年龄${age.ageMinutes.toFixed(1)}分钟不在${cfg.minMinutes}-${cfg.maxMinutes}窗`);
    return out;
  }
  out.flags.push('age_15_90');
  out.why.push(`年龄${age.ageMinutes.toFixed(1)}分钟在早期窗`);

  const holders = n(input.holders), traders = n(input.traders);
  const h0 = n(input.holdersPrev), t0 = n(input.tradersPrev);
  if (holders != null && traders != null && traders > 0) {
    const ratio = holders / traders;
    if (ratio >= cfg.holderTraderGrowthFlagRatio) {
      out.flags.push('holders_vs_traders');
      out.why.push(`持仓人数/交易者=${ratio.toFixed(2)} (>=${cfg.holderTraderGrowthFlagRatio})`);
    }
  }
  if (h0 != null && holders != null && t0 != null && traders != null && t0 > 0 && traders > 0) {
    const hg = holders / Math.max(1, h0), tg = traders / Math.max(1, t0);
    if (hg > 1.2 && hg > tg * 1.3) {
      out.flags.push('holder_growth_vs_traders');
      out.why.push(`持仓增长${hg.toFixed(2)}x 快于交易者增长${tg.toFixed(2)}x`);
    }
  }

  const smartN = n(input.smartHoldingCount) || 0;
  const kolN = n(input.kolHoldingCount) || 0;
  if (smartN + kolN >= 2) {
    out.bonus += cfg.secondSmartOrKolBonus;
    out.flags.push('second_smart_or_kol');
    out.why.push(`第二聪明钱/KOL入场(聪明钱${smartN}+KOL${kolN})+${cfg.secondSmartOrKolBonus}`);
  } else if (smartN + kolN === 1) {
    out.flags.push('first_smart_or_kol');
    out.why.push(`首个聪明钱/KOL仍持仓(聪明钱${smartN}+KOL${kolN})`);
  }

  if (input.hasSocials === true && input.hadSocialsPrev === false) {
    out.bonus += cfg.socialsAppearBonus;
    out.flags.push('socials_appeared');
    out.why.push(`社交链接新出现+${cfg.socialsAppearBonus}`);
  } else if (input.hasSocials === true) {
    out.flags.push('has_socials');
    out.why.push('已有社交链接');
  }

  out.bonus = Math.max(0, Math.min(cfg.maxBonus, out.bonus));
  return out;
}
