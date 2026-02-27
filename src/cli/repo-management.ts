import { readConfig, writeConfig, RepoConfig, ensureGitybaraDir } from "./config-store.js";
import chalk from "chalk";
import inquirer from "inquirer";
import autocomplete from "inquirer-autocomplete-prompt";
import fuzzy from "fuzzy";
import { createGitHubClient } from "../github/client.js";
import { fetchUserRepos } from "../github/repos.js";
import { execa } from "execa";
import ora from "ora";
import path from "path";
import fs from "fs";

inquirer.registerPrompt("autocomplete", autocomplete);

export async function addRepoCommand(repoArg?: string) {
    const config = readConfig();
    if (!config || !config.githubToken) {
        console.error(chalk.red("Not configured. Run ") + chalk.cyan("gitybara init") + chalk.red(" first."));
        process.exit(1);
    }

    let repoPath = repoArg;
    const octokit = createGitHubClient(config.githubToken);

    if (!repoPath) {
        const repoSpinner = ora("Fetching your repositories from GitHub...").start();
        try {
            const allRepos = await fetchUserRepos(octokit);
            repoSpinner.succeed(chalk.green(`Found ${allRepos.length} repositories`));

            const { repoSelection } = await inquirer.prompt([
                {
                    type: "autocomplete",
                    name: "repoSelection",
                    message: "Select a repository to add:",
                    source: (_answers: any, input: string) => {
                        input = input || "";
                        return fuzzy.filter(input, allRepos).map(el => el.original);
                    },
                },
            ]);
            repoPath = repoSelection;
        } catch (err) {
            repoSpinner.fail(chalk.red("Could not fetch repositories from GitHub."));
            const { manualRepo } = await inquirer.prompt([
                {
                    type: "input",
                    name: "manualRepo",
                    message: "Enter repository (owner/repo):",
                    validate: (v: string) => /^[\w.-]+\/[\w.-]+$/.test(v) ? true : "Format: owner/repo",
                }
            ]);
            repoPath = manualRepo as string;
        }
    }

    if (!repoPath) return;

    const [owner, repoName] = repoPath.split("/");

    const { issueLabel, baseBranch } = await inquirer.prompt([
        {
            type: "input",
            name: "issueLabel",
            message: `Label to filter issues in ${owner}/${repoName}:`,
            default: "gitybara",
        },
        {
            type: "input",
            name: "baseBranch",
            message: "Base branch for new branches:",
            default: "main",
        },
    ]);

    const defaultClonePath = path.join(
        process.env.HOME || process.env.USERPROFILE || "~",
        ".gitybara",
        "repos",
        `${owner}-${repoName}`
    );
    const { clonePath } = await inquirer.prompt([
        {
            type: "input",
            name: "clonePath",
            message: `Where should Gitybara clone ${owner}/${repoName} locally?`,
            default: defaultClonePath,
        },
    ]);

    const newRepo: RepoConfig = { owner, repo: repoName, issueLabel, baseBranch, clonePath };

    // Update config
    config.repos = config.repos.filter(r => !(r.owner === owner && r.repo === repoName));
    config.repos.push(newRepo);
    writeConfig(config);

    // Clone if needed
    if (!fs.existsSync(path.join(clonePath, ".git"))) {
        const spinner = ora(`Cloning ${owner}/${repoName}…`).start();
        try {
            fs.mkdirSync(clonePath, { recursive: true });
            await execa("git", [
                "clone",
                `https://x-access-token:${config.githubToken}@github.com/${owner}/${repoName}.git`,
                clonePath,
            ]);
            spinner.succeed(chalk.green(`Cloned to ${clonePath}`));
        } catch (e) {
            spinner.fail(chalk.red("Git clone failed: " + String(e)));
        }
    }

    console.log(chalk.bold.green(`\n✅ Repository ${owner}/${repoName} added successfully!`));
}

export async function removeRepoCommand(repoArg?: string) {
    const config = readConfig();
    if (!config || config.repos.length === 0) {
        console.log(chalk.yellow("No repositories configured."));
        return;
    }

    let repoToRemove = repoArg;

    if (!repoToRemove) {
        const { selection } = await inquirer.prompt([
            {
                type: "list",
                name: "selection",
                message: "Select a repository to remove:",
                choices: config.repos.map(r => `${r.owner}/${r.repo}`),
            }
        ]);
        repoToRemove = selection;
    }

    const [owner, repoName] = repoToRemove!.split("/");
    const initialCount = config.repos.length;
    config.repos = config.repos.filter(r => !(r.owner === owner && r.repo === repoName));

    if (config.repos.length === initialCount) {
        console.log(chalk.red(`Repository ${repoToRemove} not found in config.`));
        return;
    }

    writeConfig(config);
    console.log(chalk.bold.green(`\n✅ Repository ${repoToRemove} removed from Gitybara.`));
}
