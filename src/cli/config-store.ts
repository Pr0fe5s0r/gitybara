import path from "path";
import os from "os";
import fs from "fs";

export const GITYBARA_DIR = path.join(os.homedir(), ".gitybara");
export const CONFIG_FILE = path.join(GITYBARA_DIR, "config.json");
export const DB_FILE = path.join(GITYBARA_DIR, "data.db");
export const PID_FILE = path.join(GITYBARA_DIR, "daemon.pid");
export const LOG_FILE = path.join(GITYBARA_DIR, "daemon.log");

export interface GlobalConfig {
    githubToken: string;
    repos: RepoConfig[];
    pollingIntervalMinutes: number;
    daemonPort: number;
    opencodePath: string;
    defaultProvider?: string;
    defaultModel?: string;
    whatsappOwnerId?: string;
    telegramTokens?: string[];
    telegramOwnerId?: string;
}

export interface RepoConfig {
    owner: string;
    repo: string;
    issueLabel: string; // label to filter issues, e.g. "gitybara" or "" for all
    baseBranch: string;
    clonePath: string;
    webhookSecret?: string;
    autoMerge?: AutoMergeSettings;
}

export interface AutoMergeSettings {
    enabled: boolean;
    autoMergeClean: boolean;
    autoResolveConflicts: boolean;
    mergeMethod: 'merge' | 'squash' | 'rebase';
    requireChecks: boolean;
    requireReviews: boolean;
}

export function ensureGitybaraDir(): void {
    if (!fs.existsSync(GITYBARA_DIR)) {
        fs.mkdirSync(GITYBARA_DIR, { recursive: true });
    }
}

export function readConfig(): GlobalConfig | null {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as GlobalConfig;
}

export function writeConfig(config: GlobalConfig): void {
    ensureGitybaraDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getDefaultConfig(): GlobalConfig {
    return {
        githubToken: "",
        repos: [],
        pollingIntervalMinutes: 5,
        daemonPort: 4242,
        opencodePath: "opencode",
    };
}

export function getDefaultAutoMergeSettings(): AutoMergeSettings {
    return {
        enabled: true,
        autoMergeClean: true,
        autoResolveConflicts: true,
        mergeMethod: 'merge',
        requireChecks: false,
        requireReviews: false,
    };
}
