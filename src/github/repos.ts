import { Octokit } from "@octokit/rest";

export async function fetchUserRepos(octokit: Octokit): Promise<string[]> {
    const repos: string[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
        const response = await octokit.rest.repos.listForAuthenticatedUser({
            per_page: perPage,
            page: page,
            sort: "updated",
        });

        if (response.data.length === 0) break;

        for (const repo of response.data) {
            repos.push(repo.full_name);
        }

        if (response.data.length < perPage) break;
        page++;
    }

    return repos;
}
