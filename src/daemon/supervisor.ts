import fs from "fs";
import path from "path";
import { rimrafSync } from "rimraf";
import { GlobalConfig } from "../cli/config-store.js";
import { runOpenCode } from "../opencode/runner.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("daemon-supervisor");

// =============================================================================
// SUPERVISOR / SELF-HEALING HELPER
// =============================================================================

const WINDOWS_RESERVED_NAMES = new Set([
    "nul", "con", "prn", "aux",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
]);

/**
 * Recursively walk a directory and delete any file whose base name (no ext,
 * case-insensitive) is a Windows-reserved device name (nul, con, prn, etc.).
 * Uses \\?\ extended paths to bypass Windows restriction on these names.
 */
export function removeReservedWindowsFiles(dir: string): void {
    if (!fs.existsSync(dir)) return;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const baseName = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
            if (WINDOWS_RESERVED_NAMES.has(baseName)) {
                log.warn({ file: fullPath }, "🧹 Removing reserved Windows filename before git add");
                try {
                    rimrafSync(`\\\\?\\${fullPath}`);
                } catch {
                    try { rimrafSync(fullPath); } catch { /* ignore */ }
                }
            } else if (entry.isDirectory() && entry.name !== ".git") {
                removeReservedWindowsFiles(fullPath);
            }
        }
    } catch { /* ignore scan errors */ }
}

export interface HealingOptions {
    /** Directory where the healing OpenCode session runs */
    healingDir: string;
    /** Short human-readable context about the issue being worked on */
    issueContext: string;
    config: GlobalConfig;
    selectedProvider?: string;
    selectedModel?: string;
    /** How many times to retry after a healing session. Default: 2 */
    maxRetries?: number;
}

/**
 * Supervisor wrapper: runs `fn`, and if it throws, starts an OpenCode
 * healing session describing the error + context, then retries up to
 * `maxRetries` times. Only rethrows once all retries are exhausted.
 */
export async function runWithHealing<T>(
    stageName: string,
    fn: () => Promise<T>,
    opts: HealingOptions
): Promise<T> {
    const maxRetries = opts.maxRetries ?? 2;
    let lastErr: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastErr = err;
            const errMsg = err?.message ?? String(err);

            // Don't heal cancellations
            if (errMsg.includes("cancelled")) throw err;

            if (attempt >= maxRetries) break;

            log.warn(
                { stage: stageName, attempt: attempt + 1, maxRetries, err: errMsg },
                `🩺 [supervisor] Stage "${stageName}" failed — starting healing session (attempt ${attempt + 1}/${maxRetries})`
            );

            const healPrompt =
                `You are the Gitybara self-healing supervisor.\n` +
                `A pipeline stage called "${stageName}" just failed with this error:\n\n` +
                `${errMsg}\n\n` +
                `Context — the issue being worked on:\n${opts.issueContext}\n\n` +
                `Your job:\n` +
                `1. Analyze the error carefully.\n` +
                `2. Fix whatever caused it (e.g. illegal filenames, missing files, git state issues, dependency errors, wrong code, etc.).\n` +
                `3. Do NOT re-run the original task. Only fix the environment/state so that the pipeline can continue.\n` +
                `4. If no files need to change (e.g. a transient network error), just output a short explanation.`;

            try {
                await runOpenCode(
                    opts.config.opencodePath,
                    opts.healingDir,
                    healPrompt,
                    opts.selectedProvider,
                    opts.selectedModel
                );
                log.info({ stage: stageName, attempt: attempt + 1 }, "🩺 [supervisor] Healing session completed, retrying stage");
            } catch (healErr: any) {
                log.error({ stage: stageName, err: healErr?.message ?? String(healErr) }, "🩺 [supervisor] Healing session itself failed, retrying stage anyway");
            }
        }
    }
    throw lastErr;
}

/**
 * Gently attempts to remove a git worktree. If `git worktree remove` fails (common on Windows
 * due to locked files), we just log it and move on. The user can clean up manually if needed.
 */
export async function nukeWorktree(clonePath: string, workDir: string): Promise<void> {
    const { execa } = await import("execa");
    try {
        // Try standard git removal first
        await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
    } catch (err: any) {
        // If it fails, it's likely a file lock on Windows. 
        // We just prune the metadata so git doesn't think the worktree is still active.
        log.info({ workDir }, "📂 Worktree directory is locked or busy. Preserving for manual cleanup.");
        try {
            await execa("git", ["worktree", "prune"], { cwd: clonePath });
        } catch { /* ignore */ }
    }
}
