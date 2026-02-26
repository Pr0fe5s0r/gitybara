import { Octokit } from "@octokit/rest";
import pLimit from "p-limit";

export interface GitHubIssue {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: string[];
}

export async function listOpenIssues(
    octokit: Octokit,
    owner: string,
    repo: string,
    labelFilter: string
): Promise<GitHubIssue[]> {
    const params: Parameters<typeof octokit.rest.issues.listForRepo>[0] = {
        owner,
        repo,
        state: "open",
        per_page: 50,
    };
    if (labelFilter) {
        params.labels = labelFilter;
    }

    const { data } = await octokit.rest.issues.listForRepo(params);

    // Exclude pull requests (GitHub API returns PRs as issues)
    // and exclude those already marked as done
    return data
        .filter((i) => !i.pull_request)
        .map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body || null,
            html_url: i.html_url,
            labels: i.labels.map((l) =>
                typeof l === "string" ? l : (l.name || "")
            ),
        }))
        .filter((i) => !i.labels.includes("gitybara:done"));
}


export async function labelIssue(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number,
    label: string
): Promise<void> {
    // Ensure label exists first
    try {
        await octokit.rest.issues.getLabel({ owner, repo, name: label });
    } catch {
        await octokit.rest.issues.createLabel({
            owner,
            repo,
            name: label,
            color: label === "gitybara:in-progress" ? "fbca04" : "0e8a16",
        });
    }
    await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: [label],
    });
}

export async function commentOnIssue(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
): Promise<void> {
    await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
    });
}

export async function getIssueComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    issueNumber: number
): Promise<string[]> {
    const { data } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100, // Fetch up to 100 comments
    });

    return data.map((comment) => comment.body || "");
}

export async function ensureModelLabels(
    octokit: Octokit,
    owner: string,
    repo: string,
    models: { providerId: string, modelId: string }[]
): Promise<void> {
    const log = (await import("../utils/logger.js")).createLogger("github-issues");
    log.info({ repo: `${owner}/${repo}` }, "Fetching existing labels to optimize sync...");

    // 1. Fetch existing labels to avoid unnecessary 422 errors and speed up the process
    const existingLabels = new Set<string>();
    try {
        let page = 1;
        while (true) {
            const { data } = await octokit.rest.issues.listLabelsForRepo({
                owner,
                repo,
                per_page: 100,
                page,
            });
            if (data.length === 0) break;
            for (const label of data) {
                existingLabels.add(label.name);
            }
            page++;
        }
        log.debug({ count: existingLabels.size }, "Fetched existing labels");
    } catch (err: any) {
        log.error({ err }, `Error fetching labels for ${owner}/${repo}`);
    }

    // 2. Filter out models that already have labels
    const modelsToCreate = models.filter(m => !existingLabels.has(`model:${m.modelId}`));

    if (modelsToCreate.length === 0) {
        log.info({ repo: `${owner}/${repo}` }, "All model labels are already present on GitHub. Skipping creation.");
        return;
    }

    log.info({ count: modelsToCreate.length }, "Found missing model labels. Creating them now...");

    // 3. Create missing labels concurrently
    const limit = pLimit(5); // Run up to 5 label creation requests in parallel
    const promises = modelsToCreate.map(model => limit(async () => {
        const labelName = `model:${model.modelId}`;
        try {
            await octokit.rest.issues.createLabel({
                owner,
                repo,
                name: labelName,
                color: "1d76db",
                description: `Run Gitybara with ${model.providerId}/${model.modelId}`
            });
            log.debug({ label: labelName }, "Created missing label");
        } catch (err: any) {
            // Label likely already exists (422) or something went wrong
            if (err.status !== 422) {

                console.error(`Error creating label ${labelName}:`, err.message);
            }
        }
    }));

    await Promise.all(promises);
}


