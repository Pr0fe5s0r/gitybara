import { Octokit } from "@octokit/rest";
import { PRComment, getPRComments, commentOnPR } from "../github/prs.js";
import { getIssueComments, commentOnIssue } from "../github/issues.js";
import {
    isCommentProcessed,
    markCommentProcessed,
    getLastProcessedCommentTime,
    getProcessedCommentsForIssue
} from "../db/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("comment-monitor");

export interface ActionableComment {
    comment: PRComment;
    actionType: 'fix' | 'feedback' | 'clarification' | 'ignore' | 'future_fix';
    confidence: number;
    extractedRequest: string;
    context?: CommentContext;
}

export interface CommentContext {
    previousComments: PRComment[];
    conversationThread: PRComment[];
    isReply: boolean;
    parentCommentId?: number;
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
    'update the', 'modify the', 'fix the', 'correct the',
    // Future fix indicators
    'todo', 'fixme', 'future fix', 'future improvement',
    'later fix', 'fix later', 'address later', 'fix in next iteration',
    'needs work', 'needs fixing', 'should be fixed', 'must fix',
    'temporary fix', 'temporary solution', 'hack', 'workaround',
    // Additional semantic patterns
    'needs to be', 'should be', 'must be', 'has to be',
    'would be better', 'could you', 'it would be nice',
    'consider', 'suggestion', 'recommend', 'advise'
];

// Semantic patterns for intent detection (regex-based)
const SEMANTIC_PATTERNS = {
    // Direct fix requests
    directFix: /\b(please\s+)?(fix|correct|update|change|modify|improve|address)\s+(this|that|the\s+\w+|it)\b/i,
    // Future action indicators
    futureFix: /\b(todo|fixme|hack|workaround|temporary\s+(fix|solution))\b|\b(fix|address|improve)\s+(later|in\s+future|next\s+iteration|eventually)\b/i,
    // Suggestion patterns
    suggestion: /\b(consider|suggest|recommend|would\s+be\s+(?:better|nice|good)|could\s+you|maybe)\b/i,
    // Problem statements that imply fixes needed
    problemStatement: /\b(bug|issue|problem|error|broken|not\s+working|fails?|crash(?:es)?)\b.*\b(needs?|should|must|have\s+to)\s+be\s+fix/i,
    // Question-based fixes
    questionFix: /\b(why\s+(?:is|does)|should\s+(?:we|this|it)|can\s+we)\s+.*\?/i,
    // Negative feedback
    negativeFeedback: /\b(not\s+(?:correct|right|accurate|optimal|ideal|good|acceptable))\b|\b(wrong|incorrect|missing|lacking)\b/i
};

// Confidence weights for different pattern types
const PATTERN_WEIGHTS = {
    directFix: 0.6,
    futureFix: 0.5,
    suggestion: 0.3,
    problemStatement: 0.7,
    questionFix: 0.25,
    negativeFeedback: 0.4
};

/**
 * Detect semantic intent in a comment using pattern matching
 */
function detectSemanticIntent(body: string): { type: string; confidence: number }[] {
    const intents: { type: string; confidence: number }[] = [];
    
    for (const [patternName, pattern] of Object.entries(SEMANTIC_PATTERNS)) {
        if (pattern.test(body)) {
            const weight = PATTERN_WEIGHTS[patternName as keyof typeof PATTERN_WEIGHTS];
            intents.push({ type: patternName, confidence: weight });
        }
    }
    
    return intents;
}

/**
 * Check if comment indicates a future fix that should create an issue
 */
function isFutureFixComment(body: string): boolean {
    const futurePatterns = [
        /\btodo\b/i,
        /\bfixme\b/i,
        /\bfix\s+(later|in\s+future|eventually|next\s+(?:version|release|iteration))\b/i,
        /\baddress\s+(later|in\s+future|eventually)\b/i,
        /\b(temporary|temp)\s+(?:fix|solution|workaround)\b/i,
        /\bhack\b/i,
        /\bneeds?\s+(?:to\s+)?be\s+(?:fixed|addressed|improved)\s+(later|in\s+future)\b/i
    ];
    
    return futurePatterns.some(pattern => pattern.test(body));
}

/**
 * Check if a comment is likely a reply to Gitybara
 */
