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
    return `You are creating a concise REPO_MEMORY.md for an AI coding agent working on ${owner}/${repo}.

Tech Stack: ${techStack.join(", ") || "Unknown"}

Directory Structure:
${fileStructure}

Key Files:
${Object.entries(fileContents).map(([file, content]) => `${file}:\n${content.substring(0, 500)}`).join("\n\n")}

Create a minimal, actionable REPO_MEMORY.md with these sections:

1. **Project Context** (1-2 sentences max): What this codebase does and its primary purpose. No fluff.

2. **Quick Start**: 
   - Main entry points (which files to start with)
   - How to run/test the project
   - Key configuration files

3. **Architecture Patterns**:
   - Core patterns used (e.g., MVC, Event-driven, CLI tool structure)
   - Important abstractions and where they live
   - Data flow between major components

4. **Code Conventions**:
   - Existing patterns for error handling, logging, async operations
   - Naming conventions (files, functions, variables)
   - Import/export patterns
   - Testing approach

5. **Critical Files for Implementation**:
   - Where similar features are implemented
   - Utility/helper locations
   - Type definitions
   - Test file patterns

6. **Recent Changes** (if any context available):
   - Recent architectural decisions
   - Active areas of development
   - Known issues or workarounds

Rules:
- Be concise. Use bullet points, not paragraphs.
- Focus on "where" and "how" rather than "what" and "why".
- Include file paths that are relevant for implementing features.
- Skip introductory pleasantries and exploration statements.
- Assume the reader is an expert developer who needs to navigate the codebase quickly.

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

> AI Agent Context for ${owner}/${repo}
> Last Updated: ${timestamp}

## Project Context

${owner}/${repo} - ${techStack.join(", ") || "Tech stack to be determined"} codebase.

## Quick Start

- **Key config files**: ${keyFiles.filter(f => f.includes("config") || f.includes("json") || f.includes("toml") || f.includes("yaml") || f.includes("yml")).join(", ") || "package.json, tsconfig.json, etc."}
- **Entry points**: Check main files in root and src/ directory
- **Tests**: Look for test/, tests/, *.test.*, *.spec.* patterns

## Project Structure

${fileStructure}

## Code Conventions

- Follow existing patterns in the codebase
- Match indentation and formatting of surrounding code
- Use existing error handling and logging utilities
- Maintain consistency with file naming conventions

## Key Files

${keyFiles.slice(0, 10).map(f => `- \`${f}\``).join("\n") || "- To be documented"}

---

*Auto-generated by Gitybara - Focus on implementation, not exploration*`;
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
