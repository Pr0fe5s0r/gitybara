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
        `CREATE INDEX IF NOT EXISTS idx_rules_repo ON rules(repo_id);`,
        // Table for tracking processed PR/issue comments to avoid duplicate processing
        `CREATE TABLE IF NOT EXISTS processed_comments (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_owner   TEXT NOT NULL,
            repo_name    TEXT NOT NULL,
            issue_number INTEGER NOT NULL,
            comment_id   INTEGER NOT NULL,
            comment_body TEXT,
            comment_hash TEXT NOT NULL,
            processed_at TEXT DEFAULT (datetime('now')),
            status       TEXT DEFAULT 'processed',
            UNIQUE(repo_owner, repo_name, comment_id)
        );`,
    `CREATE INDEX IF NOT EXISTS idx_processed_comments_repo ON processed_comments(repo_owner, repo_name);`,
        `CREATE INDEX IF NOT EXISTS idx_processed_comments_issue ON processed_comments(issue_number);`,
        // Table for repository auto-merge configuration
        `CREATE TABLE IF NOT EXISTS repo_auto_merge_config (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_id         INTEGER NOT NULL REFERENCES repos(id),
            enabled         INTEGER DEFAULT 1,
            auto_merge_clean INTEGER DEFAULT 1,
            auto_resolve_conflicts INTEGER DEFAULT 1,
            merge_method    TEXT DEFAULT 'merge' CHECK(merge_method IN ('merge', 'squash', 'rebase')),
            require_checks  INTEGER DEFAULT 0,
            require_reviews INTEGER DEFAULT 0,
            created_at      TEXT DEFAULT (datetime('now')),
            updated_at      TEXT DEFAULT (datetime('now')),
            UNIQUE(repo_id)
        );`,
        `CREATE INDEX IF NOT EXISTS idx_repo_auto_merge ON repo_auto_merge_config(repo_id);`,
        // Table for PR-specific auto-merge configuration
        `CREATE TABLE IF NOT EXISTS pr_auto_merge_config (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_owner      TEXT NOT NULL,
            repo_name       TEXT NOT NULL,
            pr_number       INTEGER NOT NULL,
            enabled         INTEGER DEFAULT 1,
            merge_method    TEXT DEFAULT 'merge' CHECK(merge_method IN ('merge', 'squash', 'rebase')),
            created_at      TEXT DEFAULT (datetime('now')),
            updated_at      TEXT DEFAULT (datetime('now')),
            UNIQUE(repo_owner, repo_name, pr_number)
        );`,
        `CREATE INDEX IF NOT EXISTS idx_pr_auto_merge ON pr_auto_merge_config(repo_owner, repo_name, pr_number);`
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

/**
 * Cancel a job by ID - updates status to cancelled
 */
export async function cancelJob(
    id: number,
    reason?: string
): Promise<boolean> {
    try {
        await getDb().execute({
            sql: `UPDATE jobs SET status = 'cancelled', error = ?, updated_at = datetime('now')
           WHERE id = ? AND status IN ('pending', 'in-progress')`,
            args: [reason || 'Cancelled by user', id]
        });
        return true;
    } catch (e: any) {
        return false;
    }
}

/**
 * Get pending and in-progress jobs
 */
export async function getActiveJobs(): Promise<JobRecord[]> {
    const rs = await getDb().execute({
        sql: `SELECT id, status, updated_at, force_new_branch, branch, pr_url FROM jobs
       WHERE status IN ('pending', 'in-progress')
       ORDER BY created_at ASC`,
        args: []
    });
    return rs.rows as unknown as JobRecord[];
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
    branch: string | null;
    pr_url: string | null;
};

export async function getJobByIssue(
    repoOwner: string,
    repoName: string,
    issueNumber: number
): Promise<JobRecord | null> {
    const rs = await getDb().execute({
        sql: `SELECT id, status, updated_at, force_new_branch, branch, pr_url FROM jobs
       WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
       ORDER BY updated_at DESC LIMIT 1`,
        args: [repoOwner, repoName, issueNumber]
    });
    if (rs.rows.length === 0) return null;
    return rs.rows[0] as unknown as JobRecord;
}

export interface ProcessedComment {
    id: number;
    repo_owner: string;
    repo_name: string;
    issue_number: number;
    comment_id: number;
    comment_body: string | null;
    comment_hash: string;
    processed_at: string;
    status: string;
}

/**
 * Check if a comment has already been processed
 */
export async function isCommentProcessed(
    repoOwner: string,
    repoName: string,
    commentId: number
): Promise<boolean> {
    const rs = await getDb().execute({
        sql: `SELECT id FROM processed_comments 
       WHERE repo_owner = ? AND repo_name = ? AND comment_id = ?`,
        args: [repoOwner, repoName, commentId]
    });
    return rs.rows.length > 0;
}

/**
 * Mark a comment as processed
 */
