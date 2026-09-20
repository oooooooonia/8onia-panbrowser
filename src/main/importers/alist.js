import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { saveConfig } from '../config.js'

/** 从本机正在运行的 AList 数据目录只读导入 BaiduNetdisk 凭证 */

// node:sqlite 不可用时的备用读取器（写入临时目录后交给系统 node 执行）
const DUMP_SOURCE = `import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
const dbPath = process.argv[2]
if (!dbPath || !fs.existsSync(dbPath)) { console.error('db not found'); process.exit(1) }
let db
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT id, driver, mount_path, status, disabled, addition FROM x_storages').all()
  const out = rows.map((r) => {
    let addition = {}
    try { addition = JSON.parse(r.addition || '{}') } catch { addition = {} }
    return { id: r.id, driver: r.driver, mount_path: r.mount_path, status: r.status, disabled: !!r.disabled, addition }
  })
  process.stdout.write(JSON.stringify(out))
} finally { if (db) db.close() }
`

/** 在 dir 下定位 data.db（兼容 db 直接在目录 / data/ 子目录 / 传入 db 文件本身） */
export function locateDb(dir) {
  if (!dir) return null
  if (fs.existsSync(dir) && fs.statSync(dir).isFile() && dir.toLowerCase().endsWith('.db')) return dir
  const cands = [
    path.join(dir, 'data.db'),
    path.join(dir, 'data', 'data.db'),
    path.join(dir, 'alist', 'data', 'data.db'),
    path.join(dir, 'var', 'alist', 'data.db')
  ]
  for (const c of cands) if (fs.existsSync(c)) return c
  // 浅层递归找 *.db（不超过 2 层），排除日志目录
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const found = []
    const walk = (d, depth) => {
      if (depth > 2) return
      let ents = []
      try {
        ents = fs.readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) {
          if (!['log', 'logs', 'temp', 'cache', '.git'].includes(e.name.toLowerCase())) walk(p, depth + 1)
        } else if (e.name.endsWith('.db')) {
          found.push(p)
          if (found.length >= 8) return
        }
      }
    }
    walk(dir, 0)
    if (found.length) return found[0]
  }
  return null
}

/** 读取 storages 列表（只输出驱动与挂载信息，不含明文密钥字段值） */
export function describeStorages(rows) {
  return rows.map((r) => ({
    id: r.id,
    driver: r.driver,
    mountPath: r.mount_path,
    status: r.status,
    disabled: !!r.disabled,
    fields: Object.keys(r.addition || {})
  }))
}

/** 实际读取数据（Electron Node 22 无 node:sqlite 时回退到系统 node 24 执行 dump 脚本） */
async function dumpRows(dbPath) {
  // 方案 1：当前进程直接使用 node:sqlite
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare("SELECT id, driver, mount_path, status, disabled, addition FROM x_storages")
      .all()
    db.close()
    return rows.map((r) => {
      let addition = {}
      try {
        addition = JSON.parse(r.addition || '{}')
      } catch {
        addition = {}
      }
      return {
        id: r.id,
        driver: r.driver,
        mount_path: r.mount_path,
        status: r.status,
        disabled: !!r.disabled,
        addition
      }
    })
  } catch {
    /* 当前运行时无 node:sqlite，走系统 node */
  }
  // 方案 2：当前运行时无 node:sqlite —— 写临时 mjs 交给系统 node 执行（兼容打包后 asar 环境）
  const tmp = path.join(os.tmpdir(), `pan-alist-dump-${Date.now()}.mjs`)
  fs.writeFileSync(tmp, DUMP_SOURCE, 'utf-8')
  const out = await new Promise((resolve, reject) => {
    const child = spawn('node', [tmp, dbPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => (stdout += b))
    child.stderr.on('data', (b) => (stderr += b))
    child.on('error', () => {
      reject(new Error('系统未找到 node，无法读取 AList 数据库；请在本机安装 Node.js，或在设置页手动填写凭证'))
    })
    child.on('close', (code) => {
      fs.unlink(tmp, () => {})
      if (code !== 0) return reject(new Error(`读取 AList 数据库失败：${stderr.trim() || `exit ${code}`}`))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('解析 AList 数据库输出失败'))
      }
    })
  })
  return out
}

/** 扫描：定位 db 并列出百度网盘相关存储 */
export async function scanAlist(dir) {
  const dbPath = locateDb(dir)
  if (!dbPath) throw new Error('未找到 data.db，请确认 AList 数据目录（含 data.db 的目录）')
  const rows = await dumpRows(dbPath)
  const storages = rows
    .filter((r) => /baidu/i.test(r.driver) && !r.disabled)
    .map((r) => ({ id: r.id, driver: r.driver, mountPath: r.mount_path, status: r.status, fields: Object.keys(r.addition) }))
  return { dbPath, storages }
}

/** 导入指定存储的百度凭证到本应用配置 */
export async function importFromAlist(dbPath, storageId) {
  const rows = await dumpRows(dbPath)
  const row = rows.find((r) => r.id === storageId && /baidu/i.test(r.driver))
  if (!row) throw new Error(`未找到 id=${storageId} 的百度网盘存储`)
  const a = row.addition || {}
  if (!a.refresh_token || !a.client_id || !a.client_secret) {
    throw new Error(`该存储缺少完整凭证（refresh_token / client_id / client_secret），请检查 AList 存储配置`)
  }
  const cfg = saveConfig({
    clientId: String(a.client_id),
    clientSecret: String(a.client_secret),
    refreshToken: String(a.refresh_token),
    accessToken: String(a.AccessToken || a.access_token || ''),
    accessTokenExpiresAt: 0,
    rootFolderPath: a.root_folder_path || '/'
  })
  return {
    driver: row.driver,
    mountPath: row.mount_path,
    rootFolderPath: cfg.rootFolderPath,
    fromAlist: true
  }
}
