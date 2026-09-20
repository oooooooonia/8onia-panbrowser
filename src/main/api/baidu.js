import { loadConfig, saveConfig } from '../config.js'

/** 百度网盘开放平台 - xpan 驱动（对齐 AList drivers/baidu_netdisk 的官方接口实现） */

const OPENAPI_TOKEN = 'https://openapi.baidu.com/oauth/2.0/token'
const PAN_REST = 'https://pan.baidu.com/rest/2.0'
// 下载 dlink 必须携带的 UA，否则 >20MB 文件被拒（403）
export const DLINK_UA = 'pan.baidu.com'
const API_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// errno 提示（常见值）
const ERRNO_TEXT = {
  0: '成功',
  '-6': '身份验证失败，已自动刷新令牌',
  '-7': '客户端签名错误',
  2: '参数错误',
  3: '未登录或登录已过期',
  5: '没有操作权限',
  111: 'token 失效，已自动刷新',
  31023: '文件不存在或已被删除',
  '-8': '文件不存在',
  '-9': '文件已存在',
  '-33': '超出单次访问文件数限制',
  '-61': '目录不存在'
}

function timeoutSignal(ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, done: () => clearTimeout(t) }
}

async function fetchJson(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  const { signal, done } = timeoutSignal(timeout)
  try {
    const res = await fetch(url, { method, headers, body, signal, redirect: 'follow' })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = { errno: -1, raw: text.slice(0, 300) }
    }
    if (!res.ok && json.errno === undefined) {
      json.errno = res.status === 401 ? -6 : res.status
    }
    return json
  } finally {
    done()
  }
}

export class Baidu {
  constructor() {
    this.cfg = loadConfig()
    this.refreshing = null
    this.dirCache = new Map() // path -> { at, entries }
    this.dlinkCache = new Map() // path -> { at, url }
    this.finalCache = new Map() // path -> { at, url }
  }

  /* ---------------- token ---------------- */
  reload() {
    this.cfg = loadConfig()
  }

  hasCredential() {
    return !!(this.cfg.clientId && this.cfg.clientSecret && this.cfg.refreshToken)
  }

  isTokenFresh() {
    return !!this.cfg.accessToken && Date.now() < this.cfg.accessTokenExpiresAt
  }

