# Configuration Merge Guide

## ⚠️ Critical: Do NOT Overwrite Secrets

The integrated scripts reference config files that **contain secrets in production**. This guide explains how to merge safely.

---

## Files Requiring Merge

### 1. `fomo-free-scan.mjs`

**Production secrets**:
- Fomo API key (loaded from `/workspace/meme-radar-run/meme-radar-branch/state/fomo-api-key`)

**Merge strategy**:
```javascript
// ✅ KEEP production's Fomo API key loading logic
let key = ''; 
try { 
  key = fs.readFileSync(path.join(STATE, 'fomo-api-key'), 'utf8').trim(); 
} catch {}

// ✅ ADD integrated audit fix imports
import { categorizeByMarketCap, marketCapScoreModifier } from '../src/modules/market-cap-tiers.mjs';
import { createHolderSample, scoreSmartMoneyWithCompleteness } from '../src/modules/holder-sample.mjs';

// ✅ REPLACE score() function with scoreWithAuditFixes()
// See scripts/fomo-free-scan-integrated.mjs for full implementation
```

**Verification**:
```bash
# Verify no secrets leaked
grep -i "api.*key.*=" fomo-free-scan.mjs | grep -v "state/fomo-api-key"
# Should return nothing

# Verify module imports present
grep "market-cap-tiers" fomo-free-scan.mjs
grep "holder-sample" fomo-free-scan.mjs
```

---

### 2. `config/narrative-early-discovery.json`

**Production paths** (preserve these):
```json
{
  "exitDowngrade": {
    "enabled": true,
    "watchStateFile": "/workspace/meme-radar-run/scan-accum/narrative-early/state/watchlist.json",
    "alertsDir": "/workspace/meme-radar-run/scan-accum/narrative-early/alerts/pending",
    "queueFile": "/workspace/meme-radar-run/scan-accum/narrative-early/alerts/queue.jsonl"
  }
}
```

**Merge strategy**:
1. Keep existing paths above
2. Add new exit monitoring settings:
```json
{
  "exitDowngrade": {
    "enabled": true,
    "watchStateFile": "<keep-production-path>",
    "alertsDir": "<keep-production-path>",
    "queueFile": "<keep-production-path>",
    
    // ✅ ADD these new settings
    "smartMoneyReduceMin": 1,
    "netSell1hRatio": 1.5,
    "netSell1hMinUsd": 5000,
    "leaderMcBandsUsd": [1000000, 5000000, 10000000, 50000000]
  }
}
```

---

### 3. Environment Variables

**Add to production environment**:

```bash
# Market cap tiering
export MARKET_CAP_TIERS_ENABLED=1

# Exit monitoring
export EXIT_DOWNGRADE=1

# Keep existing
export FOMO_MONTHLY_CREDIT_BUDGET=150000
export FOMO_FREE_CHAINS=sol,bsc,base
```

---

## Merge Checklist

- [ ] Backup production files (`./deployment/backup.sh`)
- [ ] Copy audit fix modules to `src/modules/`
- [ ] Merge `fomo-free-scan.mjs` (preserve API key loading)
- [ ] Merge `exit-downgrade-run.mjs` (preserve paths)
- [ ] Update config JSON (preserve paths, add new settings)
- [ ] Verify no secrets in code: `./deployment/check-secrets.sh`
- [ ] Run offline tests: `npm test test/e2e-*.test.mjs`
- [ ] Verify with `node --check` on all .mjs files
- [ ] Test one scan run manually before scheduling

---

## Rollback Procedure

If something goes wrong:

```bash
# Stop running scans
pkill -f fomo-free-scan
pkill -f exit-downgrade-run

# Rollback files
./deployment/rollback.sh /workspace/backups/pre-audit-fixes-<timestamp>

# Verify
node --check /workspace/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs
npm test

# Resume scans (when ready)
```

---

## Post-Deployment Verification

### 1. Check Watchlist Auto-Registration

```bash
# Should no longer be empty
cat /workspace/meme-radar-run/scan-accum/narrative-early/state/watchlist.json | jq '.items | length'
# Expected: > 0 after first scan
```

### 2. Check Smart Money Scoring

```bash
# Look for transparency fields in scan output
grep -A 5 "smart.*stillHolding" /workspace/ebooks/out/latest-scan.json
# Should see: stillHolding, confidence, sampleComplete, coverage
```

### 3. Check Market Cap Tiers

```bash
# Look for tier assignments
grep "marketCapTier" /workspace/ebooks/out/latest-scan.json | head -5
# Should see: EMBRYONIC, EARLY, GROWTH, ESTABLISHED, LARGE_CAP
```

### 4. Verify No Historical Scoring

```bash
# Search for aggregate smart money in scoring
# Should NOT find scoring based on aggregate when sample incomplete
grep -i "aggregate.*score" /workspace/ebooks/out/latest-scan.json
# Expected: only for reference, not in score calculation
```

---

## Common Issues

### Issue: "Cannot find module 'market-cap-tiers'"

**Fix**: Ensure modules are in correct path:
```bash
ls -la /workspace/meme-radar-run/meme-radar-branch/src/modules/
# Should contain: market-cap-tiers.mjs, holder-sample.mjs, exit-monitoring.mjs
```

### Issue: "Fomo API key not found"

**Fix**: Verify key file exists:
```bash
ls -la /workspace/meme-radar-run/meme-radar-branch/state/fomo-api-key
# Should exist and be readable
```

### Issue: Watchlist still empty after scan

**Fix**: Check auto-register is enabled in code:
```javascript
// In fomo-free-scan.mjs, after scoring candidates
for (const c of topCandidates) {
  const r = autoRegisterToWatchlist({
    chain: c.chain,
    address: c.address,
    symbol: c.symbol
  }, 'hot_board', watchlist);
  if (r.registered) {
    console.log('✅ Registered:', c.symbol);
  }
}
```

---

## Security Checklist

- [ ] No API keys in code files
- [ ] No wallet private keys in code
- [ ] No webhook URLs hardcoded
- [ ] Config files use environment variables for secrets
- [ ] Backups exclude sensitive state files
- [ ] Deployment manifest doesn't include secrets

---

## Support

If merge issues occur:
1. Check `DEPLOYMENT-MANIFEST.json` for file mappings
2. Review `AUDIT_FIXES_DESIGN.md` for design rationale
3. Run `npm test` to verify module integration
4. Check GitHub PR for latest updates
