/** 内嵌字幕工具：用系统/内置 ffprobe 探测视频内的字幕流，用 ffmpeg 抽取文本字幕（SRT/ASS）。
 *  内嵌字幕无法像外挂字幕那样直接给 <video> 用，必须先从容器(MKV/MP4)里把字幕轨剥离出来再渲染。
 *  本项目让 ffmpeg 直接读本地 /api/stream（支持 Range/seek），抽取后交回标准的字幕→ASS 管线。
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { loadConfig } from './config.js'

const execFileP = promisify(execFile)

/* ---------- ffmpeg/ffprobe 串行队列 ----------
 * 所有 ffmpeg/ffprobe 都要从同一条百度直链拉数据，并行跑会互相抢带宽：
 * 实测一个字幕轨全量抽取要 131s。因此统一排队，且按优先级让「字幕显示」永远排最前。
 */
const FF_PRIORITY = {
  subtitle: 0, // 播放器要显示的字幕（内嵌轨抽取 / 探测）
  normal: 5 // 章节检测、时长读取
}
export { FF_PRIORITY }
let ffActive = 0
const ffWaiting = []

function ffAcquire(priority) {
  if (ffActive === 0 && !ffWaiting.length) {
    ffActive++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    ffWaiting.push({ priority, resolve })
    ffWaiting.sort((a, b) => a.priority - b.priority)
  })
}

function ffRelease() {
  ffActive--
  const next = ffWaiting.shift()
  if (next) {
    ffActive++
    next.resolve()
  }
}

async function ffRun(priority, fn) {
  await ffAcquire(priority)
  try {
    return await fn()
  } finally {
    ffRelease()
  }
}

// 常见 ffmpeg 安装目录（Windows）
const FFMPEG_DIRS = [
  'D:\\ffmpeg-7.1-full_build\\bin',
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
  'C:\\Program Files (x86)\\ffmpeg\\bin',
  'D:\\Program Files\\ffmpeg\\bin'
]

export function toolPath(name) {
  const cfg = loadConfig()
  const custom = (cfg && cfg.ffmpegPath) || ''
  if (custom) {
    const p = path.join(custom, name.endsWith('.exe') ? name : name + '.exe')
    if (fs.existsSync(p)) return p
  }
  for (const d of FFMPEG_DIRS) {
    const p = path.join(d, name.endsWith('.exe') ? name : name + '.exe')
    if (fs.existsSync(p)) return p
  }
  // 裸名交给 execFile 走 PATH（不依赖 shell，安全）
  return name
}

export function ffmpegAvailable() {
  try {
    const cfg = loadConfig()
    const custom = (cfg && cfg.ffmpegPath) || ''
    if (custom && fs.existsSync(path.join(custom, 'ffmpeg.exe'))) return true
    for (const d of FFMPEG_DIRS) {
      if (fs.existsSync(path.join(d, 'ffmpeg.exe'))) return true
    }
    return false
  } catch {
    return false
  }
}

// 可被 ffmpeg 转成文本（SRT/ASS）喂给 libass 的字幕编码；位图字幕(PGS/DVD)无法用 libass 渲染
export const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
  'sami',
  'subtitle'
])
export const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])

/**
 * 用 ffprobe 探测视频里的字幕流。streamUrl 为本项目 /api/stream 地址（本地，支持 Range 回源）。
 * 返回 { ok, tracks:[{index,codec,lang,title,text,bitmap,codecName}] }。
 */
export async function probeEmbeddedSubs(streamUrl) {
  if (!ffmpegAvailable()) return { ok: true, tracks: [] }
  const exe = toolPath('ffprobe')
  const args = [
    '-v', 'error',
    '-select_streams', 's',
    '-show_entries', 'stream=index,codec_name,codec_type:stream_tags=language,title,handler_name',
    '-of', 'json',
    streamUrl
  ]
  let out = ''
  try {
    const r = await ffRun(FF_PRIORITY.subtitle, () =>
      execFileP(exe, args, {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60000,
        windowsHide: true
      })
    )
    out = r.stdout
  } catch (e) {
    // ffprobe 非常容易在 HTTP 流上出非致命错误，但仍可能输出 JSON。若彻底失败则静默返回空。
    const stderr = ((e && e.stderr) || '') + '\n' + ((e && e.message) || '')
    if (!/stream/i.test(stderr)) return { ok: true, tracks: [] }
    return { ok: true, tracks: [] }
  }
  let json = null
  try {
    json = JSON.parse(out)
  } catch {
    return { ok: true, tracks: [] }
  }
  const streams = json.streams || []
  // 注意：ffprobe 返回的 stream.index 是「容器内的全局流序号」（如视频=0/音频=1/字幕=3…），
  // 而 ffmpeg 的 -map 0:s:N 用的是「字幕相对序号」（第 N 条字幕，0 起）。两者不一致会导致
  // "Stream map matches no streams" 而抽取失败。这里返回字幕相对序号 i 供 -map 使用，
  // 并保留 globalIndex 便于诊断/展示。
  const tracks = streams.map((s, i) => {
    const codec = (s.codec_name || '').toLowerCase()
    const tags = s.tags || {}
    return {
      index: i,
      globalIndex: Number(s.index),
      codec,
      codecName: s.codec_name || codec,
      lang: tags.language || '',
      title: tags.title || tags.handler_name || '',
      text: TEXT_SUBTITLE_CODECS.has(codec),
      bitmap: BITMAP_SUBTITLE_CODECS.has(codec)
    }
  })
  return { ok: true, tracks }
}

