import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api as net } from '../lib/api'

const isMedia = (e) => e && (e.kind === 'video' || e.kind === 'audio')

/**
 * 弹幕设置的真源在服务端 userData/config.json（桌面版 / dev / 手机局域网共用同一份）。
 * 策略＝「写透 + 短防抖」：任何一次改动 600ms 后自动落盘，不依赖「退出应用」那一次机会
 * （窗口被强杀/刷新/断电时渲染层没机会发请求），再在关播放器与 pagehide/beforeunload 时各 flush 一次。
 */
const DM_SAVE_DEBOUNCE_MS = 600
let dmSaveTimer = null

function pushDanmakuToServer() {
  net
    .saveConfig({ danmaku: useApp.getState().danmakuOpt })
    .then((r) => {
      const d = r && r.config && r.config.danmaku
      // 用服务端归一化后的值回填本地镜像，避免两边慢慢漂移
      if (d) useApp.setState({ danmakuOpt: d })
    })
    .catch(() => {})
}

function scheduleDanmakuSave() {
  if (dmSaveTimer) clearTimeout(dmSaveTimer)
  dmSaveTimer = setTimeout(() => {
    dmSaveTimer = null
    pushDanmakuToServer()
  }, DM_SAVE_DEBOUNCE_MS)
}

/** 立刻把待落盘的弹幕设置写回服务端（关播放器 / 退出应用 / 页面隐藏时调用） */
export function flushDanmakuSave() {
  if (!dmSaveTimer) return
  clearTimeout(dmSaveTimer)
  dmSaveTimer = null
  pushDanmakuToServer()
}

export const useApp = create(
  persist(
    (set, get) => ({
      // 服务器/账号状态
      server: null, // {config, account, potplayer, server}
      booting: true,
      refreshStatus: async () => {
        const s = await net.status()
        const d = s && s.config && s.config.danmaku
        // 启动时用服务端 config.json 里的弹幕设置灌入本地镜像
        set({ server: s, booting: false, ...(d ? { danmakuOpt: { ...get().danmakuOpt, ...d } } : {}) })
        return s
      },

      // 文件浏览
      path: '/',
      entries: [],
      loading: false,
      error: '',
      sort: { by: 'name', desc: false },
      view: 'list',
      setView: (v) => set({ view: v }),
      setSort: (by, desc) => {
        set({ sort: { by, desc } })
        get().loadDir(get().path, { by, desc })
      },
      loadDir: async (p, srt, force) => {
        const sort = srt || get().sort
        set({ path: p, loading: true, error: '' })
        try {
          const r = await net.list(p, sort.by, sort.desc, force)
          set({ entries: r.entries, loading: false, error: '' })
        } catch (err) {
          set({ entries: [], loading: false, error: err.message })
        }
      },
      navigate: (p) => get().loadDir(p),

      // 搜索模式
      searching: false,
      searchKey: '',
      searchResults: [],
      setSearch: (open) => set({ searching: open, searchKey: '', searchResults: [] }),
      runSearch: async (key) => {
        const r = await net.search(key, get().path)
        set({ searchResults: r.entries, searchKey: key })
        return r.entries
      },

      // 播放器：网页播放器（ArtPlayer+libass，alist 同款字幕渲染）
      player: null, // {kind, name, path, size}
      openPlayer: (file) =>
        set({ player: { kind: file.kind, name: file.name, path: file.path, size: file.size } }),
      closePlayer: () => set({ player: null }),
      // 播放器偏好：web | potplayer | mpv | vlc（后三者原声支持内嵌字幕，含位图）
      playerMode: 'web',
      setPlayerMode: (m) => set({ playerMode: m }),
      // 弹幕（B 站 XML）设置：真源在服务端 config.json，这里只是内存镜像（boot 时由 refreshStatus 灌入，改动写透回服务端）
      danmakuOpt: {
        visible: true,
        opacity: 0.8,
        fontSize: 25,
        speed: 5,
        margin: [10, '25%'],
        modes: [0, 1, 2],
        antiOverlap: true,
        synchronousPlayback: false,
        color: '#FFFFFF',
        mode: 0
      },
      setDanmakuOpt: (patch) => {
        set({ danmakuOpt: { ...get().danmakuOpt, ...patch } })
        scheduleDanmakuSave()
      },

      // 全局提示
      toasts: [],
      notify: (msg, type = 'info') => {
        const id = Date.now() + Math.random()
        set({ toasts: [...get().toasts, { id, msg, type }] })
        setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 3200)
      }
    }),
    {
      name: 'pan-ui',
      // 弹幕设置不进 localStorage：真源在服务端 config.json（多端共用一份）
      partialize: (s) => ({ sort: s.sort, view: s.view, playerMode: s.playerMode })
    }
  )
)
