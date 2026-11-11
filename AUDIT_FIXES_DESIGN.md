# 质量审计修复设计文档
## Quality Audit Fixes Design Document

**工作分支**: `cursor/smart-money-live-holding-fix-c671`  
**状态**: 设计阶段，等待实际运行脚本附件核对  
**日期**: 2026-11-12

---

## 重要需求变更 (Key Requirement Changes)

### 市值限制调整
- ❌ **取消**: <10万美元作为硬性入榜门槛
- ✅ **调整为**: 市值作为分层/参考因素，不作为绝对条件
- ⚠️ **保持**: 安全、证据要求不放松
- 📊 **目标**: 早期机会研究 + 可靠退出告警

### 数据源策略
- ✅ 继续使用 Fomo + 免费源
- ⚠️ GMGN 仅用户点名时使用（不扩大订阅/预算）
- ❌ 不引入新付费服务
- ❌ 不自动交易/发帖

---

## 问题 1: Watchlist 与 Exit Downgrade 失效

### 现状问题
```json
// narrative-early/state/watchlist.json
{
  "items": []  // ← 始终为空
}
```

- ❌ exit-downgrade-run 只读名单和旧字段，不刷新
- ❌ 降级扫描不登记候选
- ❌ 连续 watched=0

### 根本原因（待附件核对）
1. 自动登记逻辑缺失或未触发
2. 持仓刷新路径断开
3. 队列送达状态管理错误（交付前标记 delivered）

### 修复设计

#### 1.1 自动登记机制
```javascript
// 新增: src/exit-monitor.mjs (或在附件中定位实际文件)
export function autoRegisterCandidate(token, reason) {
  const key = `${token.chain}:${token.address}`;  // chain+CA 固定身份
  
  return {
    id: crypto.randomUUID(),
    chain: token.chain,
    address: token.address,
    symbol: token.symbol,
    registeredAt: Date.now(),
    registeredReason: reason,  // 'hot_board' | 'user_manual' | 'narrative_match'
    lastRefreshedAt: 0,
    snapshotHistory: [],  // 持仓前后快照
    alerts: []  // 去重告警记录
  };
}
```

#### 1.2 持续刷新与快照
```javascript
// 快照结构
interface HoldingSnapshot {
  capturedAt: number;
  source: 'fomo' | 'gmgn_on_demand' | 'free_scanner';
  smartWallets: {
    address: string;
    tags: string[];
    amount: number | null;  // null = 未知，不等于 0
    amountUsd: number | null;
  }[];
  totalSampleSize: number;
  sampleComplete: boolean;  // 区分"完整"vs"部分"
}

// 真实持仓减少 vs 样本缺失
function analyzeHoldingChange(prev, curr) {
  if (!prev.sampleComplete || !curr.sampleComplete) {
    return { 
      conclusion: 'INSUFFICIENT_DATA',
      reason: '样本不完整，无法确认清仓'
    };
  }
  
  const prevAddresses = new Set(prev.smartWallets.map(w => w.address));
  const currAddresses = new Set(curr.smartWallets.map(w => w.address));
  
  const exited = [...prevAddresses].filter(a => !currAddresses.has(a));
  const entered = [...currAddresses].filter(a => !prevAddresses.has(a));
  
  return {
    conclusion: exited.length > entered.length ? 'NET_SELLING_PRESSURE' : 'STABLE_OR_GROWING',
    exitedWallets: exited,
    enteredWallets: entered,
    netChange: entered.length - exited.length
  };
}
```

#### 1.3 去重告警机制
```javascript
// 告警去重键
function alertDedupeKey(alert) {
  return `${alert.type}:${alert.chain}:${alert.address}:${alert.severity}`;
}

// 队列送达状态
interface AlertDelivery {
  alertId: string;
  enqueuedAt: number;      // 入队时间
  attemptedAt: number;     // 尝试送达时间
  deliveredAt: number | null;  // ✅ 实际送达后才设置
  ttl: number;             // 过期时间
  status: 'queued' | 'attempting' | 'delivered' | 'expired' | 'failed';
  retryCount: number;
}
```

