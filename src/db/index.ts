import { createClient, type Client } from "@libsql/client";
import { DB_FILE, ensureGitybaraDir } from "../cli/config-store.js";

let client: Client | null = null;

export function getDb(): Client {
    if (!client) {
        ensureGitybaraDir();
        // Use file: prefix for local SQLite
        const url = `file:${DB_FILE}`;
        client = createClient({ url });
    }
    return client;
}

export async function initDb(): Promise<void> {
    const db = getDb();

    await db.batch([
        `CREATE TABLE IF NOT EXISTS repos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      owner     TEXT NOT NULL,
      name      TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(owner, name)
    );`,
        `CREATE TABLE IF NOT EXISTS jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id      INTEGER NOT NULL REFERENCES repos(id),
      repo_owner   TEXT NOT NULL,
      repo_name    TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_title  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      branch       TEXT,
      pr_url       TEXT,
      error        TEXT,
      force_new_branch INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );`,
        `CREATE TABLE IF NOT EXISTS rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id    INTEGER NOT NULL REFERENCES repos(id),
      type       TEXT NOT NULL CHECK(type IN ('do','dont')),
      text       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_repo ON jobs(repo_id);`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_issue ON jobs(issue_number);`,
        `CREATE INDEX IF NOT EXISTS idx_rules_repo ON rules(repo_id);`
    ], "write");

    // Migration: Add force_new_branch to existing jobs table if missing
    try {
        await db.execute("ALTER TABLE jobs ADD COLUMN force_new_branch INTEGER DEFAULT 0");
    } catch (e: any) {
        // Ignore if column already exists
        if (!e.message?.includes("duplicate column name")) {
            // Only log if it's NOT a duplicate column error
            // (libsql/sqlite might throw slightly different messages)
        }
    }
}

export async function upsertRepo(owner: string, name: string): Promise<number> {
    const db = getDb();
    await db.execute({
        sql: "INSERT OR IGNORE INTO repos (owner, name) VALUES (?, ?)",
        args: [owner, name]
    });
    const rs = await db.execute({
        sql: "SELECT id FROM repos WHERE owner = ? AND name = ?",
        args: [owner, name]
    });
    return rs.rows[0].id as number;
}

export async function createJob(
    repoId: number,
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    issueTitle: string,
    forceNewBranch: boolean = false
): Promise<number> {
    const db = getDb();
    const rs = await db.execute({
        sql: `INSERT INTO jobs (repo_id, repo_owner, repo_name, issue_number, issue_title, status, force_new_branch)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        args: [repoId, repoOwner, repoName, issueNumber, issueTitle, forceNewBranch ? 1 : 0]
    });
    return Number(rs.lastInsertRowid);
}

export async function updateJob(
    id: number,
    status: string,
    branch?: string,
    prUrl?: string,
    error?: string
): Promise<void> {
    await getDb().execute({
        sql: `UPDATE jobs SET status = ?, branch = ?, pr_url = ?, error = ?, updated_at = datetime('now')
       WHERE id = ?`,
        args: [status, branch || null, prUrl || null, error || null, id]
    });
}

export async function isIssueProcessed(
    repoOwner: string,
    repoName: string,
    issueNumber: number
): Promise<boolean> {
    const rs = await getDb().execute({
        sql: `SELECT id FROM jobs
       WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
         AND status IN ('pending','in-progress','done')`,
        args: [repoOwner, repoName, issueNumber]
    });
    return rs.rows.length > 0;
}

export async function resetStaleJobs(): Promise<number> {
    const rs = await getDb().execute({
        sql: `UPDATE jobs SET status = 'failed', error = 'Daemon forcefully restarted while processing'
       WHERE status IN ('pending', 'in-progress')`,
        args: []
    });
    return Number(rs.rowsAffected);
}

export type JobRecord = {
    id: number;
    status: string;
    updated_at: string;
    force_new_branch: number;
};

export async function getJobByIssue(
    repoOwner: string,
    repoName: string,
    issueNumber: number
): Promise<JobRecord | null> {
    const rs = await getDb().execute({
        sql: `SELECT id, status, updated_at, force_new_branch FROM jobs
       WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
       ORDER BY updated_at DESC LIMIT 1`,
        args: [repoOwner, repoName, issueNumber]
    });
    if (rs.rows.length === 0) return null;
    return rs.rows[0] as unknown as JobRecord;
}