function isReplyToGitybara(body: string, previousComments: PRComment[]): boolean {
    if (previousComments.length === 0) return false;
    
    const lastComment = previousComments[previousComments.length - 1];
    return lastComment.body.includes('🦫 **Gitybara**') || 
           body.toLowerCase().includes('@gitybara') ||
           body.toLowerCase().includes('thanks gitybara') ||
           body.toLowerCase().includes('thank you gitybara');
}

/**
 * Calculate conversation context score based on previous interactions
 */
function calculateContextScore(
    comment: PRComment, 
    previousComments: PRComment[]
): number {
    if (previousComments.length === 0) return 0;
    
    let score = 0;
    const recentComments = previousComments.slice(-5); // Look at last 5 comments
    
    // Check if this continues a previous discussion about fixes
    const recentFixDiscussions = recentComments.filter(c => 
        /\b(fix|change|update|modify|improve|address)\b/i.test(c.body)
    );
    
    if (recentFixDiscussions.length > 0) {
        score += 0.2 * Math.min(recentFixDiscussions.length, 3);
    }
    
    // Check if replying to a specific fix request
    if (isReplyToGitybara(comment.body, previousComments)) {
        score += 0.3;
    }
    
    return Math.min(score, 0.5);
}

/**
 * Detect if a comment contains actionable feedback
 */
export function analyzeComment(
    comment: PRComment,
    config: CommentMonitorConfig,
    context?: CommentContext
): ActionableComment {
    const body = comment.body;
    const bodyLower = body.toLowerCase();
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
    if (comment.user.login === 'gitybara' || body.includes('🦫 **Gitybara**')) {
        return {
            comment,
            actionType: 'ignore',
            confidence: 1.0,
            extractedRequest: ''
        };
    }

    // Check if this is a future fix indicator (should create an issue)
    if (isFutureFixComment(body)) {
        return {
            comment,
            actionType: 'future_fix',
            confidence: 0.8,
            extractedRequest: extractContextualRequest(body, context),
            context
        };
    }

    // Detect semantic intent patterns
    const semanticIntents = detectSemanticIntent(body);
    let actionType: 'fix' | 'feedback' | 'clarification' | 'ignore' | 'future_fix' = 'ignore';
    let confidence = 0;
    let extractedRequest = '';

    // Calculate base confidence from semantic patterns
    for (const intent of semanticIntents) {
        confidence += intent.confidence;
        if (intent.type === 'directFix' || intent.type === 'problemStatement') {
            actionType = 'fix';
        } else if (intent.type === 'suggestion' && actionType === 'ignore') {
            actionType = 'feedback';
        }
    }

    // Look for fix keywords (as fallback/addition to semantic patterns)
    for (const keyword of keywords) {
        if (bodyLower.includes(keyword.toLowerCase())) {
            confidence += 0.15;
            if (actionType === 'ignore') {
                actionType = 'fix';
            }
        }
    }

    // Check for code blocks (suggested changes) - high confidence indicator
    if (body.includes('```') || body.includes('`')) {
        confidence += 0.25;
        extractedRequest = extractCodeChanges(body);
        if (actionType === 'ignore') {
            actionType = 'fix';
        }
    }

    // Check for specific patterns
    if (bodyLower.includes('nit:') || bodyLower.includes('nitpick:')) {
        confidence += 0.3;
        actionType = 'fix';
    }

    // Check for LGTM or approval (should be ignored)
    if (/\b(lgtm|looks?\s+good\s+to\s+me|approved?|ship\s+it)\b/i.test(bodyLower)) {
        return {
            comment,
            actionType: 'ignore',
            confidence: 1.0,
            extractedRequest: ''
        };
    }

    // Add context score if available
    if (context) {
        confidence += calculateContextScore(comment, context.previousComments);
    }

    // Only mark as clarification if no fix action was detected and comment contains a question
    if (body.includes('?') && actionType === 'ignore') {
        actionType = 'clarification';
        confidence += 0.3;
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);

    // Extract the actual request if it's a fix
    if (actionType === 'fix' && !extractedRequest) {
        extractedRequest = extractContextualRequest(body, context);
    }

    // If no specific patterns found but comment is substantial and has context, mark as feedback
    if (actionType === 'ignore' && body.length > 50 && context && context.previousComments.length > 0) {
        actionType = 'feedback';
        confidence = 0.25;
    }

    return {
        comment,
        actionType,
        confidence,
        extractedRequest,
        context
    };
}

