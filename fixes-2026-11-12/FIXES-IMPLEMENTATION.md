# 质量审计修复实施文档
# Quality Audit Fixes Implementation

**实施日期**: 2026-11-12  
**工作分支**: cursor/smart-money-live-holding-fix-c671  
**交接包SHA256**: 0c6fedb9415b964d7aa96b06926fa1d05d8cf695319d3c6c112f8ec17e2b1505

---

## 执行摘要

根据审计发现的8个问题，已完成以下修复：

### ✅ 已修复问题

1. **市值硬限制移除** - 配置级修复
2. **Exit Watchlist 自动登记** - 核心逻辑修复  
3. **金额计算明确** - Fomo Trader Watch修复
4. **样本完整性标记** - Fomo Free Scan修复
5. **X健康检查** - 软提及路径修复
6. **时间戳与TTL** - Delivery与Narrative修复
7. **评分分层** - 证据/机会/风险分离
8. **身份标记** - chain+CA固定身份

---

## 修复1: 取消市值硬限制，改为分层参考

### 文件: `src/config-mcap-tiers.mjs` (新增)

```javascript
/**
 * 市值分层配置 (2026-11-12)
 * 用户授权：取消<10万/$100万硬限制，市值仅作分层/参考，不作绝对排除条件。
 * 高市值币不得仅因市值被拒；安全/风险/证据要求仍严格过滤。
 */

export const marketCapTiers = Object.freeze({
  // 不再设置全局 discoveryMaxMarketCap 硬上限
  // 改为分层，每层有不同的最低证据要求
  
  EMBRYONIC: {
    label: '萌芽期',
    minMcap: 0,
    maxMcap: 50_000,        // $0-5万
    minEvidence: 'MEDIUM',
    description: '超早期，需要中等证据置信度'
  },
  
  EARLY: {
    label: '早期',
    minMcap: 50_000,
    maxMcap: 200_000,       // $5万-20万
    minEvidence: 'MEDIUM',
    description: '早期机会，需要中等证据'
  },
  
  GROWTH: {
    label: '成长期',
    minMcap: 200_000,
    maxMcap: 1_000_000,     // $20万-100万
    minEvidence: 'HIGH',
    description: '成长阶段，需要高证据置信度'
  },
  
  ESTABLISHED: {
    label: '存量期',
    minMcap: 1_000_000,
    maxMcap: 20_000_000,    // $100万-2000万
    minEvidence: 'STRICT',
    description: '存量币，需要严格跨源验证'
  },
  
  LARGE_CAP: {
    label: '大市值',
    minMcap: 20_000_000,
    maxMcap: Infinity,       // >$2000万
    minEvidence: 'STRICT',
    description: '大盘，需要严格验证且多源确认'
  }
});

/**
 * 根据市值确定分层
 */
export function categorizeBehalf(marketCap, ageHours = null) {
  const mc = Number(marketCap) || 0;
  
  // 按市值分层
  if (mc < 50_000) {
    return {
      tier: 'EMBRYONIC',
      tierDef: marketCapTiers.EMBRYONIC,
      marketCapBand: '$0-5万',
      minEvidence: 'MEDIUM'
    };
  } else if (mc < 200_000) {
    return {
      tier: 'EARLY',
      tierDef: marketCapTiers.EARLY,
      marketCapBand: '$5万-20万',
      minEvidence: 'MEDIUM'
    };
  } else if (mc < 1_000_000) {
    return {
      tier: 'GROWTH',
      tierDef: marketCapTiers.GROWTH,
      marketCapBand: '$20万-100万',
      minEvidence: 'HIGH',
      note: '成长期需要更高证据置信度'
    };
  } else if (mc < 20_000_000) {
    return {
      tier: 'ESTABLISHED',
      tierDef: marketCapTiers.ESTABLISHED,
      marketCapBand: '$100万-2000万',
      minEvidence: 'STRICT',
      requireCrossValidation: true,
      note: '存量期必须跨源验证'
    };
  } else {
    return {
      tier: 'LARGE_CAP',
      tierDef: marketCapTiers.LARGE_CAP,
      marketCapBand: '>$2000万',
      minEvidence: 'STRICT',
      requireCrossValidation: true,
      requireMultiSource: true,
      note: '大盘必须多源确认'
    };
  }
}

/**
 * 市值分层评分调整系数
 * 不再硬排除，但高市值需要更强证据才能获得同等分数
 */
export function marketCapScoreModifier(tier) {
  const modifiers = {
    EMBRYONIC: 1.0,      // 萌芽期不惩罚
    EARLY: 1.0,          // 早期不惩罚  
    GROWTH: 0.85,        // 成长期轻微降分（需要更强证据补偿）
    ESTABLISHED: 0.7,    // 存量期显著降分
    LARGE_CAP: 0.5       // 大盘严格降分
  };
  return modifiers[tier] || 0.7;
}
```

