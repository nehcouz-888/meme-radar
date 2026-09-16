import { config } from './config.mjs';

export class WebhookNotifier {
  constructor({ settings = config, now = Date.now }) {
    this.settings = settings;
    this.now = now;
    this.sentAlerts = new Map();
  }

  isEnabled() {
    return Boolean(this.settings.webhookEnabled && this.settings.webhookUrl);
  }

  shouldSendAlert(key, tier) {
    if (!this.isEnabled()) return false;
    
    const minTier = this.settings.webhookMinTier.toLowerCase();
    const currentTier = String(tier || '').toLowerCase();
    
    const tierRank = { hot: 3, watch: 2, ignore: 1 };
    const minRank = tierRank[minTier] || 3;
    const currentRank = tierRank[currentTier] || 0;
    
    if (currentRank < minRank) return false;
    
    const sent = this.sentAlerts.get(key);
    if (sent && this.now() - sent.at < this.settings.webhookDedupeMs) return false;
    
    return true;
  }

  markSent(key) {
    this.sentAlerts.set(key, { at: this.now() });
  }

  cleanup() {
    const cutoff = this.now() - this.settings.webhookDedupeMs;
    for (const [key, value] of this.sentAlerts.entries()) {
      if (value.at < cutoff) this.sentAlerts.delete(key);
    }
  }

  sanitizePayload(payload) {
    const sanitized = JSON.parse(JSON.stringify(payload));
    
    const sensitiveKeys = [
      'apiKey', 'api_key', 'bearerToken', 'bearer_token', 'privateKey', 'private_key',
      'secret', 'password', 'token', 'auth', 'authorization', 'credentials'
    ];
    
    const sanitizeObject = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
          obj[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          sanitizeObject(value);
        } else if (typeof value === 'string') {
          if (/gmgn_[a-z0-9]{8,}|bearer\s|api[_ -]?key|private[_ -]?key/i.test(value)) {
            obj[key] = '[REDACTED]';
          }
        }
      }
      return obj;
    };
    
    return sanitizeObject(sanitized);
  }

  async sendCandidateAlert(candidate) {
    if (!candidate || !candidate.address) return { sent: false, reason: 'invalid_candidate' };
    
    const tier = candidate.deep?.embryonic?.embryonicTier || 'ignore';
    const key = `candidate:${candidate.chain}:${candidate.address}`;
    
    if (!this.shouldSendAlert(key, tier)) {
      return { sent: false, reason: 'filtered_or_duplicate', tier };
    }
    
    const payload = {
      type: 'embryonic_candidate',
      timestamp: this.now(),
      candidate: {
        address: candidate.address,
        chain: candidate.chain,
        symbol: candidate.symbol,
        name: candidate.name,
        marketCap: candidate.marketCap,
        liquidity: candidate.liquidity,
        price: candidate.price,
        embryonicScore: candidate.deep?.embryonic?.embryonicScore,
        embryonicTier: tier,
        embryonicSignals: candidate.deep?.embryonic?.embryonicSignals || [],
        embryonicSignalsCN: candidate.deep?.embryonic?.embryonicSignalsCN || [],
        status: candidate.status,
        gmgnUrl: candidate.gmgnUrl,
        twitter: candidate.twitter,
        website: candidate.info?.website
      }
    };
    
    try {
      const response = await fetch(this.settings.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'meme-radar-jindou/0.1.6'
        },
        body: JSON.stringify(this.sanitizePayload(payload))
      });
      
      this.markSent(key);
      this.cleanup();
      
      return {
        sent: true,
        status: response.status,
        tier,
        key
      };
    } catch (error) {
      return {
        sent: false,
        reason: 'webhook_error',
        error: error.message,
        tier
      };
    }
  }

  async sendSocialAlert(hit) {
    if (!hit || !hit.tweetId) return { sent: false, reason: 'invalid_hit' };
    
    const key = `social:${hit.tweetId}`;
    const tier = hit.tier || 'kol_alpha';
    
    if (this.sentAlerts.has(key)) {
      return { sent: false, reason: 'duplicate', tier };
    }
    
    const payload = {
      type: 'social_alert',
      timestamp: this.now(),
      social: {
        tweetId: hit.tweetId,
        handle: hit.handle,
        displayName: hit.displayName,
        tier: hit.tier,
        category: hit.category,
        text: hit.text,
        url: hit.url,
        createdAt: hit.createdAt,
        addresses: hit.addresses,
        cashtags: hit.cashtags
      }
    };
    
    try {
      const response = await fetch(this.settings.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'meme-radar-jindou/0.1.6'
        },
        body: JSON.stringify(this.sanitizePayload(payload))
      });
      
      this.markSent(key);
      this.cleanup();
      
      return {
        sent: true,
        status: response.status,
        tier,
        key
      };
    } catch (error) {
      return {
        sent: false,
        reason: 'webhook_error',
        error: error.message,
        tier
      };
    }
  }
  
  async sendChainCompetitionSignal(competition) {
    if (!this.isEnabled()) return { sent: false, reason: 'disabled' };
    if (!competition || !competition.active) return { sent: false, reason: 'inactive' };
    if (competition.intensity < this.settings.xCompetitionThreshold) {
      return { sent: false, reason: 'below_threshold' };
    }
    
    const key = `competition:${Math.floor(competition.detectedAt / 60_000)}`; // 1-minute dedupe window
    
    if (this.sentAlerts.has(key)) {
      return { sent: false, reason: 'duplicate' };
    }
    
    const payload = {
      type: 'chain_competition_signal',
      timestamp: this.now(),
      competition: {
        intensity: competition.intensity,
        chains: competition.chains,
        signals: competition.signals,
        signalsCN: competition.signalsCN,
        recentHitCount: competition.recentHitCount,
        windowHours: competition.windowHours,
        detectedAt: competition.detectedAt
      }
    };
    
    try {
      const response = await fetch(this.settings.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'meme-radar-jindou/0.1.6'
        },
        body: JSON.stringify(this.sanitizePayload(payload))
      });
      
      this.markSent(key);
      this.cleanup();
      
      return {
        sent: response.ok,
        status: response.status,
        statusText: response.statusText
      };
    } catch (err) {
      return { sent: false, reason: 'network_error', error: err.message };
    }
  }
}
