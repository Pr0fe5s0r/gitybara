import { readConfig, PID_FILE } from "./config-store.js";
import chalk from "chalk";
import Table from "cli-table3";
import fs from "fs";
import { getDb } from "../db/index.js";

export async function statusCommand(options: { json?: boolean }) {
    const config = readConfig();

    // Check daemon running
    let daemonPid: number | null = null;
    let daemonRunning = false;
    if (fs.existsSync(PID_FILE)) {
        daemonPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        try {
            process.kill(daemonPid, 0); // 0 = check existence
            daemonRunning = true;
        } catch {
            daemonRunning = false;
        }
    }

    if (options.json) {
        let jobs: unknown[] = [];
        try {
            const db = getDb();
            const rs = await db.execute("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 20");
            jobs = rs.rows;
        } catch { }
        console.log(
            JSON.stringify({ daemon: { running: daemonRunning, pid: daemonPid }, config, jobs }, null, 2)
        );
        return;
    }

    // Pretty output
    console.log(chalk.bold.cyan("\n🦫 Gitybara Status\n"));

    // Daemon status
    const daemonStatus = daemonRunning
        ? chalk.bold.green("● RUNNING") + chalk.gray(` (PID: ${daemonPid})`)
        : chalk.bold.red("● STOPPED");
    console.log(`Daemon:  ${daemonStatus}`);

    if (config) {
        console.log(`Port:    ${chalk.cyan(config.daemonPort)}`);
        console.log(`Poll:    every ${chalk.cyan(config.pollingIntervalMinutes)} minute(s)`);
        console.log(`Repos:   ${chalk.cyan(config.repos.length)} connected\n`);

        if (config.repos.length > 0) {
            const repoTable = new Table({
                head: [
                    chalk.bold("Repo"),
                    chalk.bold("Label Filter"),
                    chalk.bold("Base Branch"),
                ],
                style: { head: [], border: [] },
            });
            for (const r of config.repos) {
                repoTable.push([
                    `${r.owner}/${r.repo}`,
                    r.issueLabel || chalk.gray("(all issues)"),
                    r.baseBranch,
                ]);
            }
            console.log(repoTable.toString());
        }
    } else {
        console.log(
            chalk.yellow("No config found. Run ") +
            chalk.cyan("gitybara init") +
            chalk.yellow(" to get started.")
        );
        return;
    }

    // Recent jobs
    try {
        const db = getDb();
        const rs = await db.execute("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 10");
        const jobs = rs.rows.map((row: any) => ({
            id: row.id as number,
            repo_owner: row.repo_owner as string,
            repo_name: row.repo_name as string,
            issue_number: row.issue_number as number,
            status: row.status as string,
            branch: row.branch as string,
            pr_url: row.pr_url as string,
            updated_at: row.updated_at as string,
        }));

        if (jobs.length > 0) {
            console.log(chalk.bold("\nRecent Jobs:"));
            const jobTable = new Table({
                head: [
                    chalk.bold("Repo"),
                    chalk.bold("Issue"),
                    chalk.bold("Status"),
                    chalk.bold("Branch"),
                    chalk.bold("PR"),
                    chalk.bold("Updated"),
                ],
                style: { head: [], border: [] },
            });
            for (const j of jobs) {
                const statusColor =
                    j.status === "done"
                        ? chalk.green(j.status)
                        : j.status === "in-progress"
                            ? chalk.yellow(j.status)
                            : j.status === "failed"
                                ? chalk.red(j.status)
                                : chalk.gray(j.status);
                jobTable.push([
                    `${j.repo_owner}/${j.repo_name}`,
                    `#${j.issue_number}`,
                    statusColor,
                    chalk.cyan(j.branch || "-"),
                    j.pr_url ? chalk.blue("Open") : chalk.gray("-"),
                    new Date(j.updated_at).toLocaleString(),
                ]);
            }
            console.log(jobTable.toString());
        } else {
            console.log(chalk.gray("\nNo jobs yet. Start the daemon to begin working on issues."));
        }
    } catch { }

    console.log();
}
