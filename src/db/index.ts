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
        // Table for repository memory (REPO_MEMORY.md content)
        `CREATE TABLE IF NOT EXISTS repo_memory (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_id      INTEGER NOT NULL REFERENCES repos(id),
            content      TEXT NOT NULL,
            created_at   TEXT DEFAULT (datetime('now')),
            updated_at   TEXT DEFAULT (datetime('now')),
            UNIQUE(repo_id)
        );`,
        `CREATE INDEX IF NOT EXISTS idx_repo_memory_repo ON repo_memory(repo_id);`,
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
        `CREATE INDEX IF NOT EXISTS idx_pr_auto_merge ON pr_auto_merge_config(repo_owner, repo_name, pr_number);`,
        // Table for conflict resolution file patterns (which files to auto-resolve vs. escalate)
        `CREATE TABLE IF NOT EXISTS conflict_resolution_patterns (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_id         INTEGER NOT NULL REFERENCES repos(id),
            pattern         TEXT NOT NULL,
            action          TEXT NOT NULL CHECK(action IN ('auto_resolve', 'escalate', 'ignore')),
            priority        INTEGER DEFAULT 0,
            created_at      TEXT DEFAULT (datetime('now')),
            updated_at      TEXT DEFAULT (datetime('now')),
            UNIQUE(repo_id, pattern)
        );`,
        `CREATE INDEX IF NOT EXISTS idx_conflict_patterns_repo ON conflict_resolution_patterns(repo_id);`,
        // Table for tracking conflict resolution attempts
        `CREATE TABLE IF NOT EXISTS conflict_resolution_history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_owner      TEXT NOT NULL,
            repo_name       TEXT NOT NULL,
            pr_number       INTEGER NOT NULL,
            pr_title        TEXT,
            attempt_number  INTEGER DEFAULT 1,
            status          TEXT NOT NULL CHECK(status IN ('started', 'success', 'failed', 'escalated')),
            conflicted_files TEXT, -- JSON array of files with conflicts
            resolved_files  TEXT, -- JSON array of files that were resolved
            escalated_files TEXT, -- JSON array of files that were escalated
            error_message   TEXT,
            resolution_time_ms INTEGER,
            created_at      TEXT DEFAULT (datetime('now'))
        );`,
        `CREATE INDEX IF NOT EXISTS idx_conflict_history_repo ON conflict_resolution_history(repo_owner, repo_name);`,
        `CREATE INDEX IF NOT EXISTS idx_conflict_history_pr ON conflict_resolution_history(repo_owner, repo_name, pr_number);`,
        `CREATE INDEX IF NOT EXISTS idx_conflict_history_status ON conflict_resolution_history(status);`,
        // Table for tracking future fix issues created from PR comments
        `CREATE TABLE IF NOT EXISTS future_fix_issues (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_owner      TEXT NOT NULL,
            repo_name       TEXT NOT NULL,
            pr_number       INTEGER NOT NULL,
            comment_id      INTEGER NOT NULL,
            comment_body    TEXT NOT NULL,
            issue_number    INTEGER,
            issue_url       TEXT,
            status          TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'created', 'failed')),
            created_at      TEXT DEFAULT (datetime('now')),
            updated_at      TEXT DEFAULT (datetime('now')),
            UNIQUE(repo_owner, repo_name, comment_id)
        );`,
        `CREATE INDEX IF NOT EXISTS idx_future_fix_repo ON future_fix_issues(repo_owner, repo_name);`,
        `CREATE INDEX IF NOT EXISTS idx_future_fix_pr ON future_fix_issues(repo_owner, repo_name, pr_number);`,
        `CREATE INDEX IF NOT EXISTS idx_future_fix_status ON future_fix_issues(status);`
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

    // Migration: Add stale_pr_days and max_resolution_attempts to repo_auto_merge_config
    try {
        await db.execute("ALTER TABLE repo_auto_merge_config ADD COLUMN stale_pr_days INTEGER DEFAULT 7");
    } catch (e: any) {
        // Ignore if column already exists
    }
    try {
        await db.execute("ALTER TABLE repo_auto_merge_config ADD COLUMN max_resolution_attempts INTEGER DEFAULT 3");
    } catch (e: any) {
        // Ignore if column already exists
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
    stale_pr_days: number; // Days before a PR is considered stale
    max_resolution_attempts: number; // Maximum auto-resolution attempts before escalating
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

// Update the updateRepoAutoMergeConfig function to handle new columns
export async function updateRepoAutoMergeConfigExtended(
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
    if (config.stale_pr_days !== undefined) { fields.push('stale_pr_days = ?'); args.push(config.stale_pr_days); }
    if (config.max_resolution_attempts !== undefined) { fields.push('max_resolution_attempts = ?'); args.push(config.max_resolution_attempts); }
    
    if (fields.length === 0) return;
    
    fields.push('updated_at = datetime("now")');
    args.push(repoId);
    
    await getDb().execute({
        sql: `UPDATE repo_auto_merge_config SET ${fields.join(', ')} WHERE repo_id = ?`,
        args
    });
}

// Conflict Resolution Pattern Types
export interface ConflictResolutionPattern {
    id: number;
    repo_id: number;
    pattern: string;
    action: 'auto_resolve' | 'escalate' | 'ignore';
    priority: number;
    created_at: string;
    updated_at: string;
}

// Get all conflict resolution patterns for a repository
export async function getConflictResolutionPatterns(repoId: number): Promise<ConflictResolutionPattern[]> {
    const rs = await getDb().execute({
        sql: `SELECT * FROM conflict_resolution_patterns 
              WHERE repo_id = ? 
              ORDER BY priority DESC, created_at ASC`,
        args: [repoId]
    });
    return rs.rows as unknown as ConflictResolutionPattern[];
}

// Add a conflict resolution pattern
export async function addConflictResolutionPattern(
    repoId: number,
    pattern: string,
    action: 'auto_resolve' | 'escalate' | 'ignore',
    priority: number = 0
): Promise<number> {
    const rs = await getDb().execute({
        sql: `INSERT OR REPLACE INTO conflict_resolution_patterns 
              (repo_id, pattern, action, priority, updated_at)
              VALUES (?, ?, ?, ?, datetime('now'))`,
        args: [repoId, pattern, action, priority]
    });
    return Number(rs.lastInsertRowid);
}

// Delete a conflict resolution pattern
export async function deleteConflictResolutionPattern(patternId: number): Promise<void> {
    await getDb().execute({
        sql: `DELETE FROM conflict_resolution_patterns WHERE id = ?`,
        args: [patternId]
    });
}

// Determine action for a file based on patterns
export async function getActionForFile(
    repoId: number,
    filePath: string
): Promise<'auto_resolve' | 'escalate' | 'ignore'> {
    const patterns = await getConflictResolutionPatterns(repoId);
    
    for (const pattern of patterns) {
        // Convert glob pattern to regex
        const regex = new RegExp('^' + pattern.pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        if (regex.test(filePath)) {
            return pattern.action;
        }
    }
    
    // Default to auto_resolve if no patterns match
    return 'auto_resolve';
}

// Conflict Resolution History Types
export interface ConflictResolutionHistory {
    id: number;
    repo_owner: string;
    repo_name: string;
    pr_number: number;
    pr_title: string | null;
    attempt_number: number;
    status: 'started' | 'success' | 'failed' | 'escalated';
    conflicted_files: string[] | null;
    resolved_files: string[] | null;
    escalated_files: string[] | null;
    error_message: string | null;
    resolution_time_ms: number | null;
    created_at: string;
}

// Create a conflict resolution attempt record
export async function createConflictResolutionAttempt(
    repoOwner: string,
    repoName: string,
    prNumber: number,
    prTitle: string,
    conflictedFiles: string[]
): Promise<number> {
    // Get the next attempt number for this PR
    const rs = await getDb().execute({
        sql: `SELECT MAX(attempt_number) as max_attempt FROM conflict_resolution_history 
              WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`,
        args: [repoOwner, repoName, prNumber]
    });
    const attemptNumber = ((rs.rows[0]?.max_attempt as number) || 0) + 1;
    
    const result = await getDb().execute({
        sql: `INSERT INTO conflict_resolution_history 
              (repo_owner, repo_name, pr_number, pr_title, attempt_number, status, conflicted_files)
              VALUES (?, ?, ?, ?, ?, 'started', ?)`,
        args: [repoOwner, repoName, prNumber, prTitle, attemptNumber, JSON.stringify(conflictedFiles)]
    });
    return Number(result.lastInsertRowid);
}

// Update a conflict resolution attempt
export async function updateConflictResolutionAttempt(
    attemptId: number,
    status: 'success' | 'failed' | 'escalated',
    resolvedFiles?: string[],
    escalatedFiles?: string[],
    errorMessage?: string,
    resolutionTimeMs?: number
): Promise<void> {
    await getDb().execute({
        sql: `UPDATE conflict_resolution_history 
              SET status = ?, 
                  resolved_files = ?, 
                  escalated_files = ?, 
                  error_message = ?, 
                  resolution_time_ms = ?
              WHERE id = ?`,
        args: [
            status,
            resolvedFiles ? JSON.stringify(resolvedFiles) : null,
            escalatedFiles ? JSON.stringify(escalatedFiles) : null,
            errorMessage || null,
            resolutionTimeMs || null,
            attemptId
        ]
    });
}

// Get conflict resolution history for a PR
export async function getConflictResolutionHistory(
    repoOwner: string,
    repoName: string,
    prNumber: number
): Promise<ConflictResolutionHistory[]> {
    const rs = await getDb().execute({
        sql: `SELECT * FROM conflict_resolution_history 
              WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?
              ORDER BY attempt_number ASC`,
        args: [repoOwner, repoName, prNumber]
    });
    return (rs.rows as unknown as any[]).map(row => ({
        ...row,
        conflicted_files: row.conflicted_files ? JSON.parse(row.conflicted_files) : null,
        resolved_files: row.resolved_files ? JSON.parse(row.resolved_files) : null,
        escalated_files: row.escalated_files ? JSON.parse(row.escalated_files) : null
    })) as ConflictResolutionHistory[];
}

// Get the number of failed attempts for a PR
export async function getFailedResolutionAttemptCount(
    repoOwner: string,
    repoName: string,
    prNumber: number
): Promise<number> {
    const rs = await getDb().execute({
        sql: `SELECT COUNT(*) as count FROM conflict_resolution_history 
              WHERE repo_owner = ? AND repo_name = ? AND pr_number = ? AND status IN ('failed', 'escalated')`,
        args: [repoOwner, repoName, prNumber]
    });
    return (rs.rows[0]?.count as number) || 0;
}

// Get success rate statistics for conflict resolution
export async function getConflictResolutionStats(
    repoOwner?: string,
    repoName?: string
): Promise<{ total: number; success: number; failed: number; escalated: number; successRate: number }> {
    let sql = `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) as escalated
    FROM conflict_resolution_history`;
    const args: (string | number)[] = [];
    
    if (repoOwner && repoName) {
        sql += ` WHERE repo_owner = ? AND repo_name = ?`;
        args.push(repoOwner, repoName);
    }
    
    const rs = await getDb().execute({ sql, args });
    const row = rs.rows[0] as any;
    const total = (row?.total as number) || 0;
    const success = (row?.success as number) || 0;
    const failed = (row?.failed as number) || 0;
    const escalated = (row?.escalated as number) || 0;
    const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
    
    return { total, success, failed, escalated, successRate };
}

// Future Fix Issues Types
export interface FutureFixIssue {
    id: number;
    repo_owner: string;
    repo_name: string;
    pr_number: number;
    comment_id: number;
    comment_body: string;
    issue_number: number | null;
    issue_url: string | null;
    status: 'pending' | 'created' | 'failed';
    created_at: string;
    updated_at: string;
}

// Track a future fix comment for issue creation
export async function trackFutureFixComment(
    repoOwner: string,
    repoName: string,
    prNumber: number,
    commentId: number,
    commentBody: string
): Promise<number> {
    const rs = await getDb().execute({
        sql: `INSERT OR IGNORE INTO future_fix_issues 
              (repo_owner, repo_name, pr_number, comment_id, comment_body, status)
              VALUES (?, ?, ?, ?, ?, 'pending')`,
        args: [repoOwner, repoName, prNumber, commentId, commentBody]
    });
    return Number(rs.lastInsertRowid);
}

// Update future fix issue with created issue details
export async function updateFutureFixIssue(
    repoOwner: string,
    repoName: string,
    commentId: number,
    issueNumber: number,
    issueUrl: string,
    status: 'created' | 'failed'
): Promise<void> {
    await getDb().execute({
        sql: `UPDATE future_fix_issues 
              SET issue_number = ?, issue_url = ?, status = ?, updated_at = datetime('now')
              WHERE repo_owner = ? AND repo_name = ? AND comment_id = ?`,
        args: [issueNumber, issueUrl, status, repoOwner, repoName, commentId]
    });
}

// Get pending future fix issues for a PR
export async function getPendingFutureFixIssues(
    repoOwner: string,
    repoName: string,
    prNumber: number
): Promise<FutureFixIssue[]> {
    const rs = await getDb().execute({
        sql: `SELECT * FROM future_fix_issues 
              WHERE repo_owner = ? AND repo_name = ? AND pr_number = ? AND status = 'pending'
              ORDER BY created_at ASC`,
        args: [repoOwner, repoName, prNumber]
    });
    return rs.rows as unknown as FutureFixIssue[];
}

// Get all future fix issues for a PR
export async function getFutureFixIssuesForPR(
    repoOwner: string,
    repoName: string,
    prNumber: number
): Promise<FutureFixIssue[]> {
    const rs = await getDb().execute({
        sql: `SELECT * FROM future_fix_issues 
              WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?
              ORDER BY created_at ASC`,
        args: [repoOwner, repoName, prNumber]
    });
    return rs.rows as unknown as FutureFixIssue[];
}

// Check if a future fix comment is already tracked
export async function isFutureFixTracked(
    repoOwner: string,
    repoName: string,
    commentId: number
): Promise<boolean> {
    const rs = await getDb().execute({
        sql: `SELECT id FROM future_fix_issues 
              WHERE repo_owner = ? AND repo_name = ? AND comment_id = ?`,
        args: [repoOwner, repoName, commentId]
    });
    return rs.rows.length > 0;
}
