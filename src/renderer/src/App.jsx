import { useEffect, useState } from 'react'
import { HardDrive, FolderOpen, Settings as SettingsIcon, Loader2, CircleAlert, CircleCheck, Info } from 'lucide-react'
import { useApp } from './store/app'
import HomePage from './pages/HomePage'
import SettingsPage from './pages/SettingsPage'
import PlayerModal from './components/PlayerModal'
import ErrorBoundary from './components/ErrorBoundary'

export default function App() {
  const server = useApp((s) => s.server)
  const booting = useApp((s) => s.booting)
  const refreshStatus = useApp((s) => s.refreshStatus)
  const toasts = useApp((s) => s.toasts)
  const player = useApp((s) => s.player)
  const [page, setPage] = useState('files')

  useEffect(() => {
    refreshStatus().catch(() => {})
  }, [refreshStatus])

  const configured = !!(server && server.config && server.config.configured)

  useEffect(() => {
    if (!booting && !configured && page === 'files') setPage('settings')
  }, [booting, configured, page])

  // 手机返回键协议：关闭播放器 → 返回上级目录 → 根目录返回 "root"（宿主做双按退出）
  useEffect(() => {
    window.__panBack = () => {
      try {
        const st = useApp.getState()
        if (st.player) {
          st.closePlayer()
          return 'handled'
        }
        if (st.path && st.path !== '/') {
          const parent = st.path.lastIndexOf('/') <= 0 ? '/' : st.path.slice(0, st.path.lastIndexOf('/'))
          st.loadDir(parent, st.sort)
          return 'handled'
        }
        return 'root'
      } catch {
        return 'none'
      }
    }
    return () => {
      try {
        delete window.__panBack
      } catch { /* ignore */ }
    }
  }, [])

  const account = server?.account || null

  return (
    <div className="app">
      <header className="appbar">
        <button className="brand" onClick={() => setPage('files')}>
          <HardDrive size={19} />
          <span>PanBrowser</span>
        </button>
        <button className="acct-chip" onClick={() => setPage('settings')}>
          {booting ? <Loader2 size={13} className="spin" /> : configured ? (
            <>
              <i className="dot ok" />
              <span className="ellip">{account ? account.netdiskName || account.baiduName : '已挂载'}</span>
            </>
          ) : (
            <>
              <i className="dot warn" />
              <span>未挂载 · 设置</span>
            </>
          )}
        </button>
      </header>

      <main className="content">
        <ErrorBoundary onReset={() => setPage('files')}>
          {page === 'files' ? <HomePage /> : <SettingsPage />}
        </ErrorBoundary>
      </main>

      <nav className="bottom-nav">
        <button className={page === 'files' ? 'on' : ''} onClick={() => setPage('files')}>
          <FolderOpen size={20} />
          <span>文件</span>
        </button>
        <button className={page === 'settings' ? 'on' : ''} onClick={() => setPage('settings')}>
          <SettingsIcon size={20} />
          <span>设置</span>
        </button>
      </nav>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === 'ok' ? <CircleCheck size={15} /> : t.type === 'error' ? <CircleAlert size={15} /> : <Info size={15} />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>

      <ErrorBoundary onReset={() => { try { useApp.getState().closePlayer() } catch { /* ignore */ } }}>
        <PlayerModal key={player ? player.path : 'none'} />
      </ErrorBoundary>
    </div>
  )
}
