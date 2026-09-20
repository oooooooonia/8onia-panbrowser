import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { DLINK_UA } from './api/baidu.js'
import { loadConfig, saveConfig, publicConfig, clearCredentials, normalizeDanmaku, normalizeSubWeight, DEFAULTS } from './config.js'
import { scanAlist, importFromAlist } from './importers/alist.js'
import { detectPotplayer, detectPlayers, openWithPlayer, openWithPotplayer } from './potplayer.js'
import { SUB_EXTS, extOf, isSubtitleName, subtitleToVtt, detectSubtitleType, decodeSubtitle, srtToAss, subtitleToAss, applySubWeight } from './subtitles.js'
import { probeEmbeddedSubs, extractSubtitleText, ffmpegAvailable, localStreamUrl } from './media.js'
import { createSkipService } from './skip.js'
import { putAssText } from './asscache.js'
import { getWatchEntry, setWatchEntry, listWatch } from './history.js'
import { primaryFontFile, wideFontFile, subtitleFontInfo } from './fonts.js'

// 同目录弹幕文件（B 站弹幕 XML）：解析/渲染交给前端 artplayer-plugin-danmuku，服务端只负责列目录 + 代理取回
const DANMAKU_EXTS = ['.xml']
const isDanmakuName = (name) => DANMAKU_EXTS.includes(extOf(name))

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_DIR = path.join(__dirname, '../renderer') // out/renderer
// libass-wasm(SubtitlesOctopus) 渲染资产目录（worker + wasm + 主库；随包打包进 resources/vendor/libass）
const LIBASS_JS_DIR = path.join(__dirname, '../../resources/vendor/libass')
// 字幕字体候选与解析见 fonts.js（圆角中文字体优先，系统缺失则退到全局字体）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}

/* ---------- 流代理参数 ---------- */
// 仅用于「建连 + 首个响应头」阶段；收到响应头后会撤销（见 fetchFollowed 的 stream 选项），
// 绝不把 socket 空闲超时套在正在播放的长连接上——否则「暂停/缓冲满了不读数据」30s 就会误杀连接。
const UPSTREAM_HEADER_TIMEOUT_MS = 30000
// 流式阶段的软看门狗：上游「彻底静默」超过这个时长才算卡死。
// 取 5 分钟是刻意的保守值：客户端因缓冲满/暂停而不读时，isPaused() 的背压信号会在数据下沉到
// 内核缓冲区后消失（此时既无字节也无背压标记），阈值太小会误杀「暂停中的播放」。
// 真正的中途断流由 error/aborted/close 立刻收尾；万一这条兜底超时触发，前端自愈会自动续播。
const STREAM_IDLE_MS = 300000
const STREAM_IDLE_TICK_MS = 5000
// 这些状态码多半是直链过期/被限流造成的，刷新直链重试一次通常就好
const DLINK_RETRY_CODES = new Set([401, 403, 404, 410, 416, 500, 502, 503])

/* ---------- 通用工具 ---------- */
function debugLog(line) {
  try {
    const f = path.join(__dirname, '../../.debug/log.txt')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* ignore */
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    // dev 模式渲染层由 Vite 提供（http://localhost:5173），API 在 127.0.0.1:<port> 属跨源，
    // 少了这组头的话 fetch 会被浏览器 CORS 拦掉（打包后同源，不受影响）
    ...corsHeaders()
  })
  res.end(body)
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,range',
    'access-control-expose-headers': 'content-range,accept-ranges,content-length,content-type,content-disposition'
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 手动跟随重定向（保持 Range/UA 等头，最大 6 跳），返回最终响应流。
 * stream:true —— 这是要长期传送的媒体流：拿到响应头后立即撤销 socket 空闲超时，
 *   改用调用方的软看门狗（避免「播放器暂停/缓冲满了没在收数据」被当成上游超时误杀）。
 */
