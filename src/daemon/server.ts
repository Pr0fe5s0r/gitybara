import express from "express";
import { getDb, resetStaleJobs } from "../db/index.js";
import { readConfig } from "../cli/config-store.js";
import { createLogger } from "../utils/logger.js";
import crypto from "crypto";

const log = createLogger("daemon-server");

export function startServer(port: number) {
    const app = express();
    app.use(express.json());

    // ── GET /status ─────────────────────────────────────────────────────
    app.get("/status", async (_req, res) => {
        const config = readConfig();
        let jobs: any[] = [];
        try {
            const rs = await getDb().execute("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 20");
            jobs = rs.rows;
        } catch { }
        res.json({
            status: "running",
            pid: process.pid,
            repos: config?.repos.map((r) => `${r.owner}/${r.repo}`) || [],
            jobs,
        });
    });

    // ── GET /health ──────────────────────────────────────────────────────
    app.get("/health", (_req, res) => {
        res.json({ ok: true, pid: process.pid });
    });

    // ── GET /jobs ────────────────────────────────────────────────────────
    app.get("/jobs", async (req, res) => {
        const limit = parseInt(String(req.query.limit || "50"), 10);
        const status = req.query.status as string | undefined;
        let query = "SELECT * FROM jobs";
        const params: any[] = [];
        if (status) {
            query += " WHERE status = ?";
            params.push(status);
        }
        query += " ORDER BY updated_at DESC LIMIT ?";
        params.push(limit);
        try {
            const rs = await getDb().execute({ sql: query, args: params });
            res.json(rs.rows);
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    // ── POST /webhook ────────────────────────────────────────────────────
    // GitHub sends webhook events here (instant trigger instead of polling)
    app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
        const config = readConfig();
        const signature = req.headers["x-hub-signature-256"] as string;
        const event = req.headers["x-github-event"] as string;
        const payload = req.body as Buffer;

        // Verify webhook secret if configured
        const repoName = (JSON.parse(payload.toString()) as { repository?: { full_name?: string } })
            ?.repository?.full_name;
        const repoConfig = config?.repos.find(
            (r) => `${r.owner}/${r.repo}` === repoName
        );
        if (repoConfig?.webhookSecret && signature) {
            const hmac = crypto.createHmac("sha256", repoConfig.webhookSecret);
            const digest = "sha256=" + hmac.update(payload).digest("hex");
            if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
                log.warn("Invalid webhook signature");
                res.status(401).json({ error: "Invalid signature" });
                return;
            }
        }

        // Handle issue opened events
        if (event === "issues") {
            const body = JSON.parse(payload.toString()) as {
                action: string;
                issue?: { number: number; title: string };
                repository?: { owner?: { login?: string }; name?: string };
            };
            if (body.action === "opened") {
                log.info(
                    { issue: body.issue?.number, repo: repoName },
                    "Webhook: new issue opened — triggering immediate poll"
                );
                // Dynamic import to avoid circular deps — kick off a single-repo poll
                import("../daemon/loop.js")
                    .then(({ runDaemon: _ignored }) => {
                        log.info("Webhook-triggered poll delegated to polling loop");
                    })
                    .catch(() => { });
            }
        }

        res.json({ ok: true });
    });

    app.listen(port, "127.0.0.1", () => {
        log.info(`🌐 HTTP status server running on http://127.0.0.1:${port}`);
    });
}

// Entry point when run as a standalone spawned process
if (process.argv[1] && (process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server.ts"))) {
    const portArg = process.argv.indexOf("--port");
    const port = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : 4242;
    const { runDaemon } = await import("./loop.js");
    const { resetStaleJobs, initDb } = await import("../db/index.js");
    const config = readConfig();
    if (!config) {
        console.error("No config found. Run `gitybara init` first.");
        process.exit(1);
    }

    // Recover any jobs that were left hanging when the daemon was previously killed
    try {
        await initDb();
        const staleCount = await resetStaleJobs();
        if (staleCount > 0) {
            console.log(`♻️ Reset ${staleCount} stale jobs from a previous run to 'failed' so they can be retried.`);
        }
    } catch (e) {
        console.error("Failed to reset stale jobs on startup", e);
    }

    await runDaemon(config, port);
}
