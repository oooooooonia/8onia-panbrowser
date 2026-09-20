import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/** PanBrowser 主进程配置（账号 + 应用偏好），存放在 userData/config.json */
export const DEFAULTS = {
  // 百度网盘开放平台凭证（可通过「从 AList 导入」或手动填写）
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  // 运行时缓存的 access_token 与过期时间（进程内 + 落盘，减少不必要的刷新）
  accessToken: '',
  accessTokenExpiresAt: 0,
  // 挂载根目录（类 alist 的 root_folder_path），默认整盘根目录
  rootFolderPath: '/',
  // 文件列表默认排序
  orderBy: 'name',
  orderDirection: 'asc',
  // PotPlayer 可执行文件路径（留空 = 自动检测常见位置）
  potplayerPath: '',
  // 其它外部播放器（完全支持内嵌字幕的第三方播放器）
  mpvPath: '',
  vlcPath: '',
  // 播放器偏好：web=网页(ArtPlayer+libass)｜potplayer｜mpv｜vlc（后三者原生支持含位图的内嵌字幕）
  playerMode: 'web',
  // ffmpeg/ffprobe 所在目录（留空 = 自动检测常见位置，用于抽取内嵌字幕）
  ffmpegPath: '',
  // 本地服务
  port: 16888,
  hostBind: '127.0.0.1', // 127.0.0.1=本机；0.0.0.0=允许局域网手机访问
  // 本机 AList 数据目录（含 data.db），用于一键导入凭证；留空由用户在设置页选择
  alistDir: '',
  // SRT 增强字幕外观（接近 PotPlayer 默认：白字细描边轻阴影，字号≈屏高5%）
  subFontScale: 0.05,
  subOutline: 1.4,
  subShadow: 0.6,
  subWeight: 'normal', // 字幕粗细：normal（默认，严格按字幕文件自身的 Bold 设定）| medium | bold
  // ---- 片头/片尾（OP/ED）跳过 ----
  skipEnabled: true, // 总开关：播放器内是否显示跳过按钮/进度条标记
  skipAutoOp: false, // 进入 OP 区间后自动跳过
  skipAutoEd: false, // 进入 ED 区间后自动跳过
  skipDelaySec: 2, // 自动跳过前的等待秒数（0 = 立即）
  skipUseChapters: true, // 使用视频文件章节（打标）
  skipUseSubtitles: true, // 使用字幕信号（ASS 样式名/歌词块、跨集重复文本）
  // ---- 弹幕（B 站 XML）外观与行为：artplayer-plugin-danmuku 的 option 子集 ----
  // 存 userData/config.json：桌面版 / npm run dev / 手机局域网访问同一个服务 → 共用同一份
  danmaku: {
    visible: true, // 弹幕层开关
    opacity: 0.8, // 透明度 0~1
    fontSize: 25, // 字号（px 数字或 "25%" 百分比）
    speed: 5, // 1~10，越大越慢（在屏时间越长）
    margin: [10, '25%'], // [上, 下] 显示区域边距，下方留 25% 不压字幕
    modes: [0, 1, 2], // 可见类型：0 滚动 / 1 顶部 / 2 底部
    antiOverlap: true, // 防重叠
    synchronousPlayback: false, // 跟随播放速度
    color: '#FFFFFF', // 默认颜色（可被单条弹幕覆盖）
    mode: 0 // 手动发弹幕的默认类型
  },
  // 全局字幕字体：留空 = 自动（圆角中文字体优先，系统里没有圆体就用全局字体）
  // 可填任意 .ttf/.otf/.ttc 路径，比如自备的「方正兰亭圆」「方正准圆」
  subtitleFontPath: ''
}

let cache = null

export function configFile() {
  return path.join(app.getPath('userData'), 'config.json')
}

// 初始令牌文件（个人自用；refresh_token 一次性，失效时在设置页重新导入/粘贴即可）
const SEED_KEYS = ['clientId', 'clientSecret', 'refreshToken', 'accessToken', 'accessTokenExpiresAt', 'rootFolderPath']
function readSeedConfig() {
  try {
    const file = path.join(__dirname, '../../resources/default-config.json')
    if (!fs.existsSync(file)) return {}
    const seed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')) || {}
    const out = {}
    for (const k of SEED_KEYS) if (seed[k] !== undefined) out[k] = seed[k]
    return out
  } catch {
    return {}
  }
}

