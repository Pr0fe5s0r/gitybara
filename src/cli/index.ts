#!/usr/bin/env node
import { Agent, setGlobalDispatcher } from "undici";

// Increase timeouts for long-running AI prompts (20 minutes)
setGlobalDispatcher(new Agent({
    headersTimeout: 20 * 60 * 1000,
    bodyTimeout: 20 * 60 * 1000,
    connectTimeout: 60 * 1000,
}));

import { Command } from "commander";
import { initCommand } from "./init.js";
import { startCommand } from "./start.js";
import { stopCommand } from "./stop.js";
import { statusCommand } from "./status.js";
import { cancelCommand, listJobsCommand } from "./cancel.js";
import { configCommand, configModelCommand } from "./config.js";
import { learnCommand } from "./learn.js";
import { addRepoCommand, removeRepoCommand } from "./repo-management.js";
import chalk from "chalk";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

const program = new Command();

program
    .name("gitybara")
    .description(
        chalk.bold.cyan("🦫 Gitybara") +
        " — An AI coding assistant that actually does software development."
    )
    .version(pkg.version);

program
    .command("init")
    .description("Onboarding wizard — connect a GitHub repo and configure OpenCode")
    .option("-r, --repo <owner/repo>", "GitHub repo to connect (skip prompt)")
    .action(initCommand);

program
    .command("start")
    .description("Start the Gitybara daemon")
    .option("-f, --foreground", "Run in foreground (no daemonize)", false)
    .option("-p, --port <number>", "HTTP status server port", "4242")
    .action(startCommand);

program
    .command("stop")
    .description("Stop the running Gitybara daemon")
    .action(stopCommand);

program
    .command("status")
    .description("Show daemon status and recent jobs")
    .option("-j, --json", "Output as JSON")
    .action(statusCommand);

program
    .command("cancel")
    .description("List and cancel running tasks")
    .argument("[action]", "Action: list, stop")
    .argument("[target]", "Target: job-id or 'all'")
    .option("-f, --force", "Force cancel (kill immediately)")
    .action(cancelCommand);

program
    .command("jobs")
    .description("List all jobs with their status")
    .option("-s, --status <status>", "Filter by status (pending, in-progress, done, failed, cancelled)")
    .option("-l, --limit <number>", "Limit number of results", "20")
    .option("-j, --json", "Output as JSON")
    .action(async (options) => {
        await listJobsCommand({
            status: options.status,
            limit: parseInt(options.limit, 10),
            json: options.json
        });
    });

const configCmd = program
    .command("config")
    .description("View or edit global configuration");

configCmd
    .option("--set <key=value>", "Set a config value")
    .option("--get <key>", "Get a config value")
    .option("--list", "List all config values")
    .action(configCommand);

configCmd
    .command("model")
    .description("Configure the default AI model")
    .action(configModelCommand);

program
    .command("learn")
    .description("Manage per-repo learning rules (dos & don'ts)")
    .argument("[subcommand]", "add | list | remove", "list")
    .option("-r, --repo <owner/repo>", "Target repo (defaults to current git remote)")
    .option("--do <rule>", "Add a DO rule")
    .option("--dont <rule>", "Add a DON'T rule")
    .option("--id <id>", "Rule ID to remove")
    .action(learnCommand);

program
    .command("repo")
    .description("Manage connected repositories")
    .argument("[action]", "add | rm | list", "list")
    .argument("[repo]", "Repository name (owner/repo)")
    .action(async (action, repo) => {
        if (action === "add") {
            await addRepoCommand(repo);
        } else if (action === "rm" || action === "remove") {
            await removeRepoCommand(repo);
        } else {
            const { readConfig } = await import("./config-store.js");
            const config = readConfig();
            if (!config || config.repos.length === 0) {
                console.log(chalk.yellow("No repositories connected."));
            } else {
                console.log(chalk.bold("\nConnected Repositories:"));
                config.repos.forEach(r => console.log(`- ${r.owner}/${r.repo} (${chalk.gray(r.clonePath)})`));
            }
        }
    });

program
    .command("add")
    .description("Add a repository (alias for 'repo add')")
    .argument("[repo]", "Repository name (owner/repo)")
    .action(async (repo) => {
        await addRepoCommand(repo);
    });

program
    .command("rm")
    .description("Remove a repository (alias for 'repo rm')")
    .argument("[repo]", "Repository name (owner/repo)")
    .action(async (repo) => {
        await removeRepoCommand(repo);
    });

program.parse(process.argv);