/**
 * Extract the contextual request from a comment body
 */
function extractContextualRequest(body: string, context?: CommentContext): string {
    // First try to extract sentences containing action items
    const sentences = body.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const actionSentences: string[] = [];
    
    for (const sentence of sentences) {
        const sentenceLower = sentence.toLowerCase();
        if (/\b(fix|change|update|modify|improve|correct|address|todo|fixme)\b/i.test(sentenceLower)) {
            actionSentences.push(sentence.trim());
        }
    }
    
    if (actionSentences.length > 0) {
        return actionSentences.join('. ');
    }
    
    // If no specific action sentences found, return the whole body (truncated)
    return body.length > 500 ? body.substring(0, 500) + '...' : body;
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
 * Get full PR comment history for context
 */
export async function getPRCommentHistory(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number,
    isPR: boolean = false
): Promise<{
    allComments: PRComment[];
    processedComments: PRComment[];
    unprocessedComments: PRComment[];
    conversationThreads: Map<number, PRComment[]>;
}> {
    const allComments = isPR
        ? await getPRComments(octokit, owner, repo, issueNumber)
        : await getIssueComments(octokit, owner, repo, issueNumber);

    // Get processed comment IDs from database
    const processedCommentIds = new Set<number>();
    const processedCommentsFromDb = await getProcessedCommentsForIssue(owner, repo, issueNumber);
    
    for (const pc of processedCommentsFromDb) {
        processedCommentIds.add(pc.comment_id);
    }

    // Separate processed and unprocessed
    const processedComments: PRComment[] = [];
    const unprocessedComments: PRComment[] = [];

    for (const comment of allComments) {
        if (processedCommentIds.has(comment.id)) {
            processedComments.push(comment);
        } else {
            unprocessedComments.push(comment);
        }
    }

    // Build conversation threads (group by approximate time proximity)
    const conversationThreads = new Map<number, PRComment[]>();
    const sortedComments = [...allComments].sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    for (let i = 0; i < sortedComments.length; i++) {
        const comment = sortedComments[i];
        const thread: PRComment[] = [];
        
        // Add comments from 2 hours before to current
        const commentTime = new Date(comment.created_at).getTime();
        const twoHoursMs = 2 * 60 * 60 * 1000;
        
        for (let j = Math.max(0, i - 5); j <= i; j++) {
            const prevComment = sortedComments[j];
            const prevTime = new Date(prevComment.created_at).getTime();
            if (commentTime - prevTime <= twoHoursMs) {
                thread.push(prevComment);
            }
        }
        
        conversationThreads.set(comment.id, thread);
    }

    return {
        allComments,
        processedComments,
        unprocessedComments,
        conversationThreads
    };
}

/**
 * Get unprocessed comments for a PR or issue (with full context)
 */
export async function getUnprocessedComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number,
    isPR: boolean = false
): Promise<PRComment[]> {
    const { unprocessedComments } = await getPRCommentHistory(octokit, owner, repo, issueNumber, isPR);
    return unprocessedComments;
}

