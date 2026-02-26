import { createOpencode } from "@opencode-ai/sdk";
import * as net from "net";

async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
        srv.on("error", reject);
    });
}

export async function getAvailableModels(): Promise<{ providerId: string, modelId: string }[]> {
    const port = await getAvailablePort();
    let opencode;
    try {
        opencode = await createOpencode({ port });
        const resp = await opencode.client.config.providers();

        const models: { providerId: string, modelId: string }[] = [];
        if (resp.data && resp.data.providers) {
            for (const provider of resp.data.providers) {
                if (provider.models) {
                    for (const modelId of Object.keys(provider.models)) {
                        models.push({ providerId: provider.id, modelId });
                    }
                }
            }
        }
        return models;
    } finally {
        if (opencode) {
            await opencode.server.close();
        }
    }
}