export function loadConfig() {
  if (cache) return cache
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(configFile(), 'utf-8').replace(/^\uFEFF/, ''))
  } catch {
    // 首次运行：用内置初始令牌（若存在）
    saved = readSeedConfig()
  }
  cache = { ...DEFAULTS, ...saved }
  return cache
}

/** 合并保存配置（部分字段），返回最新配置 */
export function saveConfig(patch) {
  const cfg = loadConfig()
  Object.assign(cfg, patch)
  try {
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf-8')
  } catch (err) {
    console.error('保存配置失败：', err.message)
  }
  return cfg
}

export function clearCredentials() {
  return saveConfig({
    accessToken: '',
    accessTokenExpiresAt: 0,
    refreshToken: '',
    clientId: '',
    clientSecret: ''
  })
}

/** 弹幕设置归一化：读取与保存都走它，避免脏值进 config.json / 脏值喂给弹幕插件 */
export function normalizeDanmaku(input) {
  const D = DEFAULTS.danmaku
  const d = input && typeof input === 'object' ? input : {}
  const num = (v, lo, hi, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
  }
  // 支持像素数字或 "25%" 百分比（artplayer-plugin-danmuku 的 margin/fontSize 都吃这两种）
  const size = (v, dflt) => {
    if (typeof v === 'string' && /^[0-9]{1,3}([.][0-9]+)?%$/.test(v)) return v
    return num(v, 0, 500, dflt)
  }
  const modes = Array.isArray(d.modes) ? d.modes.map(Number).filter((m) => m === 0 || m === 1 || m === 2) : []
  const margin = Array.isArray(d.margin) ? d.margin : []
  return {
    visible: d.visible !== false,
    opacity: num(d.opacity, 0, 1, D.opacity),
    fontSize: size(d.fontSize, D.fontSize),
    speed: num(d.speed, 1, 10, D.speed),
    margin: [size(margin[0], D.margin[0]), size(margin[1], D.margin[1])],
    modes: modes.length ? Array.from(new Set(modes)).sort() : D.modes.slice(),
    antiOverlap: d.antiOverlap !== false,
    synchronousPlayback: !!d.synchronousPlayback,
    color: typeof d.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color.toUpperCase() : D.color,
    mode: num(d.mode, 0, 2, D.mode)
  }
}

/** 序列化给渲染层。本地个人工具（默认仅 127.0.0.1 监听），设置页需可回显编辑已存凭证 */
export function publicConfig() {
  const c = loadConfig()
  return {
    configured: !!(c.clientId && c.clientSecret && c.refreshToken),
    clientId: c.clientId || '',
    clientSecret: c.clientSecret || '',
    refreshToken: c.refreshToken || '',
    rootFolderPath: c.rootFolderPath,
    orderBy: c.orderBy,
    orderDirection: c.orderDirection,
    potplayerPath: c.potplayerPath,
    mpvPath: c.mpvPath,
    vlcPath: c.vlcPath,
    playerMode: c.playerMode || 'web',
    ffmpegPath: c.ffmpegPath,
    port: c.port,
    hostBind: c.hostBind,
    alistDir: c.alistDir,
    subFontScale: Number(c.subFontScale) || 0.05,
    subOutline: Number(c.subOutline) || 1.4,
    subShadow: Number(c.subShadow) || 0.6,
    subWeight: normalizeSubWeight(c.subWeight),
    skipEnabled: c.skipEnabled !== false,
    skipAutoOp: !!c.skipAutoOp,
    skipAutoEd: !!c.skipAutoEd,
    skipDelaySec: Number.isFinite(Number(c.skipDelaySec)) ? Number(c.skipDelaySec) : 2,
    skipUseChapters: c.skipUseChapters !== false,
    skipUseSubtitles: c.skipUseSubtitles !== false,
    danmaku: normalizeDanmaku(c.danmaku),
    subtitleFontPath: c.subtitleFontPath || '',
    hasAccessToken: !!c.accessToken
  }
}

/** 字幕粗细：normal | medium | bold（其余值一律回落到 medium） */
export function normalizeSubWeight(v) {
  const s = String(v || '').toLowerCase()
  // 默认 normal：不改字幕文件自己的粗细
  return s === 'medium' || s === 'bold' ? s : 'normal'
}