export async function markCommentProcessed(
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    commentId: number,
    commentBody: string,
    status: string = 'processed'
): Promise<void> {
    // Create a hash of the comment body to detect edits
    const crypto = await import('crypto');
    const commentHash = crypto.createHash('sha256').update(commentBody).digest('hex');

    await getDb().execute({
        sql: `INSERT OR REPLACE INTO processed_comments 
       (repo_owner, repo_name, issue_number, comment_id, comment_body, comment_hash, status, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [repoOwner, repoName, issueNumber, commentId, commentBody, commentHash, status]
    });
}

/**
 * Get all processed comments for an issue/PR
 */
export async function getProcessedCommentsForIssue(
    repoOwner: string,
    repoName: string,
    issueNumber: number
): Promise<ProcessedComment[]> {
    const rs = await getDb().execute({
        sql: `SELECT * FROM processed_comments 
       WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
       ORDER BY processed_at DESC`,
        args: [repoOwner, repoName, issueNumber]
    });
    return rs.rows as unknown as ProcessedComment[];
}

/**
 * Get the last processed comment timestamp for an issue/PR
 */
export async function getLastProcessedCommentTime(
    repoOwner: string,
    repoName: string,
    issueNumber: number
): Promise<string | null> {
    const rs = await getDb().execute({
        sql: `SELECT MAX(processed_at) as last_time FROM processed_comments 
       WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?`,
        args: [repoOwner, repoName, issueNumber]
    });
    if (rs.rows.length === 0 || !rs.rows[0].last_time) return null;
    return rs.rows[0].last_time as string;
}

export interface RepoAutoMergeConfig {
    id: number;
    repo_id: number;
    enabled: number;
    auto_merge_clean: number;
    auto_resolve_conflicts: number;
    merge_method: 'merge' | 'squash' | 'rebase';
    require_checks: number;
    require_reviews: number;
    created_at: string;
    updated_at: string;
}

export interface PRAutoMergeConfig {
    id: number;
    repo_owner: string;
    repo_name: string;
    pr_number: number;
    enabled: number;
    merge_method: 'merge' | 'squash' | 'rebase';
    created_at: string;
    updated_at: string;
}

/**
 * Get or create auto-merge configuration for a repository
 */
export async function getRepoAutoMergeConfig(repoId: number): Promise<RepoAutoMergeConfig | null> {
    const rs = await getDb().execute({
        sql: `SELECT * FROM repo_auto_merge_config WHERE repo_id = ?`,
        args: [repoId]
    });
    if (rs.rows.length === 0) {
        // Create default config
        await getDb().execute({
            sql: `INSERT INTO repo_auto_merge_config (repo_id, enabled, auto_merge_clean, auto_resolve_conflicts, merge_method)
                  VALUES (?, 1, 1, 1, 'merge')`,
            args: [repoId]
        });
        return getRepoAutoMergeConfig(repoId);
    }
    return rs.rows[0] as unknown as RepoAutoMergeConfig;
}

/**
 * Update repository auto-merge configuration
 */
export async function updateRepoAutoMergeConfig(
    repoId: number,
    config: Partial<Omit<RepoAutoMergeConfig, 'id' | 'repo_id' | 'created_at' | 'updated_at'>>
): Promise<void> {
    const fields: string[] = [];
    const args: (string | number)[] = [];
    
    if (config.enabled !== undefined) { fields.push('enabled = ?'); args.push(config.enabled); }
    if (config.auto_merge_clean !== undefined) { fields.push('auto_merge_clean = ?'); args.push(config.auto_merge_clean); }
    if (config.auto_resolve_conflicts !== undefined) { fields.push('auto_resolve_conflicts = ?'); args.push(config.auto_resolve_conflicts); }
    if (config.merge_method !== undefined) { fields.push('merge_method = ?'); args.push(config.merge_method); }
    if (config.require_checks !== undefined) { fields.push('require_checks = ?'); args.push(config.require_checks); }
    if (config.require_reviews !== undefined) { fields.push('require_reviews = ?'); args.push(config.require_reviews); }
    
    if (fields.length === 0) return;
    
    fields.push('updated_at = datetime("now")');
    args.push(repoId);
    
    await getDb().execute({
        sql: `UPDATE repo_auto_merge_config SET ${fields.join(', ')} WHERE repo_id = ?`,
        args
    });
}

/**
 * Get or create auto-merge configuration for a specific PR
 */
export async function getPRAutoMergeConfig(
    repoOwner: string,
    repoName: string,
    prNumber: number
): Promise<PRAutoMergeConfig | null> {
    const rs = await getDb().execute({
        sql: `SELECT * FROM pr_auto_merge_config WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`,
        args: [repoOwner, repoName, prNumber]
    });
    if (rs.rows.length === 0) return null;
    return rs.rows[0] as unknown as PRAutoMergeConfig;
}

/**
 * Set auto-merge configuration for a specific PR
 */
export async function setPRAutoMergeConfig(
    repoOwner: string,
    repoName: string,
    prNumber: number,
    enabled: boolean,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'
): Promise<void> {
    await getDb().execute({
        sql: `INSERT OR REPLACE INTO pr_auto_merge_config 
              (repo_owner, repo_name, pr_number, enabled, merge_method, updated_at)
              VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        args: [repoOwner, repoName, prNumber, enabled ? 1 : 0, mergeMethod]
    });
}

/**
 * Delete PR-specific auto-merge configuration
 */
export async function deletePRAutoMergeConfig(
    repoOwner: string,
    repoName: string,
    prNumber: number
): Promise<void> {
    await getDb().execute({
        sql: `DELETE FROM pr_auto_merge_config WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`,
        args: [repoOwner, repoName, prNumber]
    });
}