/**
 * Find actionable comments that need to be addressed
 * Now includes full PR history context and better deduplication
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

    // Get full comment history with context
    const { allComments, unprocessedComments, conversationThreads } = 
        await getPRCommentHistory(octokit, owner, repo, issueNumber, isPR);

    const actionable: ActionableComment[] = [];
    const processedCommentIds: number[] = [];

    for (const comment of unprocessedComments) {
        // Build context for this comment
        const context: CommentContext = {
            previousComments: allComments.filter(c => 
                new Date(c.created_at) < new Date(comment.created_at)
            ),
            conversationThread: conversationThreads.get(comment.id) || [],
            isReply: allComments.some(c => 
                new Date(c.created_at) < new Date(comment.created_at) && 
                c.user.login !== comment.user.login
            )
        };

        const analysis = analyzeComment(comment, config, context);

        // Handle different action types
        if (analysis.actionType === 'future_fix') {
            // Future fixes have high priority
            actionable.push(analysis);
            processedCommentIds.push(comment.id);
            log.debug({ commentId: comment.id }, 'Detected future fix comment');
        } else if (analysis.actionType !== 'ignore' && analysis.confidence >= 0.3) {
            // Check for potential duplicates before adding
            const isDuplicate = await checkForDuplicateComment(analysis, owner, repo, issueNumber);
            
            if (!isDuplicate) {
                actionable.push(analysis);
                processedCommentIds.push(comment.id);
            } else {
                log.debug({ commentId: comment.id }, 'Skipping duplicate or similar comment');
                // Still mark as processed to avoid re-checking
                await markCommentProcessed(owner, repo, issueNumber, comment.id, comment.body, 'duplicate');
            }
        } else {
            // Mark ignored comments as processed
            processedCommentIds.push(comment.id);
        }
    }

    // Batch mark comments as processed
    for (const commentId of processedCommentIds) {
        const comment = unprocessedComments.find(c => c.id === commentId);
        if (comment) {
            const analysis = actionable.find(a => a.comment.id === commentId);
            await markCommentProcessed(
                owner, repo, issueNumber, commentId, comment.body, 
                analysis?.actionType || 'ignored'
            );
        }
    }

    log.info({
        owner,
        repo,
        issue: issueNumber,
        total: unprocessedComments.length,
        actionable: actionable.length,
        futureFixes: actionable.filter(a => a.actionType === 'future_fix').length
    }, `Analyzed ${unprocessedComments.length} comments, found ${actionable.length} actionable (${actionable.filter(a => a.actionType === 'future_fix').length} future fixes)`);

    return actionable;
}

/**
 * Check if a comment is a duplicate or very similar to already processed comments
 */
async function checkForDuplicateComment(
    analysis: ActionableComment,
    owner: string,
    repo: string,
    issueNumber: number
): Promise<boolean> {
    const processedComments = await getProcessedCommentsForIssue(owner, repo, issueNumber);
    
    const currentBody = analysis.comment.body.toLowerCase();
    const currentHash = await hashString(currentBody);
    
    for (const processed of processedComments) {
        // Check exact hash match
        if (processed.comment_hash === currentHash) {
            return true;
        }
        
        // Check for similar content (80% similarity threshold)
        const similarity = calculateSimilarity(
            processed.comment_body?.toLowerCase() || '',
            currentBody
        );
        
        if (similarity > 0.8) {
            return true;
        }
    }
    
    return false;
}

/**
 * Calculate similarity between two strings (simple Jaccard similarity)
 */
