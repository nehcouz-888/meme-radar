#!/usr/bin/env python3
"""
Integrate audit fixes into production fomo-free-scan.mjs
Preserves ALL original functionality while adding:
1. Market cap tiering (no <$100k hard limit)
2. Holder sample completeness tracking
3. Zero scoring for unknown/historical holdings
4. organicScore unit correction
"""

import re

def integrate_fomo_free_scan(original_path, output_path):
    with open(original_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # Find import section (around line 10-15)
    import_idx = None
    for i, line in enumerate(lines):
        if 'from \'/workspace/meme-radar-run/meme-radar-branch/src/age-window.mjs\'' in line:
            import_idx = i + 1
            break
    
    # Add audit fix module imports
    audit_imports = '''
// ✅ Audit fix modules (2026-11-12)
import { categorizeByMarketCap, marketCapScoreModifier } from '/workspace/src/modules/market-cap-tiers.mjs';
import { createHolderSample, scoreSmartMoneyWithCompleteness } from '/workspace/src/modules/holder-sample.mjs';
'''
    
    if import_idx:
        lines.insert(import_idx, audit_imports)
    
    # Find score function (around line 180-280)
    score_start = None
    for i, line in enumerate(lines):
        if 'function score(c, smart) {' in line:
            score_start = i
            break
    
    if score_start is None:
        print("❌ Could not find score function")
        return False
    
    # Find OG config section (around line 283-295)
    og_config_start = None
    for i, line in enumerate(lines):
        if '// OG 萌芽 config + KOL sets' in line or 'const OG = { enabled:' in line:
            og_config_start = i
            break
    
    if og_config_start is None:
        print("❌ Could not find OG config section")
        return False
    
    # Replace score function (lines score_start to og_config_start)
    new_score = '''function score(c, smart) {
  const notes = [], flags = []; let s = 10, reject = null;
  const k = c.chain === 'sol' ? c.address : c.address.toLowerCase();
  
  // ✅ Market cap tiering (Fix #1) - NO <$100k hard limit
  const tierInfo = categorizeByMarketCap(c.mcap || 0, c.ageH);
  c.marketCapTier = tierInfo.tier;
  c.marketCapBand = tierInfo.marketCapBand;
  
  // ✅ Holder sample completeness (Fix #2 & #3)
  const holders = smart.holding.get(k);
  const liveHolders = c.fomoHoldersLive;
  
  // Create holder sample with completeness tracking
  const holderSample = liveHolders ? createHolderSample(
    liveHolders.map(h => ({ 
      address: h, 
      tags: SMART_HANDLES.has(h.toLowerCase()) ? ['smart_degen'] : [] 
    })),
    {
      totalHolderCount: liveHolders.length,
      source: 'fomo:token-holders',
      sampleComplete: true,
      capturedAt: Date.now()
    }
  ) : (holders ? createHolderSample(
    [...holders].map(h => ({ address: h, tags: ['smart_degen'] })),
    {
      totalHolderCount: null,
      source: 'fomo:leaderboard-topTokens',
      sampleComplete: false,
      capturedAt: Date.now()
    }
  ) : null);
  
  // ✅ Score smart money with NO historical fallback (Fix #3)
  const aggregateSmart = 0;
  const smartResult = holderSample ? scoreSmartMoneyWithCompleteness(
    { rank: c.fomo?.trendingRank },
    holderSample,
    aggregateSmart
  ) : { 
    score: 0, 
    smartWallets: 0, 
    confidence: 'UNKNOWN', 
    note: '无持仓数据',
    sampleComplete: false
  };
  
  const stillHolding = smartResult.smartWallets;
  c.smart = { 
    stillHolding,
    fomoUsersHolding: liveHolders?.length ?? null,
    handles: holderSample?.wallets.slice(0, 8).map(w => w.address) || [],
    src: holderSample?.source || 'none',
    sampleComplete: smartResult.sampleComplete,
    coverage: smartResult.coverage,
    confidence: smartResult.confidence
  };
  
  if (c.liq == null) return { ...c, score: 0, tier: 'ignore', status: 'NO_MARKET_DATA', notes: ['DexScreener 无数据'], flags, marketCapTier: tierInfo.tier };
  if (c.liq < 5000) reject = 'liq<5k';
  s += c.liq < 10e3 ? 5 : c.liq < 50e3 ? 12 : c.liq < 200e3 ? 15 : 10;
  
  // ✅ Tier-based mcap scoring (not binary)
  if (c.mcap != null) {
    if (tierInfo.tier === 'EMBRYONIC') s += c.mcap >= 10e3 && c.mcap <= 50e3 ? 12 : 4;
    else if (tierInfo.tier === 'EARLY') s += c.mcap >= 50e3 && c.mcap <= 200e3 ? 12 : 6;
    else if (tierInfo.tier === 'GROWTH') s += c.mcap >= 200e3 && c.mcap <= 1e6 ? 10 : 4;
    else s += 4;
  }
  
  if (c.vol24 != null && c.liq) { const r = c.vol24 / c.liq; s += r > 3 ? 10 : r > 1 ? 6 : 0; }
  if (c.buys1h != null && c.sells1h != null) { if (c.buys1h > 1.2 * c.sells1h) s += 6; if (c.buys1h + c.sells1h > 200) s += 5; }
  if (c.chg1h != null) { if (c.chg1h > 0) s += 4; if (c.chg1h < -30) { s -= 10; flags.push('1h跌>30%'); } }
  if (c.chg24 != null && c.chg24 > 50) s += 5;
  if (c.ageH != null) s += c.ageH < 24 ? 8 : c.ageH < 72 ? 5 : c.ageH > 720 ? -5 : 0;
  if (c.fomo.trendingRank != null) s += c.fomo.trendingRank <= 10 ? 8 : c.fomo.trendingRank <= 30 ? 5 : 2;
  if ((c.fomo.fomoHolders || 0) > 50) s += 4;
  
  // ✅ Smart money scoring from holder sample (NO historical fallback)
  const smartPts = smartResult.score;
  s += smartPts;
  notes.push(`聪明钱[${smartResult.note}；计分+${smartPts}]${c.smart.fomoUsersHolding != null ? `；Fomo 用户持仓${c.smart.fomoUsersHolding}(不计分)` : ''}`);
  
  if (c.jup) {
    if (c.jup.isSus) reject = reject || 'jupiter isSus';
    if (c.jup.mintOff === false || c.jup.freezeOff === false) reject = reject || 'mint/freeze 权限未放弃';
    if (c.jup.organicScore != null && c.jup.organicScore >= 50) s += 5;
    if (c.jup.topHoldersPct != null) { if (c.jup.topHoldersPct > 60) reject = reject || `top持仓${c.jup.topHoldersPct.toFixed(0)}%>60%`; else if (c.jup.topHoldersPct > 40) { s -= 15; flags.push(`top持仓${c.jup.topHoldersPct.toFixed(0)}%`); } }
    if (c.jup.devMints != null && c.jup.devMints > 1000) notes.push(`devMints=${c.jup.devMints}(疑似 launchpad 部署者，不计)`);
    else if (c.jup.devMints != null && c.jup.devMints >= 5) { s -= 15; flags.push(`dev发币${c.jup.devMints}次(Jupiter)`); }
    if (c.jup.devBalancePct != null && c.jup.devBalancePct > 10) { s -= 10; flags.push(`dev持仓${c.jup.devBalancePct.toFixed(1)}%`); }
  }
  
  { const st = c.jup?.stats24h || {};
    const w = washTemplateCheck({ organicScore: c.jup?.organicScore, createdAt: c.jup?.createdAt, graduatedAt: c.jup?.graduatedAt, holders: c.jup?.holders, traders: st.numTraders,
      buyVol: st.buyVolume, sellVol: st.sellVolume, buyOrganicVol: st.buyOrganicVolume, sellOrganicVol: st.sellOrganicVolume, volume: c.vol24, txns: c.dsTxns24,
      rugRisks: c.rug ? c.rug.risks.map(r => r.name) : null, hasSocials: c.hasSocials === true || c.jup?.socials === true ? true : (c.jup || c.hasSocials === false) ? false : null });
    c.wash = w; if (w.reject) { reject = reject || `wash_trade_template: ${w.signals.join('/')}`; flags.push('wash_trade_template'); } }
  
  { const w0 = c.wash; const aw = evaluateAgeWindow({
      ageH: c.ageH, createdAt: c.jup?.createdAt, holders: c.jup?.holders ?? c.jup?.holderCount, traders: (c.jup?.stats24h || {}).numTraders,
      holdersPrev: c.holdersPrev, tradersPrev: c.tradersPrev,
      smartHoldingCount: stillHolding, kolHoldingCount: (c.smart?.handles || []).filter(h => KOL_HANDLES.has(String(h).toLowerCase())).length,
      hasSocials: c.hasSocials === true || c.jup?.socials === true, hadSocialsPrev: c.hadSocialsPrev,
      washReject: Boolean(w0?.reject)
    }, ageWindowConfig());
    c.ageWindow = aw;
    if (aw.reject && !reject) { reject = aw.reject; }
    if (aw.inWindow || aw.reject) {
      if (aw.bonus && !aw.reject) { s += aw.bonus; notes.push(`早期窗15-90分+${aw.bonus}[${aw.why.join('; ')}]`); }
      else if (aw.why.length) notes.push(`早期窗15-90分[${aw.why.join('; ')}]`);
      for (const f of aw.flags) if (!flags.includes(f)) flags.push(f);
    }
  }
  
  if (c.rug?.risks?.some(r => r.level === 'danger')) reject = reject || `RugCheck danger: ${c.rug.risks.filter(r => r.level === 'danger').map(r => r.name).join('/')}`;
  
  if (c.goplus) {
    if (c.goplus.honeypot) reject = reject || 'GoPlus honeypot';
    else if (c.goplus.cannotSellAll) reject = reject || 'GoPlus cannot_sell_all';
    else if ((c.goplus.buyTax ?? 0) > 0.1 || (c.goplus.sellTax ?? 0) > 0.1) reject = reject || `GoPlus 税率 买${c.goplus.buyTax}/卖${c.goplus.sellTax}>10%`;
  }
  
  const HF = hardFilterConfig(); let downgrade = [];
  if (HF.enabled && c.followerEval) { const fe = c.followerEval;
    if (fe.reject.length) reject = reject || `跟随者硬过滤: ${fe.reject.join('; ')}`;
    downgrade.push(...fe.downgrade); if (fe.penalty) { s -= fe.penalty; } notes.push(...fe.notes);
    if (fe.bonusCap0.length && c.spillover?.bonus) { notes.push(`外溢加分上限0: ${fe.bonusCap0.join('; ')}`); c.spillover.bonus = 0; } }
  if (HF.enabled && c.chain === 'sol') {
    const b = solBundleCheck(c.bundlePct ?? null, HF); if (b.reject) reject = reject || b.reject; if (b.penalty) s -= b.penalty; if (b.note) flags.push(b.note);
    for (const x of volumeCheck({ dsVol24: c.vol24, gtVol24: null, txns24: c.dsTxns24, liq: c.liq }, HF)) downgrade.push(`疑似刷量: ${x}`);
  }
  if (downgrade.length) { flags.push('降级仅提示'); notes.push(`降级(不给外溢加分、不进观察): ${downgrade.join('; ')}`); if (c.spillover?.bonus) c.spillover.bonus = 0; }
  if (c.spillover?.bonus) { s += c.spillover.bonus; notes.push(`跨链外溢+${c.spillover.bonus}[龙头 ${c.spillover.leaderSymbol} ${c.spillover.leaderChain}/${c.spillover.leaderCA} mcap=${c.spillover.leaderMcap}; ${c.spillover.why.join(',')}]`); }
  if (c.spilloverLeaderOf?.length) notes.push(`外溢龙头→跟随：${c.spilloverLeaderOf.join('、')}`);
  
  c.og = null;
  if (OG.enabled && !reject && c.mcap != null && c.mcap >= OG.minMcap && c.mcap < OG.maxMcap) {
    const kolW = c.smart.handles.filter(h => KOL_HANDLES.has(String(h).toLowerCase()));
    const kolX = (KOL_MENTIONS.get(k) || []).filter(h => X_WATCH.has(h.toLowerCase()));
    const smartN = stillHolding; const why = [];
    if (kolX.length) why.push(`KOL提及/喊单(${kolX.slice(0, 4).join(',')})`);
    if (kolW.length) why.push(`KOL钱包仍持仓(${kolW.slice(0, 4).join(',')})`);
    if (smartN) why.push(`聪明钱仍持仓${smartN}`);
    if (!why.length) notes.push(`OG未触发：市值<${fmtK(OG.maxMcap)}但无KOL/聪明钱确定性条件（不加分）`);
    else if (c.liq < OG.minLiq) notes.push(`OG未触发：流动性${fmtK(c.liq)}<下限${fmtK(OG.minLiq)}`);
    else {
      let b = OG.bonus; if (kolX.length || kolW.length) b += 4; if (smartN >= 2) b += 3; b = Math.min(OG.maxBonus, b);
      s += b; c.og = { bonus: b, why }; flags.push('OG'); notes.push(`OG萌芽+${b}[市值${fmtK(c.mcap)}<${fmtK(OG.maxMcap)}; ${why.join('; ')}]`);
    }
  }
  
  s = Math.max(0, Math.min(100, Math.round(s)));
  const unknown = ['bundler', 'sniper', 'rat/insider'];
  if (!(c.jup && c.jup.devMints != null)) unknown.push('dev serial mints');
  if (!(c.jup && c.jup.topHoldersPct != null) && c.fomoStats?.top10HoldersPercent == null) unknown.push('holder concentration');
  if (!c.jup && !c.rug) { s = Math.min(s, 60); notes.push('无 Jupiter/RugCheck 风控数据 → 分数封顶60'); }
  const tooBig = c.mcap != null && c.mcap > 20e6;
  let tier = reject ? 'reject' : s >= 70 ? 'hot' : s >= Number(process.env.FOMO_WATCH_MIN || 60) ? 'watch' : 'ignore';
  if (downgrade.length && tier !== 'reject') tier = 'ignore';
  if (tooBig && tier !== 'reject') { tier = 'ignore'; notes.push('市值>$20M 非早期，不入观察'); }
  const rawTier = tier; if (tier === 'hot') { tier = 'watch'; notes.push('原始≥70 → 降级模式封顶观察'); }
  return { ...c, score: s, rawTier, tier, status: reject ? 'HARD_REJECT' : 'WAIT_RECHECK', rejectReason: reject, unknown, notes, flags, marketCapTier: tierInfo.tier };
}

'''
    
    # Replace the score function
    lines[score_start:og_config_start] = [new_score]
    
    # Write output
    with open(output_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    print(f"✅ Integrated fomo-free-scan.mjs created at {output_path}")
    return True

if __name__ == '__main__':
    original = '/home/ubuntu/.cursor/projects/workspace/uploads/radar-production-snapshot/deployment/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs'
    output = '/workspace/scripts/fomo-free-scan.mjs'
    
    success = integrate_fomo_free_scan(original, output)
    exit(0 if success else 1)
