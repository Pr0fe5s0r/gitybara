import { readConfig, PID_FILE } from "./config-store.js";
import chalk from "chalk";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startCommand(options: {
    foreground: boolean;
    port: string;
}) {
    const config = readConfig();
    if (!config || !config.githubToken) {
        console.error(
            chalk.red("Not configured. Run ") +
            chalk.cyan("gitybara init") +
            chalk.red(" first.")
        );
        process.exit(1);
    }

    if (config.repos.length === 0) {
        console.error(
            chalk.red("No repos configured. Run ") +
            chalk.cyan("gitybara init") +
            chalk.red(" to add a repo.")
        );
        process.exit(1);
    }

    const port = parseInt(options.port, 10);

    if (options.foreground) {
        console.log(
            chalk.bold.cyan("🦫 Starting Gitybara daemon (foreground)…") +
            chalk.gray(` Port: ${port}`)
        );

        // Write PID file for status command
        fs.writeFileSync(PID_FILE, String(process.pid));

        const cleanup = () => {
            if (fs.existsSync(PID_FILE)) {
                try {
                    const pid = fs.readFileSync(PID_FILE, "utf-8").trim();
                    if (pid === String(process.pid)) {
                        fs.unlinkSync(PID_FILE);
                    }
                } catch { }
            }
        };
        process.on("exit", cleanup);
        process.on("SIGINT", () => { cleanup(); process.exit(); });
        process.on("SIGTERM", () => { cleanup(); process.exit(); });

        // Import and run daemon directly in-process
        const { runDaemon } = await import("../daemon/loop.js");
        const { resetStaleJobs, initDb } = await import("../db/index.js");

        try {
            await initDb();
            const staleCount = await resetStaleJobs();
            if (staleCount > 0) {
                console.log(chalk.yellow(`♻️ Reset ${staleCount} stale jobs from a previous run to 'failed' so they can be retried.`));
            }
        } catch (e) {
            console.error(chalk.red("Failed to reset stale jobs on startup"), e);
        }

        await runDaemon(config, port);
    } else {
        // Check if already running
        if (fs.existsSync(PID_FILE)) {
            const pid = fs.readFileSync(PID_FILE, "utf-8").trim();
            console.log(
                chalk.yellow(`⚠ Daemon may already be running (PID ${pid}).`) +
                chalk.gray(
                    " Use `gitybara stop` to stop it, or delete ~/.gitybara/daemon.pid"
                )
            );
            process.exit(1);
        }

        // Spawn detached process
        const { spawn } = await import("child_process");
        const isTS = import.meta.url.endsWith(".ts");
        const serverPath = path.resolve(__dirname, "../daemon/server" + (isTS ? ".ts" : ".js"));

        // In dev mode (isTS) we use npx tsx to launch the server
        const child = spawn(
            isTS ? "npx" : process.execPath,
            isTS ? ["tsx", serverPath, "--port", String(port)] : [serverPath, "--port", String(port)],
            {
                detached: true,
                stdio: "ignore",
                env: { ...process.env, GITYBARA_PORT: String(port) },
                shell: isTS // Needed for npx on Windows
            }
        );
        child.unref();

        fs.writeFileSync(PID_FILE, String(child.pid));
        console.log(
            chalk.bold.green(`✅ Gitybara daemon started`) +
            chalk.gray(` (PID: ${child.pid}, Port: ${port})`) +
            `\n${chalk.gray("   Run")} ${chalk.cyan("gitybara status")} ${chalk.gray("to monitor.")}`
        );
    }
}
