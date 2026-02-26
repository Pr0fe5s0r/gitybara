#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./init.js";
import { startCommand } from "./start.js";
import { stopCommand } from "./stop.js";
import { statusCommand } from "./status.js";
import { configCommand } from "./config.js";
import { learnCommand } from "./learn.js";
import chalk from "chalk";

const program = new Command();

program
    .name("gitybara")
    .description(
        chalk.bold.cyan("🦫 Gitybara") +
        " — Autonomous GitHub issue solver powered by OpenCode"
    )
    .version("0.1.0");

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
    .command("config")
    .description("View or edit global configuration")
    .option("--set <key=value>", "Set a config value")
    .option("--get <key>", "Get a config value")
    .option("--list", "List all config values")
    .action(configCommand);

program
    .command("learn")
    .description("Manage per-repo learning rules (dos & don'ts)")
    .argument("[subcommand]", "add | list | remove", "list")
    .option("-r, --repo <owner/repo>", "Target repo (defaults to current git remote)")
    .option("--do <rule>", "Add a DO rule")
    .option("--dont <rule>", "Add a DON'T rule")
    .option("--id <id>", "Rule ID to remove")
    .action(learnCommand);

program.parse(process.argv);
