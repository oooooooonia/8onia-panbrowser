import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { loadConfig, saveConfig } from './config.js'

/** 外部播放器定位与拉起：PotPlayer / mpv / VLC。
 *  这三者都是「原生播放器」，完全支持视频内封装的字幕轨（含 PGS/DVD 位图字幕），
 *  而网页播放器(ArtPlayer)做不到——这正是内嵌字幕用外挂播放器的价值所在。 */

const PLAYER_DEFS = {
  potplayer: {
    label: 'PotPlayer',
    key: 'potplayerPath',
    exeNames: ['PotPlayerMini64.exe', 'PotPlayerMini.exe', 'PotPlayer64.exe', 'PotPlayer.exe'],
    baseDirs: (root) => [
      `${root}Program Files\\DAUM\\PotPlayer`,
      `${root}Program Files (x86)\\DAUM\\PotPlayer`,
      `${root}DAUM\\PotPlayer`,
      `${root}PotPlayer`
    ]
  },
  mpv: {
    label: 'mpv',
    key: 'mpvPath',
    exeNames: ['mpv.exe'],
    baseDirs: (root) => [
      `${root}mpv`,
      `${root}Program Files\\mpv`,
      `${root}Program Files\\mpv-x86_64`,
      `${root}Program Files (x86)\\mpv`
    ]
  },
  vlc: {
    label: 'VLC',
    key: 'vlcPath',
    exeNames: ['vlc.exe'],
    baseDirs: (root) => [
      `${root}Program Files\\VideoLAN\\VLC`,
      `${root}Program Files (x86)\\VideoLAN\\VLC`
    ]
  }
}

function driveLetters() {
  const letters = []
  for (let i = 65; i <= 90; i++) {
    const d = String.fromCharCode(i)
    if (fs.existsSync(`${d}:\\`)) letters.push(`${d}:\\`)
  }
  return letters
}

function pathDirs() {
  // 简单地把 PATH 里的目录也纳入候选（mpv 常通过 scoop/choco/portable 装进 PATH）
  const out = []
  for (const raw of (process.env.PATH || '').split(';')) {
    const d = raw.trim()
    if (d) out.push(d)
  }
  return out
}

function candidateBins(name) {
  const def = PLAYER_DEFS[name]
  if (!def) return []
  const out = []
  for (const root of driveLetters()) {
    for (const base of def.baseDirs(root)) {
      for (const exe of def.exeNames) out.push(`${base}\\${exe}`)
    }
  }
  const local = process.env.LOCALAPPDATA || ''
  if (local && name === 'potplayer') {
    for (const exe of def.exeNames) {
      out.push(`${local}\\Programs\\PotPlayer\\${exe}`)
      out.push(`${local}\\PotPlayer\\${exe}`)
    }
  }
  for (const d of pathDirs()) {
    for (const exe of def.exeNames) {
      const p = path.join(d, exe)
      if (fs.existsSync(p)) out.push(p)
    }
  }
  return out
}

/** 按名查找外部播放器：配置路径 > 常见安装路径（含 PATH）。返回 '' 表示未找到。 */
export function findPlayerPath(name) {
  const def = PLAYER_DEFS[name]
  if (!def) return ''
  const cfg = loadConfig()
  const override = cfg[def.key] || ''
  if (override && fs.existsSync(override)) return override
  for (const c of candidateBins(name)) {
    if (fs.existsSync(c)) {
      if (!cfg[def.key]) saveConfig({ [def.key]: c })
      return c
    }
  }
  return ''
}

export function detectPlayer(name) {
  const p = findPlayerPath(name)
  if (p) return { found: true, path: p, label: PLAYER_DEFS[name]?.label || name }
  const dirs = []
  for (const root of driveLetters()) for (const base of PLAYER_DEFS[name]?.baseDirs(root) || []) dirs.push(base)
  return { found: false, path: '', label: PLAYER_DEFS[name]?.label || name, searched: dirs.slice(0, 8) }
}

/** 检测全体外部播放器 */
export function detectPlayers() {
  const out = {}
  for (const name of Object.keys(PLAYER_DEFS)) out[name] = detectPlayer(name)
  return out
}

/** 兼容旧接口：只返回 PotPlayer */
export function findPotplayerPath() {
  return findPlayerPath('potplayer')
}

export function detectPotplayer() {
  return detectPlayer('potplayer')
}

/** 打开一条 URL（本地流媒体地址/直链）到指定的外部播放器。
 *  name: 'potplayer' | 'mpv' | 'vlc'；overridePath 可显式指定二进制路径。 */
export function openWithPlayer(url, name = 'potplayer', overridePath = '') {
  const def = PLAYER_DEFS[name] || PLAYER_DEFS.potplayer
  if (!PLAYER_DEFS[name]) name = 'potplayer'
  const exe = overridePath || findPlayerPath(name)
  if (!exe) throw new Error(`未找到 ${def.label}，请先在设置中填写其可执行文件路径`)
  if (!fs.existsSync(exe)) throw new Error(`${def.label} 路径不存在：${exe}`)
  const child = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return { ok: true, exe, pid: child.pid, player: name }
}

/** 兼容旧接口：用 PotPlayer 打开 */
export function openWithPotplayer(url, exePath) {
  return openWithPlayer(url, 'potplayer', exePath || '')
}
