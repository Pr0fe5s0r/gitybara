import fs from "fs";
import path from "path";
import { execa } from "execa";
import { simpleGit, SimpleGit } from "simple-git";
import pLimit from "p-limit";
import { rimrafSync } from "rimraf";
import {
    GlobalConfig,
    RepoConfig,
} from "../cli/config-store.js";
import { createGitHubClient } from "../github/client.js";
import {
    listOpenIssues,
    labelIssue,
    commentOnIssue,
    getIssueComments,
    ensureModelLabels,
} from "../github/issues.js";
import { openPR, listOpenPRs, getPR } from "../github/prs.js";
import { createBranch, issueToBranchName } from "../github/branches.js";
import { runOpenCode } from "../opencode/runner.js";
import { getAvailableModels } from "../opencode/models.js";
import { buildSystemPrompt, getRules } from "../learning/engine.js";
import {
    upsertRepo,
    createJob,
    updateJob,
    getJobByIssue,
    resetStaleJobs
} from "../db/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("daemon-loop");
const globalLimit = pLimit(5); // Global maximum parallel OpenCode sessions across all repos

let cachedModels: { providerId: string, modelId: string }[] | null = null;
const ensuredRepos = new Set<string>();

export async function runDaemon(config: GlobalConfig, port: number) {
    // Start HTTP server in background
    const { startServer } = await import("./server.js");
    startServer(port);

    // Reset jobs that were in-progress if daemon was killed
    const resetCount = await resetStaleJobs();
    if (resetCount > 0) {
        log.info({ count: resetCount }, "🔄 Recovered incomplete jobs on startup");
    }

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
    // Run sweeps in parallel for all repos to avoid head-of-line blocking
    config.repos.map(repoConfig => (async () => {
        try {
            await processRepo(config, repoConfig);
        } catch (e) {
            log.error({ e, repo: `${repoConfig.owner}/${repoConfig.repo}` }, "Error processing repo");
        }
    })());
}

