import fs from "fs";
import path from "path";
import { execa } from "execa";
import { GlobalConfig } from "../cli/config-store.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("daemon-cleanup");

export async function cleanupOldRuns(config: GlobalConfig) {
    if (config.repos.length === 0) return;
    const reposDir = path.dirname(config.repos[0].clonePath);
    if (!fs.existsSync(reposDir)) return;

    try {
        const items = fs.readdirSync(reposDir);
        const now = Date.now();
        for (const item of items) {
            if (item.startsWith("run-") || item.startsWith("gitybara-issue-") || item.startsWith("gb-i")) {
                const fullPath = path.join(reposDir, item);
                try {
                    const stat = fs.statSync(fullPath);
                    // No automatic cleanup per user request to avoid EBUSY/data loss.
                    // If older than 30 mins
                    if (now - stat.mtimeMs > 30 * 60 * 1000) {
                        log.debug({ fullPath }, "Run directory is stale (will not delete automatically)");
                    }
                } catch (e) {
                    // Ignore
                }
            }
        }

        // Prune worktrees in all shared clones
        for (const repo of config.repos) {
            if (fs.existsSync(repo.clonePath)) {
                try {
                    await execa("git", ["worktree", "prune"], { cwd: repo.clonePath });
                } catch { }
            }
        }
    } catch (e) {
        log.warn({ err: e }, "Failed during cleanup routine");
    }
}
