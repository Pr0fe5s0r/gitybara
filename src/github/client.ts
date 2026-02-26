import { Octokit } from "@octokit/rest";

export function createGitHubClient(token: string): Octokit {
    return new Octokit({
        auth: token,
        userAgent: "gitybara/0.1.0",
    });
}