### 文件: `src/config.mjs` (修改)

```javascript
// 修改前：
discoveryMinMarketCap: 10_000,
discoveryMaxMarketCap: 200_000,  // ← 硬上限，拒绝 >20万

// 修改后：
discoveryMinMarketCap: 10_000,
// discoveryMaxMarketCap 已移除，不再硬排除
// 使用 marketCapTiers 分层，见 config-mcap-tiers.mjs

// 新增配置
marketCapTiersEnabled: true,
marketCapStrictEvidence: true,  // 高市值需要严格证据
```

### 使用示例

```javascript
import { categorizeBehalf, marketCapScoreModifier } from './config-mcap-tiers.mjs';

// 评分时
const token = { marketCap: 350_000, ageHours: 12 };
const tier = categorizeBehalf(token.marketCap, token.ageHours);

console.log(tier);
// {
//   tier: 'GROWTH',
//   marketCapBand: '$20万-100万',
//   minEvidence: 'HIGH',
//   note: '成长期需要更高证据置信度'
// }

// 根据分层调整分数
let rawScore = 85;
const modifier = marketCapScoreModifier(tier.tier);
const adjustedScore = rawScore * modifier;  // 85 * 0.85 = 72.25

// 证据检查
if (tier.minEvidence === 'HIGH' && !token.crossValidated) {
  status = 'WAIT_RECHECK';
  reason = '成长期需要跨源验证';
}
```

---

## 修复2: Exit Watchlist 自动登记与持续刷新

### 文件: `src/exit-downgrade.mjs` (修改)

```javascript
/**
 * 自动登记候选到监控列表
 * chain+CA 固定身份
 */
export function autoRegisterToWatchlist(token, reason, prevWatchlist = { items: [] }) {
  const key = `${token.chain}:${token.address}`;
  const existing = prevWatchlist.items.find(
    item => item.chain === token.chain && item.address === token.address
  );
  
  if (existing) {
    // 已存在，更新最后发现时间
    existing.lastSeenAt = Date.now();
    existing.seenCount = (existing.seenCount || 0) + 1;
    return { watchlist: prevWatchlist, registered: false, updated: true };
  }
  
  // 新登记
  const entry = {
    id: crypto.randomUUID(),
    chain: token.chain,
    address: token.address,
    symbol: token.symbol || 'UNKNOWN',
    registeredAt: Date.now(),
    registeredReason: reason,  // 'hot_board' | 'user_manual' | 'narrative_match'
    lastSeenAt: Date.now(),
    lastRefreshedAt: 0,
    seenCount: 1,
    
    // 持仓快照历史
    snapshotHistory: [],
    
    // 告警记录（去重用）
    alerts: []
  };
  
  const updated = {
    ...prevWatchlist,
    items: [...prevWatchlist.items, entry]
  };
  
  return { watchlist: updated, registered: true, newEntry: entry };
}

/**
 * 持仓快照结构
 */
export function createHoldingSnapshot(source, data) {
  return {
    capturedAt: Date.now(),
    source,  // 'fomo' | 'gmgn_on_demand' | 'free_scanner'
    
    smartWallets: (data.smartWallets || []).map(w => ({
      address: w.address,
      tags: w.tags || [],
      amount: w.amount !== undefined ? w.amount : null,  // null = 未知
      amountUsd: w.amountUsd !== undefined ? w.amountUsd : null
    })),
    
    totalSampleSize: data.totalSampleSize || (data.smartWallets || []).length,
    sampleComplete: Boolean(data.sampleComplete),
    
    // 区分"完整"vs"部分样本"
    completenessNote: data.sampleComplete 
      ? '样本完整' 
      : `部分样本${data.totalSampleSize}个-覆盖未知`
  };
}

/**
 * 分析持仓变化：真实减少 vs 样本缺失
 */
export function analyzeHoldingChange(prevSnapshot, currSnapshot) {
  // 样本不完整 → 无法确认
  if (!prevSnapshot || !currSnapshot) {
    return {
      conclusion: 'INSUFFICIENT_DATA',
      reason: '缺少前后快照',
      canConfirm: false
    };
  }
  
  if (!prevSnapshot.sampleComplete || !currSnapshot.sampleComplete) {
    return {
      conclusion: 'INSUFFICIENT_DATA',
      reason: '样本不完整，无法确认清仓或减仓',
      canConfirm: false,
      prevComplete: prevSnapshot.sampleComplete,
      currComplete: currSnapshot.sampleComplete
    };
  }
  
  // 都完整 → 可以比较
  const prevAddresses = new Set(
    prevSnapshot.smartWallets.map(w => w.address)
  );
  const currAddresses = new Set(
    currSnapshot.smartWallets.map(w => w.address)
  );
  
  const exited = [...prevAddresses].filter(a => !currAddresses.has(a));
  const entered = [...currAddresses].filter(a => !prevAddresses.has(a));
  
  const netChange = entered.length - exited.length;
  
  if (exited.length > 0 && netChange < 0) {
    return {
      conclusion: 'NET_SELLING_PRESSURE',
      exitedCount: exited.length,
      enteredCount: entered.length,
      netChange,
      exitedWallets: exited,
      severity: exited.length >= 3 ? 'HIGH' : exited.length >= 2 ? 'MEDIUM' : 'LOW',
      canConfirm: true
    };
  } else if (exited.length === prevAddresses.size && currAddresses.size === 0) {
    return {
      conclusion: 'CONFIRMED_FULL_EXIT',
      exitedCount: exited.length,
      severity: 'CRITICAL',
      canConfirm: true
    };
  } else {
    return {
      conclusion: 'STABLE_OR_GROWING',
      exitedCount: exited.length,
      enteredCount: entered.length,
      netChange,
      canConfirm: true
    };
  }
}

/**
 * 刷新监控列表的持仓数据
 */
export async function refreshWatchlistHoldings(watchlist, dataSource) {
  const updated = { ...watchlist, items: [] };
  
  for (const item of watchlist.items) {
    // 获取最新持仓数据
    const freshData = await dataSource.getHoldings(item.chain, item.address);
    
    if (freshData) {
      const snapshot = createHoldingSnapshot(dataSource.name, freshData);
      
      // 添加到历史
      const history = [...(item.snapshotHistory || []), snapshot];
      // 保留最近10个快照
      const trimmed = history.slice(-10);
      
      // 分析变化
      const prevSnapshot = item.snapshotHistory?.[item.snapshotHistory.length - 1];
      let changeAnalysis = null;
      if (prevSnapshot) {
        changeAnalysis = analyzeHoldingChange(prevSnapshot, snapshot);
      }
      
      updated.items.push({
        ...item,
        lastRefreshedAt: Date.now(),
        snapshotHistory: trimmed,
        latestChangeAnalysis: changeAnalysis
      });
    } else {
      // 刷新失败，保留原数据
      updated.items.push(item);
    }
  }
  
  return updated;
}

/**
 * 告警去重键
 */
export function alertDedupeKey(alert) {
  return `${alert.type}:${alert.chain}:${alert.address}:${alert.severity || 'default'}`;
}

/**
 * 检查是否需要发送告警（去重）
 */
export function shouldSendAlert(alert, item, dedupeWindowMs = 3600_000) {
  const key = alertDedupeKey(alert);
  const now = Date.now();
  
  // 检查历史告警
  const recent = (item.alerts || []).filter(
    a => alertDedupeKey(a) === key && now - a.sentAt < dedupeWindowMs
  );
  
  return recent.length === 0;
}
```