**关键原则**: 
- ❌ 不能在交付前标记 `delivered: true`
- ✅ 送达确认后才更新状态
- ✅ 过期未送达标记为 `expired`，降为历史记录

---

## 问题 2: Fomo Free Scan 样本不完整判断

### 现状问题
```javascript
// 当前逻辑（推测）
const holders = await fomoApi.getHolders(address, { limit: 50 });
// ❌ 直接使用 50 个样本，未标记完整性
// ❌ 缺席 = 清仓？错误推断
```

### 修复设计

#### 2.1 样本完整性标记
```javascript
interface HolderSample {
  wallets: Wallet[];
  totalHolderCount: number | null;  // 总持有人数（如果已知）
  sampledCount: number;
  sampleComplete: boolean;  // sampledCount >= totalHolderCount || sampledCount >= threshold
  source: string;
  capturedAt: number;
  coverage: '榜单前50' | '当前确认完整' | '部分样本-未知覆盖';
}

function determineSampleCompleteness(sample) {
  if (sample.totalHolderCount !== null && sample.sampledCount >= sample.totalHolderCount) {
    return { complete: true, coverage: '当前确认完整' };
  }
  if (sample.sampledCount >= 100) {  // 可配置阈值
    return { complete: true, coverage: '榜单前100-足够代表性' };
  }
  return { 
    complete: false, 
    coverage: `部分样本${sample.sampledCount}个-未知覆盖` 
  };
}
```

#### 2.2 分层标记
```javascript
// 不混淆三种状态
const tokenStatus = {
  onTopBoard: boolean,           // 仍在榜单
  currentConfirmed: boolean,     // 当前持仓已确认（完整样本）
  unknown: boolean               // 样本不足，状态未知
};

// 评分逻辑
if (tokenStatus.currentConfirmed && smartWalletsStillHolding === 0) {
  score += 0;  // 确认清仓，无加分
} else if (tokenStatus.unknown) {
  score += aggregateSmartWallets * 0.3;  // 降权使用历史值，标记"未确认"
} else if (tokenStatus.onTopBoard) {
  score += liveSmartWallets;  // 完整样本，实时计分
}
```

#### 2.3 离线矛盾样本测试
```javascript
// test/holder-sample-logic.test.mjs
test('样本缺失不等于清仓', () => {
  const case1 = {
    previous: { smartWallets: 5, sampleComplete: true },
    current: { smartWallets: 0, sampleComplete: false }  // 样本不完整
  };
  
  const result = analyzeHoldingChange(case1.previous, case1.current);
  assert.equal(result.conclusion, 'INSUFFICIENT_DATA');
  assert.match(result.reason, /样本不完整/);
});

test('确认完整样本的清仓', () => {
  const case2 = {
    previous: { smartWallets: 5, sampleComplete: true },
    current: { smartWallets: 0, sampleComplete: true }  // 确认完整
  };
  
  const result = analyzeHoldingChange(case2.previous, case2.current);
  assert.equal(result.conclusion, 'CONFIRMED_EXIT');
});
```

---

## 问题 3: 主榜热度评分不合理

### 现状问题
- ❌ HOLD: smart=0, score=86 (不合理高分)
- ❌ Twin: 244天老币, 35.8%集中度, score=83
- ❌ 15-90窗口缺历史前后观测
- ❌ KOL 与 smart 重复计人

### 修复设计

#### 3.1 分离三维度评分
```javascript
// 不再混合单一 score
interface TokenEvaluation {
  // 1. 证据置信度 (Evidence Confidence)
  evidenceScore: {
    value: 0-100,
    factors: {
      sampleCompleteness: number,  // 样本完整性
      dataFreshness: number,        // 数据新鲜度
      crossValidation: number       // 多源验证
    }
  },
  
  // 2. 机会热度 (Opportunity Heat)
  opportunityScore: {
    value: 0-100,
    factors: {
      smartMoneyActivity: number,   // 聪明钱活跃度（去重）
      volumeTrend: number,           // 成交趋势
      priceActionEarly: number       // 早期价格行为
    }
  },
  
  // 3. 风险评级 (Risk Rating)
  riskScore: {
    value: 0-100,  // 越高越危险
    factors: {
      concentration: number,         // 集中度
      age: number,                   // 年龄（老币风险）
      manipulation: number           // 操纵迹象
    }
  }
}
```

