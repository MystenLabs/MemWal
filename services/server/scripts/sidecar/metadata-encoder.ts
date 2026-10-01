import { Worker } from "node:worker_threads";
import type { WalrusClient } from "@mysten/walrus";

type Input = Parameters<WalrusClient["computeBlobMetadata"]>[0];
type Output = Awaited<ReturnType<WalrusClient["computeBlobMetadata"]>>;
/** One CPU worker bounds encoding concurrency without blocking HTTP or RPC timers. */
export class MetadataEncoder {
    private worker?: Worker;
    private nextId = 0;
    private pending = new Map<number, { resolve: (r: Omit<Output, "blobDigest">) => void; reject: (e: Error) => void }>();
    private getWorker(): Worker {
        if (this.worker) return this.worker;
        const worker = new Worker(new URL("./metadata-worker.mjs", import.meta.url));
        this.worker = worker;
        worker.on("message", ({ id, result, error }) => {
            const request = this.pending.get(id);
            if (!request) return;
            this.pending.delete(id);
            if (error) request.reject(new Error(error)); else request.resolve(result);
            if (this.pending.size === 0) worker.unref();
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            for (const request of this.pending.values()) request.reject(error);
            this.pending.clear();
        };
        worker.on("error", fail);
        worker.on("exit", code => fail(new Error(`metadata encoder exited (${code})`)));
        worker.unref();
        return worker;
    }
    async compute(input: Input & { numShards: number }): Promise<Output> {
        const worker = this.getWorker();
        const id = this.nextId++;
        worker.ref();
        const result = await new Promise<Omit<Output, "blobDigest">>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { worker.postMessage({ id, ...input }); }
            catch (error) {
                this.pending.delete(id);
                if (this.pending.size === 0) worker.unref();
                reject(error);
            }
        });
        let digest: Promise<Uint8Array> | undefined;
        return { ...result, blobDigest: () => digest ??= crypto.subtle.digest("SHA-256", new Uint8Array(input.bytes)).then(b => new Uint8Array(b)) };
    }
    async close(): Promise<void> { await this.worker?.terminate(); }
}
