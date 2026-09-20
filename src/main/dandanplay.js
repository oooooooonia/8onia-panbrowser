import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'

/**
 * 弹弹play 开放弹幕网络：文件识别 → 加载弹幕。
 *
 * 认证：签名模式 X-Signature = base64(sha256(AppId + Timestamp + Path + AppSecret))
 * 流程：POST /api/v2/match（传文件名/占位 hash/大小）→ 候选列表 → 选一个 episodeId
 *       → GET /api/v2/comment/{episodeId}?withRelated=true（JSON）→ 转成 B 站 XML 给播放器
 *
 * 结果按视频路径缓存（episodeId），XML 再按 episodeId 缓存，避免重复请求。
 * 注意：不落盘 appSecret，配置里存的是用户在设置页填的明文（与百度凭证同一份 config.json）。
 */
const BASE = 'https://api.dandanplay.net'
const MATCH_PATH = '/api/v2/match'
const TIMEOUT_MS = 15000
const FAKE_HASH = '00000000000000000000000000000000' // 服务端要求 32 位 MD5 形状；我们不下载文件算真 hash

/** 转 XML 的格式版本：改了转换逻辑就 +1，让磁盘上的旧缓存自动失效（例如 p 从 4 段改 8 段那次） */
const XML_VER = 2
/** 识别/打分逻辑版本：改了打分就 +1，让磁盘上旧的 episodeId 映射自动失效重新识别 */
const PICK_VER = 2
const DEFAULT_SIZE = 1073741824

/** 弹幕 XML 缓存目录（识别/下载过一集就落盘，之后直接读本地） */
export function danmakuDir() {
  return path.join(app.getPath('userData'), 'danmaku')
}

/** 每条视频一个 xml：<videoPath 的 md5 前 10 位>_<集名>.xml（文件名可读，便于缓存管理里辨认） */
export function danmakuCacheFile(videoPath) {
  const h = crypto.createHash('md5').update(String(videoPath)).digest('hex').slice(0, 10)
  const base = String(videoPath || '').split('/').pop() || 'danmaku'
  const clean = base.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5().\[\]-]/g, '_').slice(0, 90)
  return path.join(danmakuDir(), h + '_' + clean + '.xml')
}

/** 数一数 xml 里的弹幕条数 */
export function countDanmaku(xml) {
  return (String(xml || '').match(/<d p=/g) || []).length
}

function cacheFile() {
  return path.join(app.getPath('userData'), 'danmaku-match.json')
}

let store = null
function load() {
  if (store) return store
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8').replace(/^\uFEFF/, ''))
    store = raw && typeof raw === 'object' && raw.items ? raw : { items: {}, xml: {} }
  } catch {
    store = { items: {}, xml: {} }
  }
  if (!store.items) store.items = {}
  if (!store.xml) store.xml = {}
  return store
}

function persist() {
  try {
    const f = cacheFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(store), 'utf-8')
  } catch {
    /* 缓存写不进去不影响播放 */
  }
}

export function ddpReady(cfg) {
  return !!(cfg && cfg.ddpEnabled !== false && cfg.ddpAppId && cfg.ddpAppSecret)
}

function signHeaders(cfg, apiPath) {
  const ts = Math.floor(Date.now() / 1000)
  // 文档明确：签名用的 Path 不含 ? 后面的查询参数（带上会 403）
  const pathOnly = String(apiPath).split('?')[0]
  const sig = crypto.createHash('sha256').update(cfg.ddpAppId + ts + pathOnly + cfg.ddpAppSecret).digest('base64')
  return {
    'X-AppId': cfg.ddpAppId,
    'X-Timestamp': String(ts),
    'X-Signature': sig,
    Accept: 'application/json',
    'User-Agent': 'PanBrowser/0.1'
  }
}

