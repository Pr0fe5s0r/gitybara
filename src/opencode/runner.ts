import { execa } from "execa";
import { createLogger } from "../utils/logger.js";
import { createOpencode } from "@opencode-ai/sdk";
import * as net from "net";

const log = createLogger("opencode-runner");

// Mutex to prevent race conditions when changing CWD for SDK initialization
let sdkInitMutex = Promise.resolve();

/**
 * Encode a workspace path to base64 format for URL-safe identification
 */
export function encodeWorkspacePath(workingDir: string): string {
    return Buffer.from(workingDir).toString("base64").replace(/=/g, "");
}

async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
        srv.on("error", reject);
    });
}

export interface RunResult {
    success: boolean;
    summary: string;
    filesChanged: string[];
    rawOutput: string;
    sessionUrl?: string; // Clickable link to the live session
}

export interface BridgeAnalysis {
    intent: "GENERIC_CHAT" | "ISSUE_IDEA" | "LIST_REPOS";
    response?: string; // For generic chat or list repos
    draft?: {
        title: string;
        body: string;
    }; // For issue idea
    suggestedRepoIndex?: number; // Autodetected index from availableRepos
    forceNewBranch?: boolean; // If the user explicitly asked for a separate/new branch
    shareSession?: boolean; // If the user explicitly asked to share/post the session link
}

export async function runOpenCode(
    opencodePath: string,
    workingDir: string,
    systemPrompt: string,
    provider?: string,
    model?: string,
    onSessionCreated?: (sessionUrl: string) => void | Promise<void>
): Promise<RunResult> {
    log.info({ workingDir, model, provider }, "Launching OpenCode session via SDK");

    let rawOutput = "";
    let success = false;
    let summary = "";
    let freePort: number | undefined;
    let sessionId: string | undefined;
    const originalCwd = process.cwd();
    let opencode: any;

    try {
        freePort = await getAvailablePort();

        // Use mutex to safely switch CWD for SDK initialization
        await sdkInitMutex;
        let resolveMutex: () => void;
        sdkInitMutex = new Promise(resolve => { resolveMutex = resolve; });

        try {
            process.chdir(workingDir);
            opencode = await createOpencode({
                port: freePort,
                config: {
                    model: model && provider ? `${provider}/${model}` : model,
                }
            });
        } finally {
            process.chdir(originalCwd);
            resolveMutex!();
        }

        const sessionUrl = `http://localhost:${freePort}`;

        const { client } = opencode;

        // Subscribe to events for real-time logging
        const events = await client.event.subscribe();

        // Use a flag to stop listening when prompt returns
        let completed = false;

        // Listen to events in background
        const eventProcessor = (async () => {
            try {
                for await (const event of events.stream) {
                    if (completed) break;
                    const e = event as any;
                    if (e.type === "message.part.delta") {
                        if (e.properties.field === "text" && e.properties.delta) {
                            process.stdout.write(e.properties.delta);
                        }
                    } else if (e.type === "message.part.updated") {
                        const part = e.properties.part;
                        if ((part.type === "text" || part.type === "reasoning") && part.text && !e.properties.delta) {
                            // Some providers may not stream deltas but send the whole part at once
                            // process.stdout.write(part.text);
                        } else if (part.type === "tool") {
                            const status = part.state?.status;
                            if (status === "running") {
                                process.stdout.write(`\n\n[OpenCode] 🛠️ Calling tool: ${part.tool}\n`);
                            } else if (status === "completed") {
                                process.stdout.write(`\n[OpenCode] ✅ Tool ${part.tool} completed\n\n`);
                            } else if (status === "error") {
                                process.stdout.write(`\n[OpenCode] ❌ Tool ${part.tool} error\n\n`);
                            }
                        }
                    }
                }
            } catch { }
        })();

        // Create a session
        const sessionRes = await client.session.create({
            body: { title: "Gitybara Task" }
        });

        if (!sessionRes.data?.id) throw new Error("No session ID returned");
        sessionId = sessionRes.data.id;
        const encodedPath = encodeWorkspacePath(workingDir);
        const fullSessionUrl = `${sessionUrl}/${encodedPath}/session/${sessionId}`;
        log.info({ sessionId, sessionUrl: fullSessionUrl }, "OpenCode session created");

        // Notify caller immediately that session is ready
        if (onSessionCreated) {
            await onSessionCreated(fullSessionUrl);
        }

        // Send the prompt
        const response = await client.session.prompt({
            path: { id: sessionId },
            body: {
                parts: [{ type: "text", text: systemPrompt }]
            }
        });

        completed = true;

        if (response.data?.parts) {
            summary = response.data.parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");

            success = true;
        }

    } finally {
        if (opencode?.server) {
            try {
                await opencode.server.close();
            } catch { }
        }
    }

    // Detect changed files via git
    const filesChanged = await getChangedFiles(workingDir);

    return {
        success,
        summary,
        filesChanged,
        rawOutput,
        sessionUrl: (freePort && sessionId) ? `http://localhost:${freePort}/${encodeWorkspacePath(workingDir)}/session/${sessionId}` : undefined
    };
}