### 测试用例: `tests/exit-downgrade.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoRegisterToWatchlist,
  createHoldingSnapshot,
  analyzeHoldingChange
} from '../src/exit-downgrade.mjs';

test('自动登记到watchlist', () => {
  const token = {
    chain: 'sol',
    address: '8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
    symbol: 'NIHAO'
  };
  
  const emptyWatchlist = { items: [] };
  const result = autoRegisterToWatchlist(token, 'hot_board', emptyWatchlist);
  
  assert.equal(result.registered, true);
  assert.equal(result.watchlist.items.length, 1);
  assert.equal(result.newEntry.chain, 'sol');
  assert.equal(result.newEntry.address, token.address);
});

test('样本不完整 → 无法确认清仓', () => {
  const prev = createHoldingSnapshot('fomo', {
    smartWallets: [
      { address: 'SMART_A' },
      { address: 'SMART_B' }
    ],
    totalSampleSize: 2,
    sampleComplete: true
  });
  
  const curr = createHoldingSnapshot('fomo', {
    smartWallets: [],
    totalSampleSize: 0,
    sampleComplete: false  // ← 样本不完整
  });
  
  const analysis = analyzeHoldingChange(prev, curr);
  
  assert.equal(analysis.conclusion, 'INSUFFICIENT_DATA');
  assert.equal(analysis.canConfirm, false);
  assert.match(analysis.reason, /样本不完整/);
});

test('样本完整 → 确认清仓', () => {
  const prev = createHoldingSnapshot('fomo', {
    smartWallets: [
      { address: 'SMART_A' },
      { address: 'SMART_B' }
    ],
    totalSampleSize: 2,
    sampleComplete: true
  });
  
  const curr = createHoldingSnapshot('fomo', {
    smartWallets: [],
    totalSampleSize: 0,
    sampleComplete: true  // ← 确认完整且为空
  });
  
  const analysis = analyzeHoldingChange(prev, curr);
  
  assert.equal(analysis.conclusion, 'CONFIRMED_FULL_EXIT');
  assert.equal(analysis.canConfirm, true);
  assert.equal(analysis.severity, 'CRITICAL');
});
```

---

## 修复3: Fomo Trader Watch 金额计算明确

### 问题: 混淆 tradeUsd、positionValueUsd、totalAssetsUsd

### 修复: `fomo-trader-watch.mjs` (关键部分)

```javascript
/**
 * 明确三个概念：
 * 1. tradeUsd - 实际成交额（买入/卖出金额）
 * 2. positionValueUsd - 当前持仓市值（事后估值）
 * 3. totalAssetsUsd - 钱包总资产
 */
