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
  subBold: false,
  // ---- 片头/片尾（OP/ED）跳过 ----
  skipEnabled: true, // 总开关：播放器内是否显示跳过按钮/进度条标记
  skipAutoOp: false, // 进入 OP 区间后自动跳过
  skipAutoEd: false, // 进入 ED 区间后自动跳过
  skipDelaySec: 2, // 自动跳过前的等待秒数（0 = 立即）
  skipUseChapters: true, // 使用视频文件章节（打标）
  skipUseSubtitles: true // 使用字幕信号（ASS 样式名/歌词块、跨集重复文本）
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
    subBold: !!c.subBold,
    skipEnabled: c.skipEnabled !== false,
    skipAutoOp: !!c.skipAutoOp,
    skipAutoEd: !!c.skipAutoEd,
    skipDelaySec: Number.isFinite(Number(c.skipDelaySec)) ? Number(c.skipDelaySec) : 2,
    skipUseChapters: c.skipUseChapters !== false,
    skipUseSubtitles: c.skipUseSubtitles !== false,
    hasAccessToken: !!c.accessToken
  }
}
