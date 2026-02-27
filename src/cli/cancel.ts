import chalk from "chalk";
import Table from "cli-table3";
import { getDb } from "../db/index.js";
import { 
    getRunningTasks, 
    cancelTask, 
    cancelAllTasks, 
    getTaskStats 
} from "../tasks/manager.js";
import { readConfig } from "./config-store.js";

async function isDaemonRunning(): Promise<{ running: boolean; port?: number }> {
    const config = readConfig();
    if (!config) return { running: false };
    
    const port = config.daemonPort || 4242;
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { 
            signal: AbortSignal.timeout(1000) 
        });
        if (response.ok) {
            return { running: true, port };
        }
    } catch {
        // Daemon not running
    }
    return { running: false };
}

export async function cancelCommand(
    action: string | undefined, 
    target: string | undefined, 
    options: { force?: boolean }
) {
    // If no action provided, show running tasks
    if (!action) {
        await listRunningTasks();
        return;
    }

    switch (action.toLowerCase()) {
        case "list":
        case "ls":
            await listRunningTasks();
            break;

        case "stop":
        case "cancel":
            if (!target) {
                console.log(chalk.red("❌ Error: Task ID required"));
                console.log(chalk.gray("Usage: gitybara cancel stop <job-id>"));
                console.log(chalk.gray("   or: gitybara cancel stop all"));
                return;
            }

            if (target.toLowerCase() === "all") {
                await cancelAll(options.force || false);
            } else {
                const jobId = parseInt(target, 10);
                if (isNaN(jobId)) {
                    console.log(chalk.red(`❌ Error: Invalid task ID "${target}"`));
                    return;
                }
                await cancelSingle(jobId, options.force || false);
            }
            break;

        default:
            console.log(chalk.red(`❌ Unknown action: ${action}`));
            console.log(chalk.gray("Available actions: list, stop"));
            console.log(chalk.gray("\nExamples:"));
            console.log(chalk.gray("  gitybara cancel list          # List all running tasks"));
            console.log(chalk.gray("  gitybara cancel stop 123      # Cancel task with ID 123"));
            console.log(chalk.gray("  gitybara cancel stop all      # Cancel all running tasks"));
            console.log(chalk.gray("  gitybara cancel stop 123 -f   # Force cancel task 123"));
    }
}

async function listRunningTasks() {
    // Try to fetch from daemon if running
    const daemon = await isDaemonRunning();
    let stats;
    
    if (daemon.running && daemon.port) {
        try {
            const response = await fetch(`http://127.0.0.1:${daemon.port}/tasks`, {
                signal: AbortSignal.timeout(2000)
            });
            if (response.ok) {
                const data = await response.json();
                stats = {
                    running: data.running,
                    tasks: data.tasks.map((t: any) => ({
                        jobId: t.jobId,
                        issueNumber: t.issueNumber,
                        repo: t.repo,
                        branch: t.branch,
                        duration: t.duration
                    }))
                };
            } else {
                stats = getTaskStats();
            }
        } catch {
            stats = getTaskStats();
        }
    } else {
        stats = getTaskStats();
    }
    
    console.log(chalk.bold.cyan("\n🦫 Gitybara Running Tasks\n"));

    if (stats.running === 0) {
        console.log(chalk.gray("No tasks currently running."));
        console.log(chalk.gray("\nTip: Start the daemon to begin processing issues.\n"));
        return;
    }

    console.log(chalk.bold(`Active Tasks: ${chalk.cyan(stats.running)}\n`));

    const table = new Table({
        head: [
            chalk.bold("Job ID"),
            chalk.bold("Issue"),
            chalk.bold("Repository"),
            chalk.bold("Branch"),
            chalk.bold("Duration"),
        ],
        style: { head: [], border: [] },
    });

    for (const task of stats.tasks) {
        const duration = formatDuration(task.duration);
        table.push([
            chalk.yellow(task.jobId.toString()),
            `#${task.issueNumber}`,
            task.repo,
            chalk.cyan(task.branch),
            duration,
        ]);
    }

    console.log(table.toString());

    console.log(chalk.gray("\nTo cancel a task, run:"));
    console.log(chalk.gray("  gitybara cancel stop <job-id>"));
    console.log(chalk.gray("  gitybara cancel stop all      # Cancel all tasks\n"));
}

