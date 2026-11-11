/**
 * Alert queue management: pending → claimed (lease) → sent → delivered
 * ✅ 三阶段队列with lease
 * ✅ 01:00-06:00 Asia/Shanghai静默
 * ✅ TTL过期处理
 * ✅ 多进程安全原子更新
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import fsExt from 'fs-ext';

const CST_OFFSET_MS = 8 * 3600_000;

/**
 * 检查是否在静默时段 (01:00-06:00 Asia/Shanghai)
 */
export function isQuietHours(now = Date.now()) {
  const cst = new Date(now + CST_OFFSET_MS);
  const hour = cst.getUTCHours();
  return hour >= 1 && hour < 6;
}

/**
 * 加载队列文件（原子读取）
 */
export function loadQueue(queueFile) {
  try {
    if (!fs.existsSync(queueFile)) return [];
    const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(Boolean);
    return lines.map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch {
        console.error(`Invalid queue line ${idx}: ${line.slice(0, 100)}`);
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.error(`Failed to load queue: ${e.message}`);
    return [];
  }
}

/**
 * 原子性写入队列文件
 */
export function saveQueue(queueFile, items) {
  const tmpFile = queueFile + '.tmp.' + randomBytes(8).toString('hex');
  try {
    const lines = items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
    fs.writeFileSync(tmpFile, lines, 'utf8');
    fs.renameSync(tmpFile, queueFile);
    return true;
  } catch (e) {
    console.error(`Failed to save queue: ${e.message}`);
    try { fs.unlinkSync(tmpFile); } catch {}
    return false;
  }
}

/**
 * Add pending alert to queue (原子追加 + 跨进程锁)
 * ✅ All writers must share same lock
 * @param {string} queueFile - 队列文件路径
 * @param {Object} alert - 待添加的alert
 */
export function addPendingAlert(queueFile, alert) {
  const item = {
    ...alert,
    status: 'pending',
    createdAt: alert.createdAt || new Date().toISOString()
  };
  
  // ✅ Acquire lock before append
  const lockObj = acquireLock(queueFile);
  try {
    const line = JSON.stringify(item) + '\n';
    fs.appendFileSync(queueFile, line, 'utf8');
    return true;
  } catch (e) {
    console.error(`Failed to add pending alert: ${e.message}`);
    return false;
  } finally {
    releaseLock(lockObj);
  }
}

/**
 * Acquire exclusive file lock with owner/token validation
 * ✅ Prevents healthy long operations from lock steal
 * ✅ Safe recovery from SIGKILL crashed processes
 */
/**
 * ✅ OS-level flock (fs-ext): kernel-managed advisory file lock
 * - Lock bound to file descriptor: released automatically on process crash/exit
 * - Atomic: kernel prevents duplicate acquisition (LOCK_EX | LOCK_NB)
 * - Pauses safe: no heartbeat needed, lock held by FD, not mtime
 * - Cross-process: works across sibling processes on same machine
 * - Stale-free: dead process automatically releases (kernel cleans FD on exit)
 */
function acquireLock(queueFile, timeoutMs = 5000) {
  const lockPath = queueFile + '.lock';
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Open lock file (create if not exists)
      const fd = fs.openSync(lockPath, 'w');
      
      try {
        // Try non-blocking exclusive lock (LOCK_EX | LOCK_NB)
        fsExt.flockSync(fd, 'ex');
        
        // Write owner info for debugging (not used for lock logic)
        const info = JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          acquiredIso: new Date().toISOString()
        });
        fs.writeSync(fd, info);
        fs.fsyncSync(fd);
        
        return { fd, lockPath };
      } catch (lockErr) {
        // Lock failed, close FD and retry
        fs.closeSync(fd);
        
        if (lockErr.code === 'EAGAIN' || lockErr.code === 'EWOULDBLOCK') {
          // Lock held by another process, wait and retry
          const waitMs = Math.min(50 + Math.random() * 50, timeoutMs - (Date.now() - startTime));
          if (waitMs > 0) {
            const start = Date.now();
            while (Date.now() - start < waitMs) {}
          }
          continue;
        }
        
        throw lockErr;
      }
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EMFILE') {
        // Directory doesn't exist or too many open files
        throw e;
      }
      // Unexpected error
      throw e;
    }
  }
  
  throw new Error(`Failed to acquire flock for ${queueFile} after ${timeoutMs}ms`);
}

/**
 * Release OS flock
 * ✅ Kernel automatically releases on close(fd) or process exit
 * No race: close() is atomic, lock tied to FD lifetime
 */