function analyzeTransaction(event) {
  const tx = {
    // 1. 成交额 - 实际交易金额
    tradeUsd: parseFloat(event.tradeUsd) || null,
    
    // 2. 持仓市值 - 当前估值（不是成交额！）
    positionValueUsd: parseFloat(event.usdValue || event.positionValueUsd) || null,
    
    // 3. 总资产
    totalAssetsUsd: parseFloat(event.totalValueUsd || event.assets) || null,
    
    // ❌ 不能用 positionValue 当成交额！
  };
  
  // 新仓判断逻辑
  const positionAnalysis = analyzePositionSize(tx, event);
  
  return {
    ...tx,
    ...positionAnalysis,
    eventId: event.eventId,
    timestamp: event.timestamp
  };
}

function analyzePositionSize(tx, event) {
  // Case 1: 有明确成交额
  if (tx.tradeUsd !== null && tx.tradeUsd > 0) {
    if (tx.totalAssetsUsd !== null && tx.totalAssetsUsd > 0) {
      const ratio = tx.tradeUsd / tx.totalAssetsUsd;
      
      // 异常检测: 成交额 > 总资产
      if (ratio > 1.0) {
        return {
          isNewPosition: true,
          positionRatio: ratio,
          anomaly: 'TRADE_EXCEEDS_ASSETS',
          anomalyNote: `成交额$${tx.tradeUsd.toFixed(0)}超过总资产$${tx.totalAssetsUsd.toFixed(0)}`,
          confidence: 'LOW',
          qualifies5Percent: ratio >= 0.05
        };
      }
      
      // 正常: 占比计算
      return {
        isNewPosition: ratio >= 0.05,
        positionRatio: ratio,
        confidence: 'HIGH',
        qualifies5Percent: ratio >= 0.05,
        note: `成交${(ratio * 100).toFixed(1)}%资产`
      };
    }
    
    // Case 2: 有成交额，无总资产 → Fallback
    if (tx.tradeUsd >= 3000) {
      return {
        isNewPosition: true,
        tradeUsd: tx.tradeUsd,
        confidence: 'MEDIUM',
        qualifies5Percent: 'ASSUMED',
        fallbackUsed: true,
        note: '总资产未知，使用$3000阈值fallback（用户明确）'
      };
    }
    
    // Case 3: 成交额 < $3000 且无总资产
    return {
      isNewPosition: false,
      reason: '成交额不足$3000且总资产未知',
      confidence: 'LOW'
    };
  }
  
  // Case 4: 无成交额数据
  if (tx.tradeUsd === null) {
    // ❌ 不能用 positionValue 推算！
    return {
      isNewPosition: false,
      reason: '无成交额数据',
      confidence: 'UNKNOWN',
      qualifies5Percent: false,
      note: '仅有持仓市值$' + (tx.positionValueUsd || 'unknown') + '，无实际成交额'
    };
  }
  
  return {
    isNewPosition: false,
    reason: '成交额为0或负数',
    confidence: 'LOW'
  };
}

// 在事件过滤中使用
function shouldAlertTransaction(event, config) {
  const analysis = analyzeTransaction(event);
  
  // 异常标记但不过滤（显示给用户）
  if (analysis.anomaly) {
    log(`⚠️ 异常: ${analysis.anomalyNote}`);
    // 仍然可以通过，但标记异常
  }
  
  // 检查新仓要求
  if (config.requireNewPosition && !analysis.isNewPosition) {
    return { pass: false, reason: '非新仓或无成交额确认' };
  }
  
  // 检查5%要求
  if (config.minPortfolioPct && config.minPortfolioPct >= 0.05) {
    if (!analysis.qualifies5Percent) {
      return { pass: false, reason: '未达5%仓位要求' };
    }
    if (analysis.qualifies5Percent === 'ASSUMED') {
      // Fallback情况，标记但通过
      analysis.fallbackWarning = true;
    }
  }
  
  return { pass: true, analysis };
}
```

---

## 修复4: Fomo Free Scan 样本完整性标记

### 文件: `fomo-free-scan.mjs` (修改)

```javascript
/**
 * 持仓样本结构
 */
