import { getDb } from "../db/index.js";
import { getMemoryForPrompt } from "../memory/manager.js";

export interface Rule {
    id: number;
    type: "do" | "dont";
    text: string;
}

export async function getRules(repoId: number): Promise<Rule[]> {
    const rs = await getDb().execute({
        sql: "SELECT id, type, text FROM rules WHERE repo_id = ? ORDER BY type, id",
        args: [repoId]
    });
    return rs.rows.map((row: any) => ({
        id: row.id as number,
        type: row.type as "do" | "dont",
        text: row.text as string
    }));
}

export async function getRepoMemoryForPrompt(repoId: number): Promise<string | null> {
    return getMemoryForPrompt(repoId);
}

export async function buildSystemPrompt(
    owner: string,
    repo: string,
    issueNumber: number,
    issueTitle: string,
    issueBody: string,
    rules: Rule[],
    comments?: string[],
    repoId?: number
): Promise<string> {
    const doRules = rules.filter((r) => r.type === "do");
    const dontRules = rules.filter((r) => r.type === "dont");

    const rulesSection =
        doRules.length === 0 && dontRules.length === 0
            ? ""
            : `
## Repository Guidelines

${doRules.length > 0 ? `### ALWAYS:\n${doRules.map((r) => `- ${r.text}`).join("\n")}` : ""}
${dontRules.length > 0 ? `\n### NEVER:\n${dontRules.map((r) => `- ${r.text}`).join("\n")}` : ""}
`.trim();

    let commentsSection = "";
    if (comments && comments.length > 0) {
        commentsSection = `
## Ongoing Conversation
The following comments have been added to the issue by the user and the bot:
${comments.map((c, i) => `Comment ${i + 1}:\n${c}`).join("\n\n")}
`.trim();
    }

    // Fetch repository memory if repoId is provided
    let memorySection = "";
    if (repoId) {
        const memory = await getMemoryForPrompt(repoId);
        if (memory) {
            memorySection = `
## Repository Memory (REPO_MEMORY.md)
The following is the accumulated knowledge about this repository. Read it carefully to understand the codebase structure, patterns, and important decisions.

${memory}
`.trim();
        }
    }

    return `You are Gitybara, an autonomous coding agent working on the GitHub repository **${owner}/${repo}**.

Your task is to resolve the following GitHub issue by writing code changes directly to the repository files in the current working directory.

${rulesSection}

${memorySection}

## Issue #${issueNumber}: ${issueTitle}

${issueBody || "(No description provided)"}

${commentsSection}

## Instructions

1. Analyze the issue and understand what needs to be done.
2. If the issue description or the ongoing conversation is ambiguous, missing critical information, or requires the user to make a design decision before you can proceed, STOP immediately.
   - Do NOT edit any files.
   - Output exactly this string and nothing else: \`NEED_CLARIFICATION: <your specific question here>\`
3. Make the necessary code changes to resolve the issue.
4. Ensure all changes are consistent with the existing codebase style.
5. Do not create new files unless absolutely necessary.
6. After making changes, provide a concise summary of:
   - What you changed and why
   - Any important design decisions
   - How to verify the fix

Begin working on the issue now.`.trim();
}
