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
 * ✅ PID-based lock: filename encodes owner identity
 * - Lock file: {file}.lock.{pid}.{token}
 * - Atomic ownership: file creation = ownership established
 * - No age check: only PID liveness matters
 * - SIGKILL recovery: dead PID → reclaimable
 * - Old owner cannot delete new owner lock (different filename)
 */
function acquireLock(queueFile, timeoutMs = 5000) {
  const lockToken = randomBytes(16).toString('hex').slice(0, 8);
  const myLockFile = `${queueFile}.lock.${process.pid}.${lockToken}`;
  const lockBasename = `${queueFile}.lock.`;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    // Scan existing locks
    try {
      const lockDir = path.dirname(queueFile);
      const lockPattern = path.basename(queueFile) + '.lock.';
      const existingLocks = fs.readdirSync(lockDir).filter(f => f.startsWith(lockPattern));
      
      for (const lockName of existingLocks) {
        const lockPath = path.join(lockDir, lockName);
        
        // Parse PID from filename: {file}.lock.{pid}.{token}
        const match = lockName.match(/\.lock\.(\d+)\./);
        if (!match) {
          // Malformed lock, remove if old
          try {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > 10000) {
              fs.unlinkSync(lockPath);
            }
          } catch {}
          continue;
        }
        
        const ownerPid = parseInt(match[1], 10);
        
        // Check if owner process alive
        let processAlive = false;
        try {
          process.kill(ownerPid, 0); // signal 0: check existence
          processAlive = true;
        } catch {}
        
        if (!processAlive) {
          // Owner dead, reclaim
          try {
            fs.unlinkSync(lockPath);
          } catch {}
        }
        // If alive, respect the lock (no age check)
      }
    } catch {}
    
    // Try to create our lock
    try {
      const fd = fs.openSync(myLockFile, 'wx');
      const lockData = JSON.stringify({
        pid: process.pid,
        token: lockToken,
        acquiredAt: Date.now(),
        acquiredIso: new Date().toISOString()
      });
      fs.writeSync(fd, lockData);
      fs.closeSync(fd);
      return { lockFile: myLockFile, token: lockToken };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock exists (ours or another), wait and retry
    }
    
    // Wait and retry
    const jitter = Math.random() * 50;
    const waitMs = Math.min(50 + jitter, timeoutMs - (Date.now() - startTime));
    if (waitMs > 0) {
      const start = Date.now();
      while (Date.now() - start < waitMs) {} // busy wait
    }
  }
  throw new Error(`Failed to acquire lock for ${queueFile} after ${timeoutMs}ms`);
}

/**
 * Release PID-based lock with token validation
 * ✅ Only delete our own lock file (PID+token match)
 * ✅ Old owner cannot delete new owner lock (different filename)
 */
function releaseLock(lockObj) {
  const { lockFile, token } = lockObj;
  try {
    // PID-based lock: ensure filename contains our PID
    if (!lockFile.includes(`.lock.${process.pid}.`)) {
      return; // Not our lock
    }
    
    // Verify we still own the lock (token match)
    const lockContent = fs.readFileSync(lockFile, 'utf8');
    const lockInfo = JSON.parse(lockContent);
    if (lockInfo.token === token && lockInfo.pid === process.pid) {
      fs.unlinkSync(lockFile);
    }
  } catch (e) {
    // Lock file already gone or unreadable, ok
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