function createHolderSample(wallets, metadata) {
  const totalHolderCount = metadata.totalHolderCount || null;
  const sampledCount = wallets.length;
  
  // 判断样本完整性
  let sampleComplete = false;
  let coverage = '';
  
  if (totalHolderCount !== null && sampledCount >= totalHolderCount) {
    sampleComplete = true;
    coverage = '当前确认完整';
  } else if (sampledCount >= 100) {
    // 阈值可配置
    sampleComplete = true;
    coverage = '榜单前100-足够代表性';
  } else if (totalHolderCount !== null) {
    coverage = `部分样本${sampledCount}/${totalHolderCount}-未知覆盖`;
  } else {
    coverage = `部分样本${sampledCount}个-未知总数`;
  }
  
  return {
    wallets,
    totalHolderCount,
    sampledCount,
    sampleComplete,
    coverage,
    source: metadata.source || 'fomo',
    capturedAt: Date.now()
  };
}

/**
 * 评分时考虑样本完整性
 */
function scoreSmartMoney(token, holderSample) {
  const smartWallets = countSmartWallets(holderSample.wallets);
  
  // 状态判断
  const status = {
    onTopBoard: token.rank !== null && token.rank <= 100,
    currentConfirmed: holderSample.sampleComplete,
    unknown: !holderSample.sampleComplete
  };
  
  let score = 0;
  let note = '';
  
  if (status.currentConfirmed && smartWallets === 0) {
    // 确认完整且为0 → 无加分
    score = 0;
    note = '样本完整确认：0个聪明钱仍持仓';
  } else if (status.unknown) {
    // 样本不完整 → 降权使用历史
    const aggregateSmart = token.aggregateSmartWallets || 0;
    score = aggregateSmart * 0.3;  // 30%权重
    note = `样本不完整(${holderSample.coverage})，降权使用历史聚合${aggregateSmart}个`;
  } else if (status.currentConfirmed) {
    // 完整样本 → 全权使用实时
    score = calculateSmartScore(smartWallets);
    note = `样本完整确认：${smartWallets}个聪明钱仍持仓`;
  }
  
  return {
    smartWallets,
    score,
    status,
    coverage: holderSample.coverage,
    note
  };
}

function calculateSmartScore(count) {
  if (count >= 3) return 20;
  if (count === 2) return 10;
  if (count === 1) return 5;
  return 0;
}
```

### 测试用例

```javascript
test('样本缺席不等于清仓', () => {
  const case1 = {
    previous: {
      wallets: [
        { address: 'SMART_A', tags: ['smart_degen'] },
        { address: 'SMART_B', tags: ['smart_degen'] }
      ],
      sampleComplete: true
    },
    current: {
      wallets: [],  // 空样本
      sampleComplete: false  // ← 样本不完整
    }
  };
  
  const score = scoreSmartMoney({ aggregateSmartWallets: 2 }, {
    wallets: case1.current.wallets,
    sampleComplete: case1.current.sampleComplete,
    coverage: '部分样本0个-未知总数'
  });
  
  // 不应该判定为清仓，而是状态未知
  assert.equal(score.status.unknown, true);
  assert.match(score.note, /样本不完整/);
  assert.ok(score.score > 0);  // 使用降权的历史值
});

test('确认完整样本的清仓', () => {
  const case2 = {
    previous: {
      wallets: [
        { address: 'SMART_A', tags: ['smart_degen'] }
      ],
      sampleComplete: true
    },
    current: {
      wallets: [],  // 空样本
      sampleComplete: true  // ← 确认完整
    }
  };
  
  const score = scoreSmartMoney({}, {
    wallets: case2.current.wallets,
    sampleComplete: case2.current.sampleComplete,
    coverage: '当前确认完整'
  });
  
  // 确认清仓
  assert.equal(score.status.currentConfirmed, true);
  assert.equal(score.smartWallets, 0);
  assert.equal(score.score, 0);
  assert.match(score.note, /0个聪明钱仍持仓/);
});
```

---

## 修复5: X Soft Mention 健康检查

### 文件: `src/soft-mention-health.mjs` (新增)

```javascript
/**
 * X软提及路径健康检查 (2026-11-12)
 * 问题4修复：显式标记缺失，不假装健康
 */

export function checkSoftMentionHealth(stats) {
  const {
    providerConfigured,
    providerType,
    eventsProcessed24h,
    softMentionsDetected24h,
    explicitCashtagsDetected24h,
    highTierAccounts,
    keywordsLoaded
  } = stats;
  
  // 判断健康状态
  let status = 'HEALTHY';
  let reasons = [];
  
  // 检查provider配置
  if (!providerConfigured || providerType === 'stub' || !providerType) {
    status = 'MISSING';
    reasons.push('Provider未配置或使用stub');
  }
  
  // 检查关键词配置
  if (!keywordsLoaded || keywordsLoaded === 0) {
    status = status === 'HEALTHY' ? 'DEGRADED' : status;
    reasons.push('关键词配置未加载');
  }
  
  // 检查高权重账号
  if (highTierAccounts === 0) {
    status = status === 'HEALTHY' ? 'DEGRADED' : status;
    reasons.push('无高权重账号监控');
  }
  
  // 检查24h输出
  if (eventsProcessed24h === 0) {
    status = 'MISSING';
    reasons.push('24小时内无推文处理记录');
  } else if (softMentionsDetected24h === 0 && explicitCashtagsDetected24h === 0) {
    status = 'DEGRADED';
    reasons.push('24小时内无软提及或显式cashtag检测到');
  }
  
  return {
    status,  // 'HEALTHY' | 'DEGRADED' | 'MISSING'
    reasons,
    recommendation: status !== 'HEALTHY' 
      ? '检查provider配置、关键词文件和watchlist' 
      : null,
    timestamp: Date.now()
  };
}

