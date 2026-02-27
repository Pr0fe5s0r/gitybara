import chalk from "chalk";
import { createGitHubClient } from "../github/client.js";
import { enableAutoMerge, disableAutoMerge, isAutoMergeEnabled } from "../github/prs.js";
import { 
    getDb, 
    upsertRepo, 
    getRepoAutoMergeConfig, 
    updateRepoAutoMergeConfig,
    setPRAutoMergeConfig,
    deletePRAutoMergeConfig
} from "../db/index.js";
import { readConfig } from "./config-store.js";

export async function autoMergeCommand(
    action: string,
    target: string,
    options: { repo?: string; method?: string; disable?: boolean }
): Promise<void> {
    const config = readConfig();
    if (!config) {
        console.log(chalk.red("❌ Not initialized. Run `gitybara init` first."));
        process.exit(1);
    }

    const octokit = createGitHubClient(config.githubToken);

    switch (action) {
        case "enable":
            await enableAutoMergeCommand(octokit, target, options);
            break;
        case "disable":
            await disableAutoMergeCommand(octokit, target, options);
            break;
        case "status":
            await statusAutoMergeCommand(octokit, target, options);
            break;
        case "config":
            await configAutoMergeCommand(target, options);
            break;
        default:
            console.log(chalk.yellow("Usage: gitybara auto-merge <enable|disable|status|config> [target] [options]"));
            console.log(chalk.gray("\nExamples:"));
            console.log(chalk.gray("  gitybara auto-merge enable 123 --repo owner/repo    Enable auto-merge for PR #123"));
            console.log(chalk.gray("  gitybara auto-merge disable 123 --repo owner/repo   Disable auto-merge for PR #123"));
            console.log(chalk.gray("  gitybara auto-merge status 123 --repo owner/repo    Check auto-merge status"));
            console.log(chalk.gray("  gitybara auto-merge config owner/repo               Configure repo auto-merge settings"));
    }
}

async function enableAutoMergeCommand(
    octokit: any,
    target: string,
    options: { repo?: string; method?: string; disable?: boolean }
): Promise<void> {
    const prNumber = parseInt(target, 10);
    if (isNaN(prNumber)) {
        console.log(chalk.red("❌ Please provide a valid PR number"));
        return;
    }

    const repoConfig = findRepoConfig(options.repo);
    if (!repoConfig) {
        console.log(chalk.red(`❌ Repository ${options.repo || 'not specified'} not found in config`));
        return;
    }

    const mergeMethod = (options.method || 'merge').toUpperCase() as 'MERGE' | 'SQUASH' | 'REBASE';

    console.log(chalk.blue(`🔄 Enabling auto-merge for PR #${prNumber} in ${repoConfig.owner}/${repoConfig.repo}...`));

    const result = await enableAutoMerge(octokit, repoConfig.owner, repoConfig.repo, prNumber, mergeMethod);

    if (result.success) {
        console.log(chalk.green(`✅ ${result.message}`));
        
        // Store PR-specific config
        await setPRAutoMergeConfig(
            repoConfig.owner, 
            repoConfig.repo, 
            prNumber, 
            true, 
            mergeMethod.toLowerCase() as 'merge' | 'squash' | 'rebase'
        );
    } else {
        console.log(chalk.red(`❌ ${result.message}`));
    }
}

async function disableAutoMergeCommand(
    octokit: any,
    target: string,
    options: { repo?: string; method?: string; disable?: boolean }
): Promise<void> {
    const prNumber = parseInt(target, 10);
    if (isNaN(prNumber)) {
        console.log(chalk.red("❌ Please provide a valid PR number"));
        return;
    }

    const repoConfig = findRepoConfig(options.repo);
    if (!repoConfig) {
        console.log(chalk.red(`❌ Repository ${options.repo || 'not specified'} not found in config`));
        return;
    }

    console.log(chalk.blue(`🔄 Disabling auto-merge for PR #${prNumber} in ${repoConfig.owner}/${repoConfig.repo}...`));

    const result = await disableAutoMerge(octokit, repoConfig.owner, repoConfig.repo, prNumber);

    if (result.success) {
        console.log(chalk.green(`✅ ${result.message}`));
        
        // Update PR-specific config
        await setPRAutoMergeConfig(repoConfig.owner, repoConfig.repo, prNumber, false, 'merge');
    } else {
        console.log(chalk.yellow(`⚠️ ${result.message}`));
    }
}

