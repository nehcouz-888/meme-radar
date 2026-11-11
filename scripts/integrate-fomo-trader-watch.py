#!/usr/bin/env python3
"""
Integrate position-analysis audit fixes into fomo-trader-watch.mjs
保留所有原始功能，添加审计fix：
1. tradeUsd vs positionValueUsd vs totalAssetsUsd分离
2. 新仓前余额验证
3. >100%异常标注
4. $3000 fallback降级标签
5. 输出证据类型
"""

import re

def integrate_fomo_trader_watch(original_path, output_path):
    with open(original_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 1. 在import后添加position-analysis导入
    import_section = """import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';"""
    
    new_import = """import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// ✅ Audit fix: position analysis integration
import { 
  analyzeTransaction, 
  analyzePositionSize, 
  detectPositionAnomalies,
  formatAnomalies
} from '/workspace/src/modules/position-analysis.mjs';"""
    
    content = content.replace(import_section, new_import)
    
    # 2. 替换pickBuyUsd函数 - 真实tradeUsd优先
    old_pickBuyUsd = """function pickBuyUsd(ev) {
  const n = Number(
    ev.tradeUsd ?? ev.usdValue ?? ev.positionValueUsd ?? ev.sizeUsd ?? ev.valueUsd,
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}"""
    
    new_pickBuyUsd = """// ✅ Audit fix: 真实tradeUsd与仓位市值分离
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
}"""
    
    content = content.replace(old_pickBuyUsd, new_pickBuyUsd)
    
    # 3. 替换formatAlertText - 添加证据类型和异常标注
    old_formatAlertText_start = """function formatAlertText({ handle, profileUrl, ev, when, pctInfo, newPosInfo }) {
  const sym = pickSymbol(ev);
  const chain = chainLabel(ev.chain, ev.chainId);
  const size = pickSize(ev) || '规模未知';
  const ca = pickAddress(ev);
  const ago = minutesAgoLabel(when);
  const lines = [
    `@${handle} ${ago}买入了 ${sym}`,
    `链: ${chain}`,
    `规模: ${size}`,
  ];"""
    
    new_formatAlertText_start = """// ✅ Audit fix: 输出证据类型、异常标注、绝对时间
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
  }"""
    
    content = content.replace(old_formatAlertText_start, new_formatAlertText_start)
    
    # 4. 修改judgeNewPosition - 需要可验证交易证据
    old_judgeNewPosition = """function judgeNewPosition(portfolio, buyUsd) {
  if (!portfolio?.ok) {
    return { isNew: null, unknown: true, label: '是否新仓未知' };
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
}"""
    
    new_judgeNewPosition = """// ✅ Audit fix: 新仓需要可验证交易证据
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
}"""
    
    content = content.replace(old_judgeNewPosition, new_judgeNewPosition)
    
    # 5. 修改evaluateAlertRule - $3000 fallback降级标签
    old_fallback_section = """      // degrade: minUsdHint
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
      pctInfo = {
        fallback: `总资产未知，已按 minUsdHint $${minUsdHint} 放行`,
        buyUsd: buy,
      };"""
    
    new_fallback_section = """      // ✅ degrade: minUsdHint fallback需要真实成交额并降级标签
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
      }"""
    
    content = content.replace(old_fallback_section, new_fallback_section)
    
    # 6. 修改主循环中的judgeNewPosition调用，添加evidence参数
    old_judge_call = "      const newPos = judgeNewPosition(portfolio, buyUsd);"
    new_judge_call = "      const newPos = judgeNewPosition(portfolio, buyUsd, getAmountEvidence(ev));"
    content = content.replace(old_judge_call, new_judge_call)
    
    # 7. 修改emitAlert调用，传入delaySeconds
    old_emit = """      const when = parseEventTs(ev.ts) || parseEventTs(ev.execTs) || new Date();
      const ok = emitAlert({
        trader,
        ev,
        when,
        source: 'ws/alerts',
        pctInfo: decision.pctInfo,
        newPosInfo: decision.newPosInfo,
      });"""
    
    new_emit = """      const when = parseEventTs(ev.ts) || parseEventTs(ev.execTs) || new Date();
      const delaySeconds = when ? Math.floor((Date.now() - when.getTime()) / 1000) : null;
      const ok = emitAlert({
        trader,
        ev,
        when,
        source: 'ws/alerts',
        pctInfo: decision.pctInfo,
        newPosInfo: decision.newPosInfo,
        delaySeconds,
      });"""
    
    content = content.replace(old_emit, new_emit)
    
    # 8. 修改emitAlert函数签名
    old_emit_func = "function emitAlert({ trader, ev, when, source, pctInfo, newPosInfo }) {"
    new_emit_func = "function emitAlert({ trader, ev, when, source, pctInfo, newPosInfo, delaySeconds }) {"
    content = content.replace(old_emit_func, new_emit_func)
    
    # 9. 在emitAlert中传递delaySeconds到formatAlertText
    old_format_call = """  const text = formatAlertText({
    handle: trader.handle,
    profileUrl: trader.profileUrl,
    ev,
    when,
    pctInfo,
    newPosInfo,
  });"""
    
    new_format_call = """  const text = formatAlertText({
    handle: trader.handle,
    profileUrl: trader.profileUrl,
    ev,
    when,
    pctInfo,
    newPosInfo,
    delaySeconds,
  });"""
    
    content = content.replace(old_format_call, new_format_call)
    
    # 10. 在emitAlert的meta中添加evidence和delaySeconds
    old_meta_end = """    ts: ev.ts ?? null,
    whenIso: when ? when.toISOString() : null,
    whenCst: when
      ? new Date(when.getTime() + CST_OFFSET_MS).toISOString().replace('Z', '+08:00')
      : null,
    source,
    status: 'pending',"""
    
    new_meta_end = """    ts: ev.ts ?? null,
    whenIso: when ? when.toISOString() : null,
    whenCst: when
      ? new Date(when.getTime() + CST_OFFSET_MS).toISOString().replace('Z', '+08:00')
      : null,
    source,
    status: 'pending',
    delaySeconds,
    amountEvidence: getAmountEvidence(ev),"""
    
    content = content.replace(old_meta_end, new_meta_end)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"✅ Integrated fomo-trader-watch.mjs created at {output_path}")
    return True

if __name__ == '__main__':
    original = '/home/ubuntu/.cursor/projects/workspace/uploads/radar-production-snapshot/deployment/meme-radar-run/fomo-trader-watch/fomo-trader-watch.mjs'
    output = '/workspace/scripts/fomo-trader-watch.mjs'
    
    success = integrate_fomo_trader_watch(original, output)
    exit(0 if success else 1)
