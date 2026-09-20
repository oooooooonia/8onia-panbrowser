/** 本地服务 API 桥：解析 API 基址（dev 走 vite 端口，prod 同源） */
const apiPort = new URLSearchParams(window.location.search).get('apiPort')
export const API =
  apiPort && window.location.port !== apiPort ? `http://127.0.0.1:${apiPort}` : window.location.origin

/** 是否 Electron 桌面版（有 preload 桥）；手机独立版 / 浏览器为 false */
export const isDesktop = typeof window !== 'undefined' && !!window.pan

async function call(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    throw new Error(`服务响应异常（HTTP ${res.status}）`)
  }
  if (json && json.ok === false) throw new Error(json.error || '请求失败')
  return json
}

export const api = {
  status: () => call('/api/status'),
  saveConfig: (patch) => call('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
  testConfig: () => call('/api/config/test', { method: 'POST' }),
  clearConfig: () => call('/api/config/clear', { method: 'POST' }),
  list: (p, order, desc, force) =>
    call(`/api/fs/list?path=${encodeURIComponent(p || '/')}&order=${encodeURIComponent(order || 'name')}&desc=${desc ? '1' : '0'}${force ? '&refresh=1' : ''}`),
  search: (key, dir) => call(`/api/fs/search?key=${encodeURIComponent(key)}&dir=${encodeURIComponent(dir || '/')}`),
  alistScan: (dir) => call('/api/alist/scan', { method: 'POST', body: JSON.stringify({ dir }) }),
  alistImport: (dbPath, id) => call('/api/alist/import', { method: 'POST', body: JSON.stringify({ dbPath, id }) }),
  openPlayer: (p, player, playerPath) =>
    call('/api/player/open', { method: 'POST', body: JSON.stringify({ path: p, player: player || 'potplayer', playerPath: playerPath || '' }) }),
  openPotplayer: (p) => call('/api/player/open', { method: 'POST', body: JSON.stringify({ path: p, player: 'potplayer' }) }),
  detectPlayers: () => call('/api/player/detect'),
  detectPotplayer: () => call('/api/player/detect'),
  ffmpegStatus: () => call('/api/ffmpeg/status'),
  rawlink: (p) => call(`/api/rawlink?path=${encodeURIComponent(p)}`),
  subs: (videoPath) => call(`/api/fs/subs?path=${encodeURIComponent(videoPath)}`),
  subtype: (subPath) => call(`/api/subtype?path=${encodeURIComponent(subPath)}`),
  embedProbe: (videoPath) => call(`/api/embed/probe?path=${encodeURIComponent(videoPath)}`),
  // ---- OP/ED 跳过 ----
  /** 快路径：手动标记 + 章节（打标） */
  skipProbe: (p, refresh) => call(`/api/skip/probe?path=${encodeURIComponent(p)}${refresh ? '&refresh=1' : ''}`),
  /** 慢路径：再叠加字幕信号（只复用播放器已抽好的内嵌字幕，不额外占用带宽） */
  skipRefine: (p, refresh) => call(`/api/skip/refine?path=${encodeURIComponent(p)}${refresh ? '&refresh=1' : ''}`),
  skipMark: (payload) => call('/api/skip/mark', { method: 'POST', body: JSON.stringify(payload) }),
  skipClearMark: (payload) => call('/api/skip/mark/clear', { method: 'POST', body: JSON.stringify(payload) }),
  skipMarks: (dir) => call(`/api/skip/marks?dir=${encodeURIComponent(dir || '')}`),
  skipClearCache: () => call('/api/skip/cache/clear', { method: 'POST' }),
  skipStats: () => call('/api/skip/stats'),
  // ---- 观看历史（记住每个视频上次看到第几秒） ----
  history: (p) => call(`/api/history?path=${encodeURIComponent(p || '')}`),
  saveHistory: (p, pos, duration) =>
    call('/api/history', { method: 'POST', body: JSON.stringify({ path: p, pos, duration }) }),
  historyList: (limit) => call(`/api/history/list?limit=${Number(limit) || 50}`)
}

export const streamUrl = (p) => `${API}/api/stream?path=${encodeURIComponent(p)}`
export const downloadUrl = (p) => `${API}/api/download?path=${encodeURIComponent(p)}`
export const thumbUrl = (p) => `${API}/api/thumb?path=${encodeURIComponent(p)}`
/** 字幕地址：raw=true 原样透传（ArtPlayer/ASS 渲染器解析），否则为服务端转好的 WebVTT */
export const subtitleUrl = (p, raw = true) => `${API}/api/subtitle?path=${encodeURIComponent(p)}${raw ? '&raw=1' : ''}`
/** 增强 ASS 地址（SRT→带样式 ASS / 真 ASS 原样），供 libass 渲染出 PotPlayer 观感 */
export const subassUrl = (p) => `${API}/api/subass?path=${encodeURIComponent(p)}`
/** 内嵌字幕：ffmpeg 从其容器里抽取的某条文本字幕轨，渲染成 ASS（或 VTT）*/
export const embedSubUrl = (videoPath, index, codec, fmt = 'ass') =>
  `${API}/api/embed/sub?path=${encodeURIComponent(videoPath)}&index=${Number(index)}&codec=${encodeURIComponent(codec || '')}&fmt=${fmt}`
/** 弹幕地址：B 站弹幕 XML，交给 artplayer-plugin-danmuku 自行 fetch + 解析（服务端代理 dlink，带 UA） */
export const danmakuUrl = (p) => `${API}/api/danmaku?path=${encodeURIComponent(p)}`
/** libass-wasm(SubtitlesOctopus) 渲染资源（主进程本地服务托管） */
export const libassWorkerUrl = () => `${API}/vendor/libass/subtitles-octopus-worker.js`
export const libassWasmUrl = () => `${API}/vendor/libass/subtitles-octopus-worker.wasm`
export const cjkFontUrl = () => `${API}/vendor/fonts/cjk`
/** 完整字库（微软雅黑）：缺字回退 + ASS 里「微软雅黑」族名的映射 */
export const yaheiFontUrl = () => `${API}/vendor/fonts/yahei`

/** 复制文本到剪贴板 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return true
    } catch {
      return false
    }
  }
}

/** 运行诊断上报：POST 到本地服务 /api/debug/log（App 内会写 debug.log，便于定位字幕/播放问题） */
export function report(msg) {
  try {
    if (typeof msg === 'object') msg = JSON.stringify(msg)
    fetch(`${API}/api/debug/log`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg: String(msg).slice(0, 1200) })
    }).catch(() => {})
  } catch { /* ignore */ }
}

let reportQueue = []
let reportTimer = null
export function reportThrottled(msg) {
  reportQueue.push(String(msg).slice(0, 1200))
  if (reportTimer) return
  reportTimer = setTimeout(() => {
    const batch = reportQueue.splice(0)
    reportTimer = null
    try {
      fetch(`${API}/api/debug/log`, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg: batch.join(' || ') })
      }).catch(() => {})
    } catch { /* ignore */ }
  }, 1500)
}