async function request(cfg, apiPath, init = {}) {
  const res = await fetch(BASE + apiPath, {
    ...init,
    headers: { ...signHeaders(cfg, apiPath), ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (json && json.errorMessage ? json.errorMessage : text.slice(0, 120)))
  if (json && json.success === false) throw new Error('errno ' + json.errorCode + ' ' + (json.errorMessage || ''))
  return json
}

/** 文件名里的季号提示：第二季/第2季/S02/2nd Season → 2；没写 → 1 */
function hintSeason(...texts) {
  const s = texts.filter(Boolean).join(' ')
  const cn = s.match(/第\s*([0-9一二三四五六七八九十])\s*季/)
  const cnMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  if (cn) return cnMap[cn[1]] || Number(cn[1]) || 1
  const sn = s.match(/\bS([0-9]{1,2})\b/i)
  if (sn) return Number(sn[1]) || 1
  const nd = s.match(/\b([0-9]{1,2})(?:nd|rd|th|st)\s+season/i)
  if (nd) return Number(nd[1]) || 1
  if (/\bII\b/.test(s) || /第二季/.test(s)) return 2
  if (/\bIII\b/.test(s)) return 3
  return 1
}

function titleSeason(title) {
  return hintSeason(String(title || ''))
}

/**
 * 从候选里挑最可能的一条：
 *  1) 优先 TV 动画（OVA/OAD/剧场版等排后）
 *  2) 与「目录/文件名」里的季号线索一致
 *  3) 季度相同时取季号小的（animeId 越小 = 越早的作品 = 通常是第一季）
 *  4) 尽量保持服务端返回的顺序
 */
export function pickBest(matches, ...hintTexts) {
  const list = Array.isArray(matches) ? matches : []
  if (!list.length) return null
  const want = hintSeason(...hintTexts)
  // 归一化标题：去空格、统一中英标点，便于比较「本体」和「本体+后缀（第二季/爆炎/剧场版…）」
  const normTitle = (t) =>
    String(t || '')
      .replace(/\s+/g, '')
      .replace(/[!！]/g, '!')
      .replace(/[：:・~～\-.。]/g, '')
  // 「本体标题」推断：取最相关前 8 条里「多数派共享」的最长前缀。
  // 不能用全部候选的公共前缀——同 IP 的番外会把它截短：
  // 素晴的候选是「为美好的世界献上祝福! OAD / 第二季 / 第三季 / 爆炎！/ 本体 / 红传说…」，
  // 其中「爆炎！」只共享到「为美好的世界献上」，会把前缀砍成 8 个字；而 7/8 条共享的是
  // 「为美好的世界献上祝福!」——这正是本体第一季的名字。
  let base = ''
  if (want === 1) {
    const top = list.slice(0, 8).map((m) => normTitle(m.animeTitle)).filter(Boolean)
    if (top.length) {
      const full = top[0]
      const need = Math.max(2, Math.ceil(top.length / 2))
      for (let L = full.length; L >= 3; L--) {
        const pre = full.slice(0, L)
        if (top.filter((t) => t.startsWith(pre)).length >= need) {
          base = pre
          break
        }
      }
    }
  }
  const hasBase = base.length >= 3
  const scored = list.map((m, i) => {
    const typeText = String(m.type || '') + ' ' + String(m.typeDescription || '')
    const isTv = /tvseries|TV动画|网络放送/i.test(typeText)
    const ts = titleSeason(m.animeTitle)
    // tier：3 = 最贴合（TV 且季号与线索一致）｜2 = 其它 TV｜1 = OVA/剧场版等
    let tier = 1
    if (isTv) tier = want > 1 ? (ts === want ? 3 : 2) : ts === 1 ? 3 : 2
    // 线索没写季号时，优先「标题恰好等于本体前缀」的那条
    const isBase = hasBase && normTitle(m.animeTitle) === base ? 0 : 1
    return { m, i, tier, isBase }
  })
  scored.sort((a, b) => b.tier - a.tier || a.isBase - b.isBase || a.i - b.i)
  return scored[0].m
}

export async function matchFile(cfg, { fileName, fileSize }) {
  const body = {
    fileName: String(fileName || ''),
    fileHash: FAKE_HASH,
    fileSize: Number(fileSize) > 0 ? Number(fileSize) : DEFAULT_SIZE,
    videoDuration: 0
  }
  const json = await request(cfg, MATCH_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const matches = (json && json.matches) || []
  return { isMatched: !!(json && json.isMatched), matches }
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * dandanplay 的 comment JSON → B 站 XML。
 *
 * 重要：dandanplay 的 p 只有 4 段（time,mode,color,uid），而 artplayer-plugin-danmuku 的解析器
 * 里有硬性判断 `if (attr.length >= 8)`，段数不足会把**整条弹幕丢掉**（表现就是「一条都不飘」）。
 * 所以这里必须补成标准 8 段：time,mode,fontSize,color,timestamp,pool,uid,rowId。
 */
export const BILI_MIN_FIELDS = 8
export function jsonToBiliXml(json, fontSize = 25) {
  const list = (json && json.comments) || []
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<i>']
  for (const c of list) {
    const text = c && c.m
    if (!text) continue
    const a = String(c.p || '').split(',')
    const time = Number(a[0]) || 0
    const mode = Number(a[1]) || 1
    const color = Number(a[2]) || 16777215
    const uid = parseInt(a[3], 16) || 0
    const p = [time.toFixed(2), mode, fontSize, color, 0, 0, uid, 0].join(',')
    out.push('<d p="' + p + '">' + escXml(text) + '</d>')
  }
  out.push('</i>')
  return out.join('\n')
}

/**
 * 为某条视频取弹幕 XML（优先用缓存里的 episodeId，没有就重新识别）。
 * hintPath/hintName 都会传给识别接口（带目录名命中率更高）。
 */
export async function danmakuXmlFor(cfg, { videoPath, hintName, fileSize }) {
  if (!ddpReady(cfg)) throw new Error('弹弹play 未启用或未配置 AppId/AppSecret')
  const st = load()
  // 转换格式变了就作废旧的内存/磁盘 xml 缓存
  if (st.ver !== XML_VER) {
    st.ver = XML_VER
    st.xml = {}
    persist()
  }
  // 打分逻辑改了 → 旧的「视频→episodeId」映射可能选错（例如早先把素晴本体判成了爆炎），一并作废重识别
  if (st.pickVer !== PICK_VER) {
    st.pickVer = PICK_VER
    st.items = {}
    st.xml = {}
    persist()
  }
  const key = String(videoPath || '')
  let ent = st.items[key]
  let match = null
  if (ent && ent.episodeId) {
    match = { episodeId: ent.episodeId, animeTitle: ent.animeTitle, episodeTitle: ent.episodeTitle, fromCache: true }
  } else {
    // 传完整网盘路径（服务端会拆出番剧名），命中率比只传文件名高很多
    const probe = hintName && String(hintName).includes('/') ? hintName : key
    const { matches } = await matchFile(cfg, { fileName: probe, fileSize })
    match = pickBest(matches, probe, hintName)
    if (!match) throw new Error('弹弹play 未识别出该文件（文件名里缺少番剧名时请带上级目录）')
    match = { ...match, fromCache: false }
    st.items[key] = {
      episodeId: match.episodeId,
      animeId: match.animeId,
      animeTitle: match.animeTitle,
      episodeTitle: match.episodeTitle,
      type: match.type,
      at: Date.now()
    }
    persist()
  }
  if (st.xml[match.episodeId]) {
    return { xml: st.xml[match.episodeId], match: { ...match, fromXmlCache: true } }
  }
  const json = await request(cfg, '/api/v2/comment/' + match.episodeId + '?withRelated=true')
  const xml = jsonToBiliXml(json)
  const cnt = countDanmaku(xml)
  // 落盘：识别并下载完这一集后就把弹幕存成 xml，之后（含设置页缓存管理）直接用本地文件
  let xmlFile = null
  try {
    xmlFile = danmakuCacheFile(videoPath)
    fs.mkdirSync(danmakuDir(), { recursive: true })
    fs.writeFileSync(xmlFile, xml, 'utf-8')
  } catch {
    xmlFile = null
  }
  st.items[key] = { ...(st.items[key] || {}), count: cnt, xmlFile, size: Buffer.byteLength(xml), at: Date.now() }
  persist()
  if (xml.length < 40) throw new Error('弹弹play 未返回弹幕（该节目可能没有弹幕）')
  st.xml[match.episodeId] = xml
  if (cnt > 0) match = { ...match, count: cnt }
  persist()
  return { xml, match: { ...match, count: (json && json.count) || 0 } }
}

/**
 * 手动指定某一集（把候选列表里选中的 episodeId 记下来并缓存其弹幕 xml）。
 * 「同目录没有 xml 时由用户手动选」这条路径用它；选完就等同自动识别过。
 */
export async function pickEpisode(cfg, { videoPath, episodeId, animeTitle, episodeTitle, type, hintName, fileSize }) {
  const id = Number(episodeId)
  if (!id) throw new Error('缺少 episodeId')
  const st = load()
  st.pickVer = PICK_VER
  st.items[String(videoPath || '')] = {
    episodeId: id,
    animeTitle: animeTitle || '',
    episodeTitle: episodeTitle || '',
    type: type || '',
    at: Date.now()
  }
  persist()
  // 按新映射取弹幕（会落盘成 xml 并写入条数）
  return danmakuXmlFor(cfg, { videoPath, hintName, fileSize })
}

/** 只做识别（给设置页/调试用）：返回候选列表与推荐项 */
export async function probeMatch(cfg, { fileName, fileSize }) {
  const { isMatched, matches } = await matchFile(cfg, { fileName, fileSize })
  const best = pickBest(matches, fileName)
  return {
    isMatched,
    total: matches.length,
    best: best
      ? { episodeId: best.episodeId, animeTitle: best.animeTitle, episodeTitle: best.episodeTitle, type: best.typeDescription || best.type }
      : null,
    candidates: matches.slice(0, 20).map((m) => ({
      episodeId: m.episodeId,
      animeTitle: m.animeTitle,
      episodeTitle: m.episodeTitle,
      type: m.typeDescription || m.type,
      shift: m.shift
    }))
  }
}


/** 弹幕缓存清单（合并索引与磁盘实际文件），给设置页用 */
export function danmakuCacheList() {
  const st2 = load()
  const byFile = new Map(
    Object.entries(st2.items)
      .filter(([, v]) => v && v.xmlFile)
      .map(([k, v]) => [v.xmlFile, { videoPath: k, count: v.count || 0 }])
  )
  const out = { dir: danmakuDir(), total: 0, size: 0, items: [] }
  let files = []
  try {
    files = fs.readdirSync(danmakuDir()).filter((f) => f.toLowerCase().endsWith('.xml'))
  } catch {
    files = []
  }
  for (const f of files) {
    const full = path.join(danmakuDir(), f)
    let size = 0
    let at = 0
    try {
      const stt = fs.statSync(full)
      size = stt.size
      at = stt.mtimeMs
    } catch {
      /* ignore */
    }
    const meta = byFile.get(full) || {}
    out.items.push({ file: f, path: full, size, at, videoPath: meta.videoPath || '', count: meta.count || 0 })
    out.size += size
  }
  out.items.sort((a, b) => (b.at || 0) - (a.at || 0))
  out.total = out.items.length
  return out
}

/** 清空弹幕缓存（磁盘文件 + 索引里的 xml 正文） */
export function clearDanmakuCache() {
  let n = 0
  try {
    for (const f of fs.readdirSync(danmakuDir())) {
      try {
        fs.unlinkSync(path.join(danmakuDir(), f))
        n++
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  const st2 = load()
  st2.xml = {}
  st2.items = {}
  persist()
  return { ok: true, removed: n, clearedMap: true }
}

/** 把已下载的弹幕 xml 记进缓存（写文件 + 记条数）；网盘同目录的 xml 走这条 */
export function bookCachedDanmaku(videoPath, xml) {
  const text = String(xml || '')
  const cnt = countDanmaku(text)
  let xmlFile = null
  try {
    xmlFile = danmakuCacheFile(videoPath)
    fs.mkdirSync(danmakuDir(), { recursive: true })
    fs.writeFileSync(xmlFile, text, 'utf-8')
  } catch {
    xmlFile = null
  }
  const st = load()
  st.items[String(videoPath)] = {
    ...(st.items[String(videoPath)] || {}),
    count: cnt,
    xmlFile,
    size: Buffer.byteLength(text),
    at: Date.now()
  }
  persist()
  return { count: cnt, xmlFile }
}

/** 已缓存的识别结果（chip/设置页展示用）：没有就返回 null，不打 API */
export function cachedMatchInfo(videoPath) {
  const st = load()
  const e = st.items[String(videoPath || '')]
  if (!e || !e.episodeId) return null
  return {
    episodeId: e.episodeId,
    animeId: e.animeId,
    animeTitle: e.animeTitle,
    episodeTitle: e.episodeTitle,
    type: e.type,
    count: e.count || 0,
    at: e.at || 0
  }
}

/** 该视频已缓存的弹幕条数（0 = 没缓存过） */
export function cachedDanmakuCount(videoPath) {
  const st2 = load()
  const e = st2.items[String(videoPath || '')]
  return (e && e.count) || 0
}
export function clearDdpCache() {
  store = { items: {}, xml: {} }
  try {
    fs.unlinkSync(cacheFile())
  } catch {
    /* ignore */
  }
}
