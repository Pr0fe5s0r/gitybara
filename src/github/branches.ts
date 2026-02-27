import { Octokit } from "@octokit/rest";
import { withRetry } from "../utils/retry.js";

export async function createBranch(
    octokit: Octokit,
    owner: string,
    repo: string,
    baseBranch: string,
    newBranch: string
): Promise<void> {
    // Get SHA of base branch
    const { data: ref } = await withRetry(() => octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
    }));
    const sha = ref.object.sha;

    // Create new branch
    try {
        await withRetry(() => octokit.rest.git.createRef({
            owner,
            repo,
            ref: `refs/heads/${newBranch}`,
            sha,
        }));
    } catch (err: any) {
        if (err.status === 422 && err.message.includes("Reference already exists")) {
            // Ignore if branch already exists
            return;
        }
        throw err;
    }
}

export function issueToBranchName(issueNumber: number, title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
    return `gitybara/issue-${issueNumber}-${slug}`;
}