function calculateSimilarity(str1: string, str2: string): number {
    const words1 = new Set(str1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(str2.split(/\s+/).filter(w => w.length > 2));
    
    if (words1.size === 0 && words2.size === 0) return 1;
    if (words1.size === 0 || words2.size === 0) return 0;
    
    const words1Array = Array.from(words1);
    const words2Array = Array.from(words2);
    const intersection = new Set(words1Array.filter(x => words2.has(x)));
    const union = new Set([...words1Array, ...words2Array]);
    
    return intersection.size / union.size;
}

/**
 * Hash a string for comparison
 */
async function hashString(str: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Build a prompt for OpenCode based on actionable comments
 * Now includes full conversation context for better understanding
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

`;

    // Include conversation context if available
    const commentsWithContext = actionableComments.filter(ac => ac.context && ac.context.previousComments.length > 0);
    if (commentsWithContext.length > 0) {
        prompt += `**Conversation Context:**\n`;
        prompt += `This feedback is part of an ongoing discussion. Previous comments provide important context.\n\n`;
    }

    prompt += `**Feedback to Address:**\n\n`;

    for (let i = 0; i < actionableComments.length; i++) {
        const ac = actionableComments[i];
        const isFutureFix = ac.actionType === 'future_fix';
        
        prompt += `${i + 1}. **${ac.actionType.toUpperCase()}** (confidence: ${Math.round(ac.confidence * 100)}%)`;
        
        if (isFutureFix) {
            prompt += ` [FUTURE WORK - Create separate issue]`;
        }
        
        prompt += `\n   From: @${ac.comment.user.login}\n`;
        prompt += `   Content: ${ac.comment.body}\n`;

        // Include conversation thread if available
        if (ac.context && ac.context.conversationThread.length > 1) {
            prompt += `\n   **Conversation Thread:**\n`;
            const relevantComments = ac.context.conversationThread.slice(-3); // Last 3 comments
            for (const threadComment of relevantComments) {
                if (threadComment.id !== ac.comment.id) {
                    prompt += `   - @${threadComment.user.login}: ${threadComment.body.substring(0, 100)}${threadComment.body.length > 100 ? '...' : ''}\n`;
                }
            }
            prompt += `\n`;
        }

        if (ac.extractedRequest) {
            prompt += `   Extracted Request: ${ac.extractedRequest}\n`;
        }

        if (isFutureFix) {
            prompt += `   **Note:** This is a future fix indicator. Consider creating a follow-up issue.\n`;
        }

        prompt += '\n';
    }

    if (existingCode) {
        prompt += `\n**Current Code Context:**\n\`\`\`\n${existingCode.substring(0, 2000)}\n\`\`\`\n\n`;
    }

    prompt += `**Instructions:**\n`;
    
    const hasFutureFixes = actionableComments.some(ac => ac.actionType === 'future_fix');
    const hasImmediateFixes = actionableComments.some(ac => ac.actionType === 'fix');
    
    if (hasImmediateFixes) {
        prompt += `1. Address all immediate fix requests above (marked as FIX)\n`;
        prompt += `2. Make minimal, focused changes to fix the issues\n`;
        prompt += `3. Ensure all existing tests pass\n`;
        prompt += `4. If you cannot address a specific item, explain why in your summary\n`;
    }
    
    if (hasFutureFixes) {
        if (hasImmediateFixes) {
            prompt += `5. For future fix indicators (marked as FUTURE_FIX), note them but don't implement yet\n`;
            prompt += `6. Create a summary of future work that should be addressed separately\n`;
        } else {
            prompt += `1. Note the future work items (marked as FUTURE_FIX)\n`;
            prompt += `2. Create a summary of what should be addressed in a follow-up issue\n`;
            prompt += `3. Do not make code changes for future fixes in this session\n`;
        }
    }
    
    prompt += `\nPlease implement the necessary changes now.\n`;

    return prompt;
}

/**
 * Build a prompt specifically for creating issues from future fix comments
 */
