import { readConfig } from "./config-store.js";
import { getDb } from "../db/index.js";
import chalk from "chalk";
import Table from "cli-table3";

export async function learnCommand(
    subcommand: string,
    options: {
        repo?: string;
        do?: string;
        dont?: string;
        id?: string;
    }
) {
    const config = readConfig();
    if (!config || config.repos.length === 0) {
        console.error(
            chalk.red("No repos configured. Run ") +
            chalk.cyan("gitybara init") +
            chalk.red(" first.")
        );
        process.exit(1);
    }

    // Resolve repo
    let repoOwner: string;
    let repoName: string;
    if (options.repo) {
        [repoOwner, repoName] = options.repo.split("/");
    } else if (config.repos.length === 1) {
        repoOwner = config.repos[0].owner;
        repoName = config.repos[0].repo;
    } else {
        console.error(
            chalk.yellow("Multiple repos configured. Specify with --repo owner/repo")
        );
        process.exit(1);
    }

    const db = getDb();

    // Ensure repo row exists
    const rs1 = await db.execute({
        sql: "SELECT id FROM repos WHERE owner = ? AND name = ?",
        args: [repoOwner, repoName]
    });

    if (rs1.rows.length === 0) {
        await db.execute({
            sql: "INSERT INTO repos (owner, name) VALUES (?, ?)",
            args: [repoOwner, repoName]
        });
    }

    const rs2 = await db.execute({
        sql: "SELECT id FROM repos WHERE owner = ? AND name = ?",
        args: [repoOwner, repoName]
    });
    const repoId = rs2.rows[0].id as number;

    const cmd = subcommand || "list";

    if (cmd === "add") {
        if (options.do) {
            await db.execute({
                sql: "INSERT INTO rules (repo_id, type, text, created_at) VALUES (?, 'do', ?, datetime('now'))",
                args: [repoId, options.do]
            });
            console.log(chalk.green(`✅ Added DO rule: "${options.do}"`));
        } else if (options.dont) {
            await db.execute({
                sql: "INSERT INTO rules (repo_id, type, text, created_at) VALUES (?, 'dont', ?, datetime('now'))",
                args: [repoId, options.dont]
            });
            console.log(chalk.green(`✅ Added DON'T rule: "${options.dont}"`));
        } else {
            console.error(chalk.red("Specify --do <rule> or --dont <rule>"));
            process.exit(1);
        }
        return;
    }

    if (cmd === "remove") {
        if (!options.id) {
            console.error(chalk.red("Specify --id <rule-id> to remove"));
            process.exit(1);
        }
        const res = await db.execute({
            sql: "DELETE FROM rules WHERE id = ? AND repo_id = ?",
            args: [parseInt(options.id, 10), repoId]
        });
        if (res.rowsAffected > 0) {
            console.log(chalk.green(`✅ Rule #${options.id} removed.`));
        } else {
            console.log(chalk.yellow(`Rule #${options.id} not found.`));
        }
        return;
    }

    // Default: list
    const rs3 = await db.execute({
        sql: "SELECT * FROM rules WHERE repo_id = ? ORDER BY type, id",
        args: [repoId]
    });
    const rules = rs3.rows.map((row: any) => ({
        id: row.id as number,
        type: row.type as "do" | "dont",
        text: row.text as string,
        created_at: row.created_at as string
    }));

    console.log(
        chalk.bold.cyan(`\n🦫 Learning Rules for ${repoOwner}/${repoName}\n`)
    );

    if (rules.length === 0) {
        console.log(
            chalk.gray("No rules yet.") +
            `\n  Add with: ${chalk.cyan('gitybara learn add --do "Always add tests"')}\n`
        );
        return;
    }

    const table = new Table({
        head: [chalk.bold("ID"), chalk.bold("Type"), chalk.bold("Rule")],
        style: { head: [], border: [] },
        colWidths: [6, 8, 70],
    });
    for (const r of rules) {
        const typeLabel =
            r.type === "do"
                ? chalk.green("✅ DO")
                : chalk.red("🚫 DON'T");
        table.push([r.id, typeLabel, r.text]);
    }
    console.log(table.toString());
    console.log();
}