#### 3.2 早期 vs 存量分组
```javascript
// 不设硬性 10万美元限制，但分层展示
function categorizeByStage(token) {
  const mc = token.marketCap;
  const age = token.ageHours;
  
  if (age < 24 && mc < 50_000) {
    return { tier: 'EMBRYONIC', label: '萌芽期(<1天,<5万)', minEvidence: 'high' };
  } else if (age < 168 && mc < 200_000) {
    return { tier: 'EARLY', label: '早期(<1周,<20万)', minEvidence: 'medium' };
  } else {
    return { tier: 'ESTABLISHED', label: '存量(>1周或>20万)', minEvidence: 'strict' };
  }
}

// 存量币更严格要求
if (tier === 'ESTABLISHED') {
  if (!evidenceScore.crossValidation) {
    return { qualified: false, reason: '存量币需要跨源验证' };
  }
  if (riskScore.concentration > 30) {
    return { qualified: false, reason: '老币集中度过高' };
  }
}
```

#### 3.3 历史钱包去重
```javascript
// 时序判断需要历史快照
interface WalletHistory {
  address: string;
  tags: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  holdings: Array<{
    timestamp: number,
    amount: number | null,
    source: string
  }>;
}

// KOL 与 smart 去重
function deduplicateWalletCounts(wallets) {
  const uniqueWallets = new Map();
  
  for (const wallet of wallets) {
    const isSmart = wallet.tags.some(t => smartTags.has(t));
    const isKOL = wallet.tags.some(t => renownedTags.has(t));
    
    // 同一钱包只计一次，优先级：smart > KOL
    if (isSmart && !uniqueWallets.has(wallet.address)) {
      uniqueWallets.set(wallet.address, { type: 'smart', wallet });
    } else if (isKOL && !uniqueWallets.has(wallet.address)) {
      uniqueWallets.set(wallet.address, { type: 'kol', wallet });
    }
  }
  
  return {
    smartCount: [...uniqueWallets.values()].filter(w => w.type === 'smart').length,
    kolOnlyCount: [...uniqueWallets.values()].filter(w => w.type === 'kol').length
  };
}
```

---

## 问题 4: X Soft Events 为空

### 现状问题
- ❌ `softEvents = []` 始终为空
- ❌ `high_tier_post` 无 keyword/cashtag 不落事件
- ❌ provider 可能硬编码

### 修复设计

#### 4.1 软提及路径健康检查
```javascript
// src/x-monitor-health.mjs
export function checkSoftMentionPath() {
  return {
    providerStatus: {
      configured: Boolean(config.xProvider),
      type: config.xProvider,  // 'official' | 'socialdata' | 'sorsa' | 'stub'
      authenticated: Boolean(getProviderAuth()),
      hardcoded: config.xProvider === 'stub' || !config.xProvider
    },
    
    keywordConfig: {
      loaded: keywordsLoaded,
      globalCount: globalKeywords.length,
      accountSpecificCount: Object.keys(accountSpecific).length
    },
    
    watchlist: {
      totalAccounts: watchlist.length,
      highTierAccounts: watchlist.filter(a => a.tier === 'official' || a.tier === 'founder').length
    },
    
    recentActivity: {
      tweetsProcessed: last24hTweets,
      softMentionsDetected: last24hSoftMentions,
      healthStatus: last24hSoftMentions > 0 ? 'HEALTHY' : 'MISSING_EVENTS'
    }
  };
}
```

