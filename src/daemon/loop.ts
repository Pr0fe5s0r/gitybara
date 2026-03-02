import { GlobalConfig } from "../cli/config-store.js";
import { createLogger } from "../utils/logger.js";
import { pollAllRepos } from "./processor.js";
import { cleanupOldRuns } from "./cleanup.js";

const log = createLogger("daemon-loop");

export async function runDaemon(config: GlobalConfig, port: number) {
    // Start HTTP server in background
    const { startServer } = await import("./server.js");
    startServer(port);

    // Start WhatsApp Listener in background (won't block if not configured)
    const { startWhatsappDaemon } = await import("../whatsapp/client.js");
    startWhatsappDaemon(config).catch(err => log.error({ err }, "WhatsApp daemon failed to start"));

    // Start Telegram Listener in background (won't block if not configured)
    const { startTelegramDaemon } = await import("../telegram/client.js");
    startTelegramDaemon(config).catch(err => log.error({ err }, "Telegram daemon failed to start"));

    log.info(
        { repos: config.repos.map((r) => `${r.owner}/${r.repo}`) },
        `🦫 Gitybara daemon started — polling every ${config.pollingIntervalMinutes}m`
    );

    // Graceful shutdown
    const shutdown = () => {
        log.info("Shutdown signal received, shutting down.");
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    // Initial poll immediately, then on interval
    pollAllRepos(config).catch((e) => log.error({ e }, "Initial poll error"));

    const intervalMs = config.pollingIntervalMinutes * 60 * 1000;
    setInterval(() => {
        pollAllRepos(config).catch((e) => log.error({ e }, "Poll error"));
    }, intervalMs);

    // Periodic cleanup of abandoned runs every 10 minutes
    setInterval(() => {
        cleanupOldRuns(config).catch((e) => log.error({ e }, "Cleanup error"));
    }, 10 * 60 * 1000);

    // Keep process alive
    await new Promise(() => { });
}
