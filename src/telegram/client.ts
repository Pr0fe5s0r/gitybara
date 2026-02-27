import TelegramBot from "node-telegram-bot-api";
import chalk from "chalk";
import ora from "ora";
import { createLogger } from "../utils/logger.js";
import { analyzeBridgeMessage, planGithubIssue } from "../opencode/runner.js";
import { createGitHubClient } from "../github/client.js";
import { cancelTask, getRunningTasks } from "../tasks/manager.js";

const logger = createLogger("telegram-client");

interface ConversationState {
    step: "IDLE" | "AWAITING_REPO" | "AWAITING_MODEL" | "AWAITING_CONFIRMATION";
    draft?: {
        title: string;
        body: string;
    };
    selectedRepoIndex?: number;
    selectedModel?: string;
    forceNewBranch?: boolean;
    shareSession?: boolean;
}

const states = new Map<string, ConversationState>();

// Helper to send tagged messages
async function sendTagged(bot: TelegramBot, to: string, text: string) {
    return bot.sendMessage(to, `[GITYBARA] ${text}`);
}

export async function onboardTelegram(token: string): Promise<string> {
    const bot = new TelegramBot(token, { polling: true });
    let otp = `GITYBARA-${Math.floor(1000 + Math.random() * 9000)}`;

    console.log(chalk.bold.blue(`\n🤖 Bot initialized: @${(await bot.getMe()).username}`));
    const spinner = ora(`Waiting for you to send the OTP: ${chalk.bold.cyan(otp)} to the bot...`).start();

    return new Promise((resolve) => {
        bot.on("message", async (msg: TelegramBot.Message) => {
            if (msg.text?.includes(otp)) {
                spinner.succeed(chalk.green(`Received OTP! Verified owner Chat ID: ${msg.chat.id}`));
                await sendTagged(bot, msg.chat.id.toString(), `🦫 Gitybara authenticated successfully! Just text me ideas and I'll create well-planned GitHub issues for them.`);

                bot.stopPolling();
                resolve(msg.chat.id.toString());
            }
        });
    });
}

