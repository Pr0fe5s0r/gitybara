import { simpleGit, SimpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import { execa } from "execa";
import { Octokit } from "@octokit/rest";
import { GlobalConfig } from "../cli/config-store.js";
import { getPR } from "../github/prs.js";
import { commentOnIssue, getIssueComments } from "../github/issues.js";
import { runOpenCode, encodeWorkspacePath, generateFeedbackResponse } from "../opencode/runner.js";
import { getRules } from "../learning/engine.js";
import {
    getRepoAutoMergeConfig,
    getPRAutoMergeConfig,
    getActionForFile,
    createConflictResolutionAttempt,
    updateConflictResolutionAttempt,
    getFailedResolutionAttemptCount,
} from "../db/index.js";
import { ensureRepoMemory, updateRepoMemoryWithInsights } from "../memory/manager.js";
import { createLogger } from "../utils/logger.js";
import { findActionableComments, buildFixPrompt, postFixResponse, CommentMonitorConfig, createIssuesFromFutureFixes, postFutureFixSummary } from "../monitor/comments.js";
import { nukeWorktree, removeReservedWindowsFiles } from "./supervisor.js";

const log = createLogger("daemon-pr");

export async function processSinglePR(
    octokit: Octokit,
    owner: string,
    repo: string,
    repoId: number,
    pr: any,
    config: GlobalConfig,
    cachedModels: { providerId: string, modelId: string }[] | null,
    clonePath: string,
    issueLabel: string
) {
    const hasLabel = pr.labels.some((l: any) => l.name === issueLabel);
    // Always fetch full PR details for comment check and conflict/merge state
    const fullPR = await getPR(octokit, owner, repo, pr.number);

    let selectedProvider = config.defaultProvider;
    let selectedModel = config.defaultModel;

    // Check for model labels on the PR
    for (const label of fullPR.labels) {
        const labelName = typeof label === 'string' ? label : (label as any).name;
        if (labelName.startsWith("model:")) {
            const mId = labelName.substring("model:".length);
            const foundModel = cachedModels?.find(m => m.modelId === mId);
            if (foundModel) {
                selectedProvider = foundModel.providerId;
                selectedModel = foundModel.modelId;
                log.info({ pr: pr.number, provider: selectedProvider, model: selectedModel }, "Model overridden by label on PR");
            }
        }
    }

    // Conflict resolution and auto-merge only for labeled PRs
    if (!hasLabel) {
        log.debug({ pr: pr.number }, "Skipping conflict/merge check for unlabeled PR");
    } else {
        // Get auto-merge configuration
        const repoAutoMergeConfig = await getRepoAutoMergeConfig(repoId);
        const prAutoMergeConfig = await getPRAutoMergeConfig(owner, repo, pr.number);

        // Determine effective configuration (PR config overrides repo config)
        // const autoMergeEnabled = prAutoMergeConfig?.enabled ?? repoAutoMergeConfig?.enabled ?? true;
        // const autoMergeClean = prAutoMergeConfig?.enabled !== undefined
        //     ? prAutoMergeConfig.enabled
        //     : (repoAutoMergeConfig?.auto_merge_clean ?? true);
        const autoResolveConflicts = repoAutoMergeConfig?.auto_resolve_conflicts ?? true;
        // const mergeMethod = (prAutoMergeConfig?.merge_method ?? repoAutoMergeConfig?.merge_method ?? 'merge') as 'merge' | 'squash' | 'rebase';

        // Smart conflict detection and auto-merge logic
        const hasConflicts = fullPR.mergeable_state === "dirty" || fullPR.mergeable === false;
        // const isMergeable = fullPR.mergeable === true && !hasConflicts;

        // 1. Conflict resolution - only for labeled PRs
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

                // Check max resolution attempts
                const maxAttempts = repoAutoMergeConfig?.max_resolution_attempts ?? 3;
                const failedAttempts = await getFailedResolutionAttemptCount(owner, repo, pr.number);

                if (failedAttempts >= maxAttempts) {
                    log.warn({ pr: pr.number, failedAttempts, maxAttempts }, "Max resolution attempts reached, escalating to human review.");
                    await commentOnIssue(
                        octokit, owner, repo, pr.number,
                        `[GITYBARA] 🦫 **Gitybara** has attempted to resolve conflicts ${failedAttempts} times without success. This PR requires manual intervention.`
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
                        await nukeWorktree(clonePath, workDir);
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
                                    `[GITYBARA] 🦫 **Gitybara** detected conflicts in protected files that require manual review:\n\n${filesToEscalate.map((f: string) => `- \`${f}\``).join('\n')}\n\nPlease resolve these conflicts manually.`
                                ).catch(() => { });

                                // Cleanup worktree
                                await nukeWorktree(clonePath, workDir);
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
                                await nukeWorktree(clonePath, workDir);
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
                                selectedProvider,
                                selectedModel
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
                            ? `[GITYBARA] 🦫 **Gitybara** has automatically detected and resolved merge conflicts in this PR!\n\nResolved files:\n${resolvedFiles.map(f => `- \`${f}\``).join('\n')}`
                            : `[GITYBARA] 🦫 **Gitybara** has automatically updated this PR with the latest changes from ${fullPR.base.ref}.`;

                        await commentOnIssue(
                            octokit, owner, repo, pr.number,
                            resolutionMessage
                        ).catch(() => { });

                        // Update repo memory with conflict resolution insights
                        await updateRepoMemoryWithInsights(
                            repoId,
                            workDir,
                            owner,
                            repo,
                            pr.number,
                            resolvedFiles.join(", "),
                            resolvedByAI ? "Automatically resolved merge conflicts via OpenCode AI." : "Updated PR with base branch changes."
                        ).catch(err => log.warn({ err }, "Failed to update repo memory with conflict resolution insights"));
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
                            attemptId, 'failed', resolvedFiles, escalatedFiles, errorMsg, Date.now() - startTime
                        );
                    }

                    // Check if we've hit max attempts
                    const updatedFailedAttempts = await getFailedResolutionAttemptCount(owner, repo, pr.number);
                    const remainingAttempts = maxAttempts - updatedFailedAttempts;

                    if (remainingAttempts <= 0) {
                        await commentOnIssue(
                            octokit, owner, repo, pr.number,
                            `[GITYBARA] 🦫 **Gitybara** failed to resolve merge conflicts automatically after ${maxAttempts} attempts. This PR requires manual intervention.\n\nError:\n\`\`\`\n${errorMsg}\n\`\`\``
                        ).catch(() => { });
                    } else {
                        await commentOnIssue(
                            octokit, owner, repo, pr.number,
                            `[GITYBARA] 🦫 **Gitybara** failed to resolve merge conflicts automatically. Will retry on next poll. (${remainingAttempts} attempts remaining)\n\nError:\n\`\`\`\n${errorMsg}\n\`\`\``
                        ).catch(() => { });
                    }
                }
            }
        } else if (hasConflicts && !autoResolveConflicts) {
            log.info({ pr: pr.number }, "⏸️ Conflicts detected but auto-resolution is disabled for this repository.");
        }
    }

    // 2. Check for actionable comments on the PR (always check, regardless of label)
    try {
        const commentConfig: CommentMonitorConfig = {
            enabled: true,
            autoApplyFixes: true,
            skipBotComments: true,
            requireMention: !hasLabel, // On unlabelled PRs, require @gitybara mention
            actionableKeywords: [
                'fix', 'change', 'update', 'modify', 'correct', 'improve',
                'please fix', 'can you fix', 'need to fix', 'should fix',
                'change request', 'requested changes', 'please address',
                'update the', 'modify the', 'fix the', 'correct the',
                'todo', 'fixme', 'future fix', 'later fix', 'address later',
                'temporary fix', 'hack', 'workaround', 'needs work', 'needs fixing',
                'should be fixed', 'must fix', 'needs to be', 'should be', 'must be',
                'would be better', 'could you', 'it would be nice', 'consider',
                'suggestion', 'recommend', 'advise', 'delete', 'remove', 'nuke',
                'refactor', 'cleanup', 'clean up', 'add', 'create', 'implement'
            ]
        };

        const actionableComments = await findActionableComments(
            octokit, owner, repo, pr.number, true, commentConfig
        );

        if (actionableComments.length > 0) {
            // Separate future fixes from immediate fixes
            const futureFixComments = actionableComments.filter(ac => ac.actionType === 'future_fix');
            const immediateFixComments = actionableComments.filter(ac => ac.actionType !== 'future_fix');

            log.info({
                pr: pr.number,
                total: actionableComments.length,
                immediate: immediateFixComments.length,
                future: futureFixComments.length
            }, `💬 Found ${actionableComments.length} actionable comments (${immediateFixComments.length} immediate, ${futureFixComments.length} future fixes)`);

            // Handle future fix comments - create issues for them
            if (futureFixComments.length > 0) {
                try {
                    const futureFixResult = await createIssuesFromFutureFixes(
                        octokit, owner, repo, pr.number, fullPR.title, futureFixComments
                    );

                    if (futureFixResult.createdIssues.length > 0) {
                        await postFutureFixSummary(
                            octokit, owner, repo, pr.number,
                            futureFixResult.createdIssues
                        );
                        log.info({
                            pr: pr.number,
                            issues: futureFixResult.createdIssues.map(i => i.number)
                        }, `✅ Created ${futureFixResult.createdIssues.length} future fix issues`);
                    }

                    if (futureFixResult.errors.length > 0) {
                        log.warn({
                            pr: pr.number,
                            errors: futureFixResult.errors
                        }, 'Some future fix issues failed to create');
                    }
                } catch (futureFixErr) {
                    log.error({ err: futureFixErr, pr: pr.number }, "Failed to create future fix issues");
                }
            }

            // Handle immediate fix comments - apply code changes
            if (immediateFixComments.length > 0) {
                const prBranchName = fullPR.head.ref;
                const safeBranchName = prBranchName.replace(/[^\w.-]/g, "-") + "-comment-fix";
                const workDir = path.join(path.dirname(clonePath), safeBranchName);
                const sharedGit = simpleGit(clonePath);

                try {
                    // Ensure workdir is clean
                    if (fs.existsSync(workDir)) {
                        await nukeWorktree(clonePath, workDir);
                    }

                    // Prepare worktree
                    await sharedGit.fetch(["origin", prBranchName]);
                    await execa("git", ["worktree", "add", "-d", workDir, `origin/${prBranchName}`], { cwd: clonePath });

                    const git: SimpleGit = simpleGit(workDir);

                    // Build prompt from actionable comments with full context
                    const fixPrompt = buildFixPrompt(
                        fullPR.title,
                        fullPR.body || '',
                        immediateFixComments
                    );

                    // Acknowledge the feedback before starting work
                    const allComments = await getIssueComments(octokit, owner, repo, pr.number);
                    const aiResponse = await generateFeedbackResponse(
                        { title: fullPR.title, body: fullPR.body || '', comments: allComments },
                        immediateFixComments,
                        selectedProvider,
                        selectedModel
                    );

                    await commentOnIssue(octokit, owner, repo, pr.number, aiResponse).catch(() => { });

                    log.info({ pr: pr.number }, "Running OpenCode to address feedback…");

                    const result = await runOpenCode(
                        config.opencodePath,
                        workDir,
                        fixPrompt,
                        selectedProvider,
                        selectedModel
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
                            // Filter reserved Windows filenames before committing
                            removeReservedWindowsFiles(workDir);

                            await git.commit(`🦫 Gitybara: Addressed feedback from PR comments`);
                            const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
                            await git.push(["-f", remoteWithToken, `HEAD:${prBranchName}`]);

                            await postFixResponse(
                                octokit, owner, repo, pr.number, true,
                                result.filesChanged,
                                result.summary
                            );

                            log.info({ pr: pr.number }, "✅ Successfully applied fixes from PR comments");

                            // Update repo memory with feedback resolution insights
                            await updateRepoMemoryWithInsights(
                                repoId,
                                workDir,
                                owner,
                                repo,
                                pr.number,
                                result.filesChanged.join(", "),
                                result.summary
                            ).catch(err => log.warn({ err }, "Failed to update repo memory with feedback insights"));
                        }
                    }

                    // Cleanup - the user prefers to keep the code for manual review
                    // await nukeWorktree(clonePath, workDir);
                } catch (err) {
                    log.error({ err, pr: pr.number }, "❌ Failed to apply fixes from comments");
                    await commentOnIssue(
                        octokit, owner, repo, pr.number,
                        `[GITYBARA] 🦫 **Gitybara** failed to automatically apply fixes from the feedback:\n\`\`\`\n${err}\n\`\`\``
                    ).catch(() => { });

                    // Cleanup on error - the user prefers to keep the code even if it fails
                    // if (fs.existsSync(workDir)) {
                    //     await nukeWorktree(clonePath, workDir);
                    // }
                }
            }
        }
    } catch (commentErr) {
        log.error({ err: commentErr, pr: pr.number }, "Error processing PR comments");
    }
}
