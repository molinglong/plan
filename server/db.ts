import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 跟随启动目录：本地 dev 是 plan/data，容器里是 /app/data（挂载卷）。
// 不用 import.meta.url —— 生产把服务端打成单文件后，目录层级会变。
const dataDir = join(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

// 测试可指定内存库，日常数据仍保存在原来的位置。
export const db = new DatabaseSync(process.env.PLAN_DB_PATH || join(dataDir, 'plan.db'))

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS items (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL DEFAULT 'me',
    title          TEXT NOT NULL,
    note           TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL DEFAULT 'task',
    status         TEXT NOT NULL DEFAULT 'inbox',
    priority       INTEGER NOT NULL DEFAULT 1,
    estimate_min   INTEGER NOT NULL DEFAULT 30,
    energy         TEXT NOT NULL DEFAULT 'any',
    planned_date   TEXT,
    start_min      INTEGER,
    end_min        INTEGER,
    reason         TEXT,
    done           INTEGER NOT NULL DEFAULT 0,
    postpone_count INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_status ON items(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_items_date ON items(user_id, planned_date);

  CREATE TABLE IF NOT EXISTS external_refs (
    base_url       TEXT NOT NULL,
    owner_id       TEXT NOT NULL,
    external_id    TEXT NOT NULL,
    item_id        TEXT UNIQUE,
    dismissed      INTEGER NOT NULL DEFAULT 0,
    missing        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (base_url, owner_id, external_id)
  );
`)
