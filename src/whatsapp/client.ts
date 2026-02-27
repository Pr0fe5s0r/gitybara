import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import chalk from "chalk";
import ora from "ora";
import path from "path";
import fs from "fs";
import { GITYBARA_DIR } from "../cli/config-store.js";
import { analyzeBridgeMessage, planGithubIssue } from "../opencode/runner.js";
import { createGitHubClient } from "../github/client.js";
import { createLogger } from "../utils/logger.js";
import { cancelTask, getRunningTasks } from "../tasks/manager.js";

const logger = createLogger("whatsapp-client");
const SESSION_PATH = path.join(GITYBARA_DIR, "sessions", "whatsapp");

function ensureSessionPath() {
    if (!fs.existsSync(SESSION_PATH)) {
        fs.mkdirSync(SESSION_PATH, { recursive: true });
    }
}

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
async function sendTagged(client: any, to: string, text: string) {
    return client.sendMessage(to, `[GITYBARA] ${text}`);
}

export async function onboardWhatsapp(options?: { forceNew?: boolean }): Promise<string> {
    if (options?.forceNew && fs.existsSync(SESSION_PATH)) {
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    }
    ensureSessionPath();

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: "gitybara-client",
            dataPath: SESSION_PATH
        }),
        webVersionCache: {
            type: "local",
            path: path.join(SESSION_PATH, ".wwebjs_cache")
        },
        puppeteer: {
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        }
    });

    return new Promise((resolve, reject) => {
        let otp = `${Math.floor(100000 + Math.random() * 900000)}`;
        let spinner: any;

        let qrCount = 0;
        client.on("qr", (qr) => {
            qrCount++;
            if (qrCount > 1) {
                console.log(chalk.bold.yellow("\n🔄 QR Code refreshed. Please scan the new QR code:"));
            } else {
                console.log(chalk.bold.yellow("\n📱 Scan this QR code with WhatsApp to connect:"));
            }
            qrcode.generate(qr, { small: true });
        });

        client.on("ready", () => {
            console.log(chalk.bold.green("\n✅ WhatsApp connected successfully!"));
            spinner = ora(`Waiting for you to send the OTP: ${chalk.bold.cyan(otp)} to any chat or your own number...`).start();
        });

        client.on("message_create", async (msg) => {
            if (msg.body.includes(otp)) {
                const verifiedOwnerId = msg.fromMe ? msg.to : msg.from;

                if (spinner) spinner.succeed(chalk.green(`Received OTP! Verified owner: ${verifiedOwnerId}`));
                await sendTagged(client, verifiedOwnerId, `🦫 Gitybara authenticated successfully! Just text me ideas and I'll create well-planned GitHub issues for them.`);

                setTimeout(() => {
                    client.destroy();
                    resolve(verifiedOwnerId);
                }, 2000);
            }
        });

        client.on("auth_failure", (msg) => {
            reject(new Error(`WhatsApp authentication failed: ${msg}`));
        });

        client.initialize().catch(reject);
    });
}

