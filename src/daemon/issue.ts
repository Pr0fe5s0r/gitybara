import { simpleGit, SimpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import { execa } from "execa";
import { rimrafSync } from "rimraf";
import { Octokit } from "@octokit/rest";
import { GlobalConfig } from "../cli/config-store.js";
import { createBranch, issueToBranchName } from "../github/branches.js";
import { openPR } from "../github/prs.js";
import { commentOnIssue, labelIssue, getIssueComments } from "../github/issues.js";
import { runOpenCode, encodeWorkspacePath, generateFeedbackResponse } from "../opencode/runner.js";
import { getRules, buildSystemPrompt } from "../learning/engine.js";
import {
    createJob,
    updateJob,
    getJobByIssue,
} from "../db/index.js";
import { ensureRepoMemory, updateRepoMemoryWithInsights } from "../memory/manager.js";
import { createLogger } from "../utils/logger.js";
import { registerTask, unregisterTask } from "../tasks/manager.js";
import { findActionableComments, buildFixPrompt, postFixResponse, CommentMonitorConfig } from "../monitor/comments.js";
import { HealingOptions, runWithHealing, removeReservedWindowsFiles, nukeWorktree } from "./supervisor.js";

const log = createLogger("daemon-issue");

export async function processSingleIssue(
    octokit: Octokit,
    owner: string,
    repo: string,
    repoId: number,
    issue: any,
    config: GlobalConfig,
    cachedModels: { providerId: string, modelId: string }[] | null,
    clonePath: string,
    baseBranch: string
) {
    // 0. Check interactive status
    const existingJob = await getJobByIssue(owner, repo, issue.number);
    const comments = await getIssueComments(octokit, owner, repo, issue.number);

    const jobId = existingJob ? existingJob.id : await createJob(repoId, owner, repo, issue.number, issue.title);

    if (existingJob) {
        if (existingJob.status === "done") {
            // If the user removed the 'done' label, they want us to try again.
            if (!issue.labels.find((l: any) => l.name === "gitybara:done")) {
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
        const labelName = typeof label === 'string' ? label : label.name;
        if (labelName.startsWith("model:")) {
            const mId = labelName.substring("model:".length);
            const foundModel = cachedModels?.find(m => m.modelId === mId);
            if (foundModel) {
                selectedProvider = foundModel.providerId;
                selectedModel = foundModel.modelId;
                log.info({ issue: issue.number, provider: selectedProvider, model: selectedModel }, "Model overridden by label");
            }
        }
    }

    // Shorten the directory name to avoid Windows MAX_PATH (260 char) issues.
    // We use only the issue number and a very short slug for readability, keeping it under 25 chars.
    const branchParts = finalBranchName.split('-');
    const shortSlug = (branchParts.length > 2 ? branchParts.slice(-2) : branchParts).join('-').substring(0, 15);
    const workDirName = `gb-i${issue.number}-${shortSlug}`.replace(/[^\w.-]/g, "-");
    const workDir = path.join(path.dirname(clonePath), workDirName);

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

        if (existingJob?.status === "waiting") {
            const aiResponse = await generateFeedbackResponse(
                { title: issue.title, body: issue.body || '', comments },
                [], // newComments should probably be the ones after the waiting marker, but generateFeedbackResponse can handle it from context
                selectedProvider,
                selectedModel
            );
            await commentOnIssue(octokit, owner, repo, issue.number, aiResponse).catch(() => { });
        } else {
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `[GITYBARA] 🦫 **Gitybara** is working on this issue!\n\n${joinMsg} and running OpenCode…`
            );
        }

        // Clone the repo straight into the isolated run path
        log.info({ issue: issue.number, workDir: encodeWorkspacePath(workDir) }, "Preparing isolated workspace via git worktree…");
        const sharedGit = simpleGit(clonePath);

        // Always nuke any stale worktree — git worktree remove, prune, then rimraf
        await nukeWorktree(clonePath, workDir);

        const issueContext = `Issue #${issue.number}: ${issue.title}\n${issue.body || ""}`;
        const healOpts: HealingOptions = {
            healingDir: workDir,
            issueContext,
            config,
            selectedProvider,
            selectedModel,
            maxRetries: 2
        };
        // clonePath-based healing opts for stages where workDir may not exist yet
        const cloneHealOpts: HealingOptions = { ...healOpts, healingDir: clonePath };

        // 2. Checkout to final branch using detached HEAD for isolation
        await runWithHealing("worktree-setup", async () => {
            if (isJoiningBranch) {
                log.info({ issue: issue.number, branch: finalBranchName }, "Joining existing branch via worktree…");
                await sharedGit.fetch(["origin", finalBranchName]);
                await execa("git", ["worktree", "add", "-d", workDir, `origin/${finalBranchName}`], { cwd: clonePath });
            } else {
                log.info({ issue: issue.number, branch: finalBranchName }, "Creating new branch via worktree…");
                await runWithHealing("branch-create", () => createBranch(octokit, owner, repo, baseBranch, finalBranchName), cloneHealOpts);
                await sharedGit.fetch(["origin", finalBranchName]);
                await execa("git", ["worktree", "add", "-d", workDir, `origin/${finalBranchName}`], { cwd: clonePath });
            }
        }, cloneHealOpts);

        const git: SimpleGit = simpleGit(workDir);

        // 4. Build prompt from learning rules
        const rules = await getRules(repoId);
        const systemPrompt = await buildSystemPrompt(
            owner, repo, issue.number, issue.title,
            issue.body || "", rules, comments, repoId
        );

        // Check for cancellation before running OpenCode
        if (abortController.signal.aborted) {
            throw new Error("Task was cancelled by user");
        }

        // 5. Run OpenCode (wrapped in supervisor)
        log.info({ issue: issue.number }, "Running OpenCode (this may take a few minutes)…");

        // Determine if we should share the session URL
        const shouldShareSession = issue.labels.find((l: any) => (typeof l === 'string' ? l : l.name) === "share:session_url");
        let sessionUrlPosted = false;

        const result = await runWithHealing("opencode-run", () => runOpenCode(
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
                        `[GITYBARA] 🦫 **Gitybara** is now coding! You can watch the session live here: ${sessionUrl}`
                    ).catch(() => { });
                } else if (!shouldShareSession) {
                    log.info({ issue: issue.number }, "Skipping session URL comment (share:session_url label not found)");
                }
            }
        ), { ...healOpts, maxRetries: 1 }); // 1 retry for OpenCode itself

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
                    `[GITYBARA] 🦫 **Gitybara** needs clarification:\n\n> ${question}\n\n*Please reply below and I will automatically resume work!*`
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
                `[GITYBARA] 🦫 **Gitybara** reviewed the issue but determined that no code changes are required.\n\n**Summary:**\n${result.summary}`
            );
            return;
        }

        // If we have changes but success is false, it's likely a timeout but work was done
        const finalSummary = result.success ? result.summary :
            (result.summary || "OpenCode made changes but the request timed out. These changes have been applied for your review.");

        // 6. Commit and push — supervised
        const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;

        await runWithHealing("git-commit-push", async () => {
            // Filter reserved Windows filenames before staging
            removeReservedWindowsFiles(workDir);

            await git.add(".");
            const staged = await git.status();
            if (staged.staged.length > 0) {
                await git.commit(
                    `fix(#${issue.number}): ${issue.title}\n\nResolved by Gitybara 🦫\n\n${finalSummary}`
                );
            }
            // Force push from detached HEAD
            await git.push(["-f", remoteWithToken, `HEAD:${finalBranchName}`]);
        }, healOpts);

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
                // Commit the fixes — supervised
                await runWithHealing("git-commit-push-feedback", async () => {
                    removeReservedWindowsFiles(workDir);
                    await git.add(".");
                    const staged = await git.status();
                    if (staged.staged.length > 0) {
                        await git.commit(
                            `fix(#${issue.number}): Addressed feedback from PR comments\n\n${fixResult.summary}`
                        );
                    }
                    await git.push(["-f", remoteWithToken, `HEAD:${finalBranchName}`]);
                }, healOpts);

                await postFixResponse(
                    octokit, owner, repo, associatedPRNumber, true,
                    fixResult.filesChanged,
                    fixResult.summary
                );

                log.info({ issue: issue.number, pr: associatedPRNumber },
                    "✅ Successfully addressed PR review comments");
            }
        }

        // 7. Open PR (only if not joining an existing branch) — supervised
        if (!isJoiningBranch) {
            const prBody = buildPRBody(issue.number, issue.title, finalSummary, result.filesChanged);
            const pr = await runWithHealing("pr-open", () => openPR(
                octokit, owner, repo, branchName, baseBranch,
                `fix(#${issue.number}): ${issue.title}`, prBody
            ), healOpts);

            // 8. Comment on issue with PR link
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `[GITYBARA] 🦫 **Gitybara** finished!\n\nOpened PR: ${pr.url}\n\n**Files changed:** ${result.filesChanged.join(", ")}\n\n**Summary:**\n${finalSummary}`
            );
            await labelIssue(octokit, owner, repo, issue.number, "gitybara:done").catch(() => { });

            await updateJob(jobId, "done", branchName, pr.url);

            // Update repository memory with insights from this successful run
            await updateRepoMemoryWithInsights(
                repoId,
                workDir,
                owner,
                repo,
                issue.number,
                result.filesChanged.join(", "),
                finalSummary
            ).catch(err => log.warn({ err }, "Failed to update repo memory with insights"));

            // No automatic cleanup per user request
            log.info({ issue: issue.number, pr: pr.url, workDir: encodeWorkspacePath(workDir) }, "Issue resolved — PR opened, work directory preserved.");

            log.info({ issue: issue.number, pr: pr.url }, "✅ Issue resolved — PR opened");
        } else {
            // We're joining an existing branch/PR, so just update the existing PR
            const associatedPRNumber = (issue as any).associatedPRNumber;
            const prUrl = associatedPRNumber ? `https://github.com/${owner}/${repo}/pull/${associatedPRNumber}` : undefined;

            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `[GITYBARA] 🦫 **Gitybara** updated the existing PR with additional changes!\n\n${prUrl ? `PR: ${prUrl}\n\n` : ""}**Files changed:** ${result.filesChanged.join(", ")}\n\n**Summary:**\n${finalSummary}`
            );
            await labelIssue(octokit, owner, repo, issue.number, "gitybara:done").catch(() => { });

            await updateJob(jobId, "done", finalBranchName, prUrl);

            // Update repository memory with insights from this successful run
            await updateRepoMemoryWithInsights(
                repoId,
                workDir,
                owner,
                repo,
                issue.number,
                result.filesChanged.join(", "),
                finalSummary
            ).catch(err => log.warn({ err }, "Failed to update repo memory with insights"));

            log.info({ issue: issue.number, pr: associatedPRNumber, workDir: encodeWorkspacePath(workDir) }, "Issue resolved — updated existing PR, work directory preserved.");

            log.info({ issue: issue.number, pr: associatedPRNumber }, "✅ Issue resolved — updated existing PR");
        }
    } catch (err) {
        const errMsg = String(err);

        // Check if this was a cancellation
        if (errMsg.includes("cancelled") || abortController.signal.aborted) {
            log.info({ issue: issue.number }, "🛑 Task was cancelled");
            await updateJob(jobId, "cancelled", branchName, undefined, "Cancelled by user");
            await labelIssue(octokit, owner, repo, issue.number, "gitybara:cancelled").catch(() => { });
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `[GITYBARA] 🦫 **Gitybara** stopped!\n\nThis task has been cancelled as requested.`
            ).catch(() => { });
        } else {
            await updateJob(jobId, "failed", branchName, undefined, errMsg);
            log.error({ err, issue: issue.number }, "❌ Failed to process issue");
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `[GITYBARA] 🦫 **Gitybara** encountered an error:\n\`\`\`\n${errMsg}\n\`\`\`\n\nPlease check the logs or re-open the issue.`
            ).catch(() => { });
        }

        // No automatic cleanup on error per user request
        log.info({ issue: issue.number, workDir: encodeWorkspacePath(workDir) }, "Holding worktree after error for debugging or resumption.");
    } finally {
        // Always unregister the task when done
        unregisterTask(jobId);
    }
}

function buildPRBody(
    issueNumber: number,
    issueTitle: string,
    summary: string,
    filesChanged: string[]
): string {
    return `## 🦫 Gitybara Auto-Fix\n\nCloses #${issueNumber}\n\n**Issue:** ${issueTitle}\n\n---\n\n### Changes Made\n\n${summary}\n\n### Files Modified\n\n${filesChanged.map((f) => `- \`${f}\``).join("\n") || "_No files detected_"}\n\n---\n\n> *This PR was automatically generated by [Gitybara](https://github.com/your-org/gitybara) 🦫*\n`;
}