async function getChangedFiles(repoPath: string): Promise<string[]> {
    try {
        const result = await execa("git", ["diff", "--name-only", "HEAD"], {
            cwd: repoPath,
        });
        return result.stdout.split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

export async function planGithubIssue(
    workingDir: string,
    message: string,
    provider?: string,
    model?: string
): Promise<{ title: string; body: string } | null> {
    log.info({ model, provider }, "Routing WhatsApp message to OpenCode to generate Issue Plan");

    let success = false;
    let title = "New Issue from WhatsApp";
    let body = message;

    const originalCwd = process.cwd();
    process.chdir(workingDir);

    try {
        const freePort = await getAvailablePort();
        const opencode = await createOpencode({
            port: freePort,
            config: {
                model: model && provider ? `${provider}/${model}` : model,
            }
        });

        const { client } = opencode;

        const sessionRes = await client.session.create({
            body: { title: "WhatsApp to GitHub Issue Planner" }
        });

        if (!sessionRes.data?.id) throw new Error("No session ID returned");
        const sessionId = sessionRes.data.id;

        const systemPrompt = `You are a technical product manager. I will give you a raw message from a developer sent via WhatsApp. 
Your ONLY job is to convert this message into a well-structured GitHub Issue. 
Do NOT write code. Do NOT modify files.
Analyze the request, decide on a clear issue title, and write a detailed markdown body.

You MUST reply with a pure JSON object in this exact format (do not wrap it in markdown block quotes):
{
  "title": "Clear concise title",
  "body": "Markdown formatted description"
}

Raw message:
"${message}"`;

        const response = await client.session.prompt({
            path: { id: sessionId },
            body: {
                parts: [{ type: "text", text: systemPrompt }]
            }
        });

        if (response.data?.parts) {
            const outputText = response.data.parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");

            try {
                // Try parsing the output text as JSON
                // Often LLMs wrap JSON in markdown block so let's strip it
                const stripped = outputText.replace(/```json/g, "").replace(/```/g, "").trim();
                const parsed = JSON.parse(stripped);
                if (parsed.title && parsed.body) {
                    title = parsed.title;
                    body = parsed.body + `\n\n---\n*Created automatically via Gitybara WhatsApp Integration*`;
                    success = true;
                }
            } catch (e) {
                log.warn({ e, outputText }, "Failed to parse OpenCode Issue JSON, falling back to raw message");
            }
        }

        await opencode.server.close();
    } catch (err: unknown) {
        log.error({ err }, "OpenCode SDK error during WhatsApp planning");
    } finally {
        process.chdir(originalCwd);
    }

    return success ? { title, body } : { title, body: body + `\n\n---\n*Created automatically via Gitybara WhatsApp Integration (Planning Failed)*` };
}

export async function analyzeBridgeMessage(
    message: string,
    provider?: string,
    model?: string,
    availableRepos: { owner: string; repo: string }[] = []
): Promise<BridgeAnalysis> {
    log.info({ model, provider }, "Analyzing bridge message for intent classification & repo detection");

    const repoListString = availableRepos.map((r, i) => `${i}. ${r.owner}/${r.repo}`).join("\n");

    const systemPrompt = `You are a helpful AI assistant for Gitybara, a tool that automates GitHub issue solving.
A user sent a message via a chat bridge (WhatsApp/Telegram). 

Your task is to classify the intent:
1. GENERIC_CHAT: The user is saying hello, asking a general question, or just chatting.
2. ISSUE_IDEA: The user is describing a bug, a feature request, or an idea that should become a GitHub issue.
3. LIST_REPOS: The user is asking what repositories are connected, managed, or configured.

Available Repositories:
${repoListString}

If ISSUE_IDEA:
- Draft a clear, professional GitHub issue title.
- Draft a detailed markdown body.
- SEARCH the user message for any mention of the available repositories above. If they mention one clearly (e.g. "in liteclaw" matches "Pr0fe5s0r/LiteClaw"), return the suggestedRepoIndex as the integer index from the list. If ambiguous or not mentioned, do NOT include suggestedRepoIndex.

If GENERIC_CHAT:
- Write a friendly, brief response.

If LIST_REPOS:
- Write a friendly response listing the names of the available repositories.

You MUST reply with a pure JSON object in this exact format:
{
  "intent": "GENERIC_CHAT" | "ISSUE_IDEA" | "LIST_REPOS",
  "response": "Brief friendly response",
  "draft": { "title": "...", "body": "..." },
  "suggestedRepoIndex": 0,
  "forceNewBranch": false,
  "shareSession": false
}

If the user mentions "share session", "post link", "public monitoring", or similar, set "shareSession" to true.

User message: "${message}"`;

    let result: BridgeAnalysis = { intent: "GENERIC_CHAT", response: "I'm sorry, I couldn't process that request." };

    try {
        const freePort = await getAvailablePort();
        const opencode = await createOpencode({
            port: freePort,
            config: {
                model: model && provider ? `${provider}/${model}` : model,
            }
        });

        const { client } = opencode;
        const sessionRes = await client.session.create({ body: { title: "Intent Classifier" } });
        if (!sessionRes.data?.id) throw new Error("No session ID returned");

        const response = await client.session.prompt({
            path: { id: sessionRes.data.id },
            body: { parts: [{ type: "text", text: systemPrompt }] }
        });

        if (response.data?.parts) {
            const outputText = response.data.parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");

            const stripped = outputText.replace(/```json/g, "").replace(/```/g, "").trim();
            const parsed = JSON.parse(stripped);
            if (parsed.intent) {
                result = parsed;
            }
        }
        await opencode.server.close();
    } catch (err) {
        log.error({ err }, "Error analyzing bridge message");
    }

    return result;
}

export interface AssociationResult {
    action: "CREATE_NEW" | "JOIN";
    branchName?: string;
    reason: string;
}

export async function associateIssueToBranch(
    issue: { number: number; title: string; body: string },
    activeBranches: { name: string; prTitle?: string; prBody?: string }[],
    provider?: string,
    model?: string
): Promise<AssociationResult> {
    if (activeBranches.length === 0) {
        return { action: "CREATE_NEW", reason: "No active branches found." };
    }

    log.info({ issue: issue.number, branches: activeBranches.length }, "Analyzing issue for branch association");

    const systemPrompt = `You are a technical lead managing a GitHub repository.
We have a new issue and several active branches/PRs that Gitybara is currently working on.
Your task is to decide if this new issue should be added to an existing active branch or if it requires a brand new branch.

New Issue:
Title: ${issue.title}
Body: ${issue.body}

Active Branches:
${activeBranches.map((b, i) => `${i}. Name: ${b.name}\n   PR Title: ${b.prTitle || "N/A"}\n   PR Body: ${b.prBody || "N/A"}`).join("\n\n")}

Guidelines:
- If the issue is a small fix (typo, small refactor, add test) related to an existing PR, suger JOIN.
- If the issue is a distinct feature or a bug in a different part of the system, suggest CREATE_NEW.
- If in doubt, suggest CREATE_NEW to avoid messy PRs.

Reply with EXACTLY a JSON object:
{
  "action": "CREATE_NEW" | "JOIN",
  "branchName": "name_of_branch_to_join",
  "reason": "Short explanation of your choice"
}
`;

    try {
        const freePort = await getAvailablePort();
        const opencode = await createOpencode({
            port: freePort,
            config: {
                model: model && provider ? `${provider}/${model}` : model,
            }
        });

        const { client } = opencode;
        const sessionRes = await client.session.create({ body: { title: "Branch Association Agent" } });
        if (!sessionRes.data?.id) throw new Error("No session ID returned");

        const response = await client.session.prompt({
            path: { id: sessionRes.data.id },
            body: { parts: [{ type: "text", text: systemPrompt }] }
        });

        if (response.data?.parts) {
            const outputText = response.data.parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");

            const stripped = outputText.replace(/```json/g, "").replace(/```/g, "").trim();
            const parsed = JSON.parse(stripped);
            await opencode.server.close();
            return parsed;
        }
        await opencode.server.close();
    } catch (err) {
        log.error({ err }, "Error associating issue to branch");
    }

    return { action: "CREATE_NEW", reason: "AI association failed, falling back to new branch." };
}
