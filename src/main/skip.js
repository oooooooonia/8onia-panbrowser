/**
 * OP/ED 跳过检测服务：编排「手动标记 → 章节(打标) → 字幕信号」三层数据源，
 * 负责缓存（磁盘 + 内存）与手动标记持久化。
 *
 * 分层与优先级（高 → 低）：
 *   1. manual            播放器里手动标记，100% 可靠，按剧集复用
 *   2. chapter           章节有明确命名（OP/NCOP/ED/NCED/Intro/Preview…）
 *   3. chapter-heuristic 章节名无信息时按「时长 60~130s + 位置」推断
 *   4. subtitle          ASS 样式名/歌词块、外挂字幕跨集重复文本
 *
 * 设计取舍：快路径（章节）秒级返回，字幕信号耗时较长（内嵌轨要抽窗口，1GB ≈ 15~40s），
 * 因此拆成 /api/skip/probe（快）与 /api/skip/refine（慢，后台补强），结果落盘缓存。
 */
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { loadConfig } from './config.js'
import { SUB_EXTS, extOf, isSubtitleName, decodeSubtitle } from './subtitles.js'
import { localStreamUrl, probeChapters, probeDuration } from './media.js'
import { getAnyAssText } from './asscache.js'
import { segmentsFromChapters } from './chapters.js'
import { analyzeAss, analyzeSharedText, parseSrt } from './subsig.js'

const SUB_TIMEOUT = 6 * 60 * 1000 // 字幕信号（外挂字幕读取）总预算
const CONFIDENT = 0.55 // 章节已给出该类型且置信度 ≥ 此值 → 无需字幕补强（标注 0.9+/唯一推断 0.65+）

function dataFile(name) {
  return path.join(app.getPath('userData'), name)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')) || fallback
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
  } catch {
    /* ignore */
  }
}