/**
 * 抽取一条文本字幕流到内存（SRT 或 ASS 文本）。
 * 返回 { ok, text, isAss }：isAss=true 表示已经是 ASS（保留原样式）。
 */
export async function extractSubtitleText(streamUrl, index, codec) {
  if (!ffmpegAvailable()) return { ok: false, error: '未找到 ffmpeg，无法抽取内嵌字幕' }
  const exe = toolPath('ffmpeg')
  const isAss = /^(ass|ssa)$/i.test(codec || '')
  const args = ['-v', 'error', '-nostdin', '-i', streamUrl, '-map', `0:s:${index}`]
  // ASS/SSA 字幕保留原样式；其余文本字幕统一抽出为 SRT（随后走增强 ASS / WebVTT 管线）
  if (isAss) args.push('-c:s', 'ass', '-f', 'ass', '-')
  else args.push('-c:s', 'srt', '-f', 'srt', '-')
  try {
    const r = await ffRun(FF_PRIORITY.subtitle, () =>
      execFileP(exe, args, {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 900000, // 15 分钟上限（大文件抽取需整段读流）
        windowsHide: true
      })
    )
    const text = r.stdout.toString('utf-8').replace(/^\uFEFF/, '')
    if (!text || !text.trim()) return { ok: false, error: '字幕流为空（可能是位图字幕或无字幕）' }
    return { ok: true, text, isAss }
  } catch (e) {
    const err = ((e && e.stderr) || (e && e.message) || 'ffmpeg 抽取失败').toString()
    return { ok: false, error: err.slice(0, 400) }
  }
}

/** 供 server 用来构造 ffmpeg 可读的本机 stream URL（固定走 127.0.0.1，避免 hostBind=0.0.0.0 时用错 IP） */
export function localStreamUrl(port, videoPath) {
  return `http://127.0.0.1:${Number(port) || 16888}/api/stream?path=${encodeURIComponent(videoPath)}`
}

/* ==================== 章节 / 时长 / 字幕窗口（OP 跳过检测用） ==================== */

/** 读容器时长（秒）。ffprobe 读 MKV/MP4 头部即可拿到，通常几秒内返回。 */
export async function probeDuration(streamUrl) {
  if (!ffmpegAvailable()) return 0
  const exe = toolPath('ffprobe')
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', streamUrl]
  try {
    const r = await ffRun(FF_PRIORITY.normal, () => execFileP(exe, args, { maxBuffer: 1 << 20, timeout: 45000, windowsHide: true }))
    const json = JSON.parse(r.stdout || '{}')
    const d = Number(json.format && json.format.duration)
    return Number.isFinite(d) && d > 0 ? d : 0
  } catch {
    return 0
  }
}

/**
 * 读容器章节（打标）。返回 { ok, duration, chapters:[{start,end,title}] }。
 * 章节名是番剧最可靠的 OP/ED 线索（如 "OP" / "NCOP" / "Intro" / "ED" / "Preview"），
 * 没有命名时也能靠「时长 + 位置」推断。
 */
export async function probeChapters(streamUrl) {
  if (!ffmpegAvailable()) return { ok: false, error: '未检测到 ffmpeg/ffprobe', chapters: [], duration: 0 }
  const exe = toolPath('ffprobe')
  const args = ['-v', 'error', '-show_chapters', '-show_format', '-of', 'json', streamUrl]
  let out = ''
  try {
    const r = await ffRun(FF_PRIORITY.normal, () =>
      execFileP(exe, args, { maxBuffer: 8 << 20, timeout: 120000, windowsHide: true })
    )
    out = r.stdout || ''
  } catch (e) {
    out = (e && e.stdout) || ''
    if (!out) return { ok: false, error: 'ffprobe 读取章节失败', chapters: [], duration: 0 }
  }
  let json = {}
  try {
    json = JSON.parse(out)
  } catch {
    return { ok: false, error: 'ffprobe 输出解析失败', chapters: [], duration: 0 }
  }
  const chapters = (json.chapters || [])
    .map((c) => ({
      start: Number(c.start_time),
      end: Number(c.end_time),
      title: String((c.tags && c.tags.title) || '').trim()
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start)
  const duration = Number((json.format && json.format.duration) || 0) || 0
  return { ok: true, chapters, duration }
}

