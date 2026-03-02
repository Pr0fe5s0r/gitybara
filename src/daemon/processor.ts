import { simpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import pLimit from "p-limit";
import { execa } from "execa";
import { Octokit } from "@octokit/rest";
import { GlobalConfig, RepoConfig } from "../cli/config-store.js";
import { createGitHubClient } from "../github/client.js";
import { listOpenIssues } from "../github/issues.js";
import { listOpenPRs, getPR } from "../github/prs.js";
import { commentOnIssue, labelIssue, ensureModelLabels, getIssueComments } from "../github/issues.js";
import { getAvailableModels } from "../opencode/models.js";
import { ensureRepoMemory, getRepoMemory, readExistingMemory } from "../memory/manager.js";
import {
    upsertRepo,
    updateJob,
    getJobByIssue,
} from "../db/index.js";
import { createLogger } from "../utils/logger.js";
import { findActionableComments, buildFixPrompt, postFixResponse, CommentMonitorConfig } from "../monitor/comments.js";
import { processSingleIssue } from "./issue.js";
import { processSinglePR } from "./pull-request.js";
import { runOpenCode, generateFeedbackResponse } from "../opencode/runner.js";

const log = createLogger("daemon-processor");

let cachedModels: { providerId: string, modelId: string }[] | null = null;
const ensuredRepos = new Set<string>();

export async function pollAllRepos(config: GlobalConfig) {
    for (const repoConfig of config.repos) {
        try {
            await processRepo(config, repoConfig);
        } catch (e) {
            log.error({ e, repo: `${repoConfig.owner}/${repoConfig.repo}` }, "Error processing repo");
        }
    }
}

export async function processRepo(config: GlobalConfig, repoConfig: RepoConfig) {
    const { owner, repo, issueLabel, baseBranch, clonePath } = repoConfig;
    const octokit = createGitHubClient(config.githubToken);

    log.info({ owner, repo, label: issueLabel || "(none)" }, "Polling for new issues and PRs…");
    const issues = await listOpenIssues(octokit, owner, repo, issueLabel);
    const prs = await listOpenPRs(octokit, owner, repo);
    const candidatePRs = prs; // Process all open PRs in monitored repositories for comments/conflicts
    const labeledPRsCount = prs.filter(pr => (pr as any).labels.some((l: any) => l.name === issueLabel)).length;

    log.info({ repo: `${owner}/${repo}`, issues: issues.length, prs: candidatePRs.length, labeled: labeledPRsCount }, "Scan results");
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

        // Ensure REPO_MEMORY.md exists for AI agent clarifications
        try {
            // Check if memory already exists before generating
            const existingDbMemory = await getRepoMemory(repoId);
            const existingFileMemory = await readExistingMemory(clonePath);

            // If no memory exists, notify users that we're indexing the repository
            if (!existingDbMemory && !existingFileMemory) {
                log.info({ owner, repo }, "REPO_MEMORY.md not found, will generate. Notifying issues...");
                for (const issue of issues) {
                    await commentOnIssue(
                        octokit, owner, repo, issue.number,
                        `[GITYBARA] 🦫 **Gitybara** is indexing this repository for the first time. This may take a few minutes while I analyze the codebase structure...`
                    ).catch(() => { });
                }
            }

            await ensureRepoMemory(
                repoId,
                clonePath,
                owner,
                repo,
                config.opencodePath,
                config.defaultProvider,
                config.defaultModel
            );
        } catch (memoryErr) {
            log.warn({ err: memoryErr, owner, repo }, "Failed to ensure REPO_MEMORY.md, continuing anyway");
        }
    }

    const limit = pLimit(3); // Process up to 3 issues concurrently per repo

    const issuePromises = issues.map(issue => limit(async () => {
        await processSingleIssue(
            octokit as any,
            owner,
            repo,
            repoId,
            issue,
            config,
            cachedModels,
            clonePath,
            baseBranch
        );
    }));

    // Wait for all issues in this repo to finish processing before returning
    await Promise.all(issuePromises);

    // Process actionable comments on issues with existing PRs
    await processIssueComments(octokit as any, owner, repo, clonePath, config);

    // Process PRs for conflicts and auto-merge
    const prPromises = candidatePRs.map(pr => limit(async () => {
        await processSinglePR(
            octokit as any,
            owner,
            repo,
            repoId,
            pr,
            config,
            cachedModels,
            clonePath,
            issueLabel || ""
        );
    }));

    await Promise.all(prPromises);
}

/**
 * Process actionable comments on issues that have associated PRs
 */
async function processIssueComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    clonePath: string,
    config: GlobalConfig
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
                octokit as any, owner, repo, issueNumber, false, commentConfig
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
                    await commentOnIssue(octokit, owner, repo, issueNumber, `[GITYBARA] 🦫 **Gitybara** is re-opening this issue based on your feedback!`).catch(() => { });
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

                const git = simpleGit(workDir);

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

                // Acknowledge the feedback before starting work
                const allComments = await getIssueComments(octokit, owner, repo, issueNumber);
                const aiResponse = await generateFeedbackResponse(
                    { title: issue.title, body: issue.body || '', comments: allComments },
                    actionableComments,
                    config.defaultProvider,
                    config.defaultModel
                );

                await commentOnIssue(octokit, owner, repo, issueNumber, aiResponse).catch(() => { });

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
                            octokit as any, owner, repo, associatedPR.number, true,
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
                    `[GITYBARA] 🦫 **Gitybara** failed to automatically apply fixes from the feedback on this issue:\n\`\`\`\n${err}\n\`\`\``
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
