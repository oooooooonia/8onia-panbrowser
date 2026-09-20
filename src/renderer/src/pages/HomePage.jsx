import { useEffect, useMemo, useState } from 'react'
import {
  Home, ChevronRight, ArrowUp, RefreshCw, List, LayoutGrid, Search, X,
  Play, Download, Link2, MonitorPlay, FolderInput, FileText, Pencil
} from 'lucide-react'
import { useApp } from '../store/app'
import FileIcon from '../components/FileIcon'
import { api, downloadUrl, copyText, thumbUrl, isDesktop } from '../lib/api'
import { formatSize, formatTime } from '../lib/format'

function crumbs(path) {
  if (!path || path === '/') return []
  return path
    .split('/')
    .filter(Boolean)
    .map((seg, i, arr) => ({ name: seg, path: '/' + arr.slice(0, i + 1).join('/') }))
}

export default function HomePage() {
  const { path, entries, loading, error, sort, view, setView, setSort, loadDir, openPlayer, notify, searching, setSearch, runSearch, searchResults, searchKey } =
    useApp()
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState(path)
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    setInput(path)
    setEditing(false)
  }, [path])

  useEffect(() => {
    // 仅首次挂载自动加载；后续导航全部由点击/刷新显式触发
    loadDir(path, sort, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const crumbList = useMemo(() => crumbs(path), [path])

  const parentPath = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/'

  const commitPath = (e) => {
    e.preventDefault()
    let p = input.trim().replace(/\\/g, '/')
    if (!p.startsWith('/')) p = '/' + p
    p = p.replace(/\/{2,}/g, '/')
    if (!p.endsWith('/') && p !== '/') {
      // 交给后端：如果输入的是目录路径则直接进入
    }
    setSearch(false)
    loadDir(p || '/', sort)
  }

  const toggleSort = (by) => {
    if (sort.by === by) setSort(by, !sort.desc)
    else setSort(by, false)
  }

  const doOpen = (e) => {
    e.stopPropagation()
    if (e.isDir) return navigate(e)
    openPlayer(e)
  }

  const navigate = (item) => {
    if (item.isDir) {
      setSearch(false)
      loadDir(item.path, sort)
    }
  }

  const copyLink = async (item) => {
    try {
      const r = await api.rawlink(item.path)
      const ok = await copyText(r.base)
      notify(ok ? '已复制原画直链（访问需 UA: pan.baidu.com，见播放器提示）' : '复制失败', ok ? 'ok' : 'error')
    } catch (err) {
      notify(err.message, 'error')
    }
  }

  const pot = async (item) => {
    try {
      const r = await api.openPotplayer(item.path)
      notify(`已用 PotPlayer 播放`, 'ok')
    } catch (err) {
      notify(err.message, 'error')
    }
  }

  const openPotSilent = pot

  const onSearchInput = async (e) => {
    const v = e.target.value
    setSearchText(v)
    if (v.trim().length >= 1) {
      try {
        await runSearch(v.trim())
      } catch {
        /* ignore */
      }
    }
  }

  const rows = searching && searchKey ? searchResults : entries

  return (
    <div className="page">
      {/* 工具栏 */}
      <div className="home-toolbar">
        <button className="icon-btn" title="回到根目录" onClick={() => { setSearch(false); loadDir('/', sort) }}>
          <Home size={17} />
        </button>
        {parentPath ? (
          <button className="icon-btn" title="上级目录" onClick={() => { setSearch(false); loadDir(parentPath, sort) }}>
            <ArrowUp size={17} />
          </button>
        ) : null}
        <button className="icon-btn" title="刷新" onClick={() => loadDir(path, sort, true)}>
          <RefreshCw size={16} />
        </button>

        {searching ? (
          <div className="searchbox">
            <Search size={14} />
            <input
              autoFocus
              value={searchText}
              onChange={onSearchInput}
              placeholder="搜索当前目录及子目录…"
            />
            <button className="icon-btn" onClick={() => { setSearch(false); setSearchText('') }}>
              <X size={15} />
            </button>
          </div>
        ) : (
          <>
            <button
              className="icon-btn"
              title="搜索"
              onClick={() => setSearch(true)}
            >
              <Search size={16} />
            </button>
            <div className="spacer" />
            <span className={`chip-btn ${sort.by === 'name' ? 'on' : ''}`} onClick={() => toggleSort('name')}>
              名称
            </span>
            <span className={`chip-btn ${sort.by === 'time' ? 'on' : ''}`} onClick={() => toggleSort('time')}>
              时间
            </span>
            <span className={`chip-btn ${sort.by === 'size' ? 'on' : ''}`} onClick={() => toggleSort('size')}>
              大小
            </span>
            <span className="chip-btn dim-txt" title={sort.desc ? '降序' : '升序'} onClick={() => setSort(sort.by, !sort.desc)}>
              {sort.desc ? '↓' : '↑'}
            </span>
            <div className="vsep" />
            <button className={`icon-btn ${view === 'list' ? 'on' : ''}`} title="列表视图" onClick={() => setView('list')}>
              <List size={16} />
            </button>
            <button className={`icon-btn ${view === 'grid' ? 'on' : ''}`} title="网格视图" onClick={() => setView('grid')}>
              <LayoutGrid size={16} />
            </button>
          </>
        )}
      </div>

      {/* 路径条 */}
      <div className="crumb-bar">
        {editing ? (
          <form className="crumb-edit" onSubmit={commitPath}>
            <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} onBlur={commitPath} />
          </form>
        ) : (
          <button className="crumb-click" onClick={() => setEditing(true)} title="点击编辑路径">
            <Pencil size={11} className="crumb-pencil" />
            <span className="crumb-root">/</span>
            {crumbList.map((c, i) => (
              <span key={i} className="crumb-seg" onClick={(e) => { e.stopPropagation(); loadDir(c.path, sort) }}>
                {c.name}
              </span>
            ))}
          </button>
        )}
        <span className="dim count-txt">
          {searching && searchKey ? `${searchResults.length} 条结果` : `${entries.filter((x) => x.isDir).length} 个文件夹 · ${entries.filter((x) => !x.isDir).length} 个文件`}
        </span>
      </div>

      {/* 内容 */}
      {loading ? (
        <div className="center-tip">加载中…</div>
      ) : error ? (
        <div className="error-card">
          <div className="error-title">加载失败</div>
          <div className="error-msg">{error}</div>
          <button className="btn small" onClick={() => loadDir(path, sort)}>
            <RefreshCw size={13} /> 重试
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="center-tip empty-tip">
          <FolderInput size={34} />
          {searching ? '没有找到匹配的文件' : '此目录为空'}
        </div>
      ) : view === 'grid' ? (
        <div className="grid-wrap">
          {rows.map((item) => {
            const media = item.kind === 'video' || item.kind === 'audio'
            return (
              <div key={item.path} className={`cell ${item.isDir ? 'is-dir' : ''}`} onClick={() => navigate(item)}>
                <div className="cell-ic" onClick={(e) => { if (!item.isDir) { e.stopPropagation(); openPlayer(item) } }}>
                  {item.kind === 'image' && item.hasThumb ? (
                    <img className="cell-thumb" loading="lazy" src={thumbUrl(item.path)} alt="" />
                  ) : (
                    <FileIcon kind={item.kind} size={46} />
                  )}
                  {item.kind === 'video' ? <span className="cell-badge play-badge">▶</span> : null}
                </div>
                <div className="cell-name name-full" title={item.name}>{item.name}</div>
                <div className="cell-sub">{item.isDir ? '文件夹' : formatSize(item.size)}</div>
                {!item.isDir ? (
                  <div className="cell-actions" onClick={(e) => e.stopPropagation()}>
                    {media ? (
                      <>
                        <button className="icon-btn small" title="在线播放" onClick={() => openPlayer(item)}>
                          <Play size={13} />
                        </button>
                        {isDesktop ? (
                          <button className="icon-btn small" title="PotPlayer 播放" onClick={() => openPotSilent(item)}>
                            <MonitorPlay size={13} />
                          </button>
                        ) : item.kind === 'video' && window.AndroidBridge && window.AndroidBridge.openExternal ? (
                          <button className="icon-btn small" title="VLC 播放（原生支持内嵌字幕）" onClick={() => { try { window.AndroidBridge.openExternal(item.path) } catch (e) { notify('请安装 VLC', 'error') } }}>
                            <MonitorPlay size={13} />
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    <button className="icon-btn small" title="下载" onClick={() => window.open(downloadUrl(item.path))}>
                      <Download size={13} />
                    </button>
                    <button className="icon-btn small" title="复制直链" onClick={() => copyLink(item)}>
                      <Link2 size={13} />
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="list-wrap">
          {rows.map((item) => {
            const media = item.kind === 'video' || item.kind === 'audio'
            return (
              <div
                key={item.path}
                className="row"
                onClick={() => (item.isDir ? navigate(item) : item.kind === 'image' ? openPlayer(item) : media ? openPlayer(item) : null)}
              >
                <FileIcon kind={item.kind} size={20} />
                <span className="row-name name-full" title={item.name}>{item.name}</span>
                <span className="row-size">{item.isDir ? '—' : formatSize(item.size)}</span>
                <span className="row-time">{formatTime(item.mtime)}</span>
                <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {media ? (
                    <>
                      <button className="icon-btn small" title="在线播放" onClick={() => openPlayer(item)}>
                        <Play size={14} />
                      </button>
                      {isDesktop ? (
                        <button className="icon-btn small" title="PotPlayer 播放" onClick={() => pot(item)}>
                          <MonitorPlay size={14} />
                        </button>
                      ) : item.kind === 'video' && window.AndroidBridge && window.AndroidBridge.openExternal ? (
                        <button className="icon-btn small" title="VLC 播放（原生支持内嵌字幕）" onClick={() => { try { window.AndroidBridge.openExternal(item.path) } catch (e) { notify('请安装 VLC', 'error') } }}>
                          <MonitorPlay size={14} />
                        </button>
                      ) : null}
                    </>
                  ) : item.kind === 'image' ? (
                    <button className="icon-btn small" title="预览" onClick={() => openPlayer(item)}>
                      <FileText size={14} />
                    </button>
                  ) : null}
                  {!item.isDir ? (
                    <>
                      <button className="icon-btn small" title="下载" onClick={() => window.open(downloadUrl(item.path))}>
                        <Download size={14} />
                      </button>
                      <button className="icon-btn small" title="复制直链" onClick={() => copyLink(item)}>
                        <Link2 size={14} />
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
