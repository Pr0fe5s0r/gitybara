import { readConfig, writeConfig, getDefaultConfig } from "./config-store.js";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { getAvailableModels } from "../opencode/models.js";

export async function configModelCommand() {
    const config = readConfig() || getDefaultConfig();

    const spinner = ora("Fetching available models from OpenCode...").start();
    let models: { providerId: string, modelId: string }[];
    
    try {
        models = await getAvailableModels();
        spinner.succeed(chalk.green(`Found ${models.length} available models`));
    } catch (err) {
        spinner.fail(chalk.red("Could not fetch models from OpenCode. Is OpenCode running?"));
        process.exit(1);
    }

    if (models.length === 0) {
        console.log(chalk.yellow("No models available."));
        return;
    }

    const modelChoices = models.map(m => ({
        name: `${chalk.cyan(m.providerId)}/${m.modelId}`,
        value: { providerId: m.providerId, modelId: m.modelId },
    }));

    const currentModel = config.defaultModel 
        ? `${config.defaultProvider || "opencode"}/${config.defaultModel}`
        : null;

    const { selectedModel } = await inquirer.prompt([
        {
            type: "list",
            name: "selectedModel",
            message: `Select default AI model${currentModel ? ` (current: ${currentModel})` : ""}:`,
            choices: [
                ...(currentModel ? [{ name: "Keep current selection", value: null }] : []),
                ...modelChoices,
            ],
            default: currentModel ? 1 : 0,
        },
    ]);

    if (selectedModel === null) {
        console.log(chalk.yellow("Keeping current selection."));
        return;
    }

    config.defaultProvider = selectedModel.providerId;
    config.defaultModel = selectedModel.modelId;
    writeConfig(config);

    console.log(chalk.bold.green(`\n✅ Default model set to ${selectedModel.providerId}/${selectedModel.modelId}`));
}

export async function configCommand(options: {
    set?: string;
    get?: string;
    list?: boolean;
}) {
    const config = readConfig() || getDefaultConfig();

    if (options.list || (!options.set && !options.get)) {
        console.log(chalk.bold.cyan("\n🦫 Gitybara Configuration\n"));
        const entries: [string, unknown][] = [
            ["githubToken", config.githubToken ? "****" + config.githubToken.slice(-4) : chalk.red("<not set>")],
            ["opencodePath", config.opencodePath],
            ["pollingIntervalMinutes", config.pollingIntervalMinutes],
            ["daemonPort", config.daemonPort],
            ["defaultProvider", config.defaultProvider || chalk.gray("(opencode default)")],
            ["defaultModel", config.defaultModel || chalk.gray("(opencode default)")],
            ["repos", config.repos.map((r) => `${r.owner}/${r.repo}`).join(", ") || chalk.gray("(none)")],
        ];
        for (const [k, v] of entries) {
            console.log(`  ${chalk.bold(k.padEnd(28))} ${v}`);
        }
        console.log();
        return;
    }

    if (options.get) {
        const key = options.get as keyof typeof config;
        const val = config[key];
        console.log(val !== undefined ? String(val) : chalk.red(`Key "${key}" not found.`));
        return;
    }

    if (options.set) {
        const eqIdx = options.set.indexOf("=");
        if (eqIdx === -1) {
            console.error(chalk.red('Format: --set key=value'));
            process.exit(1);
        }
        const key = options.set.slice(0, eqIdx) as keyof typeof config;
        const rawVal = options.set.slice(eqIdx + 1);

        // Type-coerce simple cases
        const currentVal = (config as any)[key as string];
        let coerced: unknown = rawVal;
        if (typeof currentVal === "number") coerced = parseFloat(rawVal);
        else if (typeof currentVal === "boolean") coerced = rawVal === "true";

        (config as any)[key as string] = coerced;
        writeConfig(config);
        console.log(chalk.green(`✅ Set ${String(key)} = ${String(rawVal)}`));
    }
}
