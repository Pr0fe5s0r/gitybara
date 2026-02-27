import { getDb } from "../db/index.js";
import { createLogger } from "../utils/logger.js";
import { runOpenCode } from "../opencode/runner.js";
import fs from "fs";
import path from "path";

const log = createLogger("memory-manager");

const REPO_MEMORY_FILENAME = "REPO_MEMORY.md";

export interface RepoMemory {
    id: number;
    repoId: number;
    content: string;
    createdAt: string;
    updatedAt: string;
}

export async function getRepoMemory(repoId: number): Promise<RepoMemory | null> {
    const rs = await getDb().execute({
        sql: `SELECT id, repo_id, content, created_at, updated_at FROM repo_memory WHERE repo_id = ?`,
        args: [repoId]
    });
    
    if (rs.rows.length === 0) return null;
    
    const row = rs.rows[0];
    return {
        id: row.id as number,
        repoId: row.repo_id as number,
        content: row.content as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string
    };
}

export async function saveRepoMemory(repoId: number, content: string): Promise<void> {
    await getDb().execute({
        sql: `INSERT INTO repo_memory (repo_id, content, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(repo_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
        args: [repoId, content]
    });
    log.info({ repoId }, "Repository memory saved");
}

export async function readExistingMemory(clonePath: string): Promise<string | null> {
    const memoryPath = path.join(clonePath, REPO_MEMORY_FILENAME);
    try {
        if (fs.existsSync(memoryPath)) {
            const content = fs.readFileSync(memoryPath, "utf-8");
            log.info({ clonePath }, "Found existing REPO_MEMORY.md");
            return content;
        }
    } catch (e) {
        log.warn({ err: e, clonePath }, "Failed to read REPO_MEMORY.md");
    }
    return null;
}

export async function writeMemoryToRepo(clonePath: string, content: string): Promise<void> {
    const memoryPath = path.join(clonePath, REPO_MEMORY_FILENAME);
    try {
        fs.writeFileSync(memoryPath, content, "utf-8");
        log.info({ clonePath }, "REPO_MEMORY.md written");
    } catch (e) {
        log.error({ err: e, clonePath }, "Failed to write REPO_MEMORY.md");
        throw e;
    }
}

async function analyzeRepositoryStructure(clonePath: string): Promise<{
    fileStructure: string;
    keyFiles: string[];
    techStack: string[];
}> {
    log.info({ clonePath }, "Analyzing repository structure...");
    
    const fileStructure = await getDirectoryTree(clonePath);
    
    const keyFiles: string[] = [];
    const configPatterns = [
        "package.json", "Cargo.toml", "pyproject.toml", "requirements.txt",
        "go.mod", "pom.xml", "build.gradle", "tsconfig.json", "Dockerfile",
        "docker-compose.yml", ".gitignore", "README.md", "LICENSE",
        "Makefile", "CMakeLists.txt", "setup.py"
    ];
    
    for (const pattern of configPatterns) {
        const fullPath = path.join(clonePath, pattern);
        if (fs.existsSync(fullPath)) {
            keyFiles.push(pattern);
        }
    }
    
    const techStack: string[] = [];
    if (fs.existsSync(path.join(clonePath, "package.json"))) {
        techStack.push("JavaScript/Node.js");
    }
    if (fs.existsSync(path.join(clonePath, "Cargo.toml"))) techStack.push("Rust");
    if (fs.existsSync(path.join(clonePath, "go.mod"))) techStack.push("Go");
    if (fs.existsSync(path.join(clonePath, "requirements.txt"))) techStack.push("Python");
    
    return { fileStructure, keyFiles, techStack };
}

async function getDirectoryTree(clonePath: string, maxDepth: number = 3): Promise<string> {
    const entries: string[] = [];
    
    function walk(dir: string, depth: number, prefix: string = ""): void {
        if (depth > maxDepth) return;
        
        try {
            const items = fs.readdirSync(dir)
                .filter(item => !item.startsWith(".") && !["node_modules", "target", "dist", "build"].includes(item))
                .sort();
            
            items.forEach((item, index) => {
                const fullPath = path.join(dir, item);
                const isLast = index === items.length - 1;
                const connector = isLast ? "└── " : "├── ";
                
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        entries.push(`${prefix}${connector}${item}/`);
                        const newPrefix = prefix + (isLast ? "    " : "│   ");
                        walk(fullPath, depth + 1, newPrefix);
                    } else {
                        entries.push(`${prefix}${connector}${item}`);
                    }
                } catch {}
            });
        } catch {}
    }
    
    walk(clonePath, 0);
    return entries.join("\n");
}

export async function generateRepoMemory(
    clonePath: string,
    owner: string,
    repo: string,
    opencodePath: string,
    provider?: string,
    model?: string
): Promise<string> {
    log.info({ owner, repo }, "Generating REPO_MEMORY.md...");
    
    const { fileStructure, keyFiles, techStack } = await analyzeRepositoryStructure(clonePath);
    
    const fileContents: Record<string, string> = {};
    for (const keyFile of keyFiles.slice(0, 5)) {
        try {
            const content = fs.readFileSync(path.join(clonePath, keyFile), "utf-8");
            fileContents[keyFile] = content.substring(0, 2000);
        } catch {}
    }
    
    const systemPrompt = buildMemoryPrompt(owner, repo, techStack, fileStructure, fileContents);

    const result = await runOpenCode(
        opencodePath,
        clonePath,
        systemPrompt,
        provider,
        model
    );
    
    if (!result.success) {
        log.warn({ owner, repo }, "AI generation failed, using template");
        return generateBasicMemoryTemplate(owner, repo, fileStructure, keyFiles, techStack);
    }
    
    let content = result.summary;
    content = content.replace(/^```markdown\s*/i, "");
    content = content.replace(/^```\s*/i, "");
    content = content.replace(/```\s*$/i, "");
    
    const timestamp = new Date().toISOString();
    content = `# REPO_MEMORY.md\n\n> AI Agent Long-term Memory for ${owner}/${repo}\n> Last Updated: ${timestamp}\n\n---\n\n${content}`;
    
    return content;
}

function buildMemoryPrompt(
    owner: string,
    repo: string,
    techStack: string[],
    fileStructure: string,
    fileContents: Record<string, string>
): string {
    return `You are an expert software architect analyzing a GitHub repository.

Create a comprehensive REPO_MEMORY.md for AI agents working on this repository.

Repository: ${owner}/${repo}
Tech Stack: ${techStack.join(", ") || "Unknown"}

Directory Structure:
${fileStructure}

Key Files:
${Object.entries(fileContents).map(([file, content]) => `${file}:\n${content.substring(0, 500)}`).join("\n\n")}

Include these sections:
1. Project Overview - Purpose and main functionality
2. Architecture Overview - System design and patterns
3. Project Structure - Directory organization
4. Key Components - Major modules and interactions
5. Data Flow - How data moves through the system
6. Configuration - Important config options
7. Development Patterns - Conventions and best practices
8. Critical Implementation Notes - Must-know information
9. Dependencies - Key libraries and their uses
10. Common Tasks - How to do typical work
11. Files to Read First - Onboarding guide

Output raw markdown without code block wrappers.`;
}

function generateBasicMemoryTemplate(
    owner: string,
    repo: string,
    fileStructure: string,
    keyFiles: string[],
    techStack: string[]
): string {
    const timestamp = new Date().toISOString();
    
    return `# REPO_MEMORY.md

> AI Agent Long-term Memory for ${owner}/${repo}
> Last Updated: ${timestamp}

## Project Overview

${owner}/${repo} repository.

## Tech Stack

${techStack.map(t => `- ${t}`).join("\n") || "- To be documented"}

## Project Structure

${fileStructure}

## Key Files

${keyFiles.map(f => `- ${f}`).join("\n") || "- To be documented"}

## Notes

- This file is auto-generated by Gitybara
- Update as the codebase evolves

---

Generated by Gitybara`;
}

export async function ensureRepoMemory(
    repoId: number,
    clonePath: string,
    owner: string,
    repo: string,
    opencodePath: string,
    provider?: string,
    model?: string
): Promise<string> {
    const existingMemory = await getRepoMemory(repoId);
    const fileMemory = await readExistingMemory(clonePath);
    
    if (fileMemory && !existingMemory) {
        log.info({ owner, repo }, "Syncing REPO_MEMORY.md from file");
        await saveRepoMemory(repoId, fileMemory);
        return fileMemory;
    }
    
    if (existingMemory && !fileMemory) {
        log.info({ owner, repo }, "Writing REPO_MEMORY.md from database");
        await writeMemoryToRepo(clonePath, existingMemory.content);
        return existingMemory.content;
    }
    
    if (!existingMemory && !fileMemory) {
        log.info({ owner, repo }, "Generating new REPO_MEMORY.md");
        const newMemory = await generateRepoMemory(clonePath, owner, repo, opencodePath, provider, model);
        await saveRepoMemory(repoId, newMemory);
        await writeMemoryToRepo(clonePath, newMemory);
        return newMemory;
    }
    
    if (existingMemory && fileMemory && existingMemory.content !== fileMemory) {
        log.info({ owner, repo }, "Syncing updated REPO_MEMORY.md to database");
        await saveRepoMemory(repoId, fileMemory);
    }
    
    return fileMemory || existingMemory?.content || "";
}

export async function getMemoryForPrompt(repoId: number): Promise<string | null> {
    const memory = await getRepoMemory(repoId);
    return memory?.content || null;
}

export async function updateRepoMemoryWithInsights(
    repoId: number,
    clonePath: string,
    owner: string,
    repo: string,
    issueNumber: number,
    changes: string,
    summary: string
): Promise<void> {
    log.info({ owner, repo, issue: issueNumber }, "Updating memory with insights");
    
    const currentMemory = await getRepoMemory(repoId);
    if (!currentMemory) {
        log.warn({ owner, repo }, "No existing memory to update");
        return;
    }
    
    const timestamp = new Date().toISOString();
    const updateSection = `\n\n---\n\n## Recent Updates\n\n### Issue #${issueNumber} (${timestamp})\n\n**Summary:** ${summary}\n\n**Changes:**\n${changes}\n`;
    
    const updatedContent = currentMemory.content + updateSection;
    
    await saveRepoMemory(repoId, updatedContent);
    await writeMemoryToRepo(clonePath, updatedContent);
    
    log.info({ owner, repo }, "Memory updated");
}
