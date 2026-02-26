import { pino } from "pino";

export function createLogger(name: string) {
    return pino({
        name,
        level: process.env.LOG_LEVEL ?? "info",
        transport:
            process.stdout.isTTY
                ? {
                    target: "pino-pretty",
                    options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
                }
                : undefined,
    });
}