#### 4.2 指定权威账号软提及
```javascript
// 不靠放宽阈值凑信号
function detectSoftMention(tweet, account) {
  // 必须满足：高权重账号 + (keyword 或 明确cashtag)
  const isHighTier = ['official', 'founder', 'chain_lead'].includes(account.tier);
  
  if (!isHighTier) {
    return null;  // 不处理低权重账号
  }
  
  // 1. 显式 cashtag
  const cashtags = extractCashtags(tweet.text);
  if (cashtags.length > 0) {
    return {
      type: 'explicit_cashtag',
      confidence: 'HIGH',
      cashtags
    };
  }
  
  // 2. 关键词匹配
  const matchedKeywords = findKeywordMatches(tweet.text, account);
  if (matchedKeywords.length > 0) {
    return {
      type: 'keyword_match',
      confidence: 'MEDIUM',
      keywords: matchedKeywords
    };
  }
  
  // 3. 无匹配 → 不生成事件
  return null;  // ✅ 不假装健康
}
```

#### 4.3 健康指标暴露
```javascript
// GET /api/x-monitor/health
{
  "status": "MISSING" | "DEGRADED" | "HEALTHY",
  "reason": "No soft mentions detected in 24h",
  "provider": {
    "configured": true,
    "type": "socialdata",
    "lastSuccessAt": 1699876543000
  },
  "events": {
    "last24h": {
      "tweets": 245,
      "softMentions": 0,  // ← 显式标注缺失
      "explicitCashtags": 12
    }
  },
  "recommendation": "Check keyword config or provider API status"
}
```

---

## 问题 5: Fomo 交付延迟

### 现状问题
- ❌ 1h27分 / 13h30分 甚至周末 25小时延迟
- ❌ stale heartbeat 多次回收 ≠ 无遗漏

### 修复设计

#### 5.1 时间戳完整记录
```javascript
interface AlertLifecycle {
  eventOccurredAt: number,      // 事件发生时间（如 smart wallet 买入）
  receivedAt: number,           // 系统接收时间
  enqueuedAt: number,           // 入队时间
  attemptedAt: number[],        // 尝试送达时间数组
  deliveredAt: number | null,   // 实际送达时间
  
  ttl: number,                  // 过期时限
  expiresAt: number,            // 过期时间点
  
  status: 'fresh' | 'stale' | 'expired' | 'historical',
  
  delays: {
    receiveDelay: number,       // receivedAt - eventOccurredAt
    queueDelay: number,         // enqueuedAt - receivedAt  
    deliveryDelay: number       // deliveredAt - enqueuedAt
  }
}
```

#### 5.2 过期降历史
```javascript
function processAlertQueue() {
  const now = Date.now();
  
  for (const alert of queue) {
    if (alert.status === 'delivered') continue;
    
    if (now > alert.expiresAt) {
      // 过期未送达 → 降为历史记录
      alert.status = 'expired';
      alert.expiredAt = now;
      moveToHistoricalLog(alert);
      queue.remove(alert);
      
      metrics.expiredAlerts++;
      console.warn(`Alert ${alert.id} expired after ${now - alert.enqueuedAt}ms`);
    }
  }
}
```

#### 5.3 休息时段管理
```javascript
// config
const quietHours = {
  timezone: 'Asia/Shanghai',
  start: 1,   // 01:00
  end: 6,     // 06:00
  behavior: 'defer',  // 'defer' | 'send' | 'discard'
  
  // 休息积压醒来后的处理
  onWake: {
    sendAccumulated: true,
    markAsHistorical: true,  // 标记为历史消息
    maxBatch: 10             // 最多发送10条，其余降历史
  }
};

function shouldDefer(alert, now) {
  const hour = new Date(now).toLocaleString('en-US', { 
    timeZone: quietHours.timezone,
    hour: 'numeric',
    hour12: false 
  });
  
  const inQuietHours = hour >= quietHours.start && hour < quietHours.end;
  
  if (inQuietHours && quietHours.behavior === 'defer') {
    return {
      defer: true,
      reason: `上海时间休息时段 (${quietHours.start}-${quietHours.end}时)`,
      markHistorical: true
    };
  }
  
  return { defer: false };
}
```