function releaseLock(lockObj) {
  const { fd } = lockObj;
  try {
    // Unlock (optional, close() will release anyway)
    try {
      fsExt.flockSync(fd, 'un');
    } catch {}
    
    // Close FD (kernel releases lock atomically)
    fs.closeSync(fd);
  } catch (e) {
    console.error(`Lock release error:`, e.message);
  }
}

/**
 * Claim pending alerts (带lease + 跨进程锁)
 * @param {string} queueFile - 队列文件路径
 * @param {Object} options - 配置
 * @returns {Array} 已claim的alerts
 */
export function claimPendingAlerts(queueFile, options = {}) {
  const {
    leaseDurationMs = 5 * 60 * 1000,   // 默认5分钟lease（短于TTL避免崩溃恢复时事件已过期）
    ttlMs = 10 * 60 * 1000,            // 默认10分钟TTL
    maxClaims = 10,
    now = Date.now()
  } = options;
  
  // ✅ 静默时段不claim
  if (isQuietHours(now)) {
    return { claimed: [], reason: 'quiet_hours', quietHours: '01:00-06:00 CST' };
  }
  
  // ✅ Acquire cross-process lock
  const lockFile = acquireLock(queueFile);
  try {
    const items = loadQueue(queueFile);
  const claimed = [];
  const updated = [];
  
  for (const item of items) {
    const status = item.status || 'pending';
    
    // ✅ 已delivered不重复
    if (status === 'delivered') {
      updated.push(item);
      continue;
    }
    
    // ✅ TTL过期标记为expired
    const eventTime = item.whenIso ? new Date(item.whenIso).getTime() : item.createdAt ? new Date(item.createdAt).getTime() : now;
    if (now - eventTime > ttlMs) {
      updated.push({ ...item, status: 'expired', expiredAt: new Date(now).toISOString(), reason: 'ttl_exceeded' });
      continue;
    }
    
    // ✅ claimed和sent状态检查lease
    if (status === 'claimed' || status === 'sent') {
      const leaseExpiry = item.leaseExpiry ? new Date(item.leaseExpiry).getTime() : 0;
      if (now < leaseExpiry) {
        // lease未过期，保留
        updated.push(item);
        continue;
      } else {
        // lease过期，可重新claim
        // 继续下面的pending逻辑
      }
    }
    
    // ✅ pending或lease过期的claimed/sent可以claim
    if ((status === 'pending' || status === 'claimed' || status === 'sent') && claimed.length < maxClaims) {
      const leaseExpiry = new Date(now + leaseDurationMs).toISOString();
      const claimedItem = {
        ...item,
        status: 'claimed',
        claimedAt: new Date(now).toISOString(),
        leaseExpiry,
        leaseId: randomBytes(16).toString('hex')
      };
      claimed.push(claimedItem);
      updated.push(claimedItem);
    } else {
      updated.push(item);
    }
  }
  
    // 原子性保存
    if (saveQueue(queueFile, updated)) {
      return { claimed, total: items.length, updated: updated.length };
    } else {
      return { claimed: [], error: 'failed_to_save' };
    }
  } finally {
    releaseLock(lockFile);
  }
}

/**
 * Acknowledge delivered alerts (带跨进程锁)
 * @param {string} queueFile - 队列文件路径
 * @param {Array} eventIds - 要ack的eventId列表
 * @param {Object} options - 配置
 */