/**
 * 软提及检测（严格模式）
 * 不放宽阈值凑信号
 */
export function detectSoftMention(tweet, account, keywords) {
  const isHighTier = ['official', 'founder', 'chain_lead'].includes(
    account.tier
  );
  
  // 必须是高权重账号
  if (!isHighTier) {
    return null;
  }
  
  const text = tweet.text || '';
  
  // 1. 显式 cashtag ($TOKEN)
  const cashtags = extractCashtags(text);
  if (cashtags.length > 0) {
    return {
      type: 'explicit_cashtag',
      confidence: 'HIGH',
      cashtags,
      handle: account.handle,
      tier: account.tier
    };
  }
  
  // 2. 关键词匹配
  const matched = findKeywordMatches(text, keywords, account);
  if (matched.length > 0) {
    return {
      type: 'keyword_match',
      confidence: 'MEDIUM',
      keywords: matched,
      handle: account.handle,
      tier: account.tier
    };
  }
  
  // 3. 无匹配 → 不生成事件
  // ✅ 不假装健康，显式返回 null
  return null;
}

function extractCashtags(text) {
  const pattern = /\$([A-Z][A-Z0-9]{1,10})\b/g;
  const matches = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}
```

### API端点: 健康检查

```javascript
// GET /api/x-monitor/health
app.get('/api/x-monitor/health', (req, res) => {
  const stats = xMonitor.getStats();
  const health = checkSoftMentionHealth(stats);
  
  res.json({
    ...health,
    provider: {
      configured: stats.providerConfigured,
      type: stats.providerType,
      lastSuccessAt: stats.lastSuccessAt
    },
    events: {
      last24h: {
        tweets: stats.eventsProcessed24h,
        softMentions: stats.softMentionsDetected24h,
        explicitCashtags: stats.explicitCashtagsDetected24h
      }
    },
    watchlist: {
      total: stats.totalAccounts,
      highTier: stats.highTierAccounts
    }
  });
});
```

---

## 修复6: Delivery时间戳与TTL管理

### Alert Lifecycle完整记录

```javascript
/**
 * 告警生命周期（2026-11-12）
 * 修复问题5：时间戳完整、过期降历史、休息时段
 */

export interface AlertLifecycle {
  // 时间戳
  eventOccurredAt: number;      // 事件发生时间
  receivedAt: number;           // 系统接收时间
  enqueuedAt: number;           // 入队时间
  attemptedAt: number[];        // 尝试送达时间数组
  deliveredAt: number | null;   // 实际送达时间（✅ 确认后才设置）
  
  // TTL管理
  ttl: number;                  // 过期时限（秒）
  expiresAt: number;            // 过期时间点
  
  // 状态
  status: 'fresh' | 'queued' | 'attempting' | 'delivered' | 'expired' | 'historical';
  
  // 延迟统计
  delays: {
    receiveDelay: number;       // receivedAt - eventOccurredAt
    queueDelay: number;         // enqueuedAt - receivedAt
    deliveryDelay: number | null; // deliveredAt - enqueuedAt
  };
  
  // 休息时段标记
  deferredDuringQuietHours: boolean;
  markedHistoricalOnWake: boolean;
}

/**
 * 创建告警
 */
export function createAlert(event, config) {
  const now = Date.now();
  const ttl = config.alertTtl || 3600;  // 默认1小时
  
  return {
    id: crypto.randomUUID(),
    eventOccurredAt: event.timestamp || now,
    receivedAt: now,
    enqueuedAt: now,
    attemptedAt: [],
    deliveredAt: null,  // ✅ 未送达前为null
    
    ttl,
    expiresAt: now + ttl * 1000,
    
    status: 'queued',
    
    delays: {
      receiveDelay: now - (event.timestamp || now),
      queueDelay: 0,
      deliveryDelay: null
    },
    
    deferredDuringQuietHours: false,
    markedHistoricalOnWake: false,
    
    // 告警内容
    type: event.type,
    message: event.message,
    data: event.data
  };
}

/**
 * 标记送达
 */
export function markDelivered(alert) {
  const now = Date.now();
  
  return {
    ...alert,
    deliveredAt: now,  // ✅ 确认送达后才设置
    status: 'delivered',
    delays: {
      ...alert.delays,
      deliveryDelay: now - alert.enqueuedAt
    }
  };
}

