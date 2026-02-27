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
import { openPR, listOpenPRs, getPR } from "../github/prs.js";
import { commentOnIssue, labelIssue, ensureModelLabels, getIssueComments } from "../github/issues.js";
import { runOpenCode } from "../opencode/runner.js";
import { getAvailableModels } from "../opencode/models.js";
import { getRules, buildSystemPrompt } from "../learning/engine.js";
import {
    upsertRepo,
    createJob,
    updateJob,
    getJobByIssue
} from "../db/index.js";
import { createLogger } from "../utils/logger.js";

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

    const intervalMs = config.pollingIntervalMinutes * 60 * 1000;
    const pollLoop = async () => {
        while (true) {
            await pollAllRepos(config).catch((e) => log.error({ e }, "Poll error"));
            await new Promise(r => setTimeout(r, intervalMs));
        }
    };
    pollLoop();

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
                    // If older than 30 mins
                    if (now - stat.mtimeMs > 30 * 60 * 1000) {
                        log.info({ fullPath }, "Cleaning up abandoned run directory");
                        rimrafSync(fullPath, { maxRetries: 3, retryDelay: 500 });
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

        if (existingJob) {
            if (existingJob.status === "done" || existingJob.status === "in-progress") {
                log.debug({ issue: issue.number }, "Already processed or in-progress, skipping");
                return;
            }
            if (existingJob.status === "waiting") {
                // If the last comment starts with Gitybara, the user hasn't replied yet
                if (comments.length > 0 && comments[comments.length - 1].includes("🦫 **Gitybara** needs clarification:")) {
                    log.debug({ issue: issue.number }, "Still waiting for user clarification, skipping");
                    return;
                }
                log.info({ issue: issue.number }, "User replied to clarification! Resuming work");
            }
            if (existingJob.status === "failed") {
                if (comments.length > 0 && comments[comments.length - 1].includes("🦫 **Gitybara** encountered an error:")) {
                    log.debug({ issue: issue.number }, "Waiting for user to reply after failure, skipping");
                    return;
                }
                log.info({ issue: issue.number }, "User replied after error! Retrying work");
            }
        } else {
            log.info({ issue: issue.number, title: issue.title }, "New issue found — starting work");
        }

        // Immediately mark as in-progress to prevent overlapping runs across loop ticks
        const jobId = existingJob ? existingJob.id : await createJob(repoId, owner, repo, issue.number, issue.title);
        await updateJob(jobId, "in-progress");

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
                    }
                }
            } catch (assocErr) {
                log.warn({ assocErr }, "Failed to perform branch association, falling back to new branch.");
            }
        }

        // Job ID is defined and locked earlier above

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
        const uniqueId = Math.random().toString(36).substring(2, 10);
        const workDir = path.join(path.dirname(clonePath), `${safeBranchName}-${uniqueId}`);

        try {
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
            log.info({ issue: issue.number, workDir }, "Preparing isolated workspace via git worktree…");
            const sharedGit = simpleGit(clonePath);

            // Ensure old worktree from previous crash doesn't exist
            if (fs.existsSync(workDir)) {
                try {
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
                } catch {
                    log.debug({ workDir }, "Git remove failed, will let periodic cleanup handle it");
                }
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

            // 5. Run OpenCode
            log.info({ issue: issue.number }, "Running OpenCode (this may take a few minutes)…");
            const result = await runOpenCode(
                config.opencodePath,
                workDir,
                systemPrompt,
                selectedProvider,
                selectedModel
            );

            if (result.sessionUrl) {
                log.info({ issue: issue.number, sessionUrl: result.sessionUrl }, "👁️ Watch live OpenCode session");
                const shouldShare = issue.labels.includes("share:session_url");
                if (shouldShare) {
                    await commentOnIssue(
                        octokit, owner, repo, issue.number,
                        `🦫 **Gitybara** is now coding! You can watch the session live here: ${result.sessionUrl}`
                    ).catch(() => { });
                } else {
                    log.info({ issue: issue.number }, "Skipping session URL comment (share:session_url label not found)");
                }
            }

            if (!result.success || result.filesChanged.length === 0) {
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

                // Cleanup isolated directory on standard error
                // Will let periodic cleanup handle the folder removal in case of EBUSY
                throw new Error(
                    result.filesChanged.length === 0
                        ? "OpenCode made no file changes"
                        : `OpenCode failed: ${result.summary}`
                );
            }

            // 6. Commit and push
            await git.add(".");
            await git.commit(
                `fix(#${issue.number}): ${issue.title}\n\nResolved by Gitybara 🦫\n\n${result.summary}`
            );

            // Force push if necessary in case branch already existed (push from detached HEAD)
            const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
            await git.push(["-f", remoteWithToken, `HEAD:${finalBranchName}`]);

            // 7. Open PR
            const prBody = buildPRBody(issue.number, issue.title, result.summary, result.filesChanged);
            const pr = await openPR(
                octokit, owner, repo, branchName, baseBranch,
                `fix(#${issue.number}): ${issue.title}`, prBody
            );

            // 8. Comment on issue with PR link
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `🦫 **Gitybara** finished!\n\nOpened PR: ${pr.url}\n\n**Files changed:** ${result.filesChanged.join(", ")}\n\n**Summary:**\n${result.summary}`
            );
            await labelIssue(octokit, owner, repo, issue.number, "gitybara:done").catch(() => { });

            await updateJob(jobId, "done", branchName, pr.url);

            // Clean up isolated directory
            try {
                await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
            } catch (cleanupErr) {
                log.warn({ err: cleanupErr, workDir }, "Failed to remove worktree via git. Will let periodic cleanup handle it.");
            }

            log.info({ issue: issue.number, pr: pr.url }, "✅ Issue resolved — PR opened");
        } catch (err) {
            const errMsg = String(err);
            await updateJob(jobId, "failed", branchName, undefined, errMsg);
            log.error({ err, issue: issue.number }, "❌ Failed to process issue");
            await commentOnIssue(
                octokit, owner, repo, issue.number,
                `🦫 **Gitybara** encountered an error:\n\`\`\`\n${errMsg}\n\`\`\`\n\nPlease check the logs or re-open the issue.`
            ).catch(() => { });

            // Ensure cleanup even on error
            if (typeof workDir !== 'undefined' && fs.existsSync(workDir)) {
                try {
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
                } catch {
                    log.debug({ workDir }, "Failed to remove worktree on error path. Will let periodic cleanup handle it.");
                }
            }
        }
    }));

    // Wait for all issues in this repo to finish processing before returning
    await Promise.all(issuePromises);

    // Process PRs for conflicts
    const prPromises = candidatePRs.map(pr => limit(async () => {
        // Detailed check for merge state
        const fullPR = await getPR(octokit, owner, repo, pr.number);

        // mergeable_state: 'dirty' means conflicts
        // mergeable: false means conflicts
        if (fullPR.mergeable_state === "dirty" || fullPR.mergeable === false) {
            log.info({ pr: pr.number }, "🔍 Conflict detected on Pull Request, attempting auto-fix…");

            const branchName = fullPR.head.ref;
            const safeBranchName = branchName.replace(/[^\w.-]/g, "-") + "-conflict-fix";
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

                // Attempt to merge base branch (e.g. main)
                log.info({ pr: pr.number, base: fullPR.base.ref }, "Merging base branch into PR branch…");
                try {
                    await sharedGit.fetch(["origin", fullPR.base.ref]);
                    await execa("git", ["merge", `origin/${fullPR.base.ref}`], { cwd: workDir });
                    log.info({ pr: pr.number }, "✅ No actual conflicts (Fast-forward or clean merge), pushing update.");
                } catch (mergeErr) {
                    log.info({ pr: pr.number }, "⚡ Conflict detected, calling OpenCode for resolution…");

                    // Conflict markers are now in the files. OpenCode should fix them.
                    const rules = await getRules(repoId);
                    const prompt = `There is a merge conflict in this Pull Request (#${pr.number}).\n\nIssue context: ${fullPR.title}\n\nExisting files contain Git conflict markers. Please resolve all conflicts, ensure the code is functional, and remove all markers.\n\nRules:\n${rules.map(r => `- ${r.text}`).join("\n")}`;

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
                    log.info({ pr: pr.number }, "✅ OpenCode resolved conflicts.");
                }

                // Commit and push
                await git.add(".");
                const status = await git.status();
                if (status.staged.length > 0) {
                    await git.commit(`🦫 Gitybara: Auto-resolved merge conflicts with ${fullPR.base.ref}`);
                    const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
                    await git.push(["-f", remoteWithToken, `HEAD:${branchName}`]);

                    await commentOnIssue(octokit, owner, repo, pr.number, "🦫 **Gitybara** has automatically detected and resolved merge conflicts in this PR!");
                } else {
                    log.info({ pr: pr.number }, "No changes to commit after conflict resolution check.");
                }

                // Cleanup
                await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
            } catch (err) {
                log.error({ err, pr: pr.number }, "❌ Failed to resolve Conflicts");
                await commentOnIssue(octokit, owner, repo, pr.number, `🦫 **Gitybara** failed to resolve merge conflicts automatically:\n\`\`\`\n${err}\n\`\`\``).catch(() => { });

                // Cleanup on error
                if (fs.existsSync(workDir)) {
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }).catch(() => { });
                }
            }
        } else {
            log.debug({ pr: pr.number }, "Pull Request is mergeable, no action needed.");
        }
    }));

    await Promise.all(prPromises);
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
