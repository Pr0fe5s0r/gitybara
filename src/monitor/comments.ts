import { Octokit } from "@octokit/rest";
import { PRComment, getPRComments, commentOnPR } from "../github/prs.js";
import { getIssueComments, commentOnIssue } from "../github/issues.js";
import {
    isCommentProcessed,
    markCommentProcessed,
    getLastProcessedCommentTime
} from "../db/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("comment-monitor");

export interface ActionableComment {
    comment: PRComment;
    actionType: 'fix' | 'feedback' | 'clarification' | 'ignore';
    confidence: number;
    extractedRequest: string;
}

export interface CommentMonitorConfig {
    enabled: boolean;
    autoApplyFixes: boolean;
    requireLabel?: string;
    skipBotComments: boolean;
    actionableKeywords: string[];
}

const DEFAULT_KEYWORDS = [
    'fix', 'change', 'update', 'modify', 'correct', 'improve',
    'please fix', 'can you fix', 'need to fix', 'should fix',
    'change request', 'requested changes', 'please address',
    'update the', 'modify the', 'fix the', 'correct the'
];

/**
 * Detect if a comment contains actionable feedback
 */
export function analyzeComment(
    comment: PRComment,
    config: CommentMonitorConfig
): ActionableComment {
    const body = comment.body.toLowerCase();
    const keywords = config.actionableKeywords || DEFAULT_KEYWORDS;

    // Skip bot comments if configured
    if (config.skipBotComments && comment.user.type === 'Bot') {
        return {
            comment,
            actionType: 'ignore',
            confidence: 1.0,
            extractedRequest: ''
        };
    }

    // Skip Gitybara's own comments
    if (comment.user.login === 'gitybara' || comment.body.includes('🦫 **Gitybara**')) {
        return {
            comment,
            actionType: 'ignore',
            confidence: 1.0,
            extractedRequest: ''
        };
    }

    // Check for explicit fix requests
    let actionType: 'fix' | 'feedback' | 'clarification' | 'ignore' = 'ignore';
    let confidence = 0;
    let extractedRequest = '';

    // Look for fix keywords
    for (const keyword of keywords) {
        if (body.includes(keyword.toLowerCase())) {
            confidence += 0.3;
            actionType = 'fix';
        }
    }

    // Check for code blocks (suggested changes)
    if (body.includes('```') || body.includes('`')) {
        confidence += 0.2;
        if (actionType === 'fix') {
            extractedRequest = extractCodeChanges(comment.body);
        }
    }

    // Check for specific patterns
    if (body.includes('nit:') || body.includes('nitpick:')) {
        confidence += 0.2;
        actionType = 'fix';
    }

    // Only mark as clarification if no fix action was detected and comment contains a question
    if (body.includes('?') && actionType === 'ignore') {
        actionType = 'clarification';
        confidence += 0.4;
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);

    // If no specific patterns found but comment is substantial, mark as feedback
    if (actionType === 'ignore' && comment.body.length > 50) {
        actionType = 'feedback';
        confidence = 0.3;
    }

    return {
        comment,
        actionType,
        confidence,
        extractedRequest
    };
}

/**
 * Extract code changes from a comment (suggested edits)
 */
function extractCodeChanges(body: string): string {
    const changes: string[] = [];

    // Extract code blocks
    const codeBlockRegex = /```[\s\S]*?```/g;
    const matches = body.match(codeBlockRegex);

    if (matches) {
        changes.push(...matches);
    }

    // Extract inline code
    const inlineCodeRegex = /`[^`]+`/g;
    const inlineMatches = body.match(inlineCodeRegex);

    if (inlineMatches) {
        changes.push(...inlineMatches);
    }

    return changes.join('\n\n');
}

/**
 * Get unprocessed comments for a PR or issue
 */
export async function getUnprocessedComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number,
    isPR: boolean = false
): Promise<PRComment[]> {
    const comments = isPR
        ? await getPRComments(octokit, owner, repo, issueNumber)
        : await getIssueComments(octokit, owner, repo, issueNumber);

    // Filter out already processed comments
    const unprocessed: PRComment[] = [];

    for (const comment of comments) {
        const processed = await isCommentProcessed(owner, repo, comment.id);
        if (!processed) {
            unprocessed.push(comment);
        }
    }

    return unprocessed;
}

/**
 * Find actionable comments that need to be addressed
 */
export async function findActionableComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number,
    isPR: boolean = false,
    config: CommentMonitorConfig = { enabled: true, autoApplyFixes: true, skipBotComments: true, actionableKeywords: DEFAULT_KEYWORDS }
): Promise<ActionableComment[]> {
    if (!config.enabled) {
        return [];
    }

    const comments = await getUnprocessedComments(octokit, owner, repo, issueNumber, isPR);
    const actionable: ActionableComment[] = [];

    for (const comment of comments) {
        const analysis = analyzeComment(comment, config);

        // Only consider comments with sufficient confidence
        if (analysis.actionType !== 'ignore' && analysis.confidence >= 0.3) {
            actionable.push(analysis);
        }

        // Mark as processed regardless of actionability (to avoid re-processing)
        await markCommentProcessed(owner, repo, issueNumber, comment.id, comment.body, analysis.actionType);
    }

    log.info({
        owner,
        repo,
        issue: issueNumber,
        total: comments.length,
        actionable: actionable.length
    }, `Analyzed ${comments.length} comments, found ${actionable.length} actionable`);

    return actionable;
}

/**
 * Build a prompt for OpenCode based on actionable comments
 */
export function buildFixPrompt(
    originalIssueTitle: string,
    originalIssueBody: string,
    actionableComments: ActionableComment[],
    existingCode?: string
): string {
    let prompt = `You are addressing feedback on a pull request or issue.

**Original Issue:**
Title: ${originalIssueTitle}
Body: ${originalIssueBody || 'No description provided'}

**Feedback to Address:**

`;

    for (let i = 0; i < actionableComments.length; i++) {
        const ac = actionableComments[i];
        prompt += `${i + 1}. **${ac.actionType.toUpperCase()}** (confidence: ${Math.round(ac.confidence * 100)}%)
   From: @${ac.comment.user.login}
   Content: ${ac.comment.body}
`;

        if (ac.extractedRequest) {
            prompt += `   Suggested Changes:\n${ac.extractedRequest}\n`;
        }

        prompt += '\n';
    }

    prompt += `
**Instructions:**
1. Address all the feedback items above
2. Make minimal, focused changes to fix the issues
3. Ensure all existing tests pass
4. If you cannot address a specific item, explain why in your summary
5. Commit your changes with a descriptive message

Please implement the necessary changes now.
`;

    return prompt;
}

/**
 * Post a response comment after applying fixes
 */
export async function postFixResponse(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number,
    isPR: boolean,
    changesMade: string[],
    summary: string
): Promise<void> {
    const body = `🦫 **Gitybara** has automatically addressed the feedback!

**Changes Made:**
${changesMade.map(c => `- ${c}`).join('\n')}

**Summary:**
${summary}

*This was an automated response to comments on this ${isPR ? 'PR' : 'issue'}.*`;

    if (isPR) {
        await commentOnPR(octokit, owner, repo, issueNumber, body);
    } else {
        await commentOnIssue(octokit, owner, repo, issueNumber, body);
    }
}
