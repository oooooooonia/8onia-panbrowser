import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * 观看历史：记住每个视频上次播放到第几秒，下次打开自动续播。
 * 存 userData/watch-history.json —— 落在服务端（主进程）而不是渲染层 localStorage，
 * 这样桌面版、`npm run dev`、以及手机通过局域网访问同一个服务时共享同一份进度。
 */
const MAX_ENTRIES = 3000

function histFile() {
  return path.join(app.getPath('userData'), 'watch-history.json')
}

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(histFile(), 'utf-8').replace(/^\uFEFF/, ''))
    cache = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw : { items: {} }
  } catch {
    cache = { items: {} }
  }
  return cache
}

function persist() {
  try {
    const f = histFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(cache), 'utf-8')
  } catch {
    /* 写不进去也不该影响播放 */
  }
}

/** 超出上限时按「最后观看时间」淘汰最旧的记录 */
function prune(items) {
  const keys = Object.keys(items)
  if (keys.length <= MAX_ENTRIES) return
  keys
    .sort((a, b) => (items[b].at || 0) - (items[a].at || 0))
    .slice(MAX_ENTRIES)
    .forEach((k) => {
      delete items[k]
    })
}

/** 取某个视频的观看记录：{ pos, duration, at } | null */
export function getWatchEntry(p) {
  if (!p) return null
  const it = load().items[String(p)]
  if (!it) return null
  return { pos: Number(it.pos) || 0, duration: Number(it.duration) || 0, at: Number(it.at) || 0 }
}

/**
 * 记录播放位置。pos <= 0 且没有 duration 时视为「删除该条记录」；
 * 前端在「已看到结尾」时会传 pos = 0，这样下次从头开始，而不是续在最后 20 秒。
 */
export function setWatchEntry(p, pos, duration) {
  if (!p) return null
  const items = load().items
  const n = Math.max(0, Number(pos) || 0)
  const d = Math.max(0, Number(duration) || 0)
  if (n <= 0 && !d) delete items[String(p)]
  else items[String(p)] = { pos: n, duration: d, at: Date.now() }
  prune(items)
  persist()
  return getWatchEntry(p)
}

/** 最近观看列表（留给后续「继续观看」入口用） */
export function listWatch(limit = 50) {
  const items = load().items
  return Object.entries(items)
    .map(([p, v]) => ({
      path: p,
      pos: Number(v.pos) || 0,
      duration: Number(v.duration) || 0,
      at: Number(v.at) || 0
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)))
}
