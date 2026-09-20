import { useState, useEffect, useRef, useCallback } from 'react'
import Artplayer from 'artplayer'
import artplayerPluginDanmuku from 'artplayer-plugin-danmuku'
import SubtitlesOctopusModule from 'libass-wasm'
import {
  X, Download, MonitorPlay, Link2, Copy, CircleAlert, File as FileIcon, Check, Captions, Loader2, ListVideo,
  SkipForward, Scissors, RotateCcw, Tag, MessageSquareText
} from 'lucide-react'
import { useApp, flushDanmakuSave } from '../store/app'
import {
  streamUrl, downloadUrl, copyText, api, subtitleUrl, subassUrl, embedSubUrl, danmakuUrl,
  libassWorkerUrl, libassWasmUrl, cjkFontUrl, yaheiFontUrl, isDesktop, report
} from '../lib/api'
import { formatSize, formatClock } from '../lib/format'

const SUB_LABEL = { ass: 'ASS', ssa: 'SSA', srt: 'SRT', vtt: 'VTT', sub: 'SUB', sbv: 'SBV' }
const KIND_LABEL = {
  ass: 'ASS·libass',
  ssa: 'ASS·libass',
  srt: 'SRT·libass',
  vtt: 'VTT·libass',
  sub: 'SUB·libass',
  sbv: 'SBV·libass',
  embed: '内嵌·libass'
}

/* OP/ED 跳过：分段类型元信息 */
const SEG_META = {
  op: { label: 'OP', name: '片头', cls: 'op' },
  ed: { label: 'ED', name: '片尾', cls: 'ed' },
  recap: { label: '回顾', name: '前情提要', cls: 'recap' },
  preview: { label: '预告', name: '下集预告', cls: 'preview' }
}
const SOURCE_NAME = {
  manual: '手动标记',
  chapter: '章节',
  'chapter-heuristic': '章节推断',
  subtitle: '字幕',
  'subtitle-shared': '字幕·跨集'
}

/** 分段唯一键（本次播放内用于「已跳过」判定） */
function segKey(s) {
  return `${s.type}|${Math.round(Number(s.start) || 0)}`
}

/* ---- 外挂字幕自动选择：文件名归一 + 语言/格式评分 ---- */
// 常见编码/画质/来源噪声标签（如 [x265_flac_aac]、[Ma10p_1080p]、[BDRIP]），剥离后字幕名才能与视频名对齐
const SUB_NOISE_RE =
  /\[(?:ma10p|10bit|8bit|h\.?26[45]|hevc|avc|x26[45]|av1|aac|flac|ac3|e?ac3|truehd|dts[-h]*(?:ma)?|opus|5\.1|2\.0|1080p|720p|2160p|4k|bdrip|bd|web[- ]?dl|web|nc(?:op|ed)|chs|cht|sc|tc|简|繁|jp|jpn|eng|v\d|r18)[^\]]*\]/gi