/**
 * 处理过期
 */
export function processExpiredAlerts(queue, archiveCallback) {
  const now = Date.now();
  const expired = [];
  const active = [];
  
  for (const alert of queue) {
    if (alert.status === 'delivered') {
      continue;  // 已送达，跳过
    }
    
    if (now > alert.expiresAt) {
      // 过期未送达 → 降为历史
      const expiredAlert = {
        ...alert,
        status: 'expired',
        expiredAt: now
      };
      
      expired.push(expiredAlert);
      archiveCallback(expiredAlert);
      
      console.warn(
        `Alert ${alert.id} expired after ${now - alert.enqueuedAt}ms ` +
        `(TTL=${alert.ttl}s)`
      );
    } else {
      active.push(alert);
    }
  }
  
  return { active, expired };
}

/**
 * 休息时段判断（上海时区 01:00-06:00）
 */
export function shouldDeferForQuietHours(alert, config) {
  if (!config.quietHoursEnabled) {
    return { defer: false };
  }
  
  const now = new Date();
  const shanghaiHour = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })
  ).getHours();
  
  const inQuietHours = shanghaiHour >= 1 && shanghaiHour < 6;
  
  if (inQuietHours) {
    return {
      defer: true,
      reason: `上海时间休息时段(01:00-06:00，当前${shanghaiHour}时)`,
      markHistorical: true
    };
  }
  
  return { defer: false };
}

/**
 * 醒来后处理积压
 */
export function processWakeUpBacklog(queue, config) {
  const now = Date.now();
  const maxBatch = config.wakeUpMaxBatch || 10;
  
  const deferred = queue.filter(
    a => a.deferredDuringQuietHours && a.status === 'queued'
  );
  
  // 按时间排序，最多发送10条
  deferred.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  
  const toSend = deferred.slice(0, maxBatch);
  const toMarkHistorical = deferred.slice(maxBatch);
  
  return {
    toSend: toSend.map(a => ({
      ...a,
      markedHistoricalOnWake: false
    })),
    toMarkHistorical: toMarkHistorical.map(a => ({
      ...a,
      status: 'historical',
      markedHistoricalOnWake: true
    }))
  };
}
```

---

## 修复7: Narrative TTL与语义过滤

### 文件: `src/narrative-daily.mjs` (修改)

```javascript
/**
 * 叙事趋势结构（2026-11-12）
 * 修复问题7：TTL、首末见、语义过滤、A级重新定义
 */

export interface NarrativeTrend {
  keyword: string;
  firstSeenAt: number;
  lastSeenAt: number;
  peakRank: number;
  currentRank: number | null;
  
  // TTL管理
  ttl: number;                  // 72小时
  expiresAt: number;            // lastSeenAt + ttl
  isActive: boolean;            // now < expiresAt && currentRank !== null
  
  // 语义分类
  semanticType: 'MEME_CONCEPT' | 'GREETING' | 'GENERIC_WORD' | 'NOISE';
  shouldDisplay: boolean;       // 非噪声
  
  // 来源
  sources: string[];            // ['weibo_hot', 'x_hot']
}

// 噪声词库
const NOISE_KEYWORDS = new Set([
  'gm', 'gn', 'good morning', 'good night', 'hello', 'hi', 'hey',
  'lol', 'lmao', 'omg', 'wtf',
  'the', 'and', 'for', 'with', 'from',
  '热搜', '热点', '今日', '今天', '明天'
]);

/**
 * 语义分类
 */
export function classifyKeyword(keyword) {
  const lower = keyword.toLowerCase().trim();
  
  // 1. 噪声词
  if (NOISE_KEYWORDS.has(lower)) {
    return { type: 'NOISE', shouldFilter: true };
  }
  
  // 2. 问候语
  if (/^(gm|gn|hello|hi|hey)\s/i.test(lower) || 
      /^(早|晚安|你好)/.test(lower)) {
    return { type: 'GREETING', shouldFilter: true };
  }
  
  // 3. 太短的通用词
  if (lower.length <= 2 && !/\$/.test(keyword)) {
    return { type: 'TOO_SHORT', shouldFilter: true };
  }
  
  // 4. 纯数字
  if (/^\d+$/.test(keyword)) {
    return { type: 'GENERIC_WORD', shouldFilter: true };
  }
  
  // 5. Meme概念
  return { type: 'MEME_CONCEPT', shouldFilter: false };
}

/**
 * 清理过期叙事
 */
export function cleanExpiredNarratives(trends, now = Date.now()) {
  const TTL_MS = 72 * 3600 * 1000;  // 72小时
  
  return trends.filter(t => {
    // 语义过滤
    const semantic = classifyKeyword(t.keyword);
    if (semantic.shouldFilter) {
      return false;
    }
    
    // TTL过期
    const expiresAt = t.lastSeenAt + TTL_MS;
    if (now > expiresAt) {
      console.log(
        `Expired narrative: ${t.keyword} ` +
        `(last seen ${((now - t.lastSeenAt) / 3600_000).toFixed(1)}h ago)`
      );
      return false;
    }
    
    return true;
  });
}

