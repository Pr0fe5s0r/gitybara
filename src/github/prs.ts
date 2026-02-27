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
