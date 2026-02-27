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
