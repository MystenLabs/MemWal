import { createHash, randomBytes } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { WalrusClient } from '@mysten/walrus';
import { SuiGrpcClient } from '@mysten/sui/grpc';
// numShards is always supplied; metadata computation performs no RPC or signing.
globalThis.fetch = async () => { throw new Error("metadata worker cannot access network"); };
const client = new WalrusClient({ network: 'testnet', suiClient: new SuiGrpcClient({network:'testnet',baseUrl:'https://fullnode.testnet.sui.io:443'}) });
const cache = new Map();
parentPort.on('message', async ({ id, bytes, numShards, nonce }) => {
    try {
        const key = `${numShards}:${createHash('sha256').update(bytes).digest('hex')}`;
        let promise = cache.get(key);
        if (!promise) {
            promise = client.computeBlobMetadata({ bytes, numShards, nonce: new Uint8Array(32) })
                .then(({ blobDigest, nonce: ignored, ...metadata }) => metadata);
            cache.set(key, promise);
            promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
            if (cache.size > 128) cache.delete(cache.keys().next().value);
        }
        const metadata = await promise;
        parentPort.postMessage({ id, result: { ...metadata, nonce: nonce ?? new Uint8Array(randomBytes(32)) } });
    } catch (error) {
        parentPort.postMessage({ id, error: String(error?.message ?? error) });
    }
});
