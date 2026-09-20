import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api as net } from '../lib/api'

const isMedia = (e) => e && (e.kind === 'video' || e.kind === 'audio')

export const useApp = create(
  persist(
    (set, get) => ({
      // 服务器/账号状态
      server: null, // {config, account, potplayer, server}
      booting: true,
      refreshStatus: async () => {
        const s = await net.status()
        set({ server: s, booting: false })
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
      partialize: (s) => ({ sort: s.sort, view: s.view, playerMode: s.playerMode })
    }
  )
)
