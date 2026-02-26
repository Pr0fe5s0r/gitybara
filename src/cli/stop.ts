import { PID_FILE } from "./config-store.js";
import chalk from "chalk";
import fs from "fs";

export async function stopCommand() {
    if (!fs.existsSync(PID_FILE)) {
        console.log(chalk.yellow("No daemon PID file found. Daemon may not be running."));
        return;
    }

    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    try {
        process.kill(pid, "SIGTERM");
        fs.unlinkSync(PID_FILE);
        console.log(chalk.green(`✅ Daemon (PID ${pid}) stopped.`));
    } catch {
        fs.unlinkSync(PID_FILE);
        console.log(
            chalk.yellow(`Daemon (PID ${pid}) was not running. Cleaned up PID file.`)
        );
    }
}
