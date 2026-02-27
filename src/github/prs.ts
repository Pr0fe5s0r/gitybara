import { Octokit } from "@octokit/rest";
import { withRetry } from "../utils/retry.js";

export interface PRResult {
    url: string;
    number: number;
}

export async function openPR(
    octokit: Octokit,
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string
): Promise<PRResult> {
    const { data } = await withRetry(() => octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body,
        head,
        base,
    }));
    return { url: data.html_url, number: data.number };
}

export async function listOpenPRs(
    octokit: Octokit,
    owner: string,
    repo: string
) {
    const { data } = await withRetry(() => octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
    }));
    return data;
}

export async function getPR(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number
) {
    const { data } = await withRetry(() => octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
    }));
    return data;
}

export interface PRComment {
    id: number;
    body: string;
    user: {
        login: string;
        type: string;
    };
    created_at: string;
    updated_at: string;
    html_url: string;
}

/**
 * Get all comments on a pull request (issue comments + PR review comments)
 */
export async function getPRComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number
): Promise<PRComment[]> {
    // Get issue-level comments on the PR
    const { data: issueComments } = await withRetry(() => octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
    }));

    // Get PR review comments
    const { data: reviewComments } = await withRetry(() => octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
    }));

    // Combine and sort by creation date
    const allComments: PRComment[] = [
        ...issueComments.map((c: any) => ({
            id: c.id,
            body: c.body || "",
            user: {
                login: c.user?.login || "unknown",
                type: c.user?.type || "User"
            },
            created_at: c.created_at,
            updated_at: c.updated_at,
            html_url: c.html_url
        })),
        ...reviewComments.map((c: any) => ({
            id: c.id,
            body: c.body || "",
            user: {
                login: c.user?.login || "unknown",
                type: c.user?.type || "User"
            },
            created_at: c.created_at,
            updated_at: c.updated_at,
            html_url: c.html_url
        }))
    ];

    // Sort by creation date (oldest first)
    return allComments.sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
}

/**
 * Post a comment on a pull request
 */
export async function commentOnPR(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
): Promise<void> {
    await withRetry(() => octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
    }));
}

export interface AutoMergeConfig {
    enabled: boolean;
    mergeMethod: 'merge' | 'squash' | 'rebase';
    requireChecks?: boolean;
    requireReviews?: boolean;
}

/**
 * Enable GitHub auto-merge for a pull request
 * Uses GraphQL API as REST API doesn't support auto-merge directly
 */
export async function enableAutoMerge(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE' = 'MERGE'
): Promise<{ success: boolean; message: string }> {
    try {
        // First get the PR's node ID (GraphQL ID)
        const { data: pr } = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
        });

        // Use GraphQL mutation to enable auto-merge
        const mutation = `
            mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
                enablePullRequestAutoMerge(input: {
                    pullRequestId: $pullRequestId,
                    mergeMethod: $mergeMethod
                }) {
                    pullRequest {
                        id
                        autoMergeRequest {
                            mergeMethod
                        }
                    }
                    clientMutationId
                }
            }
        `;

        const response = await octokit.graphql(mutation, {
            pullRequestId: pr.node_id,
            mergeMethod: mergeMethod
        }) as any;

        if (response?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest) {
            return { 
                success: true, 
                message: `Auto-merge enabled with ${mergeMethod.toLowerCase()} method` 
            };
        }

        return { 
            success: false, 
            message: 'Auto-merge could not be enabled' 
        };
    } catch (error: any) {
        // Handle specific error cases
        if (error.message?.includes('Auto-merge is not enabled for this repository')) {
            return { 
                success: false, 
                message: 'Auto-merge feature is not enabled for this repository. Please enable it in repository settings.' 
            };
        }
        if (error.message?.includes('Pull request is in clean status')) {
            return { 
                success: false, 
                message: 'PR is already mergeable. Consider merging directly.' 
            };
        }
        if (error.message?.includes('Merge conflict')) {
            return { 
                success: false, 
                message: 'PR has merge conflicts that must be resolved first' 
            };
        }
        
        return { 
            success: false, 
            message: `Failed to enable auto-merge: ${error.message || 'Unknown error'}` 
        };
    }
}

/**
 * Disable GitHub auto-merge for a pull request
 */
export async function disableAutoMerge(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number
): Promise<{ success: boolean; message: string }> {
    try {
        const { data: pr } = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
        });

        const mutation = `
            mutation DisableAutoMerge($pullRequestId: ID!) {
                disablePullRequestAutoMerge(input: {
                    pullRequestId: $pullRequestId
                }) {
                    pullRequest {
                        id
                        autoMergeRequest {
                            enabledAt
                        }
                    }
                    clientMutationId
                }
            }
        `;

        const response = await octokit.graphql(mutation, {
            pullRequestId: pr.node_id
        }) as any;

        return { 
            success: true, 
            message: 'Auto-merge disabled' 
        };
    } catch (error: any) {
        return { 
            success: false, 
            message: `Failed to disable auto-merge: ${error.message || 'Unknown error'}` 
        };
    }
}

/**
 * Check if auto-merge is enabled for a pull request
 */
export async function isAutoMergeEnabled(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number
): Promise<{ enabled: boolean; mergeMethod?: string; status?: string }> {
    try {
        const query = `
            query GetPRAutoMergeStatus($owner: String!, $repo: String!, $number: Int!) {
                repository(owner: $owner, name: $repo) {
                    pullRequest(number: $number) {
                        id
                        autoMergeRequest {
                            mergeMethod
                            enabledAt
                        }
                        mergeStateStatus
                        mergeable
                    }
                }
            }
        `;

        const response = await octokit.graphql(query, {
            owner,
            repo,
            number: pullNumber
        }) as any;

        const pr = response?.repository?.pullRequest;
        
        return {
            enabled: !!pr?.autoMergeRequest,
            mergeMethod: pr?.autoMergeRequest?.mergeMethod,
            status: pr?.mergeStateStatus
        };
    } catch (error) {
        return { enabled: false };
    }
}

/**
 * Attempt to merge a pull request directly if it's mergeable
 */
export async function mergePullRequest(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge',
    commitTitle?: string,
    commitMessage?: string
): Promise<{ success: boolean; message: string; sha?: string }> {
    try {
        const { data } = await withRetry(() => octokit.rest.pulls.merge({
            owner,
            repo,
            pull_number: pullNumber,
            merge_method: mergeMethod,
            commit_title: commitTitle,
            commit_message: commitMessage,
        }));

        return {
            success: true,
            message: `Successfully merged PR #${pullNumber}`,
            sha: data.sha
        };
    } catch (error: any) {
        if (error.status === 405) {
            return {
                success: false,
                message: 'PR is not mergeable. It may have conflicts or failing checks.'
            };
        }
        if (error.status === 409) {
            return {
                success: false,
                message: 'Merge conflict detected. Cannot merge automatically.'
            };
        }
        return {
            success: false,
            message: `Failed to merge: ${error.message || 'Unknown error'}`
        };
    }
}