#### 5.4 故障/回补状态
```javascript
interface DeliveryFailure {
  alertId: string,
  failedAt: number,
  reason: string,
  retryScheduled: boolean,
  nextRetryAt: number,
  retryCount: number,
  maxRetries: 3,
  
  // 回补逻辑
  backfill: {
    required: boolean,
    attemptedAt: number | null,
    status: 'pending' | 'completed' | 'abandoned'
  }
}
```

---

## 问题 6: Watcher 金额计算错误

### 现状问题
```javascript
// ❌ 当前逻辑（推测）
const tradeAmount = watcher.tradeUsd || watcher.usdValue || watcher.positionValueUsd;
// ↑ 混淆了成交额、持仓市值、总资产

// 案例: MASK
// tradeUsd = null
// positionValue = 399,021
// totalAssets = 388,084
// → positionValue / assets = 102.8% ❌
```

### 修复设计

#### 6.1 明确三个概念
```javascript
interface WalletTransaction {
  // 1. 成交额 (Transaction Amount) - 实际买入/卖出金额
  tradeUsd: number | null,           // ✅ 优先使用，实际成交
  
  // 2. 仓位市值 (Position Value) - 当前持仓市值
  positionValueUsd: number | null,   // 事后估值，不是成交额
  
  // 3. 总资产 (Total Assets) - 钱包总资产
  totalAssetsUsd: number | null,     // 用于计算仓位占比
  
  // 派生字段
  positionRatio: number | null,      // positionValue / totalAssets
  isNewPosition: boolean,
  newPositionConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
}
```

#### 6.2 新仓位判断逻辑
```javascript
function analyzePosition(tx) {
  // ❌ 不能用 positionValue - tradeUsd 推算
  // ✅ 必须有明确的 "新仓" 标记或历史对比
  
  if (tx.tradeUsd === null) {
    return {
      isNewPosition: false,
      reason: '无成交额数据',
      confidence: 'UNKNOWN',
      qualifies5PercentRule: false
    };
  }
  
  // 有成交额 + 仓位占比
  if (tx.totalAssetsUsd !== null && tx.totalAssetsUsd > 0) {
    const ratio = tx.tradeUsd / tx.totalAssetsUsd;
    
    if (ratio > 1.0) {
      return {
        isNewPosition: true,
        ratio: ratio,
        anomaly: 'TRADE_EXCEEDS_ASSETS',  // ⚠️ 标记异常
        warning: `成交额${tx.tradeUsd}超过总资产${tx.totalAssetsUsd}`,
        confidence: 'LOW'
      };
    }
    
    return {
      isNewPosition: ratio >= 0.05,
      ratio: ratio,
      qualifies5PercentRule: ratio >= 0.05,
      confidence: 'HIGH'
    };
  }
  
  // 仅有成交额，无总资产 → 可使用 fallback
  if (tx.tradeUsd >= 3000) {  // 用户明确的 fallback
    return {
      isNewPosition: true,
      tradeUsd: tx.tradeUsd,
      confidence: 'MEDIUM',
      note: '总资产未知，使用$3000阈值fallback',
      fallbackUsed: true,
      qualifies5PercentRule: 'ASSUMED'  // 明确标记假设
    };
  }
  
  return {
    isNewPosition: false,
    reason: '成交额不足$3000且总资产未知',
    confidence: 'LOW'
  };
}
```

#### 6.3 异常标记
```javascript
// 不指控钱包造假，但标记异常
function detectAnomalies(tx) {
  const anomalies = [];
  
  if (tx.positionValueUsd !== null && tx.totalAssetsUsd !== null) {
    const ratio = tx.positionValueUsd / tx.totalAssetsUsd;
    if (ratio > 1.0) {
      anomalies.push({
        type: 'POSITION_EXCEEDS_ASSETS',
        ratio: ratio,
        severity: ratio > 2.0 ? 'HIGH' : 'MEDIUM',
        message: `单币种仓位${(ratio*100).toFixed(1)}%超过总资产`,
        note: '可能的原因：数据延迟、杠杆、或报价差异'
      });
    }
  }
  
  if (tx.tradeUsd === null && tx.positionValueUsd !== null) {
    anomalies.push({
      type: 'MISSING_TRADE_AMOUNT',
      severity: 'LOW',
      message: '仅有持仓市值，无实际成交额',
      impact: '无法确认买入规模'
    });
  }
  
  return anomalies;
}
```

