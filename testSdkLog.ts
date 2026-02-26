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

(async () => {
    try {
        const port = await getAvailablePort();
        const opencode = await createOpencode({ port, config: { model: "opencode/gpt-5-nano" } });
        const events = await opencode.client.event.subscribe();

        const processEvents = async () => {
            for await (const x of events.stream) {
                console.log(JSON.stringify(x));
            }
        };
        processEvents();

        const session = await opencode.client.session.create({ body: { title: 'test' } });
        await opencode.client.session.prompt({
            path: { id: session.data.id },
            body: { parts: [{ type: 'text', text: 'say hello to me' }] }
        });

        console.log('DONE');
        await opencode.server.close();
        process.exit(0);

    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
