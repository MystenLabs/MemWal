# Configuration

Use this page to pick the right config shape quickly.

## `MemWalConfig`

Used by:

- `MemWal.create(config)`
- `withMemWal(model, options)`

| Field | Required | Notes |
| --- | --- | --- |
| `key` | yes | Delegate private key in hex |
| `serverUrl` | no | Relayer URL. Default: `http://localhost:8000` |
| `namespace` | no | Default memory boundary. Default: `"default"` |

## `MemWalManualConfig`

Used by:

- `new MemWalManual(config)`

Core fields:

| Field | Required | Notes |
| --- | --- | --- |
| `key` | yes | Delegate private key in hex |
| `serverUrl` | no | Relayer URL |
| `embeddingApiKey` | yes | OpenAI/OpenRouter-compatible embedding key |
| `embeddingApiBase` | no | Default: `https://api.openai.com/v1` |
| `embeddingModel` | no | Default: `text-embedding-3-small` |
| `packageId` | yes | MemWal package ID on Sui |
| `accountId` | yes | `MemWalAccount` object ID |
| `namespace` | no | Default namespace |

Sui signer fields:

| Field | Required | Notes |
| --- | --- | --- |
| `suiPrivateKey` | one of two | Use for local signing |
| `walletSigner` | one of two | Use a connected browser wallet instead |
| `suiClient` | no | Optional pre-configured Sui client |

Walrus and network fields:

| Field | Required | Notes |
| --- | --- | --- |
| `suiNetwork` | no | `testnet` or `mainnet`. Default: `testnet` |
| `walrusEpochs` | no | Default: `50` |
| `walrusAggregatorUrl` | no | Walrus download endpoint |
| `walrusPublisherUrl` | no | Walrus upload endpoint |

## `WithMemWalOptions`

`withMemWal(model, options)` accepts all `MemWalConfig` fields plus:

| Field | Required | Notes |
| --- | --- | --- |
| `maxMemories` | no | Default: `5` |
| `autoSave` | no | Default: `true` |
| `minRelevance` | no | Default: `0.3` |
| `debug` | no | Default: `false` |

## Rules That Matter

- `namespace` defaults to `"default"` when omitted.
- `MemWal` is the default relayer-handled path.
- `MemWalManual` is the manual client path, but it still uses the relayer for registration, search, and restore.
- `withMemWal` builds on top of `MemWal`, so it uses the same relayer-backed config shape.