async function statusAutoMergeCommand(
    octokit: any,
    target: string,
    options: { repo?: string; method?: string; disable?: boolean }
): Promise<void> {
    const prNumber = parseInt(target, 10);
    if (isNaN(prNumber)) {
        console.log(chalk.red("❌ Please provide a valid PR number"));
        return;
    }

    const repoConfig = findRepoConfig(options.repo);
    if (!repoConfig) {
        console.log(chalk.red(`❌ Repository ${options.repo || 'not specified'} not found in config`));
        return;
    }

    console.log(chalk.blue(`🔍 Checking auto-merge status for PR #${prNumber}...`));

    const status = await isAutoMergeEnabled(octokit, repoConfig.owner, repoConfig.repo, prNumber);

    if (status.enabled) {
        console.log(chalk.green(`✅ Auto-merge is enabled`));
        console.log(chalk.gray(`   Method: ${status.mergeMethod}`));
        console.log(chalk.gray(`   Status: ${status.status}`));
    } else {
        console.log(chalk.yellow(`⏸️ Auto-merge is not enabled`));
    }
}

async function configAutoMergeCommand(
    target: string,
    options: { repo?: string; method?: string; disable?: boolean }
): Promise<void> {
    const repoSlug = target || options.repo;
    if (!repoSlug) {
        console.log(chalk.red("❌ Please specify a repository (owner/repo)"));
        return;
    }

    const [owner, repo] = repoSlug.split('/');
    if (!owner || !repo) {
        console.log(chalk.red("❌ Invalid repository format. Use: owner/repo"));
        return;
    }

    // Ensure repo exists in database
    const repoId = await upsertRepo(owner, repo);
    
    // Get current config
    const currentConfig = await getRepoAutoMergeConfig(repoId);

    if (options.method) {
        // Update merge method
        const validMethods = ['merge', 'squash', 'rebase'];
        if (!validMethods.includes(options.method)) {
            console.log(chalk.red(`❌ Invalid merge method. Use: ${validMethods.join(', ')}`));
            return;
        }

        await updateRepoAutoMergeConfig(repoId, { merge_method: options.method as 'merge' | 'squash' | 'rebase' });
        console.log(chalk.green(`✅ Updated default merge method to: ${options.method}`));
    }

    if (options.disable !== undefined) {
        // Update enabled status
        await updateRepoAutoMergeConfig(repoId, { enabled: options.disable ? 0 : 1 });
        console.log(chalk.green(`✅ Auto-merge ${options.disable ? 'disabled' : 'enabled'} for repository`));
    }

    // Display current configuration
    console.log(chalk.bold("\n📋 Auto-merge Configuration:"));
    console.log(chalk.gray(`Repository: ${owner}/${repo}`));
    if (currentConfig) {
        console.log(chalk.gray(`Enabled: ${currentConfig.enabled ? chalk.green('Yes') : chalk.red('No')}`));
        console.log(chalk.gray(`Auto-merge clean PRs: ${currentConfig.auto_merge_clean ? chalk.green('Yes') : chalk.red('No')}`));
        console.log(chalk.gray(`Auto-resolve conflicts: ${currentConfig.auto_resolve_conflicts ? chalk.green('Yes') : chalk.red('No')}`));
        console.log(chalk.gray(`Default merge method: ${currentConfig.merge_method}`));
    } else {
        console.log(chalk.gray('Using default configuration'));
    }
}

function findRepoConfig(repoSlug?: string): { owner: string; repo: string } | null {
    const config = readConfig();
    if (!config) return null;

    if (repoSlug) {
        const [owner, repo] = repoSlug.split('/');
        const found = config.repos.find(r => r.owner === owner && r.repo === repo);
        if (found) return { owner: found.owner, repo: found.repo };
    }

    // Return first repo if only one exists
    if (config.repos.length === 1) {
        return { owner: config.repos[0].owner, repo: config.repos[0].repo };
    }

    return null;
}
