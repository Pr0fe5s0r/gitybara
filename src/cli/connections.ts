import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import path from "path";
import fs from "fs";
import {
    readConfig,
    writeConfig,
    GITYBARA_DIR,
    type GlobalConfig,
} from "./config-store.js";

const WHATSAPP_SESSION_PATH = path.join(GITYBARA_DIR, "sessions", "whatsapp");

export async function connectCommand(service: string, options?: { force?: boolean }) {
    const config = readConfig();
    if (!config) {
        console.log(chalk.red("No configuration found. Please run 'gitybara init' first."));
        process.exit(1);
    }

    const serviceLower = service.toLowerCase();

    if (serviceLower === "whatsapp") {
        await connectWhatsApp(config, options?.force);
    } else if (serviceLower === "telegram") {
        await connectTelegram(config);
    } else {
        console.log(chalk.red(`Unknown service: ${service}`));
        console.log(chalk.gray("Supported services: whatsapp, telegram"));
        process.exit(1);
    }
}

export async function disconnectCommand(service: string) {
    const config = readConfig();
    if (!config) {
        console.log(chalk.red("No configuration found. Please run 'gitybara init' first."));
        process.exit(1);
    }

    const serviceLower = service.toLowerCase();

    if (serviceLower === "whatsapp") {
        await disconnectWhatsApp(config);
    } else if (serviceLower === "telegram") {
        await disconnectTelegram(config);
    } else {
        console.log(chalk.red(`Unknown service: ${service}`));
        console.log(chalk.gray("Supported services: whatsapp, telegram"));
        process.exit(1);
    }
}

export async function listConnectionsCommand() {
    const config = readConfig();
    if (!config) {
        console.log(chalk.red("No configuration found. Please run 'gitybara init' first."));
        process.exit(1);
    }

    console.log(chalk.bold.cyan("\n🦫 Gitybara Connections\n"));

    const table = new Table({
        head: [chalk.bold("Service"), chalk.bold("Status"), chalk.bold("Details")],
        style: { head: [], border: [] },
    });

    // WhatsApp status
    const whatsappConnected = isWhatsAppConnected(config);
    const whatsappStatus = whatsappConnected
        ? chalk.green("● Connected")
        : chalk.gray("○ Disconnected");
    const whatsappDetails = config.whatsappOwnerId
        ? `Owner: ${config.whatsappOwnerId}`
        : "Not configured";
    table.push(["WhatsApp", whatsappStatus, whatsappDetails]);

    // Telegram status
    const telegramConnected = isTelegramConnected(config);
    const telegramStatus = telegramConnected
        ? chalk.green("● Connected")
        : chalk.gray("○ Disconnected");
    const telegramDetails = config.telegramTokens && config.telegramTokens.length > 0
        ? `${config.telegramTokens.length} bot(s) configured${config.telegramOwnerId ? `, Owner: ${config.telegramOwnerId}` : ""}`
        : "Not configured";
    table.push(["Telegram", telegramStatus, telegramDetails]);

    console.log(table.toString());
    console.log();

    // Show helpful hints
    console.log(chalk.gray("Commands:"));
    console.log(`  ${chalk.cyan("gitybara connect whatsapp")}    - Connect WhatsApp`);
    console.log(`  ${chalk.cyan("gitybara connect telegram")}    - Connect Telegram`);
    console.log(`  ${chalk.cyan("gitybara disconnect whatsapp")} - Disconnect WhatsApp`);
    console.log(`  ${chalk.cyan("gitybara disconnect telegram")} - Disconnect Telegram`);
    console.log();
}

async function connectWhatsApp(config: GlobalConfig, forceNew?: boolean) {
    console.log(chalk.bold("\n📱 WhatsApp Connection\n"));

    if (config.whatsappOwnerId && !forceNew) {
        const { reconnect } = await inquirer.prompt([
            {
                type: "confirm",
                name: "reconnect",
                message: `WhatsApp is already connected (Owner ID: ${config.whatsappOwnerId}). Do you want to reconnect?`,
                default: false,
            },
        ]);

        if (!reconnect) {
            console.log(chalk.gray("Keeping existing WhatsApp connection."));
            return;
        }
    }

    // Clear existing session if forcing new connection
    if (forceNew && fs.existsSync(WHATSAPP_SESSION_PATH)) {
        fs.rmSync(WHATSAPP_SESSION_PATH, { recursive: true, force: true });
        console.log(chalk.gray("Cleared existing WhatsApp session."));
    }

    try {
        const { onboardWhatsapp } = await import("../whatsapp/client.js");
        const ownerId = await onboardWhatsapp({ forceNew });

        config.whatsappOwnerId = ownerId;
        writeConfig(config);

        console.log(chalk.green(`\n✅ WhatsApp connected successfully!`));
        console.log(chalk.gray(`Bound to: ${ownerId}`));
        console.log(chalk.gray("\nRestart the daemon for changes to take effect:"));
        console.log(chalk.cyan("  gitybara stop && gitybara start"));
    } catch (err: any) {
        console.log(chalk.red(`\n❌ WhatsApp connection failed: ${err.message}`));
        process.exit(1);
    }
}

