import { simpleGit, SimpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import pLimit from "p-limit";
import { v4 as uuidv4 } from "uuid";
import { execa } from "execa";
import { rimrafSync } from "rimraf";
import { GlobalConfig, RepoConfig } from "../cli/config-store.js";
import { createGitHubClient } from "../github/client.js";
import { listOpenIssues } from "../github/issues.js";
import { createBranch, issueToBranchName } from "../github/branches.js";
import { openPR, listOpenPRs, getPR, enableAutoMerge, mergePullRequest, isAutoMergeEnabled } from "../github/prs.js";
import { commentOnIssue, labelIssue, ensureModelLabels, getIssueComments } from "../github/issues.js";
import { runOpenCode, encodeWorkspacePath } from "../opencode/runner.js";
import { getAvailableModels } from "../opencode/models.js";
import { getRules, buildSystemPrompt } from "../learning/engine.js";
import {
    upsertRepo,
    createJob,
    updateJob,
    getJobByIssue,
    cancelJob,
    getRepoAutoMergeConfig,
    getPRAutoMergeConfig,
    RepoAutoMergeConfig,
    getActionForFile,
    createConflictResolutionAttempt,
    updateConflictResolutionAttempt,
    getFailedResolutionAttemptCount,
    getConflictResolutionHistory
} from "../db/index.js";
import { createLogger } from "../utils/logger.js";
import { registerTask, unregisterTask, cancelTask } from "../tasks/manager.js";
import { findActionableComments, buildFixPrompt, postFixResponse, CommentMonitorConfig } from "../monitor/comments.js";

const log = createLogger("daemon-loop");

let cachedModels: { providerId: string, modelId: string }[] | null = null;
const ensuredRepos = new Set<string>();

export async function runDaemon(config: GlobalConfig, port: number) {
    // Start HTTP server in background
    const { startServer } = await import("./server.js");
    startServer(port);

    // Start WhatsApp Listener in background (won't block if not configured)
    const { startWhatsappDaemon } = await import("../whatsapp/client.js");
    startWhatsappDaemon(config).catch(err => log.error({ err }, "WhatsApp daemon failed to start"));

    // Start Telegram Listener in background (won't block if not configured)
    const { startTelegramDaemon } = await import("../telegram/client.js");
    startTelegramDaemon(config).catch(err => log.error({ err }, "Telegram daemon failed to start"));

    log.info(
        { repos: config.repos.map((r) => `${r.owner}/${r.repo}`) },
        `🦫 Gitybara daemon started — polling every ${config.pollingIntervalMinutes}m`
    );

    // Graceful shutdown
    process.on("SIGTERM", () => {
        log.info("SIGTERM received, shutting down.");
        process.exit(0);
    });
    process.on("SIGINT", () => {
        log.info("SIGINT received, shutting down.");
        process.exit(0);
    });

    // Initial poll immediately, then on interval
    await pollAllRepos(config);
    const intervalMs = config.pollingIntervalMinutes * 60 * 1000;
    setInterval(() => {
        pollAllRepos(config).catch((e) => log.error({ e }, "Poll error"));
    }, intervalMs);

    // Periodic cleanup of abandoned runs every 10 minutes
    setInterval(() => {
        cleanupOldRuns(config).catch((e) => log.error({ e }, "Cleanup error"));
    }, 10 * 60 * 1000);

    // Keep process alive
    await new Promise(() => { });
}

async function cleanupOldRuns(config: GlobalConfig) {
    if (config.repos.length === 0) return;
    const reposDir = path.dirname(config.repos[0].clonePath);
    if (!fs.existsSync(reposDir)) return;

    try {
        const items = fs.readdirSync(reposDir);
        const now = Date.now();
        for (const item of items) {
            if (item.startsWith("run-") || item.startsWith("gitybara-issue-")) {
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

async function pollAllRepos(config: GlobalConfig) {
    for (const repoConfig of config.repos) {
        try {
            await processRepo(config, repoConfig);
        } catch (e) {
            log.error({ e, repo: `${repoConfig.owner}/${repoConfig.repo}` }, "Error processing repo");
        }
    }
}

async function processRepo(config: GlobalConfig, repoConfig: RepoConfig) {
    const { owner, repo, issueLabel, baseBranch, clonePath } = repoConfig;
    const octokit = createGitHubClient(config.githubToken);

    log.info({ owner, repo, label: issueLabel || "(none)" }, "Polling for new issues and PRs…");
    const issues = await listOpenIssues(octokit, owner, repo, issueLabel);
    const prs = await listOpenPRs(octokit, owner, repo);
    const candidatePRs = prs.filter(pr => pr.labels.some((l: any) => l.name === issueLabel));

    log.info({ repo: `${owner}/${repo}`, issues: issues.length, prs: candidatePRs.length }, "Scan results");
    const repoId = await upsertRepo(owner, repo);

    if (!cachedModels) {
        log.info("Fetching available models from OpenCode SDK...");
        try {
            cachedModels = await getAvailableModels();
            log.info(`Found ${cachedModels.length} models`);
        } catch (e) {
            log.warn({ e }, "Failed to fetch OpenCode models, using defaults only.");
            cachedModels = [];
        }
    }

    const repoKey = `${owner}/${repo}`;
    if (!ensuredRepos.has(repoKey) && cachedModels && cachedModels.length > 0) {
        log.info(`Syncing model labels for ${repoKey} in the background (this will not block issue processing)...`);
        // Run in background to avoid blocking the polling loop
        ensureModelLabels(octokit, owner, repo, cachedModels).catch(e => {
            log.warn({ e }, `Failed to ensure labels for ${repoKey}`);
        });
        ensuredRepos.add(repoKey);
    }

    if (issues.length > 0) {
        log.info({ clonePath }, "Ensuring shared repository cache is up to date...");
        const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
        if (!fs.existsSync(clonePath)) {
            await execa("git", ["clone", remoteWithToken, clonePath]);
        } else {
            try {
                const sharedGit = simpleGit(clonePath);
                await sharedGit.remote(["set-url", "origin", remoteWithToken]);
                await sharedGit.fetch("origin");
            } catch (err) {
                log.warn({ err }, "Failed to update shared repo cache, continuing anyway");
            }
        }
    }

    const limit = pLimit(3); // Process up to 3 issues concurrently per repo

    const issuePromises = issues.map(issue => limit(async () => {
        // 0. Check interactive status
        const existingJob = await getJobByIssue(owner, repo, issue.number);
        const comments = await getIssueComments(octokit, owner, repo, issue.number);

        const jobId = existingJob ? existingJob.id : await createJob(repoId, owner, repo, issue.number, issue.title);

        if (existingJob) {
            if (existingJob.status === "done") {
                // If the user removed the 'done' label, they want us to try again.
                if (!issue.labels.includes("gitybara:done")) {
                    log.info({ issue: issue.number }, "Label 'gitybara:done' removed, re-evaluating issue.");
                    await updateJob(jobId, "pending", existingJob.branch || "");
                } else {
                    // Still marked as done. Check for actionable comments.
                    const commentConfig: CommentMonitorConfig = {
                        enabled: true,
                        autoApplyFixes: true,
                        skipBotComments: true,
                        actionableKeywords: [
                            'fix', 'change', 'update', 'modify', 'correct', 'improve',
                            'please fix', 'can you fix', 'need to fix', 'should fix',
                            'change request', 'requested changes', 'please address',
                            'update the', 'modify the', 'fix the', 'correct the'
                        ]
                    };

                    const actionable = await findActionableComments(octokit, owner, repo, issue.number, false, commentConfig);
                    if (actionable.length > 0) {
                        log.info({ issue: issue.number }, "Found new actionable comments on 'done' issue, re-opening.");
                        await updateJob(jobId, "pending", existingJob.branch || "");
                    } else {
                        log.debug({ issue: issue.number }, "Issue is already marked as 'done', skipping.");
                        return;
                    }
                }
            } else if (existingJob.status === "in-progress") {
                // Check if it's actually running in this process
                const { getRunningTask } = await import("../tasks/manager.js");
                if (getRunningTask(jobId)) {
                    log.debug({ issue: issue.number }, "Already in-progress in this runner, skipping");
                    return;
                }
                log.info({ issue: issue.number }, "Found stale in-progress job, resetting to allow resumption");
                await updateJob(jobId, "pending", existingJob.branch || "");
            }
            if (existingJob.status === "waiting") {
                // If the last comment starts with Gitybara, the user hasn't replied yet
                if (comments.length > 0 && comments[comments.length - 1].body.includes("🦫 **Gitybara** needs clarification:")) {
                    log.debug({ issue: issue.number }, "Still waiting for user clarification, skipping");
                    return;
                }
                log.info({ issue: issue.number }, "User replied to clarification! Resuming work");
            }
        } else {
            log.info({ issue: issue.number, title: issue.title }, "New issue found — starting work");
        }

        const branchName = issueToBranchName(issue.number, issue.title);
        let finalBranchName = branchName;
        let isJoiningBranch = false;

        // Smart Branch Association
        if (!existingJob?.force_new_branch) {
            try {
                const openPRs = await octokit.rest.pulls.list({
                    owner,
                    repo,
                    state: "open"
                });

                const activeBranches = openPRs.data.map(pr => ({
                    name: pr.head.ref,
                    prTitle: pr.title,
                    prBody: pr.body || ""
                })).filter(b => b.name.startsWith("gitybara/"));

                if (activeBranches.length > 0) {
                    const association = await (await import("../opencode/runner.js")).associateIssueToBranch(
                        { number: issue.number, title: issue.title, body: issue.body || "" },
                        activeBranches,
                        config.defaultProvider,
                        config.defaultModel
                    );

                    if (association.action === "JOIN" && association.branchName) {
                        log.info({ issue: issue.number, branch: association.branchName, reason: association.reason }, "🤝 Smart Association: Joining existing branch");
                        finalBranchName = association.branchName;
                        isJoiningBranch = true;

                        // Check for actionable comments on the associated PR
                        try {
                            // Find the PR number for this branch
                            const prResponse = await octokit.rest.pulls.list({
                                owner,
                                repo,
                                state: "open",
                                head: `${owner}:${association.branchName}`
                            });

                            if (prResponse.data.length > 0) {
                                const prNumber = prResponse.data[0].number;
                                const commentConfig: CommentMonitorConfig = {
                                    enabled: true,
                                    autoApplyFixes: true,
                                    skipBotComments: true,
                                    actionableKeywords: [
                                        'fix', 'change', 'update', 'modify', 'correct', 'improve',
                                        'please fix', 'can you fix', 'need to fix', 'should fix',
                                        'change request', 'requested changes', 'please address',
                                        'update the', 'modify the', 'fix the', 'correct the'
                                    ]
                                };

                                const actionableComments = await findActionableComments(
                                    octokit, owner, repo, prNumber, true, commentConfig
                                );

                                if (actionableComments.length > 0) {
                                    log.info({ issue: issue.number, pr: prNumber, comments: actionableComments.length },
                                        `💬 Found ${actionableComments.length} actionable comments on associated PR #${prNumber}`);
                                    // Store the actionable comments to process them after setup
                                    (issue as any).actionableComments = actionableComments;
                                    (issue as any).associatedPRNumber = prNumber;
                                }
                            }
                        } catch (commentErr) {
                            log.warn({ err: commentErr, issue: issue.number }, "Failed to check for actionable comments on associated PR");
                        }
                    }
                }
            } catch (assocErr) {
                log.warn({ assocErr }, "Failed to perform branch association, falling back to new branch.");
            }
        }

        // jobId is already defined above

        // Create abort controller for this task
        const abortController = new AbortController();

        // Register the task for potential cancellation
        registerTask({
            jobId,
            issueNumber: issue.number,
            repoOwner: owner,
            repoName: repo,
            branchName: finalBranchName,
            workDir: "", // Will be set later
            clonePath,
            abortController,
            startedAt: new Date()
        });

        let selectedProvider = config.defaultProvider;
        let selectedModel = config.defaultModel;

        for (const label of issue.labels) {
            if (label.startsWith("model:")) {
                const mId = label.substring("model:".length);
                const foundModel = cachedModels?.find(m => m.modelId === mId);
                if (foundModel) {
                    selectedProvider = foundModel.providerId;
                    selectedModel = foundModel.modelId;
                    log.info({ issue: issue.number, provider: selectedProvider, model: selectedModel }, "Model overridden by label");
                }
            }
        }

        // Robust safe name for directories across all OSes (no :, /, *, ?, ", <, >, |)
        const safeBranchName = finalBranchName.replace(/[^\w.-]/g, "-");
        const workDir = path.join(path.dirname(clonePath), safeBranchName);

        // Update the registered task with workDir
        const { getRunningTask } = await import("../tasks/manager.js");
        const task = getRunningTask(jobId);
        if (task) {
            task.workDir = workDir;
        }

        try {
            // Check if task was cancelled before we start
            if (abortController.signal.aborted) {
                throw new Error("Task was cancelled by user");
            }

            // 1. Label issue as in-progress
            await updateJob(jobId, "in-progress", finalBranchName);
            await labelIssue(octokit, owner, repo, issue.number, "gitybara:in-progress").catch(() => { });

            const joinMsg = isJoiningBranch ? `Continuing work on existing branch \`${finalBranchName}\`` : `Creating branch \`${finalBranchName}\``;
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                existingJob?.status === "waiting"
                    ? `🦫 **Gitybara** is reviewing your clarification and resuming work. ${joinMsg}…`
                    : `🦫 **Gitybara** is working on this issue!\n\n${joinMsg} and running OpenCode…`
            );

            // Clone the repo straight into the isolated run path
            log.info({ issue: issue.number, workDir: encodeWorkspacePath(workDir) }, "Preparing isolated workspace via git worktree…");
            const sharedGit = simpleGit(clonePath);

            // Ensure old worktree from previous crash doesn't exist
            if (fs.existsSync(workDir)) {
                await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                await execa("git", ["worktree", "prune"], { cwd: clonePath }).catch(() => { });
            }

            // 2. Checkout to final branch using detached HEAD for isolation
            if (isJoiningBranch) {
                log.info({ issue: issue.number, branch: finalBranchName }, "Joining existing branch via worktree…");
                await sharedGit.fetch(["origin", finalBranchName]);
                await execa("git", ["worktree", "add", "-d", workDir, `origin/${finalBranchName}`], { cwd: clonePath });
            } else {
                log.info({ issue: issue.number, branch: finalBranchName }, "Creating new branch via worktree…");
                await createBranch(octokit, owner, repo, baseBranch, finalBranchName);
                await sharedGit.fetch(["origin", finalBranchName]);
                await execa("git", ["worktree", "add", "-d", workDir, `origin/${finalBranchName}`], { cwd: clonePath });
            }

            const git: SimpleGit = simpleGit(workDir);

            // 4. Build prompt from learning rules
            const rules = await getRules(repoId);
            const systemPrompt = buildSystemPrompt(
                owner, repo, issue.number, issue.title,
                issue.body || "", rules, comments
            );

            // Check for cancellation before running OpenCode
            if (abortController.signal.aborted) {
                throw new Error("Task was cancelled by user");
            }

            // 5. Run OpenCode
            log.info({ issue: issue.number }, "Running OpenCode (this may take a few minutes)…");

            // Determine if we should share the session URL
            const shouldShareSession = issue.labels.includes("share:session_url");
            let sessionUrlPosted = false;

            const result = await runOpenCode(
                config.opencodePath,
                workDir,
                systemPrompt,
                selectedProvider,
                selectedModel,
                // Callback invoked immediately when session is created
                async (sessionUrl: string) => {
                    log.info({ issue: issue.number, sessionUrl }, "👁️ Watch live OpenCode session");
                    if (shouldShareSession && !sessionUrlPosted) {
                        sessionUrlPosted = true;
                        await commentOnIssue(
                            octokit, owner, repo, issue.number,
                            `🦫 **Gitybara** is now coding! You can watch the session live here: ${sessionUrl}`
                        ).catch(() => { });
                    } else if (!shouldShareSession) {
                        log.info({ issue: issue.number }, "Skipping session URL comment (share:session_url label not found)");
                    }
                }
            );

            if (result.filesChanged.length === 0) {
                // If the agent intentionally asked for clarification, pause it.
                if (result.summary.includes("NEED_CLARIFICATION:")) {
                    const match = result.summary.match(/NEED_CLARIFICATION:\s*(.*)/i);
                    const question = match ? match[1] : "The agent requires further clarification on this issue but couldn't parse the question.";

                    log.info({ issue: issue.number }, "Agent requires clarification from the user");
                    await updateJob(jobId, "waiting", branchName);
                    await labelIssue(octokit, owner, repo, issue.number, "gitybara:waiting").catch(() => { });
                    await commentOnIssue(
                        octokit, owner, repo, issue.number,
                        `🦫 **Gitybara** needs clarification:\n\n> ${question}\n\n*Please reply below and I will automatically resume work!*`
                    );
                    return; // Exit normally without committing or opening PR
                }

                if (!result.success) {
                    throw new Error(`OpenCode failed: ${result.summary}`);
                }

                log.info({ issue: issue.number }, "OpenCode made no file changes, marking as done.");
                await updateJob(jobId, "done", branchName);
                await labelIssue(octokit, owner, repo, issue.number, "gitybara:done").catch(() => { });
                await commentOnIssue(
                    octokit, owner, repo, issue.number,
                    `🦫 **Gitybara** reviewed the issue but determined that no code changes are required.\n\n**Summary:**\n${result.summary}`
                );
                return;
            }

            // If we have changes but success is false, it's likely a timeout but work was done
            const finalSummary = result.success ? result.summary :
                (result.summary || "OpenCode made changes but the request timed out. These changes have been applied for your review.");

            // 6. Commit and push
            await git.add(".");
            await git.commit(
                `fix(#${issue.number}): ${issue.title}\n\nResolved by Gitybara 🦫\n\n${finalSummary}`
            );

            // Force push if necessary in case branch already existed (push from detached HEAD)
            const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
            await git.push(["-f", remoteWithToken, `HEAD:${finalBranchName}`]);

            // Check if there are actionable comments to address (from PR review)
            const actionableComments = (issue as any).actionableComments;
            const associatedPRNumber = (issue as any).associatedPRNumber;

            if (actionableComments && actionableComments.length > 0 && associatedPRNumber) {
                log.info({ issue: issue.number, comments: actionableComments.length },
                    "Addressing actionable comments from PR review…");

                const fixPrompt = buildFixPrompt(
                    issue.title,
                    issue.body || '',
                    actionableComments
                );

                const fixResult = await runOpenCode(
                    config.opencodePath,
                    workDir,
                    fixPrompt,
                    selectedProvider,
                    selectedModel
                );

                if (fixResult.success && fixResult.filesChanged.length > 0) {
                    // Commit the fixes
                    await git.add(".");
                    await git.commit(
                        `fix(#${issue.number}): Addressed feedback from PR comments\n\n${fixResult.summary}`
                    );
                    await git.push(["-f", remoteWithToken, `HEAD:${finalBranchName}`]);

                    await postFixResponse(
                        octokit, owner, repo, associatedPRNumber, true,
                        fixResult.filesChanged,
                        fixResult.summary
                    );

                    log.info({ issue: issue.number, pr: associatedPRNumber },
                        "✅ Successfully addressed PR review comments");
                }
            }

            // 7. Open PR
            const prBody = buildPRBody(issue.number, issue.title, finalSummary, result.filesChanged);
            const pr = await openPR(
                octokit, owner, repo, branchName, baseBranch,
                `fix(#${issue.number}): ${issue.title}`, prBody
            );

            // 8. Comment on issue with PR link
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `🦫 **Gitybara** finished!\n\nOpened PR: ${pr.url}\n\n**Files changed:** ${result.filesChanged.join(", ")}\n\n**Summary:**\n${finalSummary}`
            );
            await labelIssue(octokit, owner, repo, issue.number, "gitybara:done").catch(() => { });

            await updateJob(jobId, "done", branchName, pr.url);

            // No automatic cleanup per user request
            log.info({ issue: issue.number, pr: pr.url, workDir: encodeWorkspacePath(workDir) }, "Issue resolved — PR opened, work directory preserved.");

            log.info({ issue: issue.number, pr: pr.url }, "✅ Issue resolved — PR opened");
        } catch (err) {
            const errMsg = String(err);

            // Check if this was a cancellation
            if (errMsg.includes("cancelled") || abortController.signal.aborted) {
                log.info({ issue: issue.number }, "🛑 Task was cancelled");
                await updateJob(jobId, "cancelled", branchName, undefined, "Cancelled by user");
                await labelIssue(octokit, owner, repo, issue.number, "gitybara:cancelled").catch(() => { });
                await commentOnIssue(
                    octokit, owner, repo, issue.number,
                    `🦫 **Gitybara** stopped!\n\nThis task has been cancelled as requested.`
                ).catch(() => { });
            } else {
                await updateJob(jobId, "failed", branchName, undefined, errMsg);
                log.error({ err, issue: issue.number }, "❌ Failed to process issue");
                await commentOnIssue(
                    octokit, owner, repo, issue.number,
                    `🦫 **Gitybara** encountered an error:\n\`\`\`\n${errMsg}\n\`\`\`\n\nPlease check the logs or re-open the issue.`
                ).catch(() => { });
            }

            // No automatic cleanup on error per user request
            log.info({ issue: issue.number, workDir: encodeWorkspacePath(workDir) }, "Holding worktree after error for debugging or resumption.");
        } finally {
            // Always unregister the task when done
            unregisterTask(jobId);
        }
    }));

    // Wait for all issues in this repo to finish processing before returning
    await Promise.all(issuePromises);

    // Process actionable comments on issues with existing PRs
    await processIssueComments(octokit, owner, repo, clonePath, config, limit);

    // Process PRs for conflicts and auto-merge
    const prPromises = candidatePRs.map(pr => limit(async () => {
        // Detailed check for merge state
        const fullPR = await getPR(octokit, owner, repo, pr.number);

        // Get auto-merge configuration
        const repoAutoMergeConfig = await getRepoAutoMergeConfig(repoId);
        const prAutoMergeConfig = await getPRAutoMergeConfig(owner, repo, pr.number);
        
        // Determine effective configuration (PR config overrides repo config)
        const autoMergeEnabled = prAutoMergeConfig?.enabled ?? repoAutoMergeConfig?.enabled ?? true;
        const autoMergeClean = prAutoMergeConfig?.enabled !== undefined 
            ? prAutoMergeConfig.enabled 
            : (repoAutoMergeConfig?.auto_merge_clean ?? true);
        const autoResolveConflicts = repoAutoMergeConfig?.auto_resolve_conflicts ?? true;
        const mergeMethod = (prAutoMergeConfig?.merge_method ?? repoAutoMergeConfig?.merge_method ?? 'merge') as 'merge' | 'squash' | 'rebase';

        // Smart conflict detection and auto-merge logic
        const hasConflicts = fullPR.mergeable_state === "dirty" || fullPR.mergeable === false;
        const isMergeable = fullPR.mergeable === true && !hasConflicts;

        // Handle mergeable PRs with auto-merge
        if (isMergeable && autoMergeEnabled && autoMergeClean) {
            log.info({ pr: pr.number }, "📥 PR is mergeable, attempting auto-merge…");
            
            const autoMergeResult = await enableAutoMerge(
                octokit, owner, repo, pr.number, 
                mergeMethod.toUpperCase() as 'MERGE' | 'SQUASH' | 'REBASE'
            );
            
            if (autoMergeResult.success) {
                log.info({ pr: pr.number }, `✅ Auto-merge enabled for PR: ${autoMergeResult.message}`);
                await commentOnIssue(
                    octokit, owner, repo, pr.number, 
                    `🦫 **Gitybara** has enabled auto-merge for this PR using the **${mergeMethod}** method. The PR will be merged automatically when all checks pass.`
                ).catch(() => { });
            } else {
                log.warn({ pr: pr.number }, `⚠️ Could not enable auto-merge: ${autoMergeResult.message}`);
                
                // Try direct merge if auto-merge is not available
                if (autoMergeResult.message.includes('not enabled for this repository')) {
                    const directMerge = await mergePullRequest(
                        octokit, owner, repo, pr.number, mergeMethod,
                        `🦫 Auto-merge: ${fullPR.title}`,
                        `This PR was automatically merged by Gitybara when it became mergeable.`
                    );
                    
                    if (directMerge.success) {
                        log.info({ pr: pr.number }, `✅ Directly merged PR: ${directMerge.message}`);
                        await commentOnIssue(
                            octokit, owner, repo, pr.number,
                            `🦫 **Gitybara** has automatically merged this PR using the **${mergeMethod}** method.`
                        ).catch(() => { });
                    } else {
                        log.warn({ pr: pr.number }, `⚠️ Could not merge: ${directMerge.message}`);
                    }
                }
            }
            return; // Skip to next PR after handling mergeable state
        }

        // Handle conflicting PRs with auto-resolution
        if (hasConflicts && autoResolveConflicts) {
            log.info({ pr: pr.number }, "🔍 Conflict detected on Pull Request, attempting auto-fix…");

            // Check if PR is stale (not updated for X days)
            const lastUpdated = new Date(fullPR.updated_at);
            const daysSinceUpdate = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
            const stalePrDays = repoAutoMergeConfig?.stale_pr_days ?? 7;
            
            if (daysSinceUpdate < stalePrDays) {
                log.info({ pr: pr.number, daysSinceUpdate, stalePrDays }, "PR is not stale yet, skipping conflict resolution.");
            } else {
                log.info({ pr: pr.number, daysSinceUpdate, stalePrDays }, "PR is stale, proceeding with conflict resolution.");
            }

            // Check max resolution attempts
            const maxAttempts = repoAutoMergeConfig?.max_resolution_attempts ?? 3;
            const failedAttempts = await getFailedResolutionAttemptCount(owner, repo, pr.number);
            
            if (failedAttempts >= maxAttempts) {
                log.warn({ pr: pr.number, failedAttempts, maxAttempts }, "Max resolution attempts reached, escalating to human review.");
                await commentOnIssue(
                    octokit, owner, repo, pr.number,
                    `🦫 **Gitybara** has attempted to resolve conflicts ${failedAttempts} times without success. This PR requires manual intervention.`
                ).catch(() => { });
                return;
            }

            const branchName = fullPR.head.ref;
            const safeBranchName = branchName.replace(/[^\w.-]/g, "-") + "-conflict-fix";
            const workDir = path.join(path.dirname(clonePath), safeBranchName);
            const sharedGit = simpleGit(clonePath);

            // Track resolution attempt
            let attemptId: number | null = null;
            const startTime = Date.now();
            let resolvedFiles: string[] = [];
            let escalatedFiles: string[] = [];

            try {
                // Ensure workdir doesn't exist
                if (fs.existsSync(workDir)) {
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                }

                // Prepare worktree
                await sharedGit.fetch(["origin", branchName]);
                await execa("git", ["worktree", "add", "-d", workDir, `origin/${branchName}`], { cwd: clonePath });

                const git: SimpleGit = simpleGit(workDir);

                // Attempt to merge base branch (e.g. main)
                log.info({ pr: pr.number, base: fullPR.base.ref }, "Merging base branch into PR branch…");
                let resolvedByAI = false;
                let conflictedFiles: string[] = [];
                
                try {
                    await sharedGit.fetch(["origin", fullPR.base.ref]);
                    await execa("git", ["merge", `origin/${fullPR.base.ref}`], { cwd: workDir });
                    log.info({ pr: pr.number }, "✅ No actual conflicts (Fast-forward or clean merge), pushing update.");
                } catch (mergeErr) {
                    log.info({ pr: pr.number }, "⚡ Conflict detected, analyzing conflicted files…");

                    // Get list of conflicted files
                    const status = await git.status();
                    conflictedFiles = status.conflicted;
                    
                    if (conflictedFiles.length === 0) {
                        log.info({ pr: pr.number }, "No conflicted files found after merge attempt.");
                    } else {
                        log.info({ pr: pr.number, files: conflictedFiles }, `Found ${conflictedFiles.length} conflicted files`);
                        
                        // Create tracking record
                        attemptId = await createConflictResolutionAttempt(
                            owner, repo, pr.number, fullPR.title, conflictedFiles
                        );

                        // Categorize files based on patterns
                        const filesToResolve: string[] = [];
                        const filesToEscalate: string[] = [];
                        
                        for (const file of conflictedFiles) {
                            const action = await getActionForFile(repoId, file);
                            if (action === 'escalate') {
                                filesToEscalate.push(file);
                            } else if (action === 'ignore') {
                                log.info({ pr: pr.number, file }, `Ignoring conflicts in ${file} per pattern rules`);
                            } else {
                                filesToResolve.push(file);
                            }
                        }

                        // If any files need escalation, escalate the entire PR
                        if (filesToEscalate.length > 0) {
                            log.warn({ pr: pr.number, files: filesToEscalate }, `Escalating PR due to protected files: ${filesToEscalate.join(', ')}`);
                            escalatedFiles = filesToEscalate;
                            
                            if (attemptId) {
                                await updateConflictResolutionAttempt(
                                    attemptId,
                                    'escalated',
                                    resolvedFiles,
                                    escalatedFiles,
                                    `Escalated due to protected files: ${filesToEscalate.join(', ')}`,
                                    Date.now() - startTime
                                );
                            }
                            
                            await commentOnIssue(
                                octokit, owner, repo, pr.number,
                                `🦫 **Gitybara** detected conflicts in protected files that require manual review:\n\n${filesToEscalate.map(f => `- \`${f}\``).join('\n')}\n\nPlease resolve these conflicts manually.`
                            ).catch(() => { });
                            
                            // Cleanup worktree
                            await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                            return;
                        }

                        // If no files to resolve (all ignored), skip
                        if (filesToResolve.length === 0) {
                            log.info({ pr: pr.number }, "All conflicted files are set to ignore, skipping resolution.");
                            if (attemptId) {
                                await updateConflictResolutionAttempt(
                                    attemptId,
                                    'success',
                                    [],
                                    [],
                                    'All conflicted files were ignored per pattern rules',
                                    Date.now() - startTime
                                );
                            }
                            await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                            return;
                        }

                        log.info({ pr: pr.number, files: filesToResolve }, `Attempting to resolve ${filesToResolve.length} files with OpenCode…`);

                        // Conflict markers are now in the files. OpenCode should fix them.
                        const rules = await getRules(repoId);
                        const prompt = `There is a merge conflict in this Pull Request (#${pr.number}).\n\nIssue context: ${fullPR.title}\n\nThe following files have Git conflict markers that need to be resolved:\n${filesToResolve.map(f => `- ${f}`).join('\n')}\n\nPlease resolve all conflicts in these files, ensure the code is functional, and remove all conflict markers.\n\nRules:\n${rules.map(r => `- ${r.text}`).join("\n")}`;

                        const result = await runOpenCode(
                            config.opencodePath,
                            workDir,
                            prompt,
                            config.defaultProvider,
                            config.defaultModel
                        );

                        if (!result.success) {
                            throw new Error(`OpenCode failed to resolve conflicts: ${result.summary}`);
                        }
                        
                        resolvedByAI = true;
                        resolvedFiles = filesToResolve;
                        log.info({ pr: pr.number, files: resolvedFiles }, "✅ OpenCode resolved conflicts.");

                        // Update tracking record
                        if (attemptId) {
                            await updateConflictResolutionAttempt(
                                attemptId,
                                'success',
                                resolvedFiles,
                                escalatedFiles,
                                undefined,
                                Date.now() - startTime
                            );
                        }
                    }
                }

                // Commit and push
                await git.add(".");
                const status = await git.status();
                if (status.staged.length > 0) {
                    const commitMsg = resolvedByAI 
                        ? `🦫 Gitybara: Auto-resolved merge conflicts with ${fullPR.base.ref} using AI`
                        : `🦫 Gitybara: Auto-merged ${fullPR.base.ref} (no conflicts)`;
                    
                    await git.commit(commitMsg);
                    const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
                    await git.push(["-f", remoteWithToken, `HEAD:${branchName}`]);

                    const resolutionMessage = resolvedByAI 
                        ? `🦫 **Gitybara** has automatically detected and resolved merge conflicts in this PR!\n\nResolved files:\n${resolvedFiles.map(f => `- \`${f}\``).join('\n')}`
                        : `🦫 **Gitybara** has automatically updated this PR with the latest changes from ${fullPR.base.ref}.`;
                    
                    await commentOnIssue(
                        octokit, owner, repo, pr.number, 
                        resolutionMessage
                    );
                    
                    // Check if we should enable auto-merge after conflict resolution
                    if (autoMergeEnabled) {
                        log.info({ pr: pr.number }, "Attempting to enable auto-merge after conflict resolution…");
                        const autoMergeResult = await enableAutoMerge(
                            octokit, owner, repo, pr.number,
                            mergeMethod.toUpperCase() as 'MERGE' | 'SQUASH' | 'REBASE'
                        );
                        
                        if (autoMergeResult.success) {
                            log.info({ pr: pr.number }, `✅ Auto-merge enabled after conflict resolution`);
                            await commentOnIssue(
                                octokit, owner, repo, pr.number,
                                `🦫 Auto-merge has been enabled. The PR will merge automatically when all checks pass.`
                            ).catch(() => { });
                        }
                    }
                } else {
                    log.info({ pr: pr.number }, "No changes to commit after conflict resolution check.");
                }

                // No automatic cleanup per user request
                log.info({ pr: pr.number, workDir: encodeWorkspacePath(workDir) }, "Conflict resolution complete, work directory preserved.");
            } catch (err) {
                const errorMsg = String(err);
                log.error({ err, pr: pr.number }, "❌ Failed to resolve Conflicts");
                
                // Update tracking record with failure
                if (attemptId) {
                    await updateConflictResolutionAttempt(
                        attemptId,
                        'failed',
                        resolvedFiles,
                        escalatedFiles,
                        errorMsg,
                        Date.now() - startTime
                    );
                }
                
                // Check if we've hit max attempts
                const updatedFailedAttempts = await getFailedResolutionAttemptCount(owner, repo, pr.number);
                const remainingAttempts = maxAttempts - updatedFailedAttempts;
                
                if (remainingAttempts <= 0) {
                    await commentOnIssue(
                        octokit, owner, repo, pr.number,
                        `🦫 **Gitybara** failed to resolve merge conflicts automatically after ${maxAttempts} attempts. This PR requires manual intervention.\n\nError:\n\`\`\`\n${errorMsg}\n\`\`\``
                    ).catch(() => { });
                } else {
                    await commentOnIssue(
                        octokit, owner, repo, pr.number,
                        `🦫 **Gitybara** failed to resolve merge conflicts automatically. Will retry on next poll. (${remainingAttempts} attempts remaining)\n\nError:\n\`\`\`\n${errorMsg}\n\`\`\``
                    ).catch(() => { });
                }

                // No automatic cleanup on error
            }
        } else if (hasConflicts && !autoResolveConflicts) {
            log.info({ pr: pr.number }, "⏸️ Conflicts detected but auto-resolution is disabled for this repository.");
        } else {
            log.debug({ pr: pr.number }, "Pull Request is mergeable, no action needed.");
        }

        // Check for actionable comments on the PR
        try {
            const commentConfig: CommentMonitorConfig = {
                enabled: true,
                autoApplyFixes: true,
                skipBotComments: true,
                actionableKeywords: [
                    'fix', 'change', 'update', 'modify', 'correct', 'improve',
                    'please fix', 'can you fix', 'need to fix', 'should fix',
                    'change request', 'requested changes', 'please address',
                    'update the', 'modify the', 'fix the', 'correct the'
                ]
            };

            const actionableComments = await findActionableComments(
                octokit, owner, repo, pr.number, true, commentConfig
            );

            if (actionableComments.length > 0) {
                log.info({ pr: pr.number, comments: actionableComments.length },
                    `💬 Found ${actionableComments.length} actionable comments on PR, applying fixes…`);

                const branchName = fullPR.head.ref;
                const safeBranchName = branchName.replace(/[^\w.-]/g, "-") + "-comment-fix";
                const workDir = path.join(path.dirname(clonePath), safeBranchName);
                const sharedGit = simpleGit(clonePath);

                try {
                    // Ensure workdir is clean
                    if (fs.existsSync(workDir)) {
                        await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                    }

                    // Prepare worktree
                    await sharedGit.fetch(["origin", branchName]);
                    await execa("git", ["worktree", "add", "-d", workDir, `origin/${branchName}`], { cwd: clonePath });

                    const git: SimpleGit = simpleGit(workDir);

                    // Build prompt from actionable comments
                    const fixPrompt = buildFixPrompt(
                        fullPR.title,
                        fullPR.body || '',
                        actionableComments
                    );

                    log.info({ pr: pr.number }, "Running OpenCode to address feedback…");

                    const result = await runOpenCode(
                        config.opencodePath,
                        workDir,
                        fixPrompt,
                        config.defaultProvider,
                        config.defaultModel
                    );

                    if (!result.success) {
                        throw new Error(`OpenCode failed to apply fixes: ${result.summary}`);
                    }

                    if (result.filesChanged.length === 0) {
                        log.info({ pr: pr.number }, "No file changes were made by OpenCode");
                    } else {
                        // Commit and push
                        await git.add(".");
                        const status = await git.status();
                        if (status.staged.length > 0) {
                            await git.commit(`🦫 Gitybara: Addressed feedback from PR comments`);
                            const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
                            await git.push(["-f", remoteWithToken, `HEAD:${branchName}`]);

                            await postFixResponse(
                                octokit, owner, repo, pr.number, true,
                                result.filesChanged,
                                result.summary
                            );

                            log.info({ pr: pr.number }, "✅ Successfully applied fixes from PR comments");
                        }
                    }

                    // Cleanup
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
                } catch (err) {
                    log.error({ err, pr: pr.number }, "❌ Failed to apply fixes from comments");
                    await commentOnIssue(
                        octokit, owner, repo, pr.number,
                        `🦫 **Gitybara** failed to automatically apply fixes from the feedback:\n\`\`\`\n${err}\n\`\`\``
                    ).catch(() => { });

                    // Cleanup on error
                    if (fs.existsSync(workDir)) {
                        await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                    }
                }
            }
        } catch (commentErr) {
            log.error({ err: commentErr, pr: pr.number }, "Error processing PR comments");
        }
    }));

    await Promise.all(prPromises);
}

/**
 * Process actionable comments on issues that have associated PRs
 */
async function processIssueComments(
    octokit: any,
    owner: string,
    repo: string,
    clonePath: string,
    config: GlobalConfig,
    limit: any
): Promise<void> {
    // Get issues that have associated PRs (from jobs table)
    const { getDb } = await import("../db/index.js");
    const db = getDb();

    const rs = await db.execute({
        sql: `SELECT issue_number, pr_url FROM jobs 
               WHERE repo_owner = ? AND repo_name = ? 
               AND status = 'done'`,
        args: [owner, repo]
    });

    if (rs.rows.length === 0) {
        return;
    }

    const issuesWithDoneJobs = rs.rows.map((r: any) => ({
        number: r.issue_number as number,
        prUrl: r.pr_url as string | null
    }));
    log.info({ count: issuesWithDoneJobs.length }, `Checking ${issuesWithDoneJobs.length} 'done' jobs for actionable comments`);

    for (const item of issuesWithDoneJobs) {
        const issueNumber = item.number;
        try {
            // If it has a PR, find it
            let associatedPR: any = null;
            if (item.prUrl) {
                const { data: prs } = await octokit.rest.pulls.list({
                    owner,
                    repo,
                    state: "open"
                });

                associatedPR = prs.find((pr: any) =>
                    pr.html_url === item.prUrl ||
                    pr.body?.includes(`#${issueNumber}`) ||
                    pr.title?.includes(`#${issueNumber}`)
                );
            }

            if (!associatedPR && item.prUrl) {
                // PR existed once but now gone?
                continue;
            }

            // Check for actionable comments on the issue
            const commentConfig: CommentMonitorConfig = {
                enabled: true,
                autoApplyFixes: true,
                skipBotComments: true,
                actionableKeywords: [
                    'fix', 'change', 'update', 'modify', 'correct', 'improve',
                    'please fix', 'can you fix', 'need to fix', 'should fix',
                    'change request', 'requested changes', 'please address',
                    'update the', 'modify the', 'fix the', 'correct the'
                ]
            };

            const actionableComments = await findActionableComments(
                octokit, owner, repo, issueNumber, false, commentConfig
            );

            if (actionableComments.length === 0) {
                continue;
            }

            if (associatedPR) {
                log.info({ issue: issueNumber, pr: associatedPR.number, comments: actionableComments.length },
                    `💬 Found ${actionableComments.length} actionable comments on issue #${issueNumber} with PR #${associatedPR.number}`);
            } else {
                log.info({ issue: issueNumber, comments: actionableComments.length },
                    `💬 Found ${actionableComments.length} actionable comments on issue #${issueNumber} (no PR yet).`);

                // If no PR yet, we should just reset the job to 'pending'
                // This will cause the main loop to pick it up and run a full cycle
                const jobId = (await getJobByIssue(owner, repo, issueNumber))?.id;
                if (jobId) {
                    await updateJob(jobId, "pending", "");
                    await labelIssue(octokit, owner, repo, issueNumber, "gitybara:in-progress").catch(() => { });
                    await commentOnIssue(octokit, owner, repo, issueNumber, `🦫 **Gitybara** is re-opening this issue based on your feedback!`).catch(() => { });
                }
                continue;
            }

            // Process the comments similar to PR comments
            const branchName = associatedPR.head.ref;
            const safeBranchName = branchName.replace(/[^\w.-]/g, "-") + "-issue-comment-fix";
            const workDir = path.join(path.dirname(clonePath), safeBranchName);
            const sharedGit = simpleGit(clonePath);

            try {
                // Ensure workdir is clean
                if (fs.existsSync(workDir)) {
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                }

                // Prepare worktree
                await sharedGit.fetch(["origin", branchName]);
                await execa("git", ["worktree", "add", "-d", workDir, `origin/${branchName}`], { cwd: clonePath });

                const git: SimpleGit = simpleGit(workDir);

                // Get issue details
                const { data: issue } = await octokit.rest.issues.get({
                    owner,
                    repo,
                    issue_number: issueNumber
                });

                // Build prompt from actionable comments
                const fixPrompt = buildFixPrompt(
                    issue.title,
                    issue.body || '',
                    actionableComments
                );

                log.info({ issue: issueNumber, pr: associatedPR.number }, "Running OpenCode to address issue feedback…");

                const result = await runOpenCode(
                    config.opencodePath,
                    workDir,
                    fixPrompt,
                    config.defaultProvider,
                    config.defaultModel
                );

                if (!result.success) {
                    throw new Error(`OpenCode failed to apply fixes: ${result.summary}`);
                }

                if (result.filesChanged.length === 0) {
                    log.info({ issue: issueNumber }, "No file changes were made by OpenCode");
                } else {
                    // Commit and push
                    await git.add(".");
                    const status = await git.status();
                    if (status.staged.length > 0) {
                        await git.commit(`🦫 Gitybara: Addressed feedback from issue #${issueNumber} comments`);
                        const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
                        await git.push(["-f", remoteWithToken, `HEAD:${branchName}`]);

                        await postFixResponse(
                            octokit, owner, repo, associatedPR.number, true,
                            result.filesChanged,
                            result.summary
                        );

                        log.info({ issue: issueNumber, pr: associatedPR.number },
                            "✅ Successfully applied fixes from issue comments");
                    }
                }

                // Cleanup
                await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
            } catch (err) {
                log.error({ err, issue: issueNumber }, "❌ Failed to apply fixes from issue comments");
                await commentOnIssue(
                    octokit, owner, repo, issueNumber,
                    `🦫 **Gitybara** failed to automatically apply fixes from the feedback on this issue:\n\`\`\`\n${err}\n\`\`\``
                ).catch(() => { });

                // Cleanup on error
                if (fs.existsSync(workDir)) {
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                }
            }
        } catch (err) {
            log.error({ err, issue: issueNumber }, "Error processing issue comments");
        }
    }
}

function buildPRBody(
    issueNumber: number,
    issueTitle: string,
    summary: string,
    filesChanged: string[]
): string {
    return `## 🦫 Gitybara Auto-Fix

Closes #${issueNumber}

**Issue:** ${issueTitle}

---

### Changes Made

${summary}

### Files Modified

${filesChanged.map((f) => `- \`${f}\``).join("\n") || "_No files detected_"}

---

> *This PR was automatically generated by [Gitybara](https://github.com/your-org/gitybara) 🦫*
`;
}