function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function createSkipService({ baidu, port }) {
  const cacheFile = dataFile('skip-cache.json')
  const marksFile = dataFile('skip-marks.json')
  let cache = readJson(cacheFile, {})
  let marks = readJson(marksFile, {})
  let cacheDirty = false
  let flushTimer = null

  const scheduleFlush = () => {
    cacheDirty = true
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (!cacheDirty) return
      cacheDirty = false
      writeJson(cacheFile, cache)
    }, 1500)
  }

  const streamFor = (filePath) => localStreamUrl(port, filePath)
  const seriesDir = (filePath) => {
    const i = String(filePath).lastIndexOf('/')
    return i > 0 ? String(filePath).slice(0, i) : '/'
  }
  const fileName = (filePath) => String(filePath).slice(String(filePath).lastIndexOf('/') + 1)

  function fileKey(file, filePath) {
    if (file && file.fsId) return `i${file.fsId}:${file.size || 0}:${file.mtime || 0}`
    return `p${filePath}`
  }

  /** 手动标记：文件级 > 剧集级 */
  function resolveMarks(filePath) {
    const dir = seriesDir(filePath)
    const series = marks[dir] || {}
    const perFile = (series.files && series.files[fileName(filePath)]) || {}
    const out = {}
    for (const t of ['op', 'ed']) {
      const m = perFile[t] || series[t]
      if (m && Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start) {
        out[t] = { start: m.start, end: m.end, scope: perFile[t] ? 'file' : 'series' }
      }
    }
    return out
  }

  /** 合并三层结果：手动 > 章节 > 字幕（同类型只保留一个） */
  function merge(chapterSegs, subSegs, mk) {
    const best = new Map()
    const consider = (seg, force) => {
      if (!seg || !seg.type) return
      const cur = best.get(seg.type)
      if (force || !cur || (seg.confidence || 0) > (cur.confidence || 0)) best.set(seg.type, seg)
    }
    for (const s of subSegs || []) consider(s)
    for (const s of chapterSegs || []) consider(s)
    if (mk && mk.op) consider({ type: 'op', start: mk.op.start, end: mk.op.end, title: '手动标记', source: 'manual', confidence: 1, scope: mk.op.scope }, true)
    if (mk && mk.ed) consider({ type: 'ed', start: mk.ed.start, end: mk.ed.end, title: '手动标记', source: 'manual', confidence: 1, scope: mk.ed.scope }, true)
    return [...best.values()].sort((a, b) => a.start - b.start)
  }

  function payload(filePath, entry, extra = {}) {
    const mk = resolveMarks(filePath)
    const segments = merge(entry.chapterSegments, entry.subSegments, mk)
    return {
      ok: true,
      path: filePath,
      seriesDir: seriesDir(filePath),
      duration: entry.duration || 0,
      chapters: entry.chapters || [],
      segments,
      candidates: [...(entry.chapterCandidates || []), ...(entry.subCandidates || [])],
      hints: [...(entry.chapterHints || []), ...(entry.subHints || [])],
      marks: mk,
      subAnalyzed: !!entry.subDone,
      subError: entry.subError || '',
      subSkipped: entry.subSkipped || '',
      subPending: !!entry.subPending,
      subHint: entry.subHint || '',
      sources: [...new Set(segments.map((s) => s.source))],
      ...extra
    }
  }

  /** 快路径：章节（带缓存） */
  async function loadChapters(filePath, { refresh = false } = {}) {
    const useChapters = loadConfig().skipUseChapters !== false
    const file = await baidu.findFile(filePath).catch(() => null)
    const key = fileKey(file, filePath)
    let entry = !refresh ? cache[key] : null
    if (entry && entry.chapters && entry.usedChapters === useChapters) return { key, entry }

    const stream = streamFor(filePath)
    let duration = 0
    let chapters = []
    let chapterError = ''
    if (useChapters) {
      try {
        const r = await probeChapters(stream)
        if (r.ok) {
          chapters = r.chapters
          duration = r.duration
        } else {
          chapterError = r.error || '读取章节失败'
        }
      } catch (e) {
        chapterError = e.message || String(e)
      }
    }
    if (!duration) {
      try {
        duration = await probeDuration(stream)
      } catch {
        /* ignore */
      }
    }
    const { segments, candidates, hints } = segmentsFromChapters(chapters, duration)
    const prevUsed = entry ? entry.usedChapters : undefined
    const prevSubDone = entry ? !!entry.subDone : false
    entry = {
      ...(entry || {}),
      at: Date.now(),
      path: filePath,
      duration,
      chapters,
      usedChapters: useChapters,
      chapterSegments: segments,
      chapterCandidates: candidates,
      chapterHints: useChapters ? hints : ['章节检测已在设置中关闭'],
      chapterError
    }
    // 章节开关变化会影响「字幕是否还需要补强」，让字幕信号重新计算
    if (prevSubDone && prevUsed !== useChapters) {
      entry.subDone = false
      entry.subSegments = []
      entry.subCandidates = []
      entry.subHints = []
      entry.subError = ''
      entry.subSkipped = ''
    }
    cache[key] = entry
    scheduleFlush()
    return { key, entry }
  }

  /** 慢路径：字幕信号（窗口抽取内嵌 ASS / 读外挂字幕 + 跨集重复文本） */
  async function loadSubtitleSignal(filePath, key, entry) {
    if (entry.subDone) return entry
    const cfg = loadConfig()
    if (!cfg.skipUseSubtitles) {
      entry.subDone = true
      entry.subError = '字幕检测已在设置中关闭'
      return entry
    }
    // 章节已高置信度给出 OP/ED 时不必再抽字幕（省掉几十秒到几分钟的下载）
    const chapterSegs = entry.chapterSegments || []
    const solid = (t) => chapterSegs.some((s) => s.type === t && (s.confidence || 0) >= CONFIDENT)
    const needOp = !solid('op')
    const needEd = !solid('ed')
    if (!needOp && !needEd) {
      entry.subDone = true
      entry.subSegments = []
      entry.subCandidates = []
      entry.subHints = []
      entry.subError = ''
      entry.subSkipped = '章节已明确标注 OP/ED'
      cache[key] = entry
      scheduleFlush()
      return entry
    }

    const deadline = Date.now() + SUB_TIMEOUT
    const duration = entry.duration || 0
    const collected = []
    const hints = []
    let error = ''

    // 1) 同目录外挂字幕
    let parentSubs = []
    try {
      const dir = seriesDir(filePath)
      const entries = await baidu.listDir(dir, {})
      const base = fileName(filePath).replace(/\.[^.]+$/, '').toLowerCase()
      parentSubs = entries
        .filter((e) => !e.isDir && isSubtitleName(e.name))
        .map((e) => ({ ...e, ext: extOf(e.name) }))
      parentSubs.sort((a, b) => {
        const sa = String(a.name).toLowerCase().startsWith(base + '.') ? 0 : 1
        const sb = String(b.name).toLowerCase().startsWith(base + '.') ? 0 : 1
        return sa - sb
      })
    } catch (e) {
      hints.push('读取同目录字幕列表失败：' + (e.message || e))
    }

    const assSubs = parentSubs.filter((s) => s.ext === '.ass' || s.ext === '.ssa')
    const textSubs = parentSubs.filter((s) => SUB_EXTS.includes(s.ext))

    // 1a) 外挂 ASS：样式名 → 歌词块
    for (const s of assSubs.slice(0, 2)) {
      if (Date.now() > deadline) break
      try {
        const url = await baidu.dlinkForFile(s.path)
        const text = await fetchText(url)
        const r = analyzeAss(text, { duration, offset: 0 })
        collected.push(...r.segments)
        hints.push(...r.hints)
      } catch (e) {
        hints.push(`外挂字幕「${s.name}」解析失败：${(e.message || e).toString().slice(0, 120)}`)
      }
    }

    // 1b) 外挂 SRT/SBV：跨集重复文本
    if (!collected.some((s) => s.type === 'op' || s.type === 'ed') && textSubs.length && Date.now() < deadline) {
      try {
        const fetched = []
        for (const s of textSubs.slice(0, 4)) {
          if (Date.now() > deadline) break
          const url = await baidu.dlinkForFile(s.path)
          fetched.push({ events: parseSrt(await fetchText(url)), offset: 0, name: s.name })
        }
        if (fetched.length >= 2) {
          const r = analyzeSharedText(fetched, { duration, minFiles: 2 })
          collected.push(...r.segments)
        }
      } catch (e) {
        hints.push('跨集字幕比对失败：' + (e.message || e).toString().slice(0, 120))
      }
    }

    // 2) 内嵌字幕：复用「播放器为显示字幕而已经抽好的」ASS 文本（零额外带宽）。
    //    绝不在这里主动抽取——那会在同一条百度直链上和字幕显示抢带宽，导致字幕加载不出来。
    const stillNeed = () => (needOp && !collected.some((s) => s.type === 'op')) || (needEd && !collected.some((s) => s.type === 'ed'))
    if (stillNeed()) {
      for (const c of getAnyAssText(filePath)) {
        const r = analyzeAss(c.text, { duration })
        if (r.segments.length) {
          collected.push(...r.segments)
          hints.push(...r.hints)
        }
      }
    }

    entry.subSegments = dedupe(collected)
    entry.subCandidates = entry.subSegments
    entry.subHints = [...new Set(hints)].slice(0, 6)
    entry.subError = error
    // 还没拿到内嵌字幕文本时不算「已完成」，播放器抽好字幕后再问一次即可补上（零成本）
    entry.subPending = stillNeed()
    if (entry.subPending) entry.subHint = '内嵌字幕还在加载（首次需完整抽取字幕轨），加载完成后会自动补检'
    else entry.subHint = ''
    entry.subDone = !entry.subPending
    entry.subAt = Date.now()
    cache[key] = entry
    scheduleFlush()
    return entry
  }

  async function fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'pan.baidu.com', Accept: '*/*' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 12 * 1024 * 1024) throw new Error('字幕文件过大')
    return decodeSubtitle(buf)
  }

  return {
    /** 快路径 */
    async probe(filePath, { refresh = false } = {}) {
      const { entry } = await loadChapters(filePath, { refresh })
      return payload(filePath, entry)
    },

    /** 慢路径（字幕信号：只复用已抽取的字幕，绝不自己跑 ffmpeg，避免拖慢字幕显示） */
    async refine(filePath, { refresh = false } = {}) {
      const { key, entry } = await loadChapters(filePath, { refresh })
      const merged = await loadSubtitleSignal(filePath, key, entry)
      return payload(filePath, merged)
    },

    /** 保存手动标记。scope=series 时同时作用于同目录其它集 */
    setMark({ path: filePath, type, start, end, scope = 'file' }) {
      if (!filePath) throw new Error('缺少 path')
      if (type !== 'op' && type !== 'ed') throw new Error('type 只能是 op 或 ed')
      const s = Number(start)
      const e = Number(end)
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error('时间区间无效（end 必须大于 start）')
      const dir = seriesDir(filePath)
      const box = (marks[dir] = marks[dir] || {})
      if (scope === 'series') {
        box[type] = { start: s, end: e, at: Date.now() }
      } else {
        box.files = box.files || {}
        const f = (box.files[fileName(filePath)] = box.files[fileName(filePath)] || {})
        f[type] = { start: s, end: e, at: Date.now() }
      }
      writeJson(marksFile, marks)
      return { ok: true, marks: resolveMarks(filePath) }
    },

    clearMark({ path: filePath, type, scope = 'file' }) {
      const dir = seriesDir(filePath)
      const box = marks[dir]
      if (box) {
        if (scope === 'series') {
          delete box[type]
        } else if (box.files && box.files[fileName(filePath)]) {
          const f = box.files[fileName(filePath)]
          delete f[type]
          if (!f.op && !f.ed) delete box.files[fileName(filePath)]
        }
        if (!box.op && !box.ed && (!box.files || !Object.keys(box.files).length)) delete marks[dir]
        writeJson(marksFile, marks)
      }
      return { ok: true, marks: resolveMarks(filePath) }
    },

    /** 列出某目录（或全部）的标记 */
    listMarks(dir) {
      const out = []
      for (const [d, box] of Object.entries(marks)) {
        if (dir && d !== dir) continue
        if (box.op || box.ed) {
          out.push({ seriesDir: d, scope: 'series', op: box.op || null, ed: box.ed || null })
        }
        for (const [f, m] of Object.entries(box.files || {})) {
          if (!m.op && !m.ed) continue
          out.push({ seriesDir: d, scope: 'file', file: f, op: m.op || null, ed: m.ed || null })
        }
      }
      return { ok: true, marks: out }
    },

    clearCache() {
      cache = {}
      cacheDirty = false
      writeJson(cacheFile, cache)
      return { ok: true }
    },

    stats() {
      const keys = Object.keys(cache)
      return {
        ok: true,
        cachedFiles: keys.length,
        subAnalyzed: keys.filter((k) => cache[k].subDone).length,
        markedSeries: Object.keys(marks).length
      }
    }
  }
}

function dedupe(list) {
  const best = new Map()
  for (const s of list) {
    if (!s || !s.type) continue
    const cur = best.get(s.type)
    if (!cur || (s.confidence || 0) > (cur.confidence || 0) || ((s.confidence || 0) === (cur.confidence || 0) && s.end - s.start > cur.end - cur.start)) {
      best.set(s.type, s)
    }
  }
  return [...best.values()].sort((a, b) => a.start - b.start)
}
