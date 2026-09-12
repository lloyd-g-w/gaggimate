import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { NotesPatch, ShotPayload, Workflow } from "./types.js";

export class Store {
  private db: Database.Database;
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "gaggibot.sqlite3"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shots (
        device_id TEXT NOT NULL, shot_id INTEGER NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(device_id, shot_id)
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL, shot_id INTEGER NOT NULL, user_id TEXT NOT NULL,
        channel_id TEXT, step INTEGER NOT NULL DEFAULT 0, answered_mask INTEGER NOT NULL DEFAULT 0,
        current_message_id TEXT, last_values TEXT NOT NULL DEFAULT '{}', saved_parts TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, shot_id, user_id),
        FOREIGN KEY(device_id, shot_id) REFERENCES shots(device_id, shot_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workflows_user_status ON workflows(user_id, status);
      CREATE TABLE IF NOT EXISTS feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, shot_id INTEGER NOT NULL,
        patch TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS feedback_device_id ON feedback_events(device_id, id);
      CREATE TABLE IF NOT EXISTS acknowledgements (
        device_id TEXT PRIMARY KEY, through_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  insertShot(payload: ShotPayload): boolean {
    const info = this.db.prepare("INSERT OR IGNORE INTO shots(device_id, shot_id, payload) VALUES(?,?,?)")
      .run(payload.deviceId, payload.shot.id, JSON.stringify(payload));
    return info.changes === 1;
  }
  getShot(deviceId: string, shotId: number): ShotPayload | undefined {
    const row = this.db.prepare("SELECT payload FROM shots WHERE device_id=? AND shot_id=?").get(deviceId, shotId) as {payload: string}|undefined;
    return row ? JSON.parse(row.payload) as ShotPayload : undefined;
  }
  prepareWorkflow(deviceId: string, shotId: number, userId: string, lastValues: NotesPatch): void {
    this.db.prepare("INSERT OR IGNORE INTO workflows(device_id,shot_id,user_id,last_values) VALUES(?,?,?,?)")
      .run(deviceId, shotId, userId, JSON.stringify(lastValues));
  }
  supersedeOtherWorkflows(userId: string, keepId: number): void {
    this.db.prepare("UPDATE workflows SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND id<>? AND status IN ('active','queued')")
      .run(userId, keepId);
  }
  listWorkflows(statuses: Workflow["status"][]): Workflow[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM workflows WHERE status IN (${placeholders}) ORDER BY id`).all(...statuses) as DbWorkflow[];
    return rows.map(fromDbWorkflow);
  }
  getActiveByUser(userId: string): Workflow | undefined {
    const row = this.db.prepare("SELECT * FROM workflows WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(userId) as DbWorkflow|undefined;
    return row && fromDbWorkflow(row);
  }
  saveWorkflow(w: Workflow): void {
    this.db.prepare(`UPDATE workflows SET channel_id=?,step=?,answered_mask=?,current_message_id=?,last_values=?,saved_parts=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(w.channelId, w.step, w.answeredMask, w.currentMessageId, JSON.stringify(w.lastValues), JSON.stringify(w.savedParts), w.status, w.id);
  }
  queuePatch(deviceId: string, shotId: number, patch: NotesPatch): number {
    const info = this.db.prepare("INSERT INTO feedback_events(device_id,shot_id,patch) VALUES(?,?,?)")
      .run(deviceId, shotId, JSON.stringify(patch));
    return Number(info.lastInsertRowid);
  }
  getEvents(deviceId: string, after: number, limit = 100) {
    return (this.db.prepare("SELECT id,shot_id,patch FROM feedback_events WHERE device_id=? AND id>? ORDER BY id LIMIT ?")
      .all(deviceId, after, limit) as {id:number;shot_id:number;patch:string}[])
      .map(r => ({ id: r.id, shotId: r.shot_id, patch: JSON.parse(r.patch) as NotesPatch }));
  }
  acknowledge(deviceId: string, through: number): void {
    this.db.prepare(`INSERT INTO acknowledgements(device_id,through_id) VALUES(?,?)
      ON CONFLICT(device_id) DO UPDATE SET through_id=MAX(through_id,excluded.through_id),updated_at=CURRENT_TIMESTAMP`).run(deviceId, through);
    // Keep a small audit/replay tail; acknowledged rows cannot grow without bound.
    this.db.prepare("DELETE FROM feedback_events WHERE device_id=? AND id<=MAX(0,?-100)").run(deviceId, through);
  }
  getAcknowledged(deviceId: string): number {
    const row = this.db.prepare("SELECT through_id FROM acknowledgements WHERE device_id=?").get(deviceId) as {through_id:number}|undefined;
    return row?.through_id ?? 0;
  }
  healthCheck(): boolean { return (this.db.prepare("SELECT 1 AS ok").get() as {ok:number}).ok === 1; }
  close(): void { this.db.close(); }
}

type DbWorkflow = { id:number;device_id:string;shot_id:number;user_id:string;channel_id:string|null;step:number;answered_mask:number;current_message_id:string|null;last_values:string;saved_parts:string;status:Workflow["status"] };
function fromDbWorkflow(r: DbWorkflow): Workflow {
  return { id:r.id, deviceId:r.device_id, shotId:r.shot_id, userId:r.user_id, channelId:r.channel_id, step:r.step,
    answeredMask:r.answered_mask, currentMessageId:r.current_message_id, lastValues:JSON.parse(r.last_values) as NotesPatch,
    savedParts:JSON.parse(r.saved_parts) as string[], status:r.status };
}
