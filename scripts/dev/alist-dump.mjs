// AList data.db 只读导出脚本：node scripts/alist-dump.mjs <data.db 路径>
// 输出 JSON 数组 [{id,driver,mount_path,status,disabled,addition}]
import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'

const dbPath = process.argv[2]
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('usage: node scripts/alist-dump.mjs <path-to-data.db>')
  process.exit(1)
}

let db
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT id, driver, mount_path, status, disabled, addition FROM x_storages').all()
  const out = rows.map((r) => {
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
  process.stdout.write(JSON.stringify(out))
} finally {
  if (db) db.close()
}