function fetchFollowed(target, { method = 'GET', headers = {}, redirects = 0, stream = false, idleMs = UPSTREAM_HEADER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(target)
    } catch {
      return reject(new Error('非法 URL'))
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      u,
      { method, headers },
      (res) => {
        // 流式响应头已到 → 握手阶段结束，撤掉 socket 空闲超时（长连接存活交给调用方的软看门狗）。
        // 非流式（字幕/封面等小文件）保留超时，中途卡住会被正常打断并抛错。
        if (stream) {
          try {
            req.setTimeout(0)
          } catch {
            /* ignore */
          }
        }
        const code = res.statusCode
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume()
          if (redirects >= 6) {
            reject(new Error('重定向次数过多'))
            return
          }
          const next = new URL(res.headers.location, u).href
          fetchFollowed(next, { method, headers, redirects: redirects + 1, stream, idleMs }).then(resolve, reject)
          return
        }
        resolve(res)
      }
    )
    req.on('error', reject)
    // 建连 / 等首字节超时（流式响应头到达后会被上面的 setTimeout(0) 撤销）
    req.setTimeout(idleMs, () => req.destroy(new Error('上游请求超时')))
    req.end()
  })
}

function extType(name) {
  return MIME[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream'
}

/** 把上游响应完整读进 Buffer（限流保护） */
async function fetchBuffer(upstream, headers = {}, maxBytes = 16 * 1024 * 1024) {
  const up = await fetchFollowed(upstream, { headers })
  if (up.statusCode >= 400) {
    up.resume()
    throw new Error(`上游返回 HTTP ${up.statusCode}`)
  }
  const chunks = []
  let total = 0
  for await (const c of up) {
    total += c.length
    if (total > maxBytes) {
      up.destroy()
      throw new Error('字幕文件过大')
    }
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.mov', '.m4v', '.webm', '.ts', '.m2ts', '.flv', '.avi', '.wmv',
  '.rmvb', '.rm', '.mpg', '.mpeg', '.vob', '.3gp', '.f4v', '.asf', '.divx', '.ogv', '.mts'
])
const AUDIO_EXTS = new Set(['.mp3', '.aac', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.wma', '.ape'])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.avif'])
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.zst'])
const TEXT_EXTS = new Set(['.txt', '.md', '.srt', '.ass', '.vtt', '.json', '.xml', '.csv', '.log', '.lrc'])

export function classify(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ARCHIVE_EXTS.has(ext)) return 'archive'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'file'
}