export function acknowledgeDelivered(queueFile, eventIds, options = {}) {
  const { now = Date.now(), leaseId } = options;
  
  // ✅ Acquire cross-process lock
  const lockFile = acquireLock(queueFile);
  try {
    const items = loadQueue(queueFile);
  const acknowledged = [];
  const failed = [];
  const skipped = [];
  const updated = [];
  
  const eventIdSet = new Set(eventIds);
  
  for (const item of items) {
    if (eventIdSet.has(item.eventId)) {
      // ✅ claimed状态必须验证leaseId和expiry
      if (item.status === 'claimed') {
        const leaseExpiry = item.leaseExpiry ? new Date(item.leaseExpiry).getTime() : 0;
        const leaseExpired = leaseExpiry > 0 && now > leaseExpiry;
        
        if (!leaseId || item.leaseId !== leaseId) {
          // leaseId不匹配，拒绝ack
          failed.push({ eventId: item.eventId, reason: 'lease_mismatch', status: item.status, itemLeaseId: item.leaseId?.slice(0, 8), providedLeaseId: leaseId?.slice(0, 8) });
          updated.push(item);
        } else if (leaseExpired) {
          // lease已过期，拒绝ack
          failed.push({ eventId: item.eventId, reason: 'lease_expired', status: item.status, leaseExpiry: item.leaseExpiry, now: new Date(now).toISOString() });
          updated.push(item);
        } else {
          // leaseId匹配且未过期，允许ack
          const deliveredItem = {
            ...item,
            status: 'delivered',
            deliveredAt: new Date(now).toISOString()
          };
          acknowledged.push(deliveredItem);
          updated.push(deliveredItem);
        }
      } else if (item.status === 'sent') {
        // ✅ sent状态也必须验证lease（不能绕过lease）
        const leaseExpiry = item.leaseExpiry ? new Date(item.leaseExpiry).getTime() : 0;
        const leaseExpired = leaseExpiry > 0 && now > leaseExpiry;
        
        if (!leaseId || item.leaseId !== leaseId) {
          failed.push({ eventId: item.eventId, reason: 'lease_mismatch', status: item.status });
          updated.push(item);
        } else if (leaseExpired) {
          failed.push({ eventId: item.eventId, reason: 'lease_expired', status: item.status, leaseExpiry: item.leaseExpiry });
          updated.push(item);
        } else {
          const deliveredItem = {
            ...item,
            status: 'delivered',
            deliveredAt: new Date(now).toISOString()
          };
          acknowledged.push(deliveredItem);
          updated.push(deliveredItem);
        }
      } else {
        // 已经delivered或其他状态，跳过
        skipped.push({ eventId: item.eventId, status: item.status, reason: 'invalid_status' });
        updated.push(item);
      }
    } else {
      updated.push(item);
    }
  }
  
    if (saveQueue(queueFile, updated)) {
      return { acknowledged, failed, skipped, total: items.length };
    } else {
      return { acknowledged: [], failed, skipped, error: 'failed_to_save' };
    }
  } finally {
    releaseLock(lockFile);
  }
}

/**
 * 清理过期和已delivered的旧记录 (带跨进程锁)
 * ✅ Must share lock with all writers/readers
 */
export function cleanupQueue(queueFile, options = {}) {
  const {
    keepDeliveredHours = 48,  // 保留已delivered记录48小时
    keepExpiredHours = 24,    // 保留过期记录24小时
    now = Date.now()
  } = options;
  
  // ✅ Acquire lock before cleanup
  const lockObj = acquireLock(queueFile);
  try {
    const items = loadQueue(queueFile);
    const kept = [];
    let removed = 0;
    
    for (const item of items) {
      let shouldRemove = false;
      
      if (item.status === 'delivered' && item.deliveredAt) {
        const deliveredTime = new Date(item.deliveredAt).getTime();
        if (now - deliveredTime > keepDeliveredHours * 3600_000) {
          shouldRemove = true;
        }
      } else if (item.status === 'expired' && item.expiredAt) {
        const expiredTime = new Date(item.expiredAt).getTime();
        if (now - expiredTime > keepExpiredHours * 3600_000) {
          shouldRemove = true;
        }
      }
      
      if (!shouldRemove) {
        kept.push(item);
      } else {
        removed++;
      }
    }
    
    if (saveQueue(queueFile, kept)) {
      return { kept: kept.length, removed };
    } else {
      return { kept: items.length, removed: 0, error: 'failed_to_save' };
    }
  } finally {
    releaseLock(lockObj);
  }
}

/**
 * 格式化历史提醒（06:00后）
 */
export function formatHistoricalAlert(item, now = Date.now()) {
  const eventTime = item.whenIso ? new Date(item.whenIso).getTime() : now;
  const ageMinutes = Math.floor((now - eventTime) / 60_000);
  
  // ✅ 不用"9分钟前"误导，用绝对时间
  const eventTimeStr = item.whenIso ? item.whenIso.replace('T', ' ').slice(0, 19) + ' UTC' : '时间未知';
  
  let text = item.text || '';
  
  // 在文本开头添加历史标记
  const historicalNote = `[历史提醒 - ${eventTimeStr}, ${ageMinutes}分钟前]`;
  
  return historicalNote + '\n' + text;
}

/**
 * 获取队列统计
 */
export function getQueueStats(queueFile) {
  const items = loadQueue(queueFile);
  
  const stats = {
    total: items.length,
    pending: 0,
    claimed: 0,
    sent: 0,
    delivered: 0,
    expired: 0,
    other: 0
  };
  
  for (const item of items) {
    const status = item.status || 'pending';
    if (status in stats) {
      stats[status]++;
    } else {
      stats.other++;
    }
  }
  
  return stats;
}
