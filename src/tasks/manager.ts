import { createLogger } from "../utils/logger.js";
import { updateJob } from "../db/index.js";
import { execa } from "execa";
import { rimrafSync } from "rimraf";
import fs from "fs";

const log = createLogger("task-manager");

export interface RunningTask {
    jobId: number;
    issueNumber: number;
    repoOwner: string;
    repoName: string;
    branchName: string;
    workDir: string;
    clonePath: string;
    abortController: AbortController;
    startedAt: Date;
    process?: any; // OpenCode process reference
}

// Global registry of running tasks
const runningTasks = new Map<number, RunningTask>();

/**
 * Register a new running task
 */
export function registerTask(task: RunningTask): void {
    runningTasks.set(task.jobId, task);
    log.info({ 
        jobId: task.jobId, 
        issue: task.issueNumber, 
        repo: `${task.repoOwner}/${task.repoName}`
    }, "Task registered");
}

/**
 * Unregister a task (when it completes normally)
 */
export function unregisterTask(jobId: number): void {
    runningTasks.delete(jobId);
    log.info({ jobId }, "Task unregistered");
}

/**
 * Get all currently running tasks
 */
export function getRunningTasks(): RunningTask[] {
    return Array.from(runningTasks.values());
}

/**
 * Get a specific running task by job ID
 */
export function getRunningTask(jobId: number): RunningTask | undefined {
    return runningTasks.get(jobId);
}

/**
 * Check if a task is currently running
 */
export function isTaskRunning(jobId: number): boolean {
    return runningTasks.has(jobId);
}

/**
 * Cancel a running task by job ID
 */
export async function cancelTask(
    jobId: number, 
    force: boolean = false
): Promise<{ success: boolean; message: string }> {
    const task = runningTasks.get(jobId);
    
    if (!task) {
        return { 
            success: false, 
            message: `Task ${jobId} is not currently running` 
        };
    }

    log.info({ jobId, force }, "Cancelling task");

    try {
        // Signal cancellation to the task
        task.abortController.abort();

        // If force is requested or task has a process, kill it
        if (force && task.process) {
            try {
                task.process.kill("SIGTERM");
                // Give it a moment to terminate gracefully
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Force kill if still running
                if (task.process.exitCode === null) {
                    task.process.kill("SIGKILL");
                }
            } catch (err) {
                log.warn({ jobId, err }, "Error killing task process");
            }
        }

        // Update job status in database
        await updateJob(
            jobId, 
            "cancelled", 
            task.branchName, 
            undefined, 
            `Task cancelled by user${force ? ' (forced)' : ''}`
        );

        // Clean up work directory
        if (fs.existsSync(task.workDir)) {
            try {
                await execa("git", ["worktree", "remove", "--force", task.workDir], { 
                    cwd: task.clonePath 
                });
            } catch {
                // Fallback to rimraf
                try {
                    rimrafSync(task.workDir, { maxRetries: 3, retryDelay: 500 });
                } catch (e) {
                    log.warn({ jobId, workDir: task.workDir }, "Failed to cleanup work directory");
                }
            }
        }

        // Remove from registry
        runningTasks.delete(jobId);

        return { 
            success: true, 
            message: `Task ${jobId} (Issue #${task.issueNumber} in ${task.repoOwner}/${task.repoName}) has been cancelled` 
        };
    } catch (err: any) {
        log.error({ jobId, err }, "Error cancelling task");
        return { 
            success: false, 
            message: `Failed to cancel task: ${err.message}` 
        };
    }
}

/**
 * Cancel all running tasks
 */
export async function cancelAllTasks(force: boolean = false): Promise<{ 
    success: boolean; 
    cancelled: number; 
    failed: number;
    messages: string[] 
}> {
    const tasks = getRunningTasks();
    const messages: string[] = [];
    let cancelled = 0;
    let failed = 0;

    for (const task of tasks) {
        const result = await cancelTask(task.jobId, force);
        if (result.success) {
            cancelled++;
        } else {
            failed++;
        }
        messages.push(result.message);
    }

    return {
        success: failed === 0,
        cancelled,
        failed,
        messages
    };
}

/**
 * Get task statistics
 */
export function getTaskStats(): {
    running: number;
    tasks: Array<{
        jobId: number;
        issueNumber: number;
        repo: string;
        branch: string;
        startedAt: Date;
        duration: number;
    }>;
} {
    const now = new Date();
    const tasks = getRunningTasks().map(task => ({
        jobId: task.jobId,
        issueNumber: task.issueNumber,
        repo: `${task.repoOwner}/${task.repoName}`,
        branch: task.branchName,
        startedAt: task.startedAt,
        duration: now.getTime() - task.startedAt.getTime()
    }));

    return {
        running: tasks.length,
        tasks
    };
}