---

## 问题 7: Narrative 日筛问题

### 现状问题
- ❌ 最近 2000 条无 TTL，旧趋势污染
- ❌ 历史最好 rank 不代表当前热度
- ❌ 默认 `meme_name` 导致 11/3-11/11 旧趋势凑 40 条
- ❌ A级冒充安全等级（实际仅叙事匹配，未链上验证）

### 修复设计

#### 7.1 TTL 与时间窗口
```javascript
interface NarrativeTrend {
  keyword: string,
  firstSeenAt: number,
  lastSeenAt: number,
  peakRank: number,
  currentRank: number | null,  // null = 已不在榜
  
  // TTL 管理
  ttl: number,                  // 72小时
  expiresAt: number,            // lastSeenAt + ttl
  isActive: boolean,            // now < expiresAt && currentRank !== null
  
  // 语义过滤
  semanticType: 'MEME_CONCEPT' | 'GREETING' | 'GENERIC_WORD' | 'NOISE',
  shouldDisplay: boolean        // 非问候语、有意义
}

// 清理逻辑
function cleanExpiredNarratives(trends, now) {
  return trends.filter(t => {
    if (now > t.expiresAt) {
      console.log(`Expired narrative: ${t.keyword} (last seen ${(now - t.lastSeenAt)/1000/3600}h ago)`);
      return false;
    }
    if (t.semanticType === 'GREETING' || t.semanticType === 'NOISE') {
      return false;
    }
    return true;
  });
}
```

#### 7.2 语义去噪
```javascript
// 问候语噪声库
const NOISE_KEYWORDS = new Set([
  'gm', 'gn', 'good morning', 'good night',
  'hello', 'hi', 'hey',
  'lol', 'lmao', 'omg',
  'the', 'and', 'for', 'with',  // 通用词
  ...
]);

function classifyKeyword(keyword) {
  const lower = keyword.toLowerCase();
  
  if (NOISE_KEYWORDS.has(lower)) {
    return { type: 'NOISE', shouldFilter: true };
  }
  
  if (/^(gm|gn|hello|hi)\s/i.test(lower)) {
    return { type: 'GREETING', shouldFilter: true };
  }
  
  // 通用词判断
  if (lower.length <= 3 && !/\$/.test(keyword)) {
    return { type: 'TOO_SHORT', shouldFilter: true };
  }
  
  return { type: 'MEME_CONCEPT', shouldFilter: false };
}
```

#### 7.3 A级明确定义
```javascript
// ❌ 旧定义：A级 = 安全等级
// ✅ 新定义：A级 = 叙事匹配等级（未链上验证）

interface NarrativeMatch {
  tier: 'A' | 'B' | 'C',
  tierLabel: string,
  
  // 明确说明
  tierMeaning: {
    'A': '叙事强匹配 - 仅表示趋势相关性，未经链上安全验证',
    'B': '叙事中等匹配',
    'C': '叙事弱匹配'
  }[tier],
  
  // A级原策略（保留）
  criteria: {
    narrativeScore: number,  // >= 70
    firstSeenHours: number,  // < 6h
    isTopLiquidity: boolean, // 同名流动性第一
    liquidity: number,       // >= 5k
    marketCap: number,       // 不再硬性 < 100k，但作为分层
    
    // ⚠️ 新增：安全状态独立字段
    safetyStatus: 'NOT_VERIFIED' | 'PASSED' | 'FAILED',
    safetyNote: 'A级仅代表叙事匹配，需额外安全筛查'
  }
}

// A级日报独立安全筛查
function narrativeALevelDailyReport(candidates) {
  const aLevelCandidates = candidates.filter(c => c.narrativeTier === 'A');
  
  // ✅ 必须经过安全筛查
  const safetyChecked = await Promise.all(
    aLevelCandidates.map(async (c) => {
      const safety = await runBasicSafetyCheck(c);
      return {
        ...c,
        safetyStatus: safety.passed ? 'PASSED' : 'FAILED',
        safetyReasons: safety.reasons,
        unknownFields: safety.unknownFields
      };
    })
  );
  
  // 分组展示
  return {
    section: 'A级叙事候选（未经完整链上验证）',
    disclaimer: 'A级表示叙事强匹配，不代表投资安全',
    
    passed: safetyChecked.filter(c => c.safetyStatus === 'PASSED'),
    failed: safetyChecked.filter(c => c.safetyStatus === 'FAILED'),
    unknown: safetyChecked.filter(c => c.unknownFields.length > 0)
  };
}
```