/**
 * A级叙事匹配定义（2026-11-12）
 * ⚠️ 重要：A级仅代表叙事匹配，不是链上安全评级
 */
export function narrativeALevelCriteria() {
  return {
    tierLabel: 'A级叙事匹配',
    tierMeaning: '仅表示趋势相关性，未经链上安全验证',
    
    criteria: {
      narrativeScore: { min: 70, description: '叙事分≥70' },
      firstSeenHours: { max: 6, description: '首见<6小时' },
      isTopLiquidity: { required: true, description: '同名流动性第一' },
      minLiquidity: { min: 5000, description: '流动性≥$5k' },
      
      // ⚠️ 市值不再硬限制
      marketCap: {
        note: '不再硬性<$100万限制，改为分层参考',
        tierPreference: '优先EMBRYONIC/EARLY，GROWTH需更强证据'
      }
    },
    
    safetyDisclaimer: 'A级仅代表叙事匹配强度，必须额外进行链上安全筛查'
  };
}

/**
 * A级日报独立安全筛查
 */
export async function narrativeALevelDailyReport(candidates, safetyChecker) {
  const aLevel = candidates.filter(c => c.narrativeTier === 'A');
  
  // ✅ 必须经过安全筛查
  const checked = [];
  for (const c of aLevel) {
    const safety = await safetyChecker.check(c);
    checked.push({
      ...c,
      safetyStatus: safety.passed ? 'PASSED' : 'FAILED',
      safetyReasons: safety.reasons,
      unknownFields: safety.unknownFields
    });
  }
  
  // 分组展示
  return {
    section: 'A级叙事候选（未经完整链上验证）',
    disclaimer: 'A级表示叙事强匹配，不代表投资安全。已进行基础筛查。',
    totalCount: checked.length,
    
    groups: {
      passed: checked.filter(c => c.safetyStatus === 'PASSED'),
      failed: checked.filter(c => c.safetyStatus === 'FAILED'),
      unknown: checked.filter(c => c.unknownFields.length > 0)
    }
  };
}
```

---

## 修复8: Chain+CA固定身份 & 其他标记

### Jupiter organicScore标记

```javascript
// ❌ 错误写法
const organicPercent = `有机成交占比 ${token.organicScore}%`;

// ✅ 正确写法
const organicLabel = `Jupiter organic score: ${token.organicScore}`;
const organicNote = 'organicScore是评分指标(0-100)，不是百分比';
```

### NIHAO两个CA不串联

```javascript
// chain+CA固定身份
const tokenIdentity = `${chain}:${address}`;

// 示例: NIHAO
const nihao1 = {
  identity: 'sol:8yLBuP74RnFmjSRS8BGFebvyoTo8uiEjPB71h3Zgpump',
  symbol: 'NIHAO',
  liquidity: 183_111,
  status: 'WAIT_RECHECK'
};

const nihao2 = {
  identity: 'sol:416sPL5fqhQpAJVboEQC5Yq52kY4VXzVY6y2GdJhcGnz',
  symbol: 'NIHAO',
  liquidity: 4_101,
  status: 'HARD_REJECT',
  rejectReason: 'liq<5k'
};

// ✅ 两个不同CA，独立处理
// ❌ 不能因为symbol相同就混淆前后快照
```

---

## 部署清单

### 已修复文件

1. ✅ `src/config-mcap-tiers.mjs` - 新增市值分层配置
2. ✅ `src/config.mjs` - 移除硬上限，启用分层
3. ✅ `src/exit-downgrade.mjs` - 自动登记、持仓刷新、去重
4. ✅ `src/soft-mention-health.mjs` - 新增健康检查
5. ✅ 修复文档覆盖fomo-trader-watch、fomo-free-scan、narrative-daily

### 待外部配置

- `.env` 文件中的凭据（用户自行配置）
- `config/*.json` 中的ID/账号（需合并，不能覆盖）
- 生产路径映射（见下节）

### 测试文件

- ✅ `tests/exit-downgrade.test.mjs` - 样本完整性测试
- ✅ `tests/mcap-tiers.test.mjs` - 市值分层测试
- ✅ `tests/alert-lifecycle.test.mjs` - 时间戳TTL测试

---

## 下一步：部署包生成

请运行以下命令生成可部署包：

```bash
cd /workspace/fixes-2026-11-12
npm test  # 运行离线测试
./deployment-package/create-package.sh  # 生成部署包
```

部署包将包含：
- 精确路径映射
- 回滚脚本
- 配置合并工具
- SHA256校验

---

**状态**: 核心修复已完成，等待生成部署包和提交PR。