export function buildFutureFixIssuePrompt(
    prTitle: string,
    prNumber: number,
    futureFixComments: ActionableComment[]
): string {
    let prompt = `You need to create GitHub issue(s) for future fixes identified in PR #${prNumber}: "${prTitle}"\n\n`;
    prompt += `**Future Fix Comments:**\n\n`;

    for (let i = 0; i < futureFixComments.length; i++) {
        const ac = futureFixComments[i];
        prompt += `${i + 1}. From @${ac.comment.user.login}:\n`;
        prompt += `   ${ac.comment.body}\n`;
        if (ac.extractedRequest) {
            prompt += `   Key Point: ${ac.extractedRequest}\n`;
        }
        prompt += `\n`;
    }

    prompt += `**Instructions:**\n`;
    prompt += `1. Create one or more well-structured GitHub issues based on these future fix comments\n`;
    prompt += `2. Group related items into single issues when appropriate\n`;
    prompt += `3. Include clear descriptions and acceptance criteria\n`;
    prompt += `4. Reference PR #${prNumber} in each issue\n`;
    prompt += `5. Suggest appropriate labels (e.g., "technical-debt", "enhancement", "refactoring")\n\n`;

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

/**
 * Create GitHub issues from future fix comments
 * Returns the created issue numbers
 */
export async function createIssuesFromFutureFixes(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    prTitle: string,
    futureFixComments: ActionableComment[]
): Promise<{ success: boolean; createdIssues: Array<{ number: number; url: string }>; errors: string[] }> {
    const createdIssues: Array<{ number: number; url: string }> = [];
    const errors: string[] = [];
    
    log.info({ 
        owner, repo, pr: prNumber, 
        count: futureFixComments.length 
    }, `Creating issues from ${futureFixComments.length} future fix comments`);

    for (const fixComment of futureFixComments) {
        try {
            // Check if already tracked
            const { isFutureFixTracked } = await import('../db/index.js');
            const alreadyTracked = await isFutureFixTracked(owner, repo, fixComment.comment.id);
            
            if (alreadyTracked) {
                log.debug({ commentId: fixComment.comment.id }, 'Future fix already tracked, skipping');
                continue;
            }

            // Track the future fix
            const { trackFutureFixComment } = await import('../db/index.js');
            await trackFutureFixComment(
                owner, repo, prNumber, 
                fixComment.comment.id, 
                fixComment.comment.body
            );

            // Create an issue from the future fix comment
            const issueTitle = extractIssueTitle(fixComment);
            const issueBody = buildFutureFixIssueBody(fixComment, prNumber, prTitle);

            const { data: issue } = await octokit.rest.issues.create({
                owner,
                repo,
                title: issueTitle,
                body: issueBody,
                labels: ['future-fix', 'technical-debt']
            });

            // Update tracking with created issue info
            const { updateFutureFixIssue } = await import('../db/index.js');
            await updateFutureFixIssue(
                owner, repo, fixComment.comment.id,
                issue.number,
                issue.html_url,
                'created'
            );

            createdIssues.push({ number: issue.number, url: issue.html_url });
            log.info({ 
                issue: issue.number, 
                commentId: fixComment.comment.id 
            }, 'Created issue from future fix comment');

        } catch (error: any) {
            const errorMsg = `Failed to create issue from comment ${fixComment.comment.id}: ${error.message}`;
            errors.push(errorMsg);
            log.error({ 
                err: error, 
                commentId: fixComment.comment.id 
            }, errorMsg);
            
            // Mark as failed in tracking
            try {
                const { updateFutureFixIssue } = await import('../db/index.js');
                await updateFutureFixIssue(
                    owner, repo, fixComment.comment.id,
                    0,
                    '',
                    'failed'
                );
            } catch {
                // Ignore tracking update errors
            }
        }
    }

    return {
        success: errors.length === 0,
        createdIssues,
        errors
    };
}

/**
 * Extract a concise issue title from a future fix comment
 */
function extractIssueTitle(fixComment: ActionableComment): string {
    const body = fixComment.comment.body;
    
    // Try to extract first sentence or key phrase
    const firstSentence = body.split(/[.!?]/)[0].trim();
    
    // Clean up common prefixes
    let title = firstSentence
        .replace(/^\s*(TODO|FIXME|HACK|XXX)[\s:]*/i, '')
        .replace(/^\s*[-*]\s*/, '')
        .trim();
    
    // Limit length
    if (title.length > 80) {
        title = title.substring(0, 77) + '...';
    }
    
    // Add prefix based on action type
    if (title.length > 0) {
        return `[Future Fix] ${title}`;
    }
    
    return `[Future Fix] Address comment from PR review`;
}

/**
 * Build issue body from future fix comment
 */
function buildFutureFixIssueBody(
    fixComment: ActionableComment, 
    prNumber: number, 
    prTitle: string
): string {
    let body = `## Future Fix from PR Review

**Original PR:** #${prNumber} - ${prTitle}

**Comment by @${fixComment.comment.user.login}:**
> ${fixComment.comment.body}

**Extracted Request:**
${fixComment.extractedRequest || fixComment.comment.body}

`;

    if (fixComment.context && fixComment.context.conversationThread.length > 1) {
        body += `**Conversation Context:**\n`;
        const relevantComments = fixComment.context.conversationThread.slice(-3);
        for (const comment of relevantComments) {
            if (comment.id !== fixComment.comment.id) {
                body += `- @${comment.user.login}: ${comment.body.substring(0, 150)}${comment.body.length > 150 ? '...' : ''}\n`;
            }
        }
        body += `\n`;
    }

    body += `---
*This issue was automatically created from a future fix comment in PR #${prNumber}.*
`;

    return body;
}

/**
 * Post a summary comment about created future fix issues
 */
export async function postFutureFixSummary(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    createdIssues: Array<{ number: number; url: string }>
): Promise<void> {
    if (createdIssues.length === 0) return;

    const body = `🦫 **Gitybara** has created ${createdIssues.length} issue(s) for future fixes identified in this PR:

${createdIssues.map(issue => `- #${issue.number}: ${issue.url}`).join('\n')}

These items were marked for future work and will be tracked separately.

*This is an automated summary of future fixes from PR comments.*`;

    await commentOnPR(octokit, owner, repo, prNumber, body);
}