#### 7.4 同名仿盘区分
```javascript
// chain+CA 固定身份
interface Token {
  identity: string,  // `${chain}:${address}`
  chain: string,
  address: string,
  symbol: string,
  name: string,
  
  // 同名区分
  sameNameTokens: Array<{
    identity: string,
    chain: string,
    address: string,
    liquidity: number,
    rank: number
  }>,
  
  isTopLiquidity: boolean,  // 同名中流动性第一
  totalSameNameCount: number
}

// 示例：NIHAO
// - sol:8yL... (上午下午仍在，流动性第一) ✅
// - sol:416s... (被拒，流动性第二) ❌
```

---

## 问题 8: 其他标记问题

### Jupiter organicScore
```javascript
// ❌ 不能写成 "有机成交占比 45%"
// ✅ 应该写 "Jupiter organic score: 45"

interface JupiterMetrics {
  organicScore: number,  // 0-100 的评分，不是百分比
  organicScoreLabel: string,  // "Jupiter organic score: 45"
  note: 'organicScore is a scoring metric, not a percentage'
}
```

---

## 实现计划 (Implementation Plan)

### 阶段 1: 等待附件核对
- [ ] 接收用户提供的实际运行脚本附件
- [ ] 对比仓库代码与生产脚本差异
- [ ] 保留生产脚本中有效的新逻辑
- [ ] 标记需要合并的部分

### 阶段 2: 核心修复实现
- [ ] 问题 1: Watchlist 自动登记 + 持仓刷新
- [ ] 问题 2: 样本完整性标记 + 离线测试
- [ ] 问题 3: 三维度评分分离 + 历史去重
- [ ] 问题 4: X软提及健康检查 + 显式缺失
- [ ] 问题 5: 时间戳完整 + 过期降历史 + 休息时段
- [ ] 问题 6: 金额概念明确 + 异常标记
- [ ] 问题 7: TTL清旧 + 语义去噪 + A级重新定义
- [ ] 问题 8: 其他标记修正

### 阶段 3: 测试与验证
- [ ] 离线回归测试（样本不完整、金额未知、TTL过期等）
- [ ] 失败样本构造与测试
- [ ] 完整快照归档测试
- [ ] 预算上限与缓存测试

### 阶段 4: 交付
- [ ] PR 链接（在当前分支）
- [ ] 测试输出日志
- [ ] 部署包（兼容现有路径）
- [ ] 配置样例（非密）
- [ ] 清晰的已修/待配置清单

---

## 注意事项 (Important Notes)

1. ✅ 继续在当前分支工作，不另开新分支
2. ✅ 先核对附件，再实现（避免只改旧仓库）
3. ✅ 可回滚实现，不破坏现有部署
4. ❌ 不使用真实密钥
5. ❌ 不触发消息/交易/收费扫描
6. ✅ 保留有效新逻辑（从附件中）
7. ✅ 完整离线测试，不假装已部署

---

**当前状态**: 等待用户提供实际运行脚本附件，以核对版本差异并开始实现。
