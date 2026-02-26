import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import path from "path";
import fs from "fs";
import {
    readConfig,
    writeConfig,
    getDefaultConfig,
    ensureGitybaraDir,
    type GlobalConfig,
    type RepoConfig,
} from "./config-store.js";
import { initDb } from "../db/index.js";
import { createGitHubClient } from "../github/client.js";
import { execa } from "execa";

export async function initCommand(options: { repo?: string }) {
    console.log(
        chalk.bold.cyan("\n🦫 Welcome to Gitybara") +
        chalk.gray(" — Autonomous GitHub Issue Solver\n")
    );

    const existingConfig = readConfig() || getDefaultConfig();

    // ── Step 1: GitHub Token ────────────────────────────────────────────
    console.log(chalk.bold("Step 1: GitHub Authentication"));
    const { githubToken } = await inquirer.prompt([
        {
            type: "password",
            name: "githubToken",
            message: "GitHub Personal Access Token (needs repo + workflow scopes):",
            default: existingConfig.githubToken || undefined,
            validate: (v: string) => (v.length > 10 ? true : "Token too short"),
        },
    ]);

    // Verify token
    const spinner = ora("Verifying GitHub token…").start();
    try {
        const octokit = createGitHubClient(githubToken);
        const { data: user } = await octokit.rest.users.getAuthenticated();
        spinner.succeed(chalk.green(`Authenticated as @${user.login}`));
    } catch {
        spinner.fail(chalk.red("Invalid GitHub token. Please try again."));
        process.exit(1);
    }

    // ── Step 2: Repository ──────────────────────────────────────────────
    console.log(chalk.bold("\nStep 2: Connect GitHub Repositories"));
    const repoConfigs: RepoConfig[] = [];
    let initialRepo = options.repo;
    let addAnother = true;

    while (addAnother) {
        let repoInput = initialRepo;
        if (!repoInput) {
            const ans = await inquirer.prompt([
                {
                    type: "input",
                    name: "repo",
                    message: "Repository (owner/repo):",
                    validate: (v: string) =>
                        /^[\w.-]+\/[\w.-]+$/.test(v) ? true : "Format: owner/repo",
                },
            ]);
            repoInput = ans.repo as string;
        }

        const [owner, repo] = repoInput.split("/");

        const { issueLabel, baseBranch } = await inquirer.prompt([
            {
                type: "input",
                name: "issueLabel",
                message:
                    `Label to filter issues in ${owner}/${repo} (leave blank for ALL open issues, or e.g. "gitybara"):`,
                default: "gitybara",
            },
            {
                type: "input",
                name: "baseBranch",
                message: "Base branch for new branches:",
                default: "main",
            },
        ]);

        // Clone path
        const defaultClonePath = path.join(
            process.env.HOME || process.env.USERPROFILE || "~",
            ".gitybara",
            "repos",
            `${owner}-${repo}`
        );
        const { clonePath } = await inquirer.prompt([
            {
                type: "input",
                name: "clonePath",
                message: `Where should Gitybara clone ${owner}/${repo} locally?`,
                default: defaultClonePath,
            },
        ]);

        repoConfigs.push({ owner, repo, issueLabel, baseBranch, clonePath });
        initialRepo = undefined; // Clear the CLI option so the next iteration prompts

        const { wantAnother } = await inquirer.prompt([
            {
                type: "confirm",
                name: "wantAnother",
                message: "Connect another repository?",
                default: false,
            },
        ]);
        addAnother = wantAnother;
    }

    // ── Step 3: OpenCode ────────────────────────────────────────────────
    console.log(chalk.bold("\nStep 3: OpenCode Configuration"));
    const { opencodePath } = await inquirer.prompt([
        {
            type: "input",
            name: "opencodePath",
            message: "Path to opencode binary (or just 'opencode' if on PATH):",
            default: existingConfig.opencodePath || "opencode",
        },
    ]);

    // Check opencode accessible
    const spinner2 = ora("Checking OpenCode…").start();
    try {
        await execa(opencodePath, ["--version"]);
        spinner2.succeed(chalk.green("OpenCode found!"));
    } catch {
        spinner2.warn(
            chalk.yellow(
                "OpenCode not found at that path. You can fix this later via `gitybara config --set opencodePath=<path>`."
            )
        );
    }

    let defaultProvider = "";
    let defaultModel = "";

    const spinnerModels = ora("Fetching available AI models from OpenCode SDK…").start();
    let availableModels: { providerId: string; modelId: string }[] = [];
    try {
        const { getAvailableModels } = await import("../opencode/models.js");
        availableModels = await getAvailableModels();
        spinnerModels.succeed(chalk.green(`Found ${availableModels.length} models via OpenCode SDK`));
    } catch {
        spinnerModels.warn(chalk.yellow("Could not fetch models from OpenCode SDK. Falling back to manual entry."));
    }

    if (availableModels.length > 0) {
        const providers = [...new Set(availableModels.map(m => m.providerId))];
        const { providerAns } = await inquirer.prompt([
            {
                type: "list",
                name: "providerAns",
                message: "Select Default AI provider (or Choose Manual to type it out):",
                choices: [...providers, "Manual Entry"],
            }
        ]);

        if (providerAns === "Manual Entry") {
            const manualParams = await inquirer.prompt([
                {
                    type: "input",
                    name: "defaultProvider",
                    message: "Manual Provider (e.g. anthropic, openai):",
                    default: existingConfig.defaultProvider,
                },
                {
                    type: "input",
                    name: "defaultModel",
                    message: "Manual Model ID (e.g. claude-3-7-sonnet-latest):",
                    default: existingConfig.defaultModel,
                },
            ]);
            defaultProvider = manualParams.defaultProvider;
            defaultModel = manualParams.defaultModel;
        } else {
            defaultProvider = providerAns;
            const modelsForProvider = availableModels.filter(m => m.providerId === defaultProvider).map(m => m.modelId);
            const { modelAns } = await inquirer.prompt([
                {
                    type: "list",
                    name: "modelAns",
                    message: `Select Default model for ${defaultProvider}:`,
                    choices: modelsForProvider,
                }
            ]);
            defaultModel = modelAns;
        }
    } else {
        const manualParams = await inquirer.prompt([
            {
                type: "input",
                name: "defaultProvider",
                message: "Default AI provider (e.g. anthropic, openai, google — leave blank to use OpenCode default):",
                default: existingConfig.defaultProvider || "",
            },
            {
                type: "input",
                name: "defaultModel",
                message: "Default model (leave blank to use OpenCode default):",
                default: existingConfig.defaultModel || "",
            },
        ]);
        defaultProvider = manualParams.defaultProvider;
        defaultModel = manualParams.defaultModel;
    }

    // ── Step 4: Daemon settings ─────────────────────────────────────────
    console.log(chalk.bold("\nStep 4: Daemon Settings"));
    const { pollingInterval, daemonPort } = await inquirer.prompt([
        {
            type: "number",
            name: "pollingInterval",
            message: "Polling interval (minutes):",
            default: existingConfig.pollingIntervalMinutes || 5,
        },
        {
            type: "number",
            name: "daemonPort",
            message: "Local HTTP server port (for status API & webhooks):",
            default: existingConfig.daemonPort || 4242,
        },
    ]);

    // ── Step 5: WhatsApp Integration ────────────────────────────────────
    console.log(chalk.bold("\nStep 5: WhatsApp Integration (Optional)"));
    const { connectWhatsapp } = await inquirer.prompt([
        {
            type: "confirm",
            name: "connectWhatsapp",
            message: "Connect WhatsApp to create GitHub issues via text message?",
            default: false,
        }
    ]);

    let whatsappOwnerId = existingConfig.whatsappOwnerId;
    if (connectWhatsapp) {
        try {
            const { onboardWhatsapp } = await import("../whatsapp/client.js");
            whatsappOwnerId = await onboardWhatsapp();
            console.log(chalk.green(`\nWhatsApp connected! Bound to: ${whatsappOwnerId}`));
        } catch (err: any) {
            console.log(chalk.red(`\nWhatsApp connection failed: ${err.message}`));
        }
    }

    // ── Step 6: Telegram Integration ────────────────────────────────────
    console.log(chalk.bold("\nStep 6: Telegram Integration (Optional)"));
    const { connectTelegram } = await inquirer.prompt([
        {
            type: "confirm",
            name: "connectTelegram",
            message: "Connect Telegram to create GitHub issues via bot commands?",
            default: false,
        }
    ]);

    let telegramTokens = existingConfig.telegramTokens || [];
    let telegramOwnerId = existingConfig.telegramOwnerId;

    if (connectTelegram) {
        const { tokensInput } = await inquirer.prompt([
            {
                type: "input",
                name: "tokensInput",
                message: "Enter Telegram Bot Tokens (comma separated if multiple):",
                default: telegramTokens.join(", ") || undefined,
            }
        ]);

        if (tokensInput) {
            telegramTokens = (tokensInput as string).split(",").map(t => t.trim()).filter(t => t);

            if (telegramTokens.length > 0) {
                const { verifyTelegram } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "verifyTelegram",
                        message: "Authenticate yourself as the owner on one of these bots now?",
                        default: true,
                    }
                ]);

                if (verifyTelegram) {
                    try {
                        const { onboardTelegram } = await import("../telegram/client.js");
                        // We verify against the first token for simplicity during onboard
                        telegramOwnerId = await onboardTelegram(telegramTokens[0]);
                        console.log(chalk.green(`\nTelegram authenticated! Bound to Chat ID: ${telegramOwnerId}`));
                    } catch (err: any) {
                        console.log(chalk.red(`\nTelegram verification failed: ${err.message}`));
                    }
                }
            }
        }
    }

    // Merge repos — replace if same owner/repo already exists
    let mergedRepos = [...existingConfig.repos];
    for (const newRepo of repoConfigs) {
        mergedRepos = mergedRepos.filter(
            (r) => !(r.owner === newRepo.owner && r.repo === newRepo.repo)
        );
        mergedRepos.push(newRepo);
    }

    const newConfig: GlobalConfig = {
        githubToken,
        repos: mergedRepos,
        pollingIntervalMinutes: pollingInterval as number,
        daemonPort: daemonPort as number,
        opencodePath,
        defaultProvider: defaultProvider || undefined,
        defaultModel: defaultModel || undefined,
        whatsappOwnerId,
        telegramTokens: telegramTokens.length > 0 ? telegramTokens : undefined,
        telegramOwnerId,
    };

    ensureGitybaraDir();
    writeConfig(newConfig);
    await initDb(); // ensure DB schema is created

    // Clone repos if not already cloned
    for (const repoConfig of repoConfigs) {
        if (!fs.existsSync(path.join(repoConfig.clonePath as string, ".git"))) {
            const spinner3 = ora(`Cloning ${repoConfig.owner}/${repoConfig.repo}…`).start();
            try {
                fs.mkdirSync(repoConfig.clonePath as string, { recursive: true });
                await execa("git", [
                    "clone",
                    `https://x-access-token:${githubToken}@github.com/${repoConfig.owner}/${repoConfig.repo}.git`,
                    repoConfig.clonePath as string,
                ]);
                spinner3.succeed(chalk.green(`Cloned ${repoConfig.owner}/${repoConfig.repo} to ${repoConfig.clonePath}`));
            } catch (e) {
                spinner3.fail(chalk.red("Git clone failed: " + String(e)));
            }
        } else {
            console.log(chalk.gray(`Repo already cloned at ${repoConfig.clonePath}`));
        }
    }

    console.log(
        chalk.bold.green("\n✅ Gitybara configured!") +
        chalk.gray(`\n   Config saved to ~/.gitybara/config.json`) +
        chalk.gray(`\n   Run `) +
        chalk.cyan("gitybara start") +
        chalk.gray(" to begin watching issues.\n")
    );
}