export async function startTelegramDaemon(
    globalConfig: import("../cli/config-store.js").GlobalConfig
) {
    if (!globalConfig.telegramTokens || globalConfig.telegramTokens.length === 0 || !globalConfig.telegramOwnerId) {
        return;
    }

    const ownerId = globalConfig.telegramOwnerId;
    const octokit = createGitHubClient(globalConfig.githubToken);

    for (const token of globalConfig.telegramTokens) {
        const bot = new TelegramBot(token, { polling: true });

        bot.getMe().then((me: TelegramBot.User) => {
            logger.info({ username: me.username }, `🤖 Telegram bot connected: @${me.username}`);
        });

        bot.on("message", async (msg: TelegramBot.Message) => {
            if (msg.chat.id.toString() !== ownerId) return;
            if (!msg.text) return;

            const text = msg.text.trim();
            // CRITICAL: Ignore any message starting with [GITYBARA]
            if (text.startsWith("[GITYBARA]") || text.startsWith("🦫 Gitybara") || text.includes("GITYBARA-") || text.startsWith("gitybara:") || text.startsWith("Gitybara:")) {
                return;
            }

            const state = states.get(ownerId) || { step: "IDLE" };

            // Handle stop/cancel commands
            const lowerText = text.toLowerCase();
            if (lowerText === "/stop" || lowerText === "/cancel" || lowerText === "stop" || lowerText === "cancel") {
                const tasks = getRunningTasks();
                if (tasks.length === 0) {
                    await sendTagged(bot, ownerId, "🦫 No tasks are currently running.");
                    return;
                }
                
                // Cancel the most recently started task
                const mostRecentTask = tasks[tasks.length - 1];
                await sendTagged(bot, ownerId, `🛑 Cancelling task for Issue #${mostRecentTask.issueNumber} in ${mostRecentTask.repoOwner}/${mostRecentTask.repoName}...`);
                
                const result = await cancelTask(mostRecentTask.jobId);
                if (result.success) {
                    await sendTagged(bot, ownerId, `✅ Task cancelled successfully!`);
                } else {
                    await sendTagged(bot, ownerId, `❌ Failed to cancel: ${result.message}`);
                }
                return;
            }

            // Handle /tasks command to list running tasks
            if (lowerText === "/tasks" || lowerText === "/status") {
                const tasks = getRunningTasks();
                if (tasks.length === 0) {
                    await sendTagged(bot, ownerId, "🦫 No tasks are currently running.");
                } else {
                    let message = `🦫 <b>Running Tasks (${tasks.length}):</b>\n\n`;
                    tasks.forEach((task, i) => {
                        const duration = Math.floor((Date.now() - task.startedAt.getTime()) / 1000 / 60);
                        message += `${i + 1}. Issue #${task.issueNumber} in ${task.repoOwner}/${task.repoName}\n`;
                        message += `   Branch: ${task.branchName}\n`;
                        message += `   Duration: ${duration}m\n\n`;
                    });
                    message += `Send /stop to cancel the most recent task.`;
                    await bot.sendMessage(ownerId, message, { parse_mode: "HTML" });
                }
                return;
            }

            if (state.step === "IDLE") {
                logger.info({ text: text.substring(0, 50) + "..." }, "Processing new message from Telegram owner...");

                const analysis = await analyzeBridgeMessage(
                    text,
                    globalConfig.defaultProvider,
                    globalConfig.defaultModel,
                    globalConfig.repos
                );

                if (analysis.intent === "GENERIC_CHAT" || analysis.intent === "LIST_REPOS") {
                    await sendTagged(bot, ownerId, analysis.response || "🦫 Gitybara is listening!");
                    return;
                }

                if (analysis.intent === "ISSUE_IDEA" && analysis.draft) {
                    state.draft = analysis.draft;
                    state.forceNewBranch = analysis.forceNewBranch || false;
                    state.shareSession = analysis.shareSession || false;
                    states.set(ownerId, state);

                    // Smart Autodetection
                    if (typeof analysis.suggestedRepoIndex === "number" && analysis.suggestedRepoIndex >= 0 && analysis.suggestedRepoIndex < globalConfig.repos.length) {
                        state.selectedRepoIndex = analysis.suggestedRepoIndex;
                        state.step = "AWAITING_MODEL";
                        states.set(ownerId, state);

                        const repo = globalConfig.repos[state.selectedRepoIndex];
                        await sendTagged(bot, ownerId,
                            `🦫 I've drafted an issue for you!\n\n*Repo (Autodetected):* ${repo.owner}/${repo.repo}\n*Title:* ${analysis.draft.title}\n\n*Would you like to use a specific model?*\nDefault: ${globalConfig.defaultModel || "OpenCode Default"}\n\n(Reply with a model name, or reply 'skip' to use default)`
                        );
                    } else {
                        state.step = "AWAITING_REPO";
                        states.set(ownerId, state);

                        let repoList = globalConfig.repos.map((r, i) => `${i + 1}. ${r.owner}/${r.repo}`).join("\n");
                        await sendTagged(bot, ownerId,
                            `🦫 I've drafted an issue for you!\n\n*Title:* ${analysis.draft.title}\n\n*Description:* ${analysis.draft.body.substring(0, 200)}...\n\n*Which repository should I add this to?*\n${repoList}\n\n(Reply with the number)`
                        );
                    }
                }
            }
            else if (state.step === "AWAITING_REPO") {
                const index = parseInt(text) - 1;
                if (isNaN(index) || index < 0 || index >= globalConfig.repos.length) {
                    await sendTagged(bot, ownerId, "❌ Invalid selection. Please reply with a number from the list.");
                    return;
                }

                state.selectedRepoIndex = index;
                state.step = "AWAITING_MODEL";
                states.set(ownerId, state);

                await sendTagged(bot, ownerId,
                    `📌 Target Repo: ${globalConfig.repos[index].owner}/${globalConfig.repos[index].repo}\n\n*Would you like to use a specific model?*\nDefault: ${globalConfig.defaultModel || "OpenCode Default"}\n\n(Reply with a model name, or reply 'skip' to use default)`
                );
            }
            else if (state.step === "AWAITING_MODEL") {
                if (text.toLowerCase() !== "skip") {
                    state.selectedModel = text;
                } else {
                    state.selectedModel = globalConfig.defaultModel;
                }

                state.step = "AWAITING_CONFIRMATION";
                states.set(ownerId, state);

                const repo = globalConfig.repos[state.selectedRepoIndex!];
                const shareIcon = state.shareSession ? "✅" : "❌";
                await sendTagged(bot, ownerId,
                    `🚀 *Final Confirmation*\n\n*Repo:* ${repo.owner}/${repo.repo}\n*Model:* ${state.selectedModel}\n*Issue:* ${state.draft?.title}\n*Share Session:* ${shareIcon}\n\nReady to publish? (Reply 'yes' to create, 'no' to cancel, or 'share' to toggle session visibility)`
                );
            }
            else if (state.step === "AWAITING_CONFIRMATION") {
                if (text.toLowerCase() === "share") {
                    state.shareSession = !state.shareSession;
                    states.set(ownerId, state);
                    const repo = globalConfig.repos[state.selectedRepoIndex!];
                    const shareIcon = state.shareSession ? "✅" : "❌";
                    await sendTagged(bot, ownerId, `👁️ Session visibility toggled: ${shareIcon}\n\nReady to publish? (Reply 'yes', 'no', or 'share')`);
                    return;
                }

                if (text.toLowerCase() === "yes") {
                    const repo = globalConfig.repos[state.selectedRepoIndex!];
                    await sendTagged(bot, ownerId, "⏳ Publishing to GitHub...");

                    try {
                        const repoId = await (await import("../db/index.js")).upsertRepo(repo.owner, repo.repo);
                        const { createJob } = await import("../db/index.js");

                        const labels = [repo.issueLabel || "gitybara"];
                        if (state.shareSession) {
                            labels.push("share:session_url");
                        }

                        const issueRes = await octokit.rest.issues.create({
                            owner: repo.owner,
                            repo: repo.repo,
                            title: state.draft!.title,
                            body: state.draft!.body,
                            labels
                        });

                        const issue = issueRes.data;
                        await createJob(
                            repoId,
                            repo.owner,
                            repo.repo,
                            issue.number,
                            issue.title,
                            state.forceNewBranch
                        );

                        logger.info({ url: issue.html_url }, "Created new GitHub issue via interactive Telegram flow");
                        await sendTagged(bot, ownerId, `✅ Created Issue #${issue.number}!\n${issue.html_url}`);
                    } catch (err: any) {
                        logger.error({ err }, "Failed to create GitHub issue");
                        await sendTagged(bot, ownerId, `❌ Failed to create GitHub issue: ${err.message}`);
                    }
                } else {
                    await sendTagged(bot, ownerId, "🦫 Okay, cancelled. I've discarded the draft.");
                }

                state.step = "IDLE";
                states.set(ownerId, state);
            }
        });

        bot.on("polling_error", (error: Error) => {
            if ((error as any).code !== "EFATAL") { }
        });
    }
}