async function processRepo(config: GlobalConfig, repoConfig: RepoConfig) {
    const { owner, repo, issueLabel, baseBranch, clonePath } = repoConfig;
    const octokit = createGitHubClient(config.githubToken);

    log.info({ owner, repo, label: issueLabel || "(none)" }, "Polling for new issues and PRs…");
    const issues = await listOpenIssues(octokit, owner, repo, issueLabel || "gitybara");
    const prs = await listOpenPRs(octokit, owner, repo);
    const candidatePRs = prs.filter(pr => pr.labels.some((l: any) => l.name === (issueLabel || "gitybara")));

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
        log.info(`Syncing model labels for ${repoKey} in the background...`);
        ensureModelLabels(octokit, owner, repo, cachedModels).catch(e => {
            log.warn({ e }, `Failed to ensure labels for ${repoKey}`);
        });
        ensuredRepos.add(repoKey);
    }

    if (issues.length > 0 || candidatePRs.length > 0) {
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

    // 1. Pre-lock ALL new issues immediately
    for (const issue of issues) {
        const existingJob = await getJobByIssue(owner, repo, issue.number);
        if (!existingJob) {
            log.info({ issue: issue.number }, "New issue found — locking for background processing");
            const jobId = await createJob(repoId, owner, repo, issue.number, issue.title);
            await updateJob(jobId, "in-progress");
        }
    }

    // 2. Process Issues
    issues.forEach(issue => {
        globalLimit(async () => {
            const existingJob = await getJobByIssue(owner, repo, issue.number);
            const comments = await getIssueComments(octokit, owner, repo, issue.number);

            if (existingJob) {
                if (existingJob.status === "done") return;
                if (existingJob.status === "in-progress") {
                    const updatedAt = new Date(existingJob.updated_at).getTime();
                    const now = Date.now();
                    const isStale = (now - updatedAt) > 45 * 60 * 1000;
                    if (!isStale) return;
                    log.info({ issue: issue.number }, "⚠️ Resuming stale job");
                }
                if (existingJob.status === "waiting") {
                    if (comments.length > 0 && comments[comments.length - 1].includes("🦫 **Gitybara** needs clarification:")) return;
                    log.info({ issue: issue.number }, "User replied! Resuming");
                }
                if (existingJob.status === "failed") {
                    if (comments.length > 0 && comments[comments.length - 1].includes("🦫 **Gitybara** encountered an error:")) return;
                    log.info({ issue: issue.number }, "User replied after error! Retrying");
                }
                await updateJob(existingJob.id, "in-progress");
            }

            const branchName = issueToBranchName(issue.number, issue.title);
            let finalBranchName = branchName;
            let isJoiningBranch = false;

            if (!existingJob?.force_new_branch) {
                try {
                    const openPRs = await octokit.rest.pulls.list({ owner, repo, state: "open" });
                    const activeBranches = openPRs.data.map((pr: any) => ({
                        name: pr.head.ref,
                        prTitle: pr.title,
                        prBody: pr.body || ""
                    })).filter((b: any) => b.name.startsWith("gitybara/"));

                    if (activeBranches.length > 0) {
                        const { associateIssueToBranch } = await import("../opencode/runner.js");
                        const association = await associateIssueToBranch(
                            { number: issue.number, title: issue.title, body: issue.body || "" },
                            activeBranches,
                            config.defaultProvider,
                            config.defaultModel
                        );
                        if (association.action === "JOIN" && association.branchName) {
                            finalBranchName = association.branchName;
                            isJoiningBranch = true;
                        }
                    }
                } catch { }
            }

            const jobRecord = await getJobByIssue(owner, repo, issue.number);
            if (!jobRecord) return;
            const jobId = jobRecord.id;

            const uniqueId = Math.random().toString(36).substring(2, 10);
            const workDir = path.join(path.dirname(clonePath), `${finalBranchName.replace(/[^\w.-]/g, "-")}-${uniqueId}`);

            try {
                await labelIssue(octokit, owner, repo, issue.number, "gitybara:in-progress").catch(() => { });
                const joinMsg = isJoiningBranch ? `Continuing work on existing branch \`${finalBranchName}\`` : `Creating branch \`${finalBranchName}\``;
                await commentOnIssue(octokit, owner, repo, issue.number, `🦫 **Gitybara** is working on this!\n\n${joinMsg}…`);

                const sharedGit = simpleGit(clonePath);
                if (isJoiningBranch) {
                    await sharedGit.fetch(["origin", finalBranchName]);
                    await execa("git", ["worktree", "add", "-d", workDir, `origin/${finalBranchName}`], { cwd: clonePath });
                } else {
                    await createBranch(octokit, owner, repo, baseBranch, finalBranchName);
                    await sharedGit.fetch(["origin", finalBranchName]);
                    await execa("git", ["worktree", "add", "-d", workDir, `origin/${finalBranchName}`], { cwd: clonePath });
                }

                const git = simpleGit(workDir);
                const rules = await getRules(repoId);
                const systemPrompt = buildSystemPrompt(owner, repo, issue.number, issue.title, issue.body || "", rules, comments);

                const result = await runOpenCode(config.opencodePath, workDir, systemPrompt, config.defaultProvider, config.defaultModel);

                if (result.sessionUrl && issue.labels.includes("share:session_url")) {
                    await commentOnIssue(octokit, owner, repo, issue.number, `🦫 Live session: ${result.sessionUrl}`).catch(() => { });
                }

                if (!result.success || result.filesChanged.length === 0) {
                     if (result.summary.includes("NEED_CLARIFICATION:")) {
                        const match = result.summary.match(/NEED_CLARIFICATION:\s*(.*)/i);
                        const question = match ? match[1] : "Agent needs clarification.";
                        await updateJob(jobId, "waiting", finalBranchName);
                        await labelIssue(octokit, owner, repo, issue.number, "gitybara:waiting").catch(() => { });
                        await commentOnIssue(octokit, owner, repo, issue.number, `🦫 **Needs clarification**:\n\n> ${question}`);
                        return;
                    }
                    throw new Error(result.filesChanged.length === 0 ? "No changes made" : result.summary);
                }

                await git.add(".");
                await git.commit(`fix(#${issue.number}): ${issue.title}\n\n${result.summary}`);
                const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
                await git.push(["-f", remoteWithToken, `HEAD:${finalBranchName}`]);

                const prBody = buildPRBody(issue.number, issue.title, result.summary, result.filesChanged);
                const pr = await openPR(octokit, owner, repo, finalBranchName, baseBranch, `fix(#${issue.number}): ${issue.title}`, prBody);

                await commentOnIssue(octokit, owner, repo, issue.number, `🦫 **Gitybara** finished! opened PR: ${pr.url}`);
                await labelIssue(octokit, owner, repo, issue.number, "gitybara:done").catch(() => { });
                await updateJob(jobId, "done", finalBranchName, pr.url);

                try { await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath }); } catch { }
            } catch (err) {
                const errMsg = String(err);
                await updateJob(jobId, "failed", finalBranchName, undefined, errMsg);
                log.error({ err, issue: issue.number }, "❌ Processing failed");
                await commentOnIssue(octokit, owner, repo, issue.number, `🦫 **Error**:\n\`\`\`\n${errMsg}\n\`\`\``).catch(() => { });
            }
        }).catch(err => log.error({ err }, "Global limit error"));
    });

    // 3. Process PR Conflicts
    candidatePRs.forEach(pr => {
        globalLimit(async () => {
            const fullPR = await getPR(octokit, owner, repo, pr.number);
            if (fullPR.mergeable_state === "dirty" || fullPR.mergeable === false) {
                log.info({ pr: pr.number }, "🔍 Conflict detected, attempting auto-fix…");
                const branchName = fullPR.head.ref;
                const workDir = path.join(path.dirname(clonePath), `${branchName.replace(/[^\w.-]/g, "-")}-conflict-${Math.random().toString(36).substring(2, 6)}`);
                const sharedGit = simpleGit(clonePath);

                try {
                    await sharedGit.fetch(["origin", branchName]);
                    await execa("git", ["worktree", "add", "-d", workDir, `origin/${branchName}`], { cwd: clonePath });
                    const git = simpleGit(workDir);

                    try {
                        await sharedGit.fetch(["origin", fullPR.base.ref]);
                        await execa("git", ["merge", `origin/${fullPR.base.ref}`], { cwd: workDir });
                    } catch (mergeErr) {
                        const rules = await getRules(repoId);
                        const prompt = `Resolve conflicts in PR #${pr.number}.\n\nRules:\n${rules.map(r => r.text).join("\n")}`;
                        const result = await runOpenCode(config.opencodePath, workDir, prompt, config.defaultProvider, config.defaultModel);
                        if (!result.success) throw new Error("Conflict resolution failed");
                    }

                    await git.add(".");
                    const status = await git.status();
                    if (status.staged.length > 0) {
                        await git.commit(`🦫 Gitybara: Auto-resolved merge conflicts`);
                        const remoteWithToken = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
                        await git.push(["-f", remoteWithToken, `HEAD:${branchName}`]);
                        await commentOnIssue(octokit, owner, repo, pr.number, "🦫 **Gitybara** resolved merge conflicts!");
                    }
                    await execa("git", ["worktree", "remove", "--force", workDir], { cwd: clonePath });
                } catch (err) {
                    log.error({ err, pr: pr.number }, "❌ Conflict fix failed");
                }
            }
        }).catch(err => log.error({ err }, "PR conflict global limit error"));
    });
}

function buildPRBody(issueNumber: number, issueTitle: string, summary: string, filesChanged: string[]): string {
    return `## 🦫 Gitybara Auto-Fix\n\nCloses #${issueNumber}\n\n**Issue:** ${issueTitle}\n\n---\n\n### Changes Made\n\n${summary}\n\n### Files Modified\n\n${filesChanged.map((f) => `- \`${f}\``).join("\n") || "_No files detected_"}\n\n---\n\n> *This PR was automatically generated by [Gitybara](https://github.com/your-org/gitybara) 🦫*`;
}