async function connectTelegram(config: GlobalConfig) {
    console.log(chalk.bold("\n🤖 Telegram Connection\n"));

    const existingTokens = config.telegramTokens || [];

    const { tokensInput } = await inquirer.prompt([
        {
            type: "input",
            name: "tokensInput",
            message: "Enter Telegram Bot Token(s) (comma separated if multiple):",
            default: existingTokens.join(", ") || undefined,
            validate: (input: string) => {
                if (!input || input.trim().length === 0) {
                    return "Please enter at least one bot token";
                }
                return true;
            },
        },
    ]);

    const newTokens = tokensInput
        .split(",")
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0);

    if (newTokens.length === 0) {
        console.log(chalk.red("No valid tokens provided."));
        process.exit(1);
    }

    // Merge with existing tokens, removing duplicates
    const allTokens = [...new Set([...existingTokens, ...newTokens])];

    const { verifyNow } = await inquirer.prompt([
        {
            type: "confirm",
            name: "verifyNow",
            message: "Authenticate yourself as the owner now?",
            default: true,
        },
    ]);

    let ownerId = config.telegramOwnerId;

    if (verifyNow) {
        try {
            const { onboardTelegram } = await import("../telegram/client.js");
            ownerId = await onboardTelegram(allTokens[0]);
            console.log(chalk.green(`\n✅ Telegram authenticated! Bound to Chat ID: ${ownerId}`));
        } catch (err: any) {
            console.log(chalk.red(`\n❌ Telegram verification failed: ${err.message}`));
            console.log(chalk.yellow("\nTokens are saved but owner is not verified."));
            console.log(chalk.gray("You can verify later by running 'gitybara connect telegram' again."));
        }
    }

    config.telegramTokens = allTokens;
    if (ownerId) {
        config.telegramOwnerId = ownerId;
    }
    writeConfig(config);

    console.log(chalk.green(`\n✅ Telegram configuration saved!`));
    console.log(chalk.gray(`${allTokens.length} bot(s) configured`));
    if (config.telegramOwnerId) {
        console.log(chalk.gray(`Owner: ${config.telegramOwnerId}`));
    }
    console.log(chalk.gray("\nRestart the daemon for changes to take effect:"));
    console.log(chalk.cyan("  gitybara stop && gitybara start"));
}

async function disconnectWhatsApp(config: GlobalConfig) {
    console.log(chalk.bold("\n📱 Disconnect WhatsApp\n"));

    if (!config.whatsappOwnerId) {
        console.log(chalk.yellow("WhatsApp is not currently connected."));
        return;
    }

    const { confirm } = await inquirer.prompt([
        {
            type: "confirm",
            name: "confirm",
            message: `Disconnect WhatsApp (Owner ID: ${config.whatsappOwnerId})?`,
            default: false,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray("Operation cancelled."));
        return;
    }

    // Clear session files
    if (fs.existsSync(WHATSAPP_SESSION_PATH)) {
        const spinner = ora("Clearing WhatsApp session...").start();
        try {
            fs.rmSync(WHATSAPP_SESSION_PATH, { recursive: true, force: true });
            spinner.succeed(chalk.green("WhatsApp session cleared."));
        } catch (err: any) {
            spinner.fail(chalk.red(`Failed to clear session: ${err.message}`));
        }
    }

    // Update config
    delete config.whatsappOwnerId;
    writeConfig(config);

    console.log(chalk.green("✅ WhatsApp disconnected successfully."));
    console.log(chalk.gray("\nRestart the daemon for changes to take effect:"));
    console.log(chalk.cyan("  gitybara stop && gitybara start"));
}

async function disconnectTelegram(config: GlobalConfig) {
    console.log(chalk.bold("\n🤖 Disconnect Telegram\n"));

    const hasTokens = config.telegramTokens && config.telegramTokens.length > 0;
    const hasOwner = !!config.telegramOwnerId;

    if (!hasTokens && !hasOwner) {
        console.log(chalk.yellow("Telegram is not currently connected."));
        return;
    }

    const { confirm } = await inquirer.prompt([
        {
            type: "confirm",
            name: "confirm",
            message: `Remove Telegram configuration (${config.telegramTokens?.length || 0} bot(s), Owner: ${config.telegramOwnerId || "N/A"})?`,
            default: false,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray("Operation cancelled."));
        return;
    }

    // Update config
    delete config.telegramTokens;
    delete config.telegramOwnerId;
    writeConfig(config);

    console.log(chalk.green("✅ Telegram disconnected successfully."));
    console.log(chalk.gray("\nRestart the daemon for changes to take effect:"));
    console.log(chalk.cyan("  gitybara stop && gitybara start"));
}

function isWhatsAppConnected(config: GlobalConfig): boolean {
    // Check if session directory exists and has content
    if (!config.whatsappOwnerId) return false;
    if (!fs.existsSync(WHATSAPP_SESSION_PATH)) return false;

    try {
        const files = fs.readdirSync(WHATSAPP_SESSION_PATH);
        return files.length > 0;
    } catch {
        return false;
    }
}

function isTelegramConnected(config: GlobalConfig): boolean {
    return !!(
        config.telegramTokens &&
        config.telegramTokens.length > 0 &&
        config.telegramOwnerId
    );
}