function normSubKey(name) {
  let s = String(name || '').replace(/\.[^.]+$/, '').toLowerCase()
  s = s.replace(SUB_NOISE_RE, '')
  s = s.replace(/[()\[\]（）【】\s._\-+!~…':：,，。!?]/g, '')
  // 语言后缀：..sc / ..chs / ..zh 等（剥离后同片名不同语言才能匹配上）
  s = s.replace(/(?:sc|tc|chs|cht|zh[a-z]*|jp[a-z]*|eng?|gb|big5|简|繁)$/, '')
  return s
}

/** 简中优先，繁中次之，其它最后 */
function subLangScore(name) {
  const s = String(name || '')
  if (/\.(?:sc|chs)\.|简|zh-(?:cn|hans)|zhs|zhcn/i.test(s)) return 0
  if (/\.(?:tc|cht)\.|繁|zh-(?:tw|hant)|zht|zhtw/i.test(s)) return 2
  return 1
}

/** 从检测结果生成手动标记草稿（已有标记优先，其次自动检测值） */
function draftFrom(r) {
  const pick = (t) => {
    const m = r && r.marks && r.marks[t]
    if (m) return { start: String(Math.round(m.start * 10) / 10), end: String(Math.round(m.end * 10) / 10) }
    const s = ((r && r.segments) || []).find((x) => x.type === t)
    if (s) return { start: String(Math.round(s.start * 10) / 10), end: String(Math.round(s.end * 10) / 10) }
    return { start: '', end: '' }
  }
  return { op: pick('op'), ed: pick('ed'), scope: 'file' }
}

function extOf(name) {
  const i = String(name || '').lastIndexOf('.')
  return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ''
}

function normKind(type) {
  // detectSubtitleType 可能返回 ass|srt|vtt|subviewer|microdvd；归一为展示用 kind
  if (type === 'microdvd') return 'sub'
  if (type === 'subviewer') return 'sbv'
  return type || ''
}

/** 剧集按钮的短标签：优先取“第N集 / EP N / E N”，否则用去掉扩展名的文件名 */
function epLabel(name, index) {
  const n = String(name || '').replace(/\.[^.]+$/, '')
  const m = n.match(/(EP|E|第)\s*0?(\d{1,4})\s*(集|话|话数|\.|$)/i)
  if (m) {
    if (m[1].toLowerCase() === '第') return `第${m[2]}集`
    return `${m[1].toUpperCase()}${m[2]}`
  }
  return n || `第${index + 1}集`
}

function getOctopus() {
  const m = SubtitlesOctopusModule
  if (m && (typeof m === 'function' || typeof m === 'object')) return m.SubtitlesOctopus || m.default || m
  if (typeof window !== 'undefined' && window.SubtitlesOctopus) return window.SubtitlesOctopus
  return null
}

let cjkProbePromise = null
function cjkFontAvailable() {
  if (!cjkProbePromise) {
    cjkProbePromise = fetch(cjkFontUrl(), { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false)
  }
  return cjkProbePromise
}

/**
 * alist 同款：把 worker 脚本里的 wasm 相对名替换为绝对地址后，
 * 用 Blob URL 创建 worker（避免 wasm 相对路径/CSP 问题）。
 */
async function buildWorkerBlobUrl() {
  const workerUrl = libassWorkerUrl()
  const wasmUrl = libassWasmUrl()
  let text = await (await fetch(workerUrl)).text()
  text = text.replace(/wasmBinaryFile\s*=\s*"subtitles-octopus-worker\.wasm"/g, () => `wasmBinaryFile = "${wasmUrl}"`)
  // 让 worker 的 console 消息回传给页面（Diagnostics：libass 的错误/警告能进应用日志）
  text = text.replace(/var hasNativeConsole=typeof console!="undefined";/, 'var hasNativeConsole=false;')
  return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
}

/** 把任意错误对象/值转成可读文本（避免出现 "Uncaught [object Object]" 之类晦涩信息） */
function fmtErr(e) {
  if (e == null) return '未知错误'
  if (typeof e === 'string') return e.slice(0, 300)
  if (e instanceof Error) return (e.message || String(e)).slice(0, 300)
  const m = e.message || e.description
  if (m) return String(m).slice(0, 300)
  try {
    return JSON.stringify(e).slice(0, 300)
  } catch {
    return String(e).slice(0, 300)
  }
}

export default function PlayerModal() {
  const player = useApp((s) => s.player)
  const server = useApp((s) => s.server)
  const notify = useApp((s) => s.notify)
  const closePlayer = useApp((s) => s.closePlayer)
  const openPlayer = useApp((s) => s.openPlayer)
  const playerMode = useApp((s) => s.playerMode)
  const setPlayerMode = useApp((s) => s.setPlayerMode)
  // 弹幕设置（全局持久化在 store，跨会话记忆）
  const danmakuOpt = useApp((s) => s.danmakuOpt)
  const setDanmakuOpt = useApp((s) => s.setDanmakuOpt)
  const [err, setErr] = useState('')
  // 播放器内报错/警告条：顶部滑入、可叉掉、10s 未关自动淡出
  const [hintGone, setHintGone] = useState(false)
  const [hintLeaving, setHintLeaving] = useState(false)
  const hintTimerRef = useRef(null)
  const closeHint = useCallback(() => {
    setHintLeaving(true)
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current)
      hintTimerRef.current = null
    }
    setTimeout(() => setHintGone(true), 280)
  }, [])
  const [showLink, setShowLink] = useState(false)
  const [raw, setRaw] = useState('')
  const [copied, setCopied] = useState(false)
  const [subs, setSubs] = useState([])
  // eps: 同目录视频（剧集）
  const [eps, setEps] = useState([])
  // 外部播放器检测结果（桌面）：{potplayer, mpv, vlc}
  const [players, setPlayers] = useState(null)
  // 内嵌字幕包含位图轨（PGS/DVD，网页无法显示），提示切外部播放器
  const [hasBitmapEmbed, setHasBitmapEmbed] = useState(false)
  // sel: { item, name, kind, url, vttUrl }；item 为外挂字幕 {path,ext} 或内嵌 {streamIndex,codec,lang,title}
  const [sel, setSel] = useState(null)
  const [subLoading, setSubLoading] = useState(false)
  /* ---- OP/ED 跳过 ---- */
  // info: {segments, chapters, candidates, hints, duration, subAnalyzed, subError, sources}
  const [skipInfo, setSkipInfo] = useState(null)
  const [skipLoading, setSkipLoading] = useState(false)
  const [skipRefining, setSkipRefining] = useState(false)
  const [activeSeg, setActiveSeg] = useState(null) // {type,start,end,remain,auto}
  const [showMark, setShowMark] = useState(false)
  const [showChapters, setShowChapters] = useState(false)
  const [markDraft, setMarkDraft] = useState({ op: { start: '', end: '' }, ed: { start: '', end: '' }, scope: 'series' })
  /* ---- 弹幕（B 站 XML） ---- */
  // danmakus: 同目录 .xml 列表；danmaku: 当前选中项 {name,path}（null = 不加载）
  const [danmakus, setDanmakus] = useState([])
  const [danmaku, setDanmaku] = useState(null)
  // playerEpoch：ArtPlayer 每次重建后 +1，用于重建后重新把弹幕灌进新实例
  const [playerEpoch, setPlayerEpoch] = useState(0)
  const loadedDmRef = useRef(null) // 已装载的弹幕 path，避免重复 fetch
  const epsRef = useRef([]) // 同目录剧集（上/下集按钮在 ArtPlayer 回调里读它，避免重建播放器）
  // resumeRef：待续播位置。换字幕/换集都会重建 ArtPlayer，重建时 restoreRef 会被
  // 「上个实例的 currentTime」覆盖；这里单独留一份带 path 的续播点，重建时优先用它兜底。
  const resumeRef = useRef({ path: null, pos: 0 })
  const boxRef = useRef(null)
  const artRef = useRef(null)
  const restoreRef = useRef(0)
  const octRef = useRef(null)
  const overlayRef = useRef(null)
  // skipDataRef：供 ArtPlayer 事件回调读取（避免重建播放器）
  const skipDataRef = useRef({ segments: [], done: new Set(), cfg: {} })
  const activeSegRef = useRef(null)
  const skipBtnRef = useRef(null)
  const paintRef = useRef(null)

  const isVideo = player && player.kind === 'video'
  const isImage = player && player.kind === 'image'
  const videoKey = player && isVideo ? player.path : null

  const onError = useCallback((msg) => {
    setErr(msg || '播放失败：浏览器可能不支持该编码（常见 H.265/HEVC、AC3），源文件为原画，可用 PotPlayer 播放。')
  }, [])

  const subKey = useCallback((item) => {
    if (!item) return 'none'
    return item.embed ? 'e' + item.streamIndex : 'p' + item.path
  }, [])

  /* 字幕项的渲染 URL：外挂→/api/subass（增强 ASS），内嵌→/api/embed/sub（ffmpeg 抽取后转 ASS） */
  const urlsFor = useCallback(
    (item) => {
      if (!item) return null
      if (item.embed) {
        return {
          url: embedSubUrl(videoKey, item.streamIndex, item.codec, 'ass'),
          vttUrl: embedSubUrl(videoKey, item.streamIndex, item.codec, 'vtt')
        }
      }
      return { url: subassUrl(item.path), vttUrl: subtitleUrl(item.path, false) }
    },
    [videoKey]
  )

  /* 关闭/切换/换集时清理 */
  useEffect(() => {
    return () => {
      try {
        if (octRef.current && octRef.current.dispose) octRef.current.dispose()
      } catch { /* ignore */ }
      octRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey])

  /* 手机版：视频播放进入沉浸式横向全屏（隐藏系统栏），关闭恢复 */
  useEffect(() => {
    if (!isVideo || !videoKey) return undefined
    try {
      if (window.AndroidBridge && window.AndroidBridge.enterImmersive) window.AndroidBridge.enterImmersive()
    } catch { /* ignore */ }
    return () => {
      try {
        if (window.AndroidBridge && window.AndroidBridge.exitImmersive) window.AndroidBridge.exitImmersive()
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey])

  /* 桌面端：剧集/字幕横向条可用鼠标滚轮横向滚动（隐藏了滚动条，滚轮默认只做纵向，这里转成横向） */
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      const bar = e.target && e.target.closest ? e.target.closest('.sub-bar') : null
      if (!bar) return
      const canScroll = bar.scrollWidth > bar.clientWidth + 1
      if (!canScroll) return
      const dx = e.deltaX || 0
      const dy = e.deltaY || 0
      if (Math.abs(dy) > Math.abs(dx)) {
        bar.scrollLeft += dy
        e.preventDefault()
        e.stopPropagation()
      } else if (dx) {
        bar.scrollLeft += dx
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /* 选中某条字幕（外挂 / 内嵌统一处理） */
  const selectSub = useCallback(
    async (item) => {
      if (!item) {
        setSel(null)
        return
      }
      setSubLoading(true)
      try {
        let kind = ''
        if (item.embed) {
          kind = 'embed' // 内嵌文本字幕由 libass 渲染
        } else {
          try {
            const r = await api.subtype(item.path)
            if (r && r.ok) kind = normKind(r.type)
          } catch { /* ignore */ }
          if (!kind) kind = item.ext.replace(/^\./, '')
        }
        const urls = urlsFor(item)
        setSel({ item, name: item.name, kind, url: urls.url, vttUrl: urls.vttUrl })
        report(`subtitle sel kind=${kind} ${String(item.name || '').slice(-40)}`)
      } catch (e) {
        report('selectSub fail ' + e.message)
      } finally {
        setSubLoading(false)
      }
    },
    [urlsFor]
  )

  /* 拉取同目录字幕 + 同目录剧集 + 内嵌字幕，并自动选用（内容嗅探真实格式） */
  useEffect(() => {
    if (!player || !isVideo) return undefined
    let alive = true
    setSubs([])
    setSel(null)
    setEps([])
    setDanmakus([])
    setDanmaku(null)
    setSubLoading(true)
    ;(async () => {
      let fileSubs = []
      let eps = []
      let embedItems = []
      try {
        const r = await api.subs(player.path)
        if (!alive) return
        fileSubs = (r && r.subs) || []
        eps = (r && r.videos) || []
        setEps(eps)
        report(`subs found=${fileSubs.length} videos=${eps.length} for ${String(player.name).slice(-40)}`)
        // 同目录弹幕：自动匹配「归一化后与视频同名」的那份 xml（VCB 这类一集一份弹幕的文件名与视频完全一致）
        const dms = (r && r.danmakus) || []
        if (dms.length) {
          setDanmakus(dms)
          const dwKey = normSubKey(player.name)
          const dmPick =
            dms.find((d) => normSubKey(d.name) === dwKey) ||
            dms.find((d) => String(d.name).replace(/\.[^.]+$/, '').toLowerCase() === String(player.name).replace(/\.[^.]+$/, '').toLowerCase()) ||
            null
          setDanmaku(dmPick)
          report(`danmaku found=${dms.length} picked=${dmPick ? dmPick.name.slice(-28) : 'none'}`)
        } else {
          report('danmaku found=0')
        }
      } catch { /* ignore */ }
      try {
        const probe = await api.embedProbe(player.path)
        if (!alive) return
        const tracks = (probe && probe.ok && probe.tracks) || []
        embedItems = tracks
          .filter((t) => t.text)
          .map((t, i) => ({
            _key: 'e' + t.index,
            embed: true,
            streamIndex: t.index,
            codec: t.codec,
            lang: t.lang,
            title: t.title,
            name:
              `内嵌${String(i + 1).padStart(2, '0')}` +
              (t.lang ? ' · ' + t.lang.toUpperCase() : '') +
              (t.title ? ' · ' + t.title : '') +
              (t.codec ? ' · ' + t.codec : '')
          }))
        const bitmap = tracks.some((t) => t.bitmap)
        setHasBitmapEmbed(bitmap)
        report(`embed tracks=${tracks.length} text=${embedItems.length} bitmap=${bitmap}`)
      } catch { /* ignore */ }
      if (!alive) return
      const all = [...fileSubs, ...embedItems]
      setSubs(all)

      // 自动选：优先同片名的外挂字幕，否则选内嵌中/英文本轨。
      // 片名匹配做了归一化：去掉编码/画质等噪声标签（如 [x265_flac_aac] vs [x265_flac]），
      // 兼容字幕名与视频名不是完全一致的情况（如 VCB-Studio 的 .sc.ass 外挂）
      const prio = { ass: 0, ssa: 1, srt: 2, vtt: 3, sub: 4, sbv: 5 }
      const vKey = normSubKey(player.name)
      const matched = fileSubs.filter((s) => normSubKey(s.name) === vKey)
      const exactBase = String(player.name).replace(/\.[^.]+$/, '').toLowerCase()
      const cands = matched.length
        ? matched.sort(
            (a, b) =>
              subLangScore(a.name) - subLangScore(b.name) ||
              (prio[String(a.ext).slice(1)] ?? 9) - (prio[String(b.ext).slice(1)] ?? 9)
          )
        : fileSubs.filter((s) => String(s.name).toLowerCase().startsWith(exactBase + '.'))
      let pick = cands[0] || null
      if (!pick && embedItems.length) {
        pick =
          embedItems.find((t) => /zh|chi|chs|zho|und/i.test((t.lang || '') + ' ' + (t.title || ''))) ||
          embedItems[0]
      }
      if (pick) selectSub(pick)
      else setSubLoading(false)
    })()
    return () => {
      alive = false
      setSubLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player && player.path])

  /* 弹幕装载：把选中的 xml 灌进当前 ArtPlayer 实例。
     依赖 playerEpoch —— 换字幕/换集时 ArtPlayer 会重建，重建后必须重新灌一次。 */
  useEffect(() => {
    if (!isVideo) return
    const dm = artRef.current && artRef.current.plugins && artRef.current.plugins.artplayerPluginDanmuku
    if (!dm) return
    const want = danmaku ? danmaku.path : null
    if (loadedDmRef.current === want) return
    loadedDmRef.current = want
    try {
      dm.load(want ? danmakuUrl(want) : [])
      report(`danmaku load=${want ? want.slice(-28) : 'off'}`)
    } catch (e) {
      report(`danmaku load fail ${e.message}`)
      notify('弹幕加载失败：' + e.message, 'error')
    }
  }, [danmaku, playerEpoch, isVideo, notify])

  /* 手动切换弹幕（选中即装载；不重建播放器，不丢进度） */
  const switchDanmaku = (d) => {
    const dm = artRef.current && artRef.current.plugins && artRef.current.plugins.artplayerPluginDanmuku
    if (!dm) return setDanmaku(d)
    const want = d ? d.path : null
    if (loadedDmRef.current === want) return setDanmaku(d)
    loadedDmRef.current = want
    setDanmaku(d)
    try {
      dm.load(want ? danmakuUrl(want) : [])
      if (d) dm.show()
    } catch (e) {
      notify('弹幕加载失败：' + e.message, 'error')
    }
  }

  /* 观看历史：打开视频时恢复到上次看到的位置（服务端 userData/watch-history.json，桌面/局域网共用） */
  useEffect(() => {
    if (!isVideo || !player || !player.path) return undefined
    let alive = true
    ;(async () => {
      try {
        const r = await api.history(player.path)
        if (!alive || !r || !r.entry) return
        const pos = Number(r.entry.pos) || 0
        const dur = Number(r.entry.duration) || 0
        if (pos < 5) return // 才开头，不值当续播
        if (dur > 0 && dur - pos < 20) return // 上次已看完 → 从头开始
        // 关键：换个实例（选字幕会重建 ArtPlayer）也要能续上，所以既要写 restoreRef，
        // 也要把「本视频的续播点」记到 resumeRef，重建时优先用它兜底。
        resumeRef.current = { path: player.path, pos }
        restoreRef.current = pos
        const a = artRef.current
        const aDur = a ? Number(a.duration) || 0 : 0
        const atStart = !a || (Number(a.currentTime) || 0) < 1
        // 时长未知时不要直接 seek（会被 clamp 到 0），交给 onMeta 里按 restoreRef 处理
        if (a && aDur > 0 && pos < aDur - 1 && atStart) {
          try { a.seek = pos } catch { /* ignore */ }
        }
        if (atStart) notify(`已从上一次位置 ${formatClock(pos)} 继续播放`, 'ok')
        report(`history resume pos=${Math.round(pos)} dur=${Math.round(aDur)} atStart=${atStart} seekNow=${!!(a && aDur > 0 && pos < aDur - 1 && atStart)}`)
      } catch { /* ignore */ }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player && player.path, isVideo])

  /* 同目录剧集列表（异步到达）→ 供播放器控制栏里的上/下集按钮读取 */
  useEffect(() => {
    epsRef.current = eps
  }, [eps])

  /* 上/下集按钮的边界态：没有上一集/下一集时压暗并禁用点击（列表异步到 + 播放器会重建，用 playerEpoch 触发重算） */
  useEffect(() => {
    const a = artRef.current
    if (!a || !a.controls) return
    const i = eps.findIndex((e) => e.path === (player && player.path))
    const set = (el, on) => {
      if (!el || !el.style) return
      el.style.opacity = on ? '' : '.35'
      el.style.pointerEvents = on ? '' : 'none'
    }
    set(a.controls.epPrev, i > 0)
    set(a.controls.epNext, i >= 0 && i < eps.length - 1)
  }, [eps, player && player.path, playerEpoch])

  /* 退出应用 / 页面被隐藏（刷新、切走、关窗口）前，把还没落盘的弹幕设置立刻写回服务端 */
  useEffect(() => {
    const onHide = () => flushDanmakuSave()
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
      flushDanmakuSave()
    }
  }, [])

  /* ---------- OP/ED 检测：先快路径（手动标记 + 章节打标），再后台补字幕信号 ---------- */
  useEffect(() => {
    if (!isVideo || !videoKey) return undefined
    let alive = true
    setSkipInfo(null)
    setActiveSeg(null)
    setShowMark(false)
    setShowChapters(false)
    setSkipLoading(true)
    setSkipRefining(false)
    skipDataRef.current = { segments: [], done: new Set(), cfg: {} }
    activeSegRef.current = null

    const apply = (r) => {
      if (!alive || !r || r.ok === false) return
      setSkipInfo(r)
      setMarkDraft(draftFrom(r))
      report(
        'skip probe ' +
          ((r.segments || []).map((s) => `${s.type}:${Math.round(s.start)}-${Math.round(s.end)}@${s.source}`).join(' ') || 'none') +
          ` dur=${Math.round(r.duration || 0)} ch=${(r.chapters || []).length}`
      )
    }

    api
      .skipProbe(videoKey)
      .then((r) => {
        apply(r)
        if (alive) setSkipLoading(false)
      })
      .catch((e) => {
        if (alive) setSkipLoading(false)
        report('skip probe fail ' + e.message)
      })

    // 字幕信号：优先复用播放器已抽好的内嵌字幕（零额外带宽），
    // 内嵌字幕首次要完整抽取字幕轨（1GB 约 2 分钟），所以隔一段时间再问几次；
    // 绝不再并行抽一遍——那会和字幕显示抢带宽，导致字幕加载不出来。
    let cancelled = false
    const timers = [15000, 45000, 95000, 155000, 215000].map((ms) =>
      setTimeout(() => {
        if (!alive || cancelled) return
        setSkipRefining(true)
        api
          .skipRefine(videoKey)
          .then((r) => {
            apply(r)
            if (r && r.ok && !r.subPending) cancelled = true
          })
          .catch((e) => report('skip refine fail ' + e.message))
          .finally(() => {
            if (alive) setSkipRefining(false)
          })
      }, ms)
    )

    return () => {
      alive = false
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, isVideo])

  /* 检测结果 / 设置 → 供播放器事件回调读取（不重建播放器） */
  useEffect(() => {
    skipDataRef.current.segments = (skipInfo && skipInfo.segments) || []
    skipDataRef.current.cfg = (server && server.config) || {}
    if (paintRef.current) paintRef.current()
  }, [skipInfo, server])

  const seekTo = useCallback((t) => {
    const a = artRef.current
    if (!a) return
    try {
      a.seek = Math.max(0, Number(t) || 0)
    } catch { /* ignore */ }
  }, [])

  const setMarkAt = (type, field) => {
    const a = artRef.current
    const t = a && a.video ? a.video.currentTime : 0
    setMarkDraft((d) => ({ ...d, [type]: { ...d[type], [field]: String(Math.round(t * 10) / 10) } }))
  }

  const saveMark = async (type) => {
    const d = markDraft[type]
    const start = Number(d.start)
    const end = Number(d.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      notify(`${type.toUpperCase()} 的时间无效：终点必须大于起点`, 'error')
      return
    }
    try {
      await api.skipMark({ path: player.path, type, start, end, scope: markDraft.scope })
      const r = await api.skipProbe(player.path, true)
      setSkipInfo(r)
      notify(`${type.toUpperCase()} 标记已保存（${markDraft.scope === 'series' ? '本剧集全部' : '仅本集'}）`, 'ok')
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  const clearMark = async (type) => {
    try {
      await api.skipClearMark({ path: player.path, type, scope: markDraft.scope })
      const r = await api.skipProbe(player.path, true)
      setSkipInfo(r)
      setMarkDraft(draftFrom(r))
      notify(`${type.toUpperCase()} 标记已清除`, 'ok')
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  /* 字幕切换：直接选（Effect 会因 sel 变化重建播放器并恢复进度） */
  const switchSub = (item) => {    if (!item) {
      setSel(null)
      return
    }
    if (sel && sel.item && subKey(sel.item) === subKey(item)) return
    selectSub(item)
  }

  /* ArtPlayer（+ libass ASS 叠加）创建/重建 */
  useEffect(() => {
    if (!videoKey || !boxRef.current) return undefined
    const box = boxRef.current

    // 记录上个实例进度（换字幕/换集续播用），并清理旧实例。
    // 注意：上个实例刚建好就被重建时它的 currentTime 还是 0，这时要回落到 resumeRef
    // 里记的「本视频续播点」，否则「换了字幕就从 0 重播」会把续播吃掉。
    const prevArt = artRef.current
    const livePos = prevArt ? Number(prevArt.currentTime) || 0 : 0
    const wantResume = resumeRef.current && resumeRef.current.path === player.path ? resumeRef.current.pos : 0
    restoreRef.current = livePos > 1 ? livePos : wantResume
    if (prevArt) {
      try { prevArt.destroy() } catch { /* ignore */ }
      artRef.current = null
    }
    try {
      if (octRef.current && octRef.current.dispose) octRef.current.dispose()
    } catch { /* ignore */ }
    octRef.current = null
    const oldCanvas = box.querySelector('.ass-canvas')
    if (oldCanvas) oldCanvas.remove()
    setErr('')

    const options = {
      container: box,
      url: streamUrl(player.path),
      autoplay: true,
      muted: false,
      volume: 0.85,
      playbackRate: true,
      // PiP/原生全屏仅桌面 Electron 可用；手机 WebView 用页面级全屏(fullscreenWeb)
      pip: isDesktop,
      setting: true,
      fullscreen: isDesktop,
      fullscreenWeb: true,
      loop: false,
      flip: false,
      rotate: false,
      aspectRatio: false,
      screenshot: false,
      hotkey: true,
      theme: '#4d9fff',
      // 内联播放（Android WebView 若走系统播放器会盖掉字幕层，必须 playsinline）
      playsInline: true,
      moreVideoAttr: {
        'webkit-playsinline': '',
        playsInline: '',
        'x5-playsinline': '',
        'x5-video-player-type': 'h5',
        'x5-video-player-fullscreen': 'false'
      }
    }
    // 弹幕：解析/渲染交给 artplayer-plugin-danmuku（内置 B 站 XML 解析，自己在 Blob Worker 里解析）。
    // 控制件（开关 + 齿轮设置面板 + 发弹幕输入框）走插件默认位置 —— 播放器控制栏内（全屏时同样在播放器里）。
    // 设置项来自 store（全局保存、跨会话记忆）；具体 xml 由下面的 effect 调 load() 灌入。
    options.plugins = [
      artplayerPluginDanmuku({
        danmuku: [],
        theme: 'dark',
        emitter: true, // 保留发弹幕输入框（仅本次播放内可见，本 app 不向 B 站投稿）
        heatmap: false,
        maxLength: 100,
        lockTime: 5,
        ...danmakuOpt
      })
    ]
    // 字幕统一委托给 libass 以得到 PotPlayer 观感；这里不设 ArtPlayer 原生字幕（仅在 libass 失败时降级）

    let art = null
    let disposed = false
    let assAttached = false // libass 叠加层是否已挂（断流重连会再触发 loadedmetadata，避免重复挂）
    try {
      art = new Artplayer(options)
    } catch (e) {
      setErr(`播放器初始化失败：${e.message}`)
      return undefined
    }
    artRef.current = art
    loadedDmRef.current = null // 新实例还没装弹幕，交给下面的 effect 灌
    setPlayerEpoch((n) => n + 1)
    report(`player created video=${String(videoKey || '').slice(-40)}`)

    /* ---- 观看历史：节流保存播放位置（关播放器/换集/换字幕时强制存一次） ---- */
    let lastHistAt = 0
    const saveHistoryNow = (force) => {
      try {
        const vd = art && art.video
        if (!vd) return
        const pos = Number(vd.currentTime) || 0
        const dur = Number(art.duration) || 0
        if (pos < 1) return
        const now = Date.now()
        if (!force && now - lastHistAt < 5000) return
        lastHistAt = now
        // 已看到结尾：记 0，下次从头开始（否则会续在最后几秒）
        const nearEnd = dur > 0 && dur - pos < 20
        api.saveHistory(player.path, nearEnd ? 0 : pos, dur).catch(() => {})
      } catch { /* ignore */ }
    }
    const onHistTick = () => saveHistoryNow(false)
    const onHistPause = () => saveHistoryNow(true)
    art.on('video:timeupdate', onHistTick)
    art.on('video:pause', onHistPause)

    /* ---- 弹幕设置全局保存：插件没有 change 事件，改为控件交互后 / 销毁前抓一次 option ---- */
    const dmPlugin = art.plugins && art.plugins.artplayerPluginDanmuku
    let dmSnapTimer = null
    const snapshotDanmaku = () => {
      if (!dmPlugin) return
      try {
        const o = dmPlugin.option || {}
        const next = {
          visible: o.visible !== false,
          opacity: Number(o.opacity),
          fontSize: o.fontSize,
          speed: Number(o.speed),
          margin: Array.isArray(o.margin) ? o.margin : [10, '25%'],
          modes: Array.isArray(o.modes) ? o.modes : [0, 1, 2],
          antiOverlap: o.antiOverlap !== false,
          synchronousPlayback: !!o.synchronousPlayback,
          color: o.color || '#FFFFFF',
          mode: Number(o.mode) || 0
        }
        if (JSON.stringify(next) !== JSON.stringify(useApp.getState().danmakuOpt)) setDanmakuOpt(next)
      } catch { /* ignore */ }
    }
    const onDanmakuUi = () => {
      if (dmSnapTimer) clearTimeout(dmSnapTimer)
      dmSnapTimer = setTimeout(snapshotDanmaku, 250)
    }
    box.addEventListener('pointerup', onDanmakuUi)
    box.addEventListener('click', onDanmakuUi)

    /* ---- 上/下集按钮（放进播放器控制栏；剧集列表异步到达，所以列表走 epsRef） ---- */
    // 用播放器自带的图标，外观与原生控制条一致
    const epIcon = (name) => {
      try {
        const el = art.icons && art.icons[name]
        return (el && el.innerHTML) || ''
      } catch {
        return ''
      }
    }
    const goEp = (delta) => {
      const list = epsRef.current || []
      const i = list.findIndex((e) => e.path === player.path)
      if (i < 0) return
      const t = list[i + delta]
      if (!t) {
        notify(delta < 0 ? '已经是第一集' : '已经是最后一集')
        return
      }
      saveHistoryNow(true)
      openPlayer({ kind: 'video', name: t.name, path: t.path, size: t.size })
    }
    // 原生位置：控制栏左侧组里 playAndPause 的 index 是 10、volume 是 20，
    // 所以 9 / 11 正好把「上一集 / 下一集」插到播放暂停键两侧。
    try {
      art.controls.add({
        name: 'epPrev',
        position: 'left',
        index: 9,
        html: epIcon('arrowLeft'),
        tooltip: '上一集',
        click: () => goEp(-1)
      })
      art.controls.add({
        name: 'epNext',
        position: 'left',
        index: 11,
        html: epIcon('arrowRight'),
        tooltip: '下一集',
        click: () => goEp(1)
      })
    } catch (e) {
      report('ep controls fail ' + e.message)
    }

    // 容器尺寸变化（窗口缩放/信息条增删/进入全屏）时同步 libass 画布尺寸与进度条标记，
    // 否则画布仍是初始化时的大小，字幕会跑位或看起来“不见了”
    let ro = null
    let roCount = 0
    try {
      ro = new ResizeObserver(() => {
        roCount++
        if (roCount % 20 === 1) report(`ass resize #${roCount} box=${box.clientWidth}x${box.clientHeight}`)
        const oct = octRef.current
        if (oct && typeof oct.resize === 'function') {
          try { oct.resize() } catch { /* ignore */ }
        }
        paintRanges()
      })
      ro.observe(box)
    } catch { /* ignore */ }

    // 注意：Octopus 必须自己创建 canvas 与 parent（插到 video 旁），外部传入 canvas 会让其内部
    // canvasParent 保持 null，resize 时崩溃。这里只传 video / subUrl / workerUrl。
    const detachAss = () => {
      if (octRef.current) {
        try { octRef.current.dispose() } catch { /* ignore */ }
        octRef.current = null
      }
      const zone = box.querySelector('.libassjs-canvas-parent, .ass-canvas-parent, .ass-overlay')
      if (zone) zone.remove()
      const c = box.querySelector('.libassjs-canvas, .ass-canvas')
      if (c) c.remove()
    }

    // libass 失败时降级为文本 VTT（保证至少看到字幕）
    const fallbackToTextVtt = () => {
      const cur = sel
      if (!cur) return
      report('ass-fallback-to-text: ' + String(cur.name || '').slice(-50))
      try {
        if (art && art.subtitle) {
          if (typeof art.subtitle.switch === 'function') {
            art.subtitle.switch(cur.vttUrl, { type: 'vtt', name: cur.name })
          }
          art.subtitle.show = true
        }
      } catch (e2) {
        report('ass-fallback-err: ' + e2.message)
      }
    }

    /* ---- libass(SubtitlesOctopus)：真·ASS 渲染叠加（覆盖外挂 SRT/ASS/VTT/SUB 与内嵌文本字幕） ---- */
    const attachAss = async () => {
      const cur = sel
      if (!cur) return
      let workerBlobUrl = null
      report('ass attach begin: ' + String(cur.name || '').slice(-60))
      try {
        const SO = getOctopus()
        if (!SO) throw new Error('libass-wasm 未加载成功')
        // 服务端已把任意外挂/内嵌字幕统一转成增强 ASS（白字描边，PotPlayer 观感）。
        // 直接让 libass 拉取该 URL（外挂 /api/subass、内嵌 /api/embed/sub），与旧版一致、避免 worker 拉 blob 字幕失效。
        const libassSrcUrl = cur.url
        // alist 同款：worker 脚本经 Blob 重写 wasm 绝对路径后作为 workerUrl
        workerBlobUrl = await buildWorkerBlobUrl()
        let oct = null
        const opts = {
          video: art.video,
          subUrl: libassSrcUrl,
          workerUrl: workerBlobUrl,
          debug: window.__PANBOX_LIBASS_DEBUG__ === true,
          onReady: () => {
            try {
              const c = (oct && oct.canvas) || box.querySelector('.ass-overlay canvas, .libassjs-canvas, .ass-canvas')
              const r = c && c.getBoundingClientRect ? c.getBoundingClientRect() : null
              report(`ass onReady canvas=${r ? r.width + 'x' + r.height : '0x0'} vw=${art.video.videoWidth}x${art.video.videoHeight}`)
            } catch { /* ignore */ }
          },
          onError: (e) => {
            const m = fmtErr(e)
            report('octopus-onError: ' + m)
            setErr('字幕渲染错误：' + m)
            fallbackToTextVtt()
          }
        }
        // 全局字幕字体：主进程在系统里挑的圆角中文字体（方正准圆 → 方正兰亭圆 → 华文圆体 → 幼圆），
        // 系统里没有圆体就用全局兜底字体。浏览器 libass 看不到系统字体，所以这些字体名必须在这里
        // 显式登记，否则 ASS 指定的「方正准圆_GBK」「微软雅黑」一个都匹配不上（只剩 fallback）。
        const sf = (server && server.subtitleFont) || null
        if (sf && sf.roundedNames) {
          const map = {}
          // 带上字体指纹 token：字体文件换掉后 URL 会变，否则浏览器会一直用缓存里的旧字体
          const pUrl = cjkFontUrl(sf.token)
          const wUrl = yaheiFontUrl(sf.wideToken)
          for (const n of sf.roundedNames) if (n) map[String(n).toLowerCase()] = pUrl
          for (const n of sf.wideNames || []) if (n) map[String(n).toLowerCase()] = wUrl
          opts.availableFonts = map
          opts.fallbackFont = wUrl || pUrl
          report('subtitle font ' + sf.family + (sf.fallback ? ' (global fallback)' : sf.installed ? ' (installed)' : '') + ' names=' + Object.keys(map).length)
        } else if (await cjkFontAvailable()) {
          opts.fallbackFont = cjkFontUrl()
        }
        oct = new SO(opts)
        if (disposed) {
          try { oct.dispose() } catch { /* ignore */ }
          return
        }
        octRef.current = oct
        // alist 同款：让字幕叠加层绝对铺满播放器容器并置顶（否则看不见）
        const parent = oct.canvasParent
        if (parent) {
          parent.className = 'ass-overlay'
          parent.style.cssText =
            'position:absolute;left:0;top:0;width:100%;height:100%;' +
            'user-select:none;pointer-events:none;z-index:20;'
          report('ass overlay attached ok parent=' + (parent.parentNode && parent.parentNode.className))
        } else {
          report('ass warning: no canvasParent')
        }
      } catch (e) {
        const m = fmtErr(e)
        report('ass init catch: ' + m)
        setErr('字幕加载失败：' + m)
        detachAss()
      } finally {
        if (workerBlobUrl) {
          setTimeout(() => { try { URL.revokeObjectURL(workerBlobUrl) } catch { /* ignore */ } }, 15000)
        }
      }
    }

    /* ---- 断流自愈：画面卡住时自动重连续播（不必再刷新页面） ----
     * 服务端已把「上游异常」明确表现为连接中断，浏览器 media 会 error(网络) 或长时间停滞；
     * 这里兜住：等待超过 STALL_MS 且进度不动（或 networkState=NO_SOURCE）→ 记住位置重新 load()，
     * 元数据就绪后由 onMeta 里的 restoreRef 续播到断点。 */
    const STALL_MS = 8000 // 已在播放中：8s 没有任何进度推进才算卡住
    const STALL_START_MS = 25000 // 还没出第一帧（首次缓冲/慢网）给更宽的容忍，避免误重连
    const HARD_ERR_MS = 1500 // 明确的网络错误（= 服务端断流收尾）：快速重连
    let stallTimer = null
    let stallTries = 0
    let lastTime = 0
    let recovering = false
    let everPlayed = false

    const clearStall = () => {
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
    }
    const tryRecover = () => {
      stallTimer = null
      if (disposed) return
      const vd = art && art.video
      if (!vd) return
      if (vd.ended || vd.paused) return // 用户自己暂停：不折腾
      const t = Number(vd.currentTime) || 0
      if (t - lastTime > 0.2) return // 进度在推进：没卡
      const noSource = vd.networkState === 3 // NETWORK_NO_SOURCE：这条源已确定不可用
      if (!noSource && vd.readyState >= 3) return // 数据够播，只是在等时间轴
      if (stallTries >= 3) {
        onError('播放中断，已自动重连 3 次仍未恢复。可关闭后重新打开，或改用下方外部播放器播放原画。')
        return
      }
      stallTries++
      report(
        `stall recover #${stallTries} at=${Math.round(t)}s ready=${vd.readyState} net=${vd.networkState} err=${vd.error ? vd.error.code : 0}`
      )
      if (t > 1) restoreRef.current = t
      recovering = true
      try {
        vd.load() // 中止旧请求、用同一 URL 重新发起（服务端会按新的 Range 续传）
      } catch (e) {
        recovering = false
        report('stall load fail ' + fmtErr(e))
      }
    }
    const armStall = (delay) => {
      if (stallTimer || disposed) return
      const d = Number(delay) > 0 ? Number(delay) : everPlayed ? STALL_MS : STALL_START_MS
      stallTimer = setTimeout(tryRecover, d)
    }
    const onWaiting = () => armStall()
    const onPlaying = () => {
      everPlayed = true
      clearStall()
    }
    const onProgressTick = () => {
      const vd = art && art.video
      const t = vd ? Number(vd.currentTime) || 0 : 0
      if (t - lastTime > 0.2) {
        lastTime = t
        everPlayed = true
        stallTries = 0 // 真的在推进 → 重连额度恢复
        clearStall()
      }
    }
    art.on('video:waiting', onWaiting)
    art.on('video:stalled', onWaiting)
    art.on('video:playing', onPlaying)
    art.on('video:timeupdate', onProgressTick)

    /* 元数据就绪：恢复进度 + 挂载 libass 叠加层（选中的任何字幕都走它） */
    const onMeta = () => {
      report('video metadata')
      // 编码无法解码（如 10-bit HEVC/AV1）时 Chromium 拿不到视频帧，videoWidth=0 → 无画面，字幕叠加层也就无内容可叠
      setTimeout(() => {
        try {
          const vd = art && art.video
          if (disposed) return
          if (vd && (vd.videoWidth === 0 || vd.videoHeight === 0)) {
            onError('此视频为浏览器无法解码的编码（常见 10-bit HEVC / AV1），网页端无视频画面，字幕也无法叠加显示。请用下方外部播放器（PotPlayer/mpv/VLC）。')
          }
        } catch { /* ignore */ }
      }, 1100)
      // 字幕叠加层只挂一次（断流重连会再次触发 loadedmetadata，重复挂会叠加出多个 libass 画布）
      if (sel && !assAttached) {
        assAttached = true
        attachAss()
      }
      if (restoreRef.current > 1) {
        try { art.seek = restoreRef.current } catch { /* ignore */ }
        report(`restore seek ${Math.round(restoreRef.current)}s`)
        // 续播点已兑现 → 清掉，避免后续重建又跳回这里（用户可能已经往前看了）
        if (resumeRef.current && resumeRef.current.path === player.path) {
          resumeRef.current = { path: null, pos: 0 }
        }
      }
      // 断流自愈时保留断点（万一这次重连又断，下一次仍能接上），正常情况用完即清
      if (!recovering) restoreRef.current = 0
      if (recovering) {
        recovering = false
        clearStall()
        try { art.video.play().catch(() => {}) } catch { /* ignore */ }
      }
    }
    art.video.addEventListener('loadedmetadata', onMeta)
    const onVideoError = () => {
      const vd = art && art.video
      const code = vd && vd.error ? vd.error.code : 0
      const t = (vd && Number(vd.currentTime)) || 0
      // MEDIA_ERR_NETWORK(2)：正是服务端断流收尾那条路径 → 先自愈续播，别误报成「编码不支持」
      if (code === 2 && stallTries < 3) {
        if (t > 1) restoreRef.current = t
        report(`media error code=2(network) at=${Math.round(t)}s → 自动重连`)
        armStall(HARD_ERR_MS)
        return
      }
      if (code === 1) return // ABORTED：用户自己的操作（seek/切换），忽略
      if (t > 1) restoreRef.current = t
      if (code === 2) {
        onError('网络中断，自动重连未能恢复。关闭后重新打开可从未播处继续。')
        return
      }
      onError('')
    }
    art.on('error', onVideoError)
    art.video.addEventListener('error', onVideoError)

    /* ---------- OP/ED 跳过：浮动按钮 + 进度条区间 + 自动跳过 ---------- */
    const skipCfg = () => skipDataRef.current.cfg || {}
    const skippable = () => (skipDataRef.current.segments || []).filter((s) => s.type === 'op' || s.type === 'ed')
    const autoOn = (type, cfg) =>
      cfg.skipEnabled !== false && (type === 'op' ? !!cfg.skipAutoOp : type === 'ed' ? !!cfg.skipAutoEd : false)

    const doSkip = (seg, reason = 'button') => {
      const s = seg || (activeSegRef.current && activeSegRef.current.seg)
      if (!s) return
      skipDataRef.current.done.add(segKey(s))
      const target = Math.min(s.end + 0.15, (art.duration || s.end + 1) - 0.1)
      try {
        art.seek = Math.max(0, target)
      } catch { /* ignore */ }
      activeSegRef.current = null
      setActiveSeg(null)
      if (skipBtnRef.current) skipBtnRef.current.style.display = 'none'
      report(`skip ${s.type} ${Math.round(s.start)}->${Math.round(s.end)} via=${reason}`)
    }

    // 浮动跳过按钮（放在 ArtPlayer 的 layer 里，全屏模式下同样可见）
    try {
      const el = art.layers.add({
        name: 'skipButton',
        html: '<button type="button" class="skip-float"></button>',
        style: { position: 'absolute', right: '18px', bottom: '86px', display: 'none', pointerEvents: 'none' },
        click: () => doSkip(null, 'button')
      })
      const btn = el && el.querySelector('button')
      if (btn) btn.style.pointerEvents = 'auto'
      skipBtnRef.current = el || null
    } catch {
      skipBtnRef.current = null
    }

    // 进度条上的 OP/ED 区间标记（自绘层，避免动 ArtPlayer 的 highlight）
    const paintRanges = () => {
      const track = box.querySelector('.art-control-progress-inner')
      const dur = Number(art.duration) || 0
      const segs = skippable()
      const layer = box.querySelector('.skip-ranges')
      if (!track || !dur || !segs.length || skipCfg().skipEnabled === false) {
        if (layer) layer.remove()
        return
      }
      let host = layer
      if (!host) {
        host = document.createElement('div')
        host.className = 'skip-ranges'
        track.appendChild(host)
      }
      const sig = segs.map((s) => `${s.type}${Math.round(s.start)}-${Math.round(s.end)}`).join(',') + '@' + Math.round(dur)
      if (host.dataset.sig === sig) return
      host.dataset.sig = sig
      host.textContent = ''
      for (const s of segs) {
        const meta = SEG_META[s.type] || { label: s.type.toUpperCase(), cls: '' }
        const i = document.createElement('i')
        i.className = 'skip-range ' + meta.cls
        i.style.left = Math.max(0, Math.min(100, (s.start / dur) * 100)) + '%'
        i.style.width = Math.max(0.3, Math.min(100, ((s.end - s.start) / dur) * 100)) + '%'
        i.title = `${meta.label} ${formatClock(s.start)}–${formatClock(s.end)}`
        host.appendChild(i)
      }
    }
    paintRef.current = paintRanges

    const updateSkipButton = () => {
      const el = skipBtnRef.current
      if (!el) return
      const cur = activeSegRef.current
      const cfg = skipCfg()
      if (!cur || cfg.skipEnabled === false) {
        el.style.display = 'none'
        return
      }
      const meta = SEG_META[cur.seg.type] || { name: cur.seg.type }
      const t = (art.video && art.video.currentTime) || 0
      const elapsed = Math.max(0, t - cur.enteredAt)
      const delay = Math.max(0, Number(cfg.skipDelaySec) || 0)
      let text = `跳过${meta.name} · ${formatClock(cur.remain)}`
      if (cur.auto && delay > 0) {
        const left = Math.max(0, Math.ceil(delay - elapsed))
        text = left > 0 ? `自动跳过${meta.name} · ${left}s` : `跳过${meta.name}`
      }
      const btn = el.querySelector('button')
      if (btn) {
        if (btn.textContent !== text) btn.textContent = text
      }
      el.style.display = ''
    }

    const onTime = () => {
      const vd = art.video
      if (!vd) return
      const t = vd.currentTime || 0
      const cfg = skipCfg()
      let hit = null
      for (const s of skippable()) {
        if (t >= s.start - 0.25 && t < s.end - 0.5) {
          hit = s
          break
        }
      }
      const key = hit ? segKey(hit) : ''
      const prev = activeSegRef.current
      if (key !== (prev ? prev.key : '')) {
        if (!hit || skipDataRef.current.done.has(key)) {
          activeSegRef.current = null
          setActiveSeg(null)
        } else {
          activeSegRef.current = {
            key,
            seg: hit,
            remain: Math.max(0, hit.end - t),
            enteredAt: t,
            auto: autoOn(hit.type, cfg)
          }
          setActiveSeg(activeSegRef.current)
        }
      } else if (prev) {
        const remain = Math.max(0, prev.seg.end - t)
        if (Math.abs(remain - prev.remain) >= 1) {
          activeSegRef.current = { ...prev, remain }
          setActiveSeg(activeSegRef.current)
        }
        if (prev.auto && !skipDataRef.current.done.has(prev.key)) {
          const delay = Math.max(0, Number(cfg.skipDelaySec) || 0)
          if (t - prev.enteredAt >= delay) doSkip(prev.seg, 'auto')
        }
      }
      updateSkipButton()
      paintRanges()
    }

    art.on('video:timeupdate', onTime)
    art.on('video:durationchange', paintRanges)
    paintRanges()

    return () => {
      disposed = true
      // 弹幕设置 + 观看进度：销毁前落盘（换集/换字幕/关播放器都会走到）
      if (dmSnapTimer) clearTimeout(dmSnapTimer)
      snapshotDanmaku()
      flushDanmakuSave() // 关播放器/换集/换字幕就把弹幕设置落盘，不等退出应用
      saveHistoryNow(true)
      try {
        box.removeEventListener('pointerup', onDanmakuUi)
        box.removeEventListener('click', onDanmakuUi)
        art.off('video:timeupdate', onHistTick)
        art.off('video:pause', onHistPause)
      } catch { /* ignore */ }
      paintRef.current = null
      skipBtnRef.current = null
      activeSegRef.current = null
      try {
        if (ro) ro.disconnect()
      } catch { /* ignore */ }
      try {
        art.off('video:timeupdate', onTime)
        art.off('video:durationchange', paintRanges)
        art.off('video:waiting', onWaiting)
        art.off('video:stalled', onWaiting)
        art.off('video:playing', onPlaying)
        art.off('video:timeupdate', onProgressTick)
      } catch { /* ignore */ }
      clearStall()
      detachAss()
      try {
        art.video.removeEventListener('loadedmetadata', onMeta)
        art.video.removeEventListener('error', onVideoError)
      } catch { /* ignore */ }
      try { art.destroy() } catch { /* ignore */ }
      if (artRef.current === art) artRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, sel ? subKey(sel.item) : 'none'])

  /* 恢复上次位置（重建时）；player.path 变化时置 0 */
  useEffect(() => {
    setShowLink(false)
    setRaw('')
    setCopied(false)
  }, [player && player.path])

  /* 换集/重开视频时重置提示条状态 */
  useEffect(() => {
    setHintGone(false)
    setHintLeaving(false)
  }, [player && player.path])

  /* 提示条出现后 10s 没被叉掉就自动淡出 */
  const hintVisible = !!(player && (err || hasBitmapEmbed)) && !hintGone
  useEffect(() => {
    if (!hintVisible) return undefined
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(closeHint, 10000)
    return () => {
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current)
        hintTimerRef.current = null
      }
    }
  }, [hintVisible, closeHint])

  if (!player) return null
  const src = streamUrl(player.path)

  const fetchRaw = async () => {
    try {
      const r = await api.rawlink(player.path)
      setRaw(r.base)
      setShowLink(true)
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  const doCopy = async (text) => {
    if (await copyText(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      notify('已复制', 'ok')
    } else {
      notify('复制失败', 'error')
    }
  }

  /* 桌面：探测可用的外部播放器（PotPlayer / mpv / VLC，全部支持内嵌字幕含位图） */
  useEffect(() => {
    if (!isDesktop || !isVideo) return undefined
    let alive = true
    api
      .detectPlayers()
      .then((r) => {
        if (!alive) return
        const out = {}
        for (const [k, v] of Object.entries(r || {})) {
          if (v && v.found) out[k] = v
        }
        setPlayers(out)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, isVideo])

  const launchExternal = async (name) => {
    try {
      const r = await api.openPlayer(player.path, name, (players && players[name] && players[name].path) || '')
      setPlayerMode(name)
      notify(`已用 ${r.player === 'mpv' ? 'mpv' : r.player === 'vlc' ? 'VLC' : 'PotPlayer'} 播放（原生支持内嵌字幕）`, 'ok')
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  const openPot = async () => {
    await launchExternal('potplayer')
  }

  const activeSub = sel ? subKey(sel.item) : null
  const renderKind = sel ? sel.kind : ''
  const firstFileSub = subs.find((s) => !s.embed)
  const dlSubPath = (sel && !sel.item.embed && sel.item.path) || (firstFileSub && firstFileSub.path)
  const externalOrder = ['potplayer', 'mpv', 'vlc']

  return (
    <div className="player-overlay" role="dialog" aria-modal="true" ref={overlayRef}>
      <div className="player-head">
        <div className="player-title">
          <FileIcon size={15} />
          <span className="name-full" style={{ minWidth: 0 }}>{player.name}</span>
          <span className="dim">{formatSize(player.size)}</span>
        </div>
        <button className="icon-btn" onClick={closePlayer} aria-label="关闭">
          <X size={20} />
        </button>
      </div>

      <div className="player-stage">
        {isImage ? (
          <img src={src} alt={player.name} onError={() => onError('图片加载失败')} />
        ) : isVideo ? (
          <>
            <div className="art-host" ref={boxRef} />
            {subLoading ? <div className="player-loading"><Loader2 size={16} className="spin" /> 字幕解析中…</div> : null}
            {/* 报错/警告：从播放器顶部滑入、带叉键、10s 未关自动淡出（不再压住底部控制条） */}
            {!hintGone && (err || hasBitmapEmbed) ? (
              <div className={'player-hint' + (hintLeaving ? ' leaving' : '')}>
                <CircleAlert size={15} />
                <span>{err || '该视频含位图内嵌字幕（PGS/DVD），网页播放器无法显示。请在播放器控制栏切换到外部播放器（PotPlayer/mpv/VLC）获取原画并完整显示字幕。'}</span>
                {err && isDesktop ? (
                  <button className="btn small" onClick={openPot}>
                    <MonitorPlay size={14} /> PotPlayer 播放原画
                  </button>
                ) : null}
                <button className="player-hint-close" onClick={closeHint} aria-label="关闭" title="关闭">
                  <X size={14} />
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <audio key={player.path} src={src} controls autoPlay onError={() => onError('音频加载失败')} />
        )}
      </div>

      {/* 播放器下方的信息条：整体可收缩/纵向滚动，视频区域始终自适应 */}
      <div className="player-bars">
      {/* 同目录剧集选择（位于字幕条上方） */}
      {isVideo && eps.length > 0 ? (
        <div className="sub-bar ep-bar">
          <span className="sub-bar-title">
            <ListVideo size={14} /> 剧集
          </span>
          {eps.map((v, i) => (
            <button
              key={v.path}
              className={`sub-chip ${player.path === v.path ? 'on' : ''}`}
              title={v.name}
              onClick={() => {
                if (player.path === v.path) return
                openPlayer({ kind: 'video', name: v.name, path: v.path, size: v.size })
              }}
            >
              <span className="ellip">{epLabel(v.name, i)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* 片头片尾（OP/ED）检测条 */}
      {isVideo && (skipInfo || skipLoading) ? (
        <div className="sub-bar skip-bar">
          <span className="sub-bar-title">
            <SkipForward size={14} /> 片头片尾
          </span>
          {skipLoading ? (
            <span className="dim small"><Loader2 size={12} className="spin" /> 检测中…</span>
          ) : null}
          {skipInfo
            ? (skipInfo.segments || [])
                .filter((s) => s.type === 'op' || s.type === 'ed')
                .map((s) => (
                  <button
                    key={s.type + '-' + Math.round(s.start)}
                    className="sub-chip on"
                    title={`${SEG_META[s.type].name} ${formatClock(s.start)}–${formatClock(s.end)} · 来源：${SOURCE_NAME[s.source] || s.source} · 置信度 ${Math.round((s.confidence || 0) * 100)}%`}
                    onClick={() => seekTo(s.start + 0.1)}
                  >
                    <span className="ellip">{SEG_META[s.type].label} {formatClock(s.start)}–{formatClock(s.end)}</span>
                    <i>{SOURCE_NAME[s.source] || s.source}</i>
                  </button>
                ))
            : null}
          {skipInfo && !(skipInfo.segments || []).some((s) => s.type === 'op' || s.type === 'ed') ? (
            <span className="dim small">未检测到 OP/ED（可手动标记）</span>
          ) : null}
          {skipRefining ? (
            <span className="dim small"><Loader2 size={12} className="spin" /> 字幕信号分析中…</span>
          ) : null}
          {skipInfo && (skipInfo.chapters || []).length ? (
            <button className={`sub-chip ${showChapters ? 'on' : ''}`} onClick={() => setShowChapters((v) => !v)}>
              <Tag size={12} /> 章节 {skipInfo.chapters.length}
            </button>
          ) : null}
          {skipInfo ? (
            <button className={`sub-chip ${showMark ? 'on' : ''}`} onClick={() => setShowMark((v) => !v)}>
              <Scissors size={12} /> 手动标记
            </button>
          ) : null}
          {activeSeg ? (
            <button className="sub-chip on" onClick={() => seekTo(activeSeg.seg.end + 0.15)}>
              <SkipForward size={12} />
              <span className="ellip">
                跳过{SEG_META[activeSeg.seg.type] ? SEG_META[activeSeg.seg.type].name : activeSeg.seg.type} · {formatClock(activeSeg.remain)}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 章节列表（打标来源，可点击跳转） */}
      {isVideo && showChapters && skipInfo && (skipInfo.chapters || []).length ? (
        <div className="sub-bar chap-bar">
          <span className="sub-bar-title"><Tag size={14} /> 章节</span>
          {skipInfo.chapters.map((c, i) => {
            const seg = (skipInfo.segments || []).find((s) => Math.abs(s.start - c.start) < 0.6)
            const label = c.title || `第 ${i + 1} 段`
            return (
              <button
                key={c.start + '-' + i}
                className={`sub-chip ${seg ? 'on' : ''}`}
                title={`${formatClock(c.start)}–${formatClock(c.end)}`}
                onClick={() => seekTo(c.start + 0.1)}
              >
                <span className="ellip">{label}</span>
                <i>{formatClock(c.start)}</i>
              </button>
            )
          })}
        </div>
      ) : null}

      {/* 手动标记面板 */}
      {isVideo && showMark && skipInfo ? (
        <div className="mark-panel">
          <div className="mark-head">
            <Scissors size={14} /> 手动标记片头片尾
            <span className="dim small">先播放到对应位置，再点「设为起点/终点」</span>
          </div>
          {['op', 'ed'].map((t) => (
            <div className="mark-row" key={t}>
              <b>{SEG_META[t].label}</b>
              <input
                className="num-input"
                type="number"
                step="0.5"
                min="0"
                value={markDraft[t].start}
                onChange={(e) => setMarkDraft((d) => ({ ...d, [t]: { ...d[t], start: e.target.value } }))}
                placeholder="起点秒"
              />
              <input
                className="num-input"
                type="number"
                step="0.5"
                min="0"
                value={markDraft[t].end}
                onChange={(e) => setMarkDraft((d) => ({ ...d, [t]: { ...d[t], end: e.target.value } }))}
                placeholder="终点秒"
              />
              <button className="btn ghost small" onClick={() => setMarkAt(t, 'start')}>设为起点</button>
              <button className="btn ghost small" onClick={() => setMarkAt(t, 'end')}>设为终点</button>
              <button className="btn small" onClick={() => saveMark(t)}><Check size={13} /> 保存</button>
              <button className="btn ghost small" onClick={() => clearMark(t)}><RotateCcw size={13} /> 清除</button>
              <span className="dim small">
                {markDraft[t].start !== '' && markDraft[t].end !== ''
                  ? `${formatClock(Number(markDraft[t].start))}–${formatClock(Number(markDraft[t].end))}`
                  : '未设置'}
              </span>
            </div>
          ))}
          <div className="mark-row">
            <span className="dim small">应用范围</span>
            <label className="radio-line">
              <input
                type="radio"
                checked={markDraft.scope === 'file'}
                onChange={() => setMarkDraft((d) => ({ ...d, scope: 'file' }))}
              />
              <span>仅本集</span>
            </label>
            <label className="radio-line">
              <input
                type="radio"
                checked={markDraft.scope === 'series'}
                onChange={() => setMarkDraft((d) => ({ ...d, scope: 'series' }))}
              />
              <span>本剧集全部（同目录其它集自动套用）</span>
            </label>
          </div>
          {skipInfo.hints && skipInfo.hints.length ? (
            <div className="mark-hints dim small">
              {skipInfo.hints.map((h, i) => <div key={i}>· {h}</div>)}
            </div>
          ) : null}
          {skipInfo.subError ? <div className="dim small">字幕信号未取到：{skipInfo.subError}</div> : null}
          {skipInfo.subHint ? <div className="dim small">{skipInfo.subHint}</div> : null}
          {skipInfo.subSkipped ? <div className="dim small">字幕信号已跳过：{skipInfo.subSkipped}</div> : null}
        </div>
      ) : null}

      {/* 字幕条 */}
      {isVideo && subs.length > 0 ? (
        <div className="sub-bar">
          <span className="sub-bar-title">
            <Captions size={14} /> 字幕
            {renderKind ? <i className="sub-kind">{KIND_LABEL[renderKind] || renderKind.toUpperCase()}</i> : null}
          </span>
          <button className={`sub-chip ${!activeSub ? 'on' : ''}`} onClick={() => switchSub(null)}>
            关闭
          </button>
          {subs.map((s) => {
            const on = activeSub && activeSub === subKey(s)
            const label = s.embed ? s.name : s.name.replace(/\.[^.]+$/, '')
            const tag = s.embed
              ? (s.lang || s.codec || '内嵌').toUpperCase()
              : SUB_LABEL[extOf(s.name)] || extOf(s.name).toUpperCase()
            return (
              <button
                key={s._key || s.path}
                className={`sub-chip ${on ? 'on' : ''}`}
                onClick={() => switchSub(s)}
                title={s.name}
              >
                <span className="ellip">{label}</span>
                <i>{tag}</i>
              </button>
            )
          })}
        </div>
      ) : null}

      {/* 弹幕条（在「字幕」条下方）：同目录 .xml 选择 + 自动匹配；开关/设置面板/发弹幕输入框由插件挂在播放器控制栏内 */}
      {isVideo ? (
        <div className="sub-bar dm-bar">
          <span className="sub-bar-title">
            <MessageSquareText size={14} /> 弹幕
          </span>
          <button className={`sub-chip ${!danmaku ? 'on' : ''}`} onClick={() => switchDanmaku(null)}>
            关闭
          </button>
          {danmakus.length === 0 ? (
            <span className="dim small">同目录未找到 .xml 弹幕（B 站格式）</span>
          ) : (
            danmakus.map((d) => {
              const on = !!(danmaku && danmaku.path === d.path)
              const base = String(player.name).replace(/\.[^.]+$/, '')
              const raw = String(d.name).replace(/\.[^.]+$/, '')
              // 标签：优先取集数标记（[01] / [OVA] / [SP1]），取不到就回落到去掉扩展名的文件名
              const ep = String(d.name).match(/\[(\d{1,3}(?:v\d)?|SP\d*|OVA\d*|NC(?:OP|ED)\d*|OP\d*|ED\d*)\]/i)
              const label = ep ? ep[1] : raw === base ? '同名' : raw
              const auto = normSubKey(d.name) === normSubKey(player.name)
              return (
                <button
                  key={d.path}
                  className={`sub-chip ${on ? 'on' : ''}`}
                  onClick={() => switchDanmaku(d)}
                  title={`${d.name}\n${formatSize(d.size)}`}
                >
                  <span className="ellip">{label}</span>
                  {auto ? <i className="dm-auto" title="与当前视频同名（自动匹配）">匹配</i> : <i>XML</i>}
                </button>
              )
            })
          )}
        </div>
      ) : null}
      </div>

      <div className="player-tools">
        {isDesktop && isVideo ? (
          <div className="sub-bar ep-bar player-bar">
            <span className="sub-bar-title"><MonitorPlay size={14} /> 播放器</span>
            <button className={`sub-chip ${playerMode === 'web' ? 'on' : ''}`} onClick={() => setPlayerMode('web')}>
              在线
            </button>
            {externalOrder
              .filter((k) => players && players[k])
              .map((k) => {
                const label = k === 'mpv' ? 'mpv' : k === 'vlc' ? 'VLC' : 'PotPlayer'
                return (
                  <button
                    key={k}
                    className={`sub-chip ${playerMode === k ? 'on' : ''}`}
                    onClick={() => launchExternal(k)}
                    title={players[k].path}
                  >
                    {label}
                  </button>
                )
              })}
            <span className="player-dim">外部播放器原生支持内嵌字幕（含 PGS/DVD 位图）</span>
          </div>
        ) : isDesktop && player.kind === 'audio' ? (
          <button className="btn" onClick={openPot}>
            <MonitorPlay size={16} /> PotPlayer
          </button>
        ) : null}
        {!isDesktop && isVideo && typeof window !== 'undefined' && window.AndroidBridge && window.AndroidBridge.openExternal ? (
          <button
            className="btn"
            title="用本地 VLC（原生支持内嵌字幕）打开原画"
            onClick={() => {
              try {
                window.AndroidBridge.openExternal(player.path)
                notify('已调用 VLC 打开（原生支持内嵌字幕）', 'ok')
              } catch (e) {
                notify('无法唤起外部播放器，请安装 VLC', 'error')
              }
            }}
          >
            <MonitorPlay size={16} /> VLC 播放
          </button>
        ) : null}
        <a className="btn" href={downloadUrl(player.path)}>
          <Download size={16} /> 下载
        </a>
        {dlSubPath ? (
          <a className="btn ghost small" href={downloadUrl(dlSubPath)}>
            <Captions size={14} /> 下载字幕
          </a>
        ) : null}
        <button
          className="btn ghost"
          onClick={() => {
            if (!raw) fetchRaw()
            else setShowLink((v) => !v)
          }}
        >
          <Link2 size={16} /> 原画直链
        </button>
        <span className="player-dim">在线播放为原画直出（UA: pan.baidu.com，支持拖动）</span>
      </div>

      {showLink && raw ? (
        <div className="player-link">
          <div className="link-row ellip">
            <span>{raw}</span>
            <button className="icon-btn" onClick={() => doCopy(raw)} aria-label="复制链接">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <div className="link-hint">
            直链需要请求头 <code>User-Agent: pan.baidu.com</code>（大于 20MB 的文件必须），可用下载工具携带该头，或复制 curl：
          </div>
          <div className="link-row ellip code">
            <span>curl -L -H "User-Agent: pan.baidu.com" -o {JSON.stringify(player.name)} "{raw}"</span>
            <button
              className="icon-btn"
              onClick={() => doCopy(`curl -L -H "User-Agent: pan.baidu.com" -o "${player.name}" "${raw}"`)}
              aria-label="复制curl"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