async function cancelSingle(jobId: number, force: boolean) {
    console.log(chalk.bold.cyan("\n🦫 Gitybara Task Cancellation\n"));
    
    // Try to cancel via daemon if running
    const daemon = await isDaemonRunning();
    let result;
    
    if (daemon.running && daemon.port) {
        try {
            const response = await fetch(`http://127.0.0.1:${daemon.port}/tasks/${jobId}/cancel?force=${force}`, {
                method: "POST",
                signal: AbortSignal.timeout(5000)
            });
            
            if (response.ok) {
                result = await response.json();
            } else {
                const error = await response.json();
                result = { success: false, message: error.error || "Failed to cancel task" };
            }
        } catch (e: any) {
            // Fall back to local task manager
            result = await cancelTask(jobId, force);
        }
    } else {
        // Use local task manager
        result = await cancelTask(jobId, force);
    }
    
    if (result.success) {
        console.log(chalk.green(`✅ ${result.message}`));
    } else {
        console.log(chalk.red(`❌ ${result.message}`));
    }
    console.log();
}

async function cancelAll(force: boolean) {
    console.log(chalk.bold.cyan("\n🦫 Gitybara Task Cancellation\n"));
    
    // Try to cancel via daemon if running
    const daemon = await isDaemonRunning();
    let result;
    
    if (daemon.running && daemon.port) {
        try {
            const response = await fetch(`http://127.0.0.1:${daemon.port}/tasks/cancel-all?force=${force}`, {
                method: "POST",
                signal: AbortSignal.timeout(10000)
            });
            
            if (response.ok) {
                const data = await response.json();
                result = {
                    success: data.success,
                    cancelled: data.cancelled,
                    failed: data.failed,
                    messages: data.messages
                };
            } else {
                const error = await response.json();
                result = {
                    success: false,
                    cancelled: 0,
                    failed: 0,
                    messages: [error.error || "Failed to cancel tasks"]
                };
            }
        } catch (e: any) {
            // Fall back to local task manager
            result = await cancelAllTasks(force);
        }
    } else {
        // Use local task manager
        result = await cancelAllTasks(force);
    }
    
    const totalTasks = result.cancelled + result.failed;
    if (totalTasks === 0) {
        console.log(chalk.gray("No tasks are currently running."));
        console.log();
        return;
    }

    console.log(chalk.yellow(`Cancelling ${totalTasks} task(s)...\n`));
    
    for (const msg of result.messages) {
        if (result.success) {
            console.log(chalk.green(`✅ ${msg}`));
        } else {
            console.log(chalk.red(`❌ ${msg}`));
        }
    }

    console.log(chalk.bold(`\nCancelled: ${result.cancelled}, Failed: ${result.failed}\n`));
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * List all jobs (including non-running) with their status
 */
export async function listJobsCommand(options: { 
    status?: string; 
    limit?: number;
    json?: boolean;
}) {
    const db = getDb();
    let sql = "SELECT * FROM jobs ORDER BY updated_at DESC";
    const args: any[] = [];

    if (options.status) {
        sql = "SELECT * FROM jobs WHERE status = ? ORDER BY updated_at DESC";
        args.push(options.status);
    }

    if (options.limit) {
        sql += " LIMIT ?";
        args.push(options.limit);
    } else {
        sql += " LIMIT 20";
    }

    const rs = await db.execute({ sql, args });
    const jobs = rs.rows;

    if (options.json) {
        console.log(JSON.stringify(jobs, null, 2));
        return;
    }

    console.log(chalk.bold.cyan("\n🦫 Gitybara Jobs\n"));

    if (jobs.length === 0) {
        console.log(chalk.gray("No jobs found."));
        console.log();
        return;
    }

    const table = new Table({
        head: [
            chalk.bold("ID"),
            chalk.bold("Repository"),
            chalk.bold("Issue"),
            chalk.bold("Status"),
            chalk.bold("Branch"),
            chalk.bold("Updated"),
        ],
        style: { head: [], border: [] },
    });

    for (const row of jobs) {
        const status = row.status as string;
        const statusColor = getStatusColor(status);
        
        table.push([
            row.id as number,
            `${row.repo_owner}/${row.repo_name}`,
            `#${row.issue_number}`,
            statusColor,
            (row.branch as string) || "-",
            new Date(row.updated_at as string).toLocaleString(),
        ]);
    }

    console.log(table.toString());
    console.log();
}

function getStatusColor(status: string): string {
    switch (status) {
        case "done":
            return chalk.green(status);
        case "in-progress":
            return chalk.yellow(status);
        case "pending":
            return chalk.gray(status);
        case "failed":
            return chalk.red(status);
        case "cancelled":
            return chalk.magenta(status);
        case "waiting":
            return chalk.blue(status);
        default:
            return status;
    }
}