export async function startWhatsappDaemon(
    globalConfig: import("../cli/config-store.js").GlobalConfig
) {
    if (!globalConfig.whatsappOwnerId || globalConfig.repos.length === 0) {
        return;
    }

    const ownerId = globalConfig.whatsappOwnerId;
    ensureSessionPath();

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: "gitybara-client",
            dataPath: SESSION_PATH
        }),
        webVersionCache: {
            type: "local",
            path: path.join(SESSION_PATH, ".wwebjs_cache")
        },
        puppeteer: {
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        }
    });

    const octokit = createGitHubClient(globalConfig.githubToken);

    client.on("ready", () => {
        logger.info({ jid: ownerId }, "📱 WhatsApp Bridge is READY and listening for messages");
    });

    client.on("message_create", async (msg) => {
        // Normalize comparison for owner verification
        const remoteJid = msg.fromMe ? msg.to : msg.from;
        if (remoteJid !== ownerId) return;

        const text = msg.body.trim();
        if (!text) return;

        // Filter out control and loop messages - CRITICAL: Ignore any message starting with [GITYBARA]
        if (text.startsWith("[GITYBARA]") || text.startsWith("🦫 Gitybara") || text.includes("GITYBARA-") || text.startsWith("gitybara:") || text.startsWith("Gitybara:")) {
            return;
        }

        const state = states.get(ownerId) || { step: "IDLE" };

        // Handle stop/cancel commands
        const lowerText = text.toLowerCase();
        if (lowerText === "stop" || lowerText === "cancel") {
            const tasks = getRunningTasks();
            if (tasks.length === 0) {
                await sendTagged(client, ownerId, "🦫 No tasks are currently running.");
                return;
            }
            
            // Cancel the most recently started task
            const mostRecentTask = tasks[tasks.length - 1];
            await sendTagged(client, ownerId, `🛑 Cancelling task for Issue #${mostRecentTask.issueNumber} in ${mostRecentTask.repoOwner}/${mostRecentTask.repoName}...`);
            
            const result = await cancelTask(mostRecentTask.jobId);
            if (result.success) {
                await sendTagged(client, ownerId, `✅ Task cancelled successfully!`);
            } else {
                await sendTagged(client, ownerId, `❌ Failed to cancel: ${result.message}`);
            }
            return;
        }

        // Handle "tasks" command to list running tasks
        if (lowerText === "tasks" || lowerText === "status") {
            const tasks = getRunningTasks();
            if (tasks.length === 0) {
                await sendTagged(client, ownerId, "🦫 No tasks are currently running.");
            } else {
                let message = `🦫 *Running Tasks (${tasks.length}):*\n\n`;
                tasks.forEach((task, i) => {
                    const duration = Math.floor((Date.now() - task.startedAt.getTime()) / 1000 / 60);
                    message += `${i + 1}. Issue #${task.issueNumber} in ${task.repoOwner}/${task.repoName}\n`;
                    message += `   Branch: ${task.branchName}\n`;
                    message += `   Duration: ${duration}m\n\n`;
                });
                message += `Reply "stop" to cancel the most recent task.`;
                await sendTagged(client, ownerId, message);
            }
            return;
        }

        if (state.step === "IDLE") {
            logger.info({ text: text.substring(0, 50) + "..." }, "Processing new message from owner...");

            const analysis = await analyzeBridgeMessage(
                text,
                globalConfig.defaultProvider,
                globalConfig.defaultModel,
                globalConfig.repos
            );

            if (analysis.intent === "GENERIC_CHAT" || analysis.intent === "LIST_REPOS") {
                await sendTagged(client, ownerId, analysis.response || "🦫 Gitybara is listening!");
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
                    await sendTagged(client, ownerId,
                        `🦫 I've drafted an issue for you!\n\n*Repo (Autodetected):* ${repo.owner}/${repo.repo}\n*Title:* ${analysis.draft.title}\n\n*Would you like to use a specific model?*\nDefault: ${globalConfig.defaultModel || "OpenCode Default"}\n\n(Reply with a model name, or reply 'skip' to use default)`
                    );
                } else {
                    state.step = "AWAITING_REPO";
                    states.set(ownerId, state);

                    let repoList = globalConfig.repos.map((r, i) => `${i + 1}. ${r.owner}/${r.repo}`).join("\n");
                    await sendTagged(client, ownerId,
                        `🦫 I've drafted an issue for you!\n\n*Title:* ${analysis.draft.title}\n\n*Description:* ${analysis.draft.body.substring(0, 200)}...\n\n*Which repository should I add this to?*\n${repoList}\n\n(Reply with the number)`
                    );
                }
            }
        }
        else if (state.step === "AWAITING_REPO") {
            const index = parseInt(text) - 1;
            if (isNaN(index) || index < 0 || index >= globalConfig.repos.length) {
                await sendTagged(client, ownerId, "❌ Invalid selection. Please reply with a number from the list.");
                return;
            }

            state.selectedRepoIndex = index;
            state.step = "AWAITING_MODEL";
            states.set(ownerId, state);

            await sendTagged(client, ownerId,
                `📌 Target Repo: ${globalConfig.repos[index].owner}/${globalConfig.repos[index].repo}\n\n*Would you like to use a specific model?*\nDefault: ${globalConfig.defaultModel || "OpenCode Default"}\n\n(Reply with a model name like 'claude-3-5-sonnet', or reply 'skip' to use default)`
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
            await sendTagged(client, ownerId,
                `🚀 *Final Confirmation*\n\n*Repo:* ${repo.owner}/${repo.repo}\n*Model:* ${state.selectedModel}\n*Issue:* ${state.draft?.title}\n*Share Session:* ${shareIcon}\n\nReady to publish? (Reply 'yes' to create, 'no' to cancel, or 'share' to toggle session visibility)`
            );
        }
        else if (state.step === "AWAITING_CONFIRMATION") {
            if (text.toLowerCase() === "share") {
                state.shareSession = !state.shareSession;
                states.set(ownerId, state);
                const repo = globalConfig.repos[state.selectedRepoIndex!];
                const shareIcon = state.shareSession ? "✅" : "❌";
                await sendTagged(client, ownerId, `👁️ Session visibility toggled: ${shareIcon}\n\nReady to publish? (Reply 'yes', 'no', or 'share')`);
                return;
            }

            if (text.toLowerCase() === "yes") {
                const repo = globalConfig.repos[state.selectedRepoIndex!];
                await sendTagged(client, ownerId, "⏳ Publishing to GitHub...");

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

                    logger.info({ url: issue.html_url }, "Created new GitHub issue via interactive WhatsApp flow");
                    await sendTagged(client, ownerId, `✅ Created Issue #${issue.number}!\n${issue.html_url}`);
                } catch (err: any) {
                    logger.error({ err }, "Failed to create GitHub issue");
                    await sendTagged(client, ownerId, `❌ Failed to create GitHub issue: ${err.message}`);
                }
            } else {
                await sendTagged(client, ownerId, "🦫 Okay, cancelled. I've discarded the draft.");
            }

            state.step = "IDLE";
            states.set(ownerId, state);
        }
    });

    client.initialize().catch(err => {
        logger.error({ err }, "Failed to initialize WhatsApp client");
    });
}
