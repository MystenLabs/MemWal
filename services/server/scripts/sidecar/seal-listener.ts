/**
 * Forks the seal process and restarts the parent if that process dies.
 * Upload saturation stays on the main sidecar; recall talks to this port.
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

let stopActive: (() => Promise<void>) | null = null;

export function stopSealListener(): Promise<void> {
    return stopActive ? stopActive() : Promise.resolve();
}

function uploadPort(): number {
    const parsed = Number.parseInt(process.env.SIDECAR_PORT?.trim() || "9000", 10);
    return Number.isInteger(parsed) ? parsed : 9000;
}

function sealPort(): number {
    const raw = process.env.SIDECAR_SEAL_PORT?.trim();
    if (!raw) return uploadPort() + 1;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : uploadPort() + 1;
}

export type SealListener = {
    port: number | null;
    stop: () => Promise<void>;
};

function loaderArgv(): string[] {
    const kept: string[] = [];
    const argv = process.execArgv;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] ?? "";
        if (arg === "--import" || arg === "--require" || arg === "-r") {
            const next = argv[i + 1];
            if (next) kept.push(arg, next);
            i += 1;
            continue;
        }
        if (arg.startsWith("--import=") || arg.startsWith("--require=")) kept.push(arg);
    }
    if (kept.length === 0) kept.push("--import", "tsx");
    return kept;
}

export function startSealListener(options?: { exitOnFailure?: boolean }): Promise<SealListener> {
    const disabled: SealListener = { port: null, stop: async () => {} };
    const routeMode = (process.env.SIDECAR_ROUTE_MODE || "full").trim().toLowerCase();
    if (process.env.SIDECAR_SEAL_LISTENER === "0" || routeMode === "writer") {
        return Promise.resolve(disabled);
    }
    const port = sealPort();
    if (port === uploadPort()) {
        console.warn(
            `[seal-listener] SIDECAR_SEAL_PORT=${port} matches the upload port; recall stays on the upload process`
        );
        return Promise.resolve(disabled);
    }

    const workerPath = fileURLToPath(new URL("./seal-worker.ts", import.meta.url));
    const child: ChildProcess = fork(workerPath, [], {
        execArgv: loaderArgv(),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: process.env,
    });

    let stopping = false;
    let ready = false;
    const exitOnFailure = options?.exitOnFailure === true;

    const stop = async () => {
        stopping = true;
        if (stopActive === stop) stopActive = null;
        if (child.exitCode != null || child.signalCode != null) return;
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
            }, 2_000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    };
    stopActive = stop;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            void stop().finally(() => reject(new Error("seal listener did not become ready")));
        }, 20_000);

        child.once("exit", (code, signal) => {
            if (!ready) {
                clearTimeout(timer);
                if (!stopping) {
                    reject(new Error(`seal listener exited before ready (code=${code} signal=${signal})`));
                }
                return;
            }
            if (!stopping && exitOnFailure) {
                console.error(`[seal-listener] exited code=${code} signal=${signal}; shutting down so recall is not served by the upload process`);
                process.exit(1);
            }
        });

        child.on("message", (message: { type?: string; port?: number }) => {
            if (message?.type !== "ready" || typeof message.port !== "number") return;
            ready = true;
            clearTimeout(timer);
            resolve({ port: message.port, stop });
        });
    });
}