/* ---------- 本地 HTTP 服务 ---------- */
export function startServer({ baidu }) {
  const cfg = loadConfig()
  const skip = createSkipService({ baidu, port: cfg.port })

  async function handleStream(res, pathStr, { download = false } = {}) {
    const range = (res.req && res.req.headers && res.req.headers.range) || ''
    const t0 = Date.now()

    /* ---------- ① 建上游：直链过期/被限流时刷新直链再试一次 ---------- */
    let up = null
    let lastErr = ''
    for (let attempt = 1; attempt <= 2 && !up; attempt++) {
      try {
        const url = await baidu.dlinkForFile(pathStr, { force: attempt > 1 })
        const headers = {
          'User-Agent': DLINK_UA,
          Accept: '*/*',
          Referer: 'http://pan.baidu.com/'
        }
        if (range) headers.Range = range
        const r = await fetchFollowed(url, { headers, stream: true })
        if (r.statusCode >= 400) {
          const code = r.statusCode
          lastErr = `百度直链返回 HTTP ${code}`
          r.resume() // 排空并释放这条上游连接
          if (attempt === 2 || !DLINK_RETRY_CODES.has(code)) {
            debugLog(`stream fail http=${code} path=${pathStr}`)
            return sendJson(res, 502, { ok: false, error: lastErr })
          }
          debugLog(`stream retry http=${code} → 刷新直链重试 path=${pathStr}`)
          continue
        }
        up = r
      } catch (err) {
        lastErr = err.message || String(err)
        if (attempt === 2) {
          debugLog(`stream fail err=${lastErr} path=${pathStr}`)
          return sendJson(res, 502, { ok: false, error: lastErr })
        }
        debugLog(`stream retry err=${lastErr} → 刷新直链重试 path=${pathStr}`)
      }
    }
    if (!up) return sendJson(res, 502, { ok: false, error: lastErr || '无法建立上游连接' })

    /* ---------- ② 透传响应头 ---------- */
    const hdrs = { ...corsHeaders(), 'cache-control': 'no-store' }
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = up.headers[k]
      if (v) hdrs[k] = v
    }
    if (!hdrs['content-type'] || hdrs['content-type'].includes('octet-stream')) {
      hdrs['content-type'] = extType(pathStr) || 'application/octet-stream'
    }
    hdrs['accept-ranges'] = up.headers['accept-ranges'] || 'bytes'
    if (download) {
      const name = path.basename(pathStr)
      const ascii = name.replace(/[^\x20-\x7e]/g, '_')
      hdrs['content-disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
    }
    res.writeHead(up.statusCode || 200, hdrs)

    /* ---------- ③ 上游生命周期收尾（关键修复） ----------
     * 上游中途断掉时，过去只写了 up.pipe(res)：既不 end 也不 destroy 客户端响应，
     * 声明了 content-length 的响应就永远停半截，浏览器 <video> 会「无限等待」——画面定格、
     * 不报错、也永远不自愈，用户只能刷新页面换一条连接。这里把任何异常都明确地收尾。
     */
    let bytes = 0
    let lastAt = Date.now()
    let done = false
    let idleTimer = null

    const stopWatch = () => {
      if (idleTimer) {
        clearInterval(idleTimer)
        idleTimer = null
      }
    }
    // 正常/异常都走这里：结束客户端这条响应并释放上游
    const closeBoth = (reason) => {
      if (done) return
      done = true
      stopWatch()
      try {
        if (!res.writableEnded) res.destroy()
      } catch {
        /* ignore */
      }
      try {
        up.destroy()
      } catch {
        /* ignore */
      }
      if (reason) {
        debugLog(`stream abort ${reason} bytes=${bytes} ms=${Date.now() - t0} range="${range}" path=${pathStr}`)
      }
    }

    up.pipe(res)
    // 字节计数（同时刷新看门狗时钟）
    up.on('data', (c) => {
      bytes += c.length
      lastAt = Date.now()
    })
    up.on('error', (e) => closeBoth(`upstream-error:${(e && (e.code || e.message)) || 'unknown'}`))
    up.on('aborted', () => closeBoth('upstream-aborted'))
    up.on('close', () => {
      // 上游没读完就关了 → 客户端还在等剩余的 content-length，必须收尾
      if (!up.readableEnded) closeBoth('upstream-close-incomplete')
      else stopWatch()
    })
    res.on('finish', () => {
      done = true
      stopWatch()
    })
    res.on('close', () => {
      // 客户端（播放器 seek/关播放器）主动断开：静默清理，不当异常记录
      if (!res.writableEnded) closeBoth('')
    })

    // 软看门狗：只有「上游彻底静默」才断。
    // 播放器暂停 / 缓冲已满而停止读取（TCP 窗口关闭 → 上游也停发）属于正常静止，不算卡死。
    idleTimer = setInterval(() => {
      if (done || res.writableEnded || res.destroyed) return
      const clientPaused = up.isPaused() || res.writableNeedDrain || res.writableLength > 0
      if (clientPaused) {
        lastAt = Date.now()
        return
      }
      if (Date.now() - lastAt >= STREAM_IDLE_MS) {
        closeBoth(`upstream-silent>${Math.round(STREAM_IDLE_MS / 1000)}s`)
      }
    }, STREAM_IDLE_TICK_MS)
    if (idleTimer && idleTimer.unref) idleTimer.unref()
  }

  const router = async (req, res) => {
    let u
    try {
      u = new URL(req.url, 'http://local')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' })
    }
    const p = u.pathname
    const q = u.searchParams
    const method = req.method

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      return res.end()
    }

    /* ============ JSON API ============ */
    if (p === '/api/debug/log' && method === 'POST') {
      try {
        const body = await readBody(req)
        debugLog(String((body && body.msg) || '').slice(0, 2000))
        return sendJson(res, 200, { ok: true })
      } catch {
        return sendJson(res, 200, { ok: true })
      }
    }

    if (p === '/api/status' && method === 'GET') {
      const out = {
        ok: true,
        config: publicConfig(),
        server: { port: cfg.port, hostBind: cfg.hostBind }
      }
      try {
        out.account = await baidu.uinfo()
      } catch {
        out.account = null
      }
      try {
        out.potplayer = detectPotplayer()
      } catch {
        out.potplayer = { found: false }
      }
      try {
        // 全局字幕字体（供渲染层构造 libass 的 availableFonts / fallbackFont）
        out.subtitleFont = subtitleFontInfo()
      } catch {
        out.subtitleFont = null
      }
      return sendJson(res, 200, out)
    }

    if (p === '/api/config' && method === 'POST') {
      const body = await readBody(req)
      const patch = {}
      const strFields = ['clientId', 'clientSecret', 'refreshToken', 'rootFolderPath', 'orderBy', 'orderDirection', 'potplayerPath', 'mpvPath', 'vlcPath', 'playerMode', 'ffmpegPath', 'port', 'hostBind', 'alistDir', 'subtitleFontPath']
      let credsChanged = false
      for (const k of strFields) {
        if (body[k] !== undefined && body[k] !== null) {
          if (k === 'port') {
            const n = Math.trunc(Number(body[k]))
            patch.port = Number.isFinite(n) ? Math.min(65535, Math.max(1024, n)) : DEFAULTS.port
          } else {
            patch[k] = String(body[k])
          }
          if (k === 'clientId' || k === 'clientSecret' || k === 'refreshToken') credsChanged = true
        }
      }
      if (credsChanged) {
        patch.accessToken = ''
        patch.accessTokenExpiresAt = 0
      }
      // 支持显式写入 access_token（配合新 refresh_token 一起更换时不被上面的重置清掉）
      if (body.accessToken !== undefined && body.accessToken !== null) {
        patch.accessToken = String(body.accessToken)
        if (credsChanged) patch.accessTokenExpiresAt = 0
      }
      if (body.accessTokenExpiresAt !== undefined && body.accessTokenExpiresAt !== null) {
        patch.accessTokenExpiresAt = Number(body.accessTokenExpiresAt) || 0
      }
      // 字幕外观：数值与布尔
      const numKeys = { subFontScale: [0.01, 0.15], subOutline: [0, 8], subShadow: [0, 8] }
      for (const [k, range] of Object.entries(numKeys)) {
        if (body[k] !== undefined && body[k] !== null) {
          const n = Number(body[k])
          patch[k] = Number.isFinite(n) ? Math.min(range[1], Math.max(range[0], n)) : DEFAULTS[k]
        }
      }
      if (body.subWeight !== undefined && body.subWeight !== null) patch.subWeight = normalizeSubWeight(String(body.subWeight))
      // 弹幕外观（B 站 XML 弹幕插件）：整体对象，服务端归一化后落盘
      if (body.danmaku !== undefined && body.danmaku !== null) patch.danmaku = normalizeDanmaku(body.danmaku)
      // OP/ED 跳过
      for (const k of ['skipEnabled', 'skipAutoOp', 'skipAutoEd', 'skipUseChapters', 'skipUseSubtitles']) {
        if (body[k] !== undefined && body[k] !== null) patch[k] = !!body[k]
      }
      if (body.skipDelaySec !== undefined && body.skipDelaySec !== null) {
        const n = Number(body.skipDelaySec)
        patch.skipDelaySec = Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : DEFAULTS.skipDelaySec
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: '无有效字段' })
      saveConfig(patch)
      baidu.reload()
      baidu.clearDirCache()
      return sendJson(res, 200, { ok: true, config: publicConfig() })
    }

    if (p === '/api/config/test' && method === 'POST') {
      try {
        const account = await baidu.uinfo()
        return sendJson(res, 200, { ok: true, account })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/config/clear' && method === 'POST') {
      clearCredentials()
      baidu.reload()
      baidu.clearDirCache()
      return sendJson(res, 200, { ok: true })
    }

    if (p === '/api/alist/scan' && method === 'POST') {
      const body = await readBody(req)
      try {
        const r = await scanAlist(body.dir || cfg.alistDir)
        return sendJson(res, 200, { ok: true, ...r })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/alist/import' && method === 'POST') {
      const body = await readBody(req)
      try {
        const r = await importFromAlist(body.dbPath, body.id)
        baidu.reload()
        baidu.clearDirCache()
        let account = null
        let accountError = ''
        try {
          account = await baidu.uinfo()
        } catch (err) {
          accountError = err.message
        }
        return sendJson(res, 200, { ok: true, imported: r, account, accountError })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/fs/list' && method === 'GET') {
      try {
        const entries = await baidu.listDir(q.get('path') || '/', {
          order: q.get('order') || cfg.orderBy || 'name',
          desc: q.get('desc') === '1' || q.get('desc') === 'true',
          force: q.get('refresh') === '1'
        })
        const withType = entries.map((e) => ({ ...e, kind: e.isDir ? 'folder' : classify(e.name) }))
        return sendJson(res, 200, { ok: true, path: q.get('path') || '/', entries: withType })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/fs/search' && method === 'GET') {
      try {
        const list = await baidu.search(q.get('key') || '', q.get('dir') || '/')
        const withType = list.map((e) => ({ ...e, kind: e.isDir ? 'folder' : classify(e.name) }))
        return sendJson(res, 200, { ok: true, entries: withType })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/rawlink' && method === 'GET') {
      try {
        const pathStr = q.get('path')
        const base = await baidu.dlinkForFile(pathStr)
        // 跟随一次以拿到最终可直链地址（HEAD 即可，不下载）
        const up = await fetchFollowed(base, { method: 'GET', headers: { 'User-Agent': DLINK_UA } })
        up.resume()
        return sendJson(res, 200, { ok: true, base, final: up.statusCode === 200 ? base : base })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/player/open' && method === 'POST') {
      const body = await readBody(req)
      try {
        const pathStr = body.path
        if (!pathStr) throw new Error('缺少 path')
        const host = '127.0.0.1'
        const port = cfg.port
        const local = `http://${host}:${port}/api/stream?path=${encodeURIComponent(pathStr)}`
        const player = body.player || 'potplayer'
        const playerPath = body.playerPath || ''
        const r = openWithPlayer(local, player, playerPath)
        return sendJson(res, 200, { ok: true, ...r, url: local, player })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/player/detect' && method === 'GET') {
      try {
        const r = detectPlayers()
        return sendJson(res, 200, { ok: true, ...r })
      } catch (err) {
        return sendJson(res, 200, { ok: true, potplayer: detectPotplayer() })
      }
    }

    if (p === '/api/ffmpeg/status' && method === 'GET') {
      return sendJson(res, 200, { ok: true, available: ffmpegAvailable(), path: loadConfig().ffmpegPath || '' })
    }

    /* ============ 媒体/下载流 ============ */
    if (p === '/api/stream' && method === 'GET') {
      const pathStr = q.get('path')
      if (!pathStr) return sendJson(res, 400, { ok: false, error: 'missing path' })
      return handleStream(res, pathStr)
    }
    if (p === '/api/download' && method === 'GET') {
      const pathStr = q.get('path')
      if (!pathStr) return sendJson(res, 400, { ok: false, error: 'missing path' })
      return handleStream(res, pathStr, { download: true })
    }

    if (p === '/api/thumb' && method === 'GET') {
      try {
        const pathStr = q.get('path')
        const file = await baidu.findFile(pathStr)
        if (!file || !file.thumbUrl) return sendJson(res, 404, { ok: false, error: '无缩略图' })
        res.writeHead(302, { location: file.thumbUrl, 'cache-control': 'no-store' })
        return res.end()
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message })
      }
    }

    /* ============ 字幕 ============ */
    if (p === '/api/fs/subs' && method === 'GET') {
      try {
        const videoPath = q.get('path') || ''
        const parent = videoPath.slice(0, videoPath.lastIndexOf('/')) || '/'
        const entries = await baidu.listDir(parent, {})
        const subs = entries
          .filter((e) => !e.isDir && isSubtitleName(e.name))
          .map((e) => ({ name: e.name, path: e.path, ext: extOf(e.name) }))
        // 同目录弹幕（B 站 XML）：供播放页“弹幕”条选择；一个视频通常配一份同名 xml
        const danmakus = entries
          .filter((e) => !e.isDir && isDanmakuName(e.name))
          .map((e) => ({ name: e.name, path: e.path, ext: extOf(e.name), size: e.size }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true, sensitivity: 'base' }))
        // 同目录视频（剧集）：供播放页“剧集选择”使用，按数字大小优先排序
        const videos = entries
          .filter((e) => !e.isDir && classify(e.name) === 'video')
          .map((e) => ({ name: e.name, path: e.path, size: e.size, mtime: e.mtime, kind: 'video' }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true, sensitivity: 'base' }))
        return sendJson(res, 200, { ok: true, parent, subs, videos, danmakus })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    /* 弹幕（B 站 XML）：本地代理取回原始 XML，前端 artplayer-plugin-danmuku 自行 fetch(url) 解析。
       必须带 CORS 头：dev 模式渲染层在 Vite 端口，与本服务跨源。 */
    if (p === '/api/danmaku' && method === 'GET') {
      try {
        const xmlPath = q.get('path') || ''
        if (!isDanmakuName(xmlPath)) throw new Error('不是弹幕文件（仅支持 .xml）')
        const url = await baidu.dlinkForFile(xmlPath)
        const buf = await fetchBuffer(url, { 'User-Agent': DLINK_UA, Accept: '*/*' }, 32 * 1024 * 1024)
        const text = decodeSubtitle(buf)
        const body = Buffer.from(text, 'utf-8')
        res.writeHead(200, {
          'content-type': 'text/xml; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
          ...corsHeaders()
        })
        return res.end(body)
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/subass' && method === 'GET') {
      try {
        const subPath = q.get('path') || ''
        const url = await baidu.dlinkForFile(subPath)
        const buf = await fetchBuffer(url, { 'User-Agent': DLINK_UA, Accept: '*/*' })
        const text = decodeSubtitle(buf)
        // SRT/VTT/SUB/SBV -> 增强 ASS（样式来自设置页“字幕外观”，默认接近 PotPlayer）；真 ASS/SSA 原样透传
        const cfg2 = loadConfig()
        const ass = subtitleToAss(text, extOf(subPath), {
          width: 1920,
          height: 1080,
          fontScale: Number(cfg2.subFontScale) || 0.05,
          outline: Number(cfg2.subOutline) || 1.4,
          shadow: Number(cfg2.subShadow) || 0.6,
          bold: (cfg2.subWeight || 'medium') !== 'normal'
        })
        if (!ass) throw new Error('无法生成增强字幕')
        const body = Buffer.from(applySubWeight(ass, cfg2.subWeight), 'utf-8')
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
          ...corsHeaders()
        })
        return res.end(body)
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/subtitle' && method === 'GET') {
      try {
        const subPath = q.get('path') || ''
        const ext = extOf(subPath)
        if (!SUB_EXTS.includes(ext)) throw new Error('不支持的字幕格式')
        const url = await baidu.dlinkForFile(subPath)
        const buf = await fetchBuffer(url, { 'User-Agent': DLINK_UA, Accept: '*/*' })
        // raw=1：原样透传，交给 ArtPlayer 原生解析（保真 srt/ass）；否则服务端统一转 WebVTT
        if (q.get('raw') === '1') {
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': buf.length,
            'cache-control': 'public, max-age=3600',
            ...corsHeaders()
          })
          return res.end(buf)
        }
        const vtt = subtitleToVtt(buf, ext)
        if (!vtt) throw new Error('字幕内容无法解析')
        const body = Buffer.from(vtt, 'utf-8')
        res.writeHead(200, {
          'content-type': 'text/vtt; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'public, max-age=3600',
          ...corsHeaders()
        })
        return res.end(body)
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    /* ============ ASS 渲染资源（libass-wasm） ============ */
    const LIBASS_FILES = new Set([
      'subtitles-octopus.js',
      'subtitles-octopus-worker.js',
      'subtitles-octopus-worker-legacy.js',
      'subtitles-octopus-worker.wasm'
    ])
    if (p.startsWith('/vendor/libass/') && method === 'GET') {
      const name = decodeURIComponent(p.slice('/vendor/libass/'.length))
      if (!LIBASS_FILES.has(name)) return sendJson(res, 404, { ok: false, error: 'not found' })
      const file = path.join(LIBASS_JS_DIR, name)
      if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'asset missing' })
      const data = fs.readFileSync(file)
      res.writeHead(200, {
        'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        'content-length': data.length,
        'cache-control': 'public, max-age=86400',
        ...corsHeaders()
      })
      return res.end(data)
    }
    // 全局字幕字体（圆角中文字体优先）与完整字库（缺字回退）
    if ((p === '/vendor/fonts/cjk' || p === '/vendor/fonts/yahei') && (method === 'GET' || method === 'HEAD')) {
      const font = p === '/vendor/fonts/yahei' ? wideFontFile() : primaryFontFile()
      if (!font || !fs.existsSync(font)) return sendJson(res, 404, { ok: false, error: 'no font' })
      debugLog('font serve ' + p + ' -> ' + path.basename(font))
      const ext = path.extname(font).toLowerCase()
      res.writeHead(200, {
        'content-type': ext === '.ttf' ? 'font/ttf' : ext === '.otf' ? 'font/otf' : 'font/ttf',
        'content-length': fs.statSync(font).size,
        'cache-control': 'public, max-age=86400',
        ...corsHeaders()
      })
      if (method === 'HEAD') return res.end()
      return fs.createReadStream(font).pipe(res)
    }

    /* ============ 字幕真实格式探测（libass/播放器分流用） ============ */
    if (p === '/api/subtype' && method === 'GET') {      try {
        const subPath = q.get('path') || ''
        const url = await baidu.dlinkForFile(subPath)
        const buf = await fetchBuffer(url, { 'User-Agent': DLINK_UA, Accept: '*/*', Range: 'bytes=0-65535' }, 96 * 1024)
        const text = decodeSubtitle(buf)
        return sendJson(res, 200, { ok: true, path: subPath, ext: extOf(subPath), type: detectSubtitleType(text, extOf(subPath)) })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    /* ============ 内嵌字幕（MKV/MP4 内的字幕轨）：ffprobe 探测 + ffmpeg 抽取 ============ */
    const embedAvailable = () => {
      if (!ffmpegAvailable()) {
        throw new Error('未检测到 ffmpeg（如需内嵌字幕，请在设置页指定 ffmpeg 目录，例如 D:\\ffmpeg-7.1-full_build\\bin）')
      }
    }

    if (p === '/api/embed/probe' && method === 'GET') {
      try {
        embedAvailable()
        const videoPath = q.get('path') || ''
        const port = cfg.port
        const stream = localStreamUrl(port, videoPath)
        const r = await probeEmbeddedSubs(stream)
        return sendJson(res, 200, { ok: true, ...r, videoPath })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/embed/sub' && method === 'GET') {
      try {
        embedAvailable()
        const videoPath = q.get('path') || ''
        const idx = Number(q.get('index'))
        if (!Number.isInteger(idx) || idx < 0) throw new Error('缺少有效的字幕流 index')
        const fmt = q.get('fmt') === 'vtt' ? 'vtt' : 'ass'
        const codec = q.get('codec') || ''
        const stream = localStreamUrl(cfg.port, videoPath)
        const ex = await extractSubtitleText(stream, idx, codec)
        if (!ex.ok) throw new Error(ex.error)
        // 抽取得到 SRT 或 ASS 文本，统一走标准字幕管线
        let out = ''
        let contentType = 'text/plain; charset=utf-8'
        if (ex.isAss) {
          // 原生 ASS：保留样式（libass 直读）；若要 vtt 则降级成文字
          if (fmt === 'vtt') {
            out = subtitleToVtt(Buffer.from(ex.text, 'utf-8'), '.ass')
            contentType = 'text/vtt; charset=utf-8'
          } else {
            out = ex.text
          }
        } else {
          const cfg2 = loadConfig()
          const body = Buffer.from(ex.text, 'utf-8')
          if (fmt === 'vtt') {
            out = subtitleToVtt(body, '.srt')
            contentType = 'text/vtt; charset=utf-8'
          } else {
            out = subtitleToAss(ex.text, '.srt', {
              width: 1920,
              height: 1080,
              fontScale: Number(cfg2.subFontScale) || 0.05,
              outline: Number(cfg2.subOutline) || 1.4,
              shadow: Number(cfg2.subShadow) || 0.6,
              bold: (cfg2.subWeight || 'medium') !== 'normal'
            })
          }
        }
        if (!out) throw new Error('无法生成内嵌字幕（请确认该轨为文本字幕）')
        // 复用：播放器已经抽过的这条字幕轨留一份，OP/ED 检测就不必再拉一遍整集数据
        if (ex.isAss) putAssText(videoPath, idx, ex.text)
        else if (fmt !== 'vtt') putAssText(videoPath, idx, out)
        const body = Buffer.from(applySubWeight(out, cfg2.subWeight), 'utf-8')
        res.writeHead(200, {
          'content-type': contentType,
          'content-length': body.length,
          'cache-control': 'public, max-age=3600',
          ...corsHeaders()
        })
        return res.end(body)
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    /* ============ OP/ED 跳过检测（章节打标 + 字幕信号 + 手动标记） ============ */
    if (p === '/api/skip/probe' && method === 'GET') {
      const pathStr = q.get('path') || ''
      if (!pathStr) return sendJson(res, 400, { ok: false, error: 'missing path' })
      try {
        const r = await skip.probe(pathStr, { refresh: q.get('refresh') === '1' })
        return sendJson(res, 200, r)
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/skip/refine' && method === 'GET') {
      const pathStr = q.get('path') || ''
      if (!pathStr) return sendJson(res, 400, { ok: false, error: 'missing path' })
      try {
        const r = await skip.refine(pathStr, { refresh: q.get('refresh') === '1' })
        return sendJson(res, 200, r)
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/skip/mark' && method === 'POST') {
      try {
        const body = await readBody(req)
        return sendJson(res, 200, skip.setMark(body))
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/skip/mark/clear' && method === 'POST') {
      try {
        const body = await readBody(req)
        return sendJson(res, 200, skip.clearMark(body))
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/skip/marks' && method === 'GET') {
      try {
        return sendJson(res, 200, skip.listMarks(q.get('dir') || ''))
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/skip/cache/clear' && method === 'POST') {
      return sendJson(res, 200, skip.clearCache())
    }

    if (p === '/api/skip/stats' && method === 'GET') {
      return sendJson(res, 200, skip.stats())
    }

    /* ============ 观看历史（记住每个视频上次看到第几秒） ============ */
    if (p === '/api/history' && method === 'GET') {
      try {
        return sendJson(res, 200, { ok: true, entry: getWatchEntry(q.get('path') || '') })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/history' && method === 'POST') {
      try {
        const body = await readBody(req)
        return sendJson(res, 200, { ok: true, entry: setWatchEntry(body.path, body.pos, body.duration) })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    if (p === '/api/history/list' && method === 'GET') {
      try {
        return sendJson(res, 200, { ok: true, items: listWatch(Number(q.get('limit')) || 50) })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message })
      }
    }

    /* ============ 静态 UI ============ */
    if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not found' })
    if (fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) {
      let filePath = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(p === '/' ? '/index.html' : p)))
      if (!filePath.startsWith(RENDERER_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(RENDERER_DIR, 'index.html')
      const data = fs.readFileSync(filePath)
      const hdrs = {
        'content-type': extType(filePath),
        'content-length': data.length,
        ...corsHeaders()
      }
      if (filePath.endsWith('.html')) {
        hdrs['content-security-policy'] =
          "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
          "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:"
      }
      res.writeHead(200, hdrs)
      return res.end(data)
    }
    // 开发模式（dist 未构建）
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>PanBrowser API</title><body style="background:#0e1116;color:#cfe;font-family:system-ui">' +
        '<h3>PanBrowser 本地服务运行中</h3><p>API 可用（/api/status）。UI 需构建 renderer（npm run build）或以 electron-vite dev 加载。</p></body>'
    )
  }

  const server = http.createServer((req, res) => {
    router(req, res).catch((err) => {
      try {
        sendJson(res, 500, { ok: false, error: err.message || String(err) })
      } catch {
        /* ignore */
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(Number(cfg.port) || 16888, cfg.hostBind, () => {
      const addr = server.address()
      resolve({ server, port: addr.port })
    })
  })
}