  async refreshToken(force = false) {
    if (!this.hasCredential()) throw new Error('尚未配置百度网盘凭证（client_id / client_secret / refresh_token）')
    if (!force && this.isTokenFresh()) return this.cfg.accessToken
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const qs = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.cfg.refreshToken,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret
      })
      const json = await fetchJson(`${OPENAPI_TOKEN}?${qs}`, { timeout: 25000 })
      if (json.error || !json.access_token) {
        const desc = json.error_description || json.error || JSON.stringify(json).slice(0, 160)
        let hint = ''
        // 百度 refresh_token 为一次性（轮换）：与正在运行的 AList 共用同一令牌时容易踩到
        if (/used|invalid_grant|expired/i.test(String(json.error || '') + ' ' + desc)) {
          hint =
            '。提示：百度 refresh_token 为一次性令牌，与正在运行的 AList 共用时会被其轮换消耗；' +
            '请在 AList 存储设置中重新保存一次该存储（使其持久化最新令牌），或停止 AList 后再导入，' +
            '或在设置页手动粘贴最新 refresh_token'
        }
        throw new Error(`刷新 access_token 失败：${desc}${hint}`)
      }
      this.cfg.accessToken = json.access_token
      this.cfg.refreshToken = json.refresh_token || this.cfg.refreshToken
      this.cfg.accessTokenExpiresAt = Date.now() + (Number(json.expires_in) || 2592000) * 1000 - 120000
      try {
        saveConfig({
          accessToken: this.cfg.accessToken,
          refreshToken: this.cfg.refreshToken,
          accessTokenExpiresAt: this.cfg.accessTokenExpiresAt
        })
      } catch {
        /* ignore */
      }
      return this.cfg.accessToken
    })()
    try {
      return await this.refreshing
    } finally {
      this.refreshing = null
    }
  }

  /**
   * 取 access_token：
   * - 显式 force：强制刷新；
   * - 有 access_token 且未知过期时间（如刚从 AList 导入）或未过期：直接用，不主动刷新（避免消耗一次性 refresh_token）；
   * - 无可用 access_token：走刷新。
   */
  async accessToken(forceRefresh = false) {
    if (forceRefresh) return this.refreshToken(true)
    if (this.cfg.accessToken) {
      if (this.cfg.accessTokenExpiresAt === 0 || Date.now() < this.cfg.accessTokenExpiresAt) {
        return this.cfg.accessToken
      }
    }
    return this.refreshToken(false)
  }

  /* ---------------- 底层请求 ---------------- */
  async panGet(pathname, params, { retried = false } = {}) {
    const token = await this.accessToken()
    const qs = new URLSearchParams({ access_token: token, ...params })
    const json = await fetchJson(`${PAN_REST}${pathname}?${qs}`, {
      headers: { 'User-Agent': API_UA, Accept: 'application/json' }
    })
    const errno = Number(json.errno)
    if (errno !== 0) {
      // token 失效：刷新后重试一次
      if (errno === -6 || errno === 111 || json.errno === 401) {
        if (!retried) {
          await this.refreshToken(true)
          return this.panGet(pathname, params, { retried: true })
        }
      }
      const msg = ERRNO_TEXT[String(errno)] || `errno ${errno}`
      throw new Error(`百度接口错误 ${msg}：${pathname}`)
    }
    return json
  }

  /* ---------------- 账户 ---------------- */
  async uinfo() {
    const json = await this.panGet('/xpan/nas', { method: 'uinfo' })
    return {
      uid: json.uk,
      baiduName: json.baidu_name,
      netdiskName: json.netdisk_name,
      avatarUrl: json.avatar_url || '',
      vipType: Number(json.vip_type) || 0,
      used: json.used,
      total: json.total
    }
  }

  /* ---------------- 目录 ---------------- */
  async listDir(dir, { order, desc, force = false } = {}) {
    const key = `${dir}|${order || ''}|${desc ? '1' : '0'}`
    const hit = !force ? this.dirCache.get(key) : null
    if (hit && Date.now() - hit.at < 30000) return hit.entries
    const entries = []
    let start = 0
    const limit = 200
    for (;;) {
      const params = { method: 'list', dir: dir || '/', web: 'web', start: String(start), limit: String(limit) }
      if (order) {
        params.order = order
        if (desc) params.desc = '1'
      }
      const json = await this.panGet('/xpan/file', params)
      const list = json.list || []
      for (const f of list) {
        entries.push({
          name: f.server_filename || f.path.split('/').pop(),
          path: f.path,
          isDir: Number(f.isdir) === 1,
          size: Number(f.size) || 0,
          mtime: Math.max(Number(f.server_mtime) || 0, Number(f.local_mtime) || 0) * 1000,
          fsId: Number(f.fs_id) || 0,
          category: Number(f.category) || 0,
          hasThumb: !!(f.thumbs && f.thumbs.url3),
          thumbUrl: (f.thumbs && f.thumbs.url3) || '',
          md5: f.md5 || ''
        })
      }
      if (list.length < limit) break
      start += limit
      if (start > 4000) break // 安全上限（百度单目录文件数通常 < 数千）
    }
    this.dirCache.set(key, { at: Date.now(), entries })
    return entries
  }

  clearDirCache() {
    this.dirCache.clear()
    this.dlinkCache.clear()
    this.finalCache.clear()
  }

  async findFile(path) {
    const norm = String(path || '/').replace(/\/+/g, '/')
    const parent = norm === '/' ? '/' : norm.slice(0, norm.lastIndexOf('/')) || '/'
    const entries = await this.listDir(parent, {})
    return entries.find((e) => e.path === norm) || null
  }

  /* ---------------- 直链 ---------------- */
  async dlinkForFile(path, { force = false } = {}) {
    const hit = this.dlinkCache.get(path)
    if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.url
    const file = await this.findFile(path)
    if (!file) throw new Error(`未能在网盘找到文件：${path}`)
    const json = await this.panGet('/xpan/multimedia', {
      method: 'filemetas',
      fsids: `[${file.fsId}]`,
      dlink: '1'
    })
    const item = json.list && json.list[0]
    if (!item || !item.dlink) throw new Error('获取下载直链失败（filemetas 无 dlink）')
    const sep = item.dlink.includes('?') ? '&' : '?'
    const url = `${item.dlink}${sep}access_token=${encodeURIComponent(this.cfg.accessToken)}`
    this.dlinkCache.set(path, { at: Date.now(), url })
    return url
  }

  /* ---------------- 搜索 ---------------- */
  async search(key, dir = '/', num = 60) {
    const json = await this.panGet('/xpan/file', {
      method: 'search',
      key: String(key),
      dir: dir || '/',
      recursion: '1',
      page: '1',
      num: String(num)
    })
    const list = json.list || []
    return list.map((f) => ({
      name: f.server_filename || f.path.split('/').pop(),
      path: f.path,
      isDir: Number(f.isdir) === 1,
      size: Number(f.size) || 0,
      mtime: Math.max(Number(f.server_mtime) || 0, Number(f.local_mtime) || 0) * 1000,
      fsId: Number(f.fs_id) || 0,
      category: Number(f.category) || 0,
      hasThumb: !!(f.thumbs && f.thumbs.url3),
      thumbUrl: (f.thumbs && f.thumbs.url3) || ''
    }))
  }
}
