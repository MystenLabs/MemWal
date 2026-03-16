# API Reference

## MemWal Class

### Constructor

```typescript
new MemWal(config: MemWalConfig)
```

#### MemWalConfig

| Property | Type | Description |
|----------|------|-------------|
| `network` | `'testnet' \| 'mainnet'` | Sui network |
| `packageId` | `string` | MemWal package ID |
| `registryId` | `string` | MemWal registry ID |
| `enokiApiKey?` | `string` | Enoki API key |
| `googleClientId?` | `string` | Google OAuth client ID |

### Methods

#### connectEnoki()

```typescript
connectEnoki(): Promise<void>
```

Connect using Enoki zkLogin (Google OAuth).

#### connectWallet()

```typescript
connectWallet(): Promise<void>
```

Connect using any Sui wallet.

#### addMemory()

```typescript
addMemory(input: AddMemoryInput): Promise<Memory>
```

Store a new memory.

**AddMemoryInput:**

| Property | Type | Description |
|----------|------|-------------|
| `content` | `string` | Memory content |
| `metadata?` | `Record<string, unknown>` | Optional metadata |

#### search()

```typescript
search(query: string, options?: SearchOptions): Promise<Memory[]>
```

Search memories by semantic similarity.

**SearchOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `limit` | `number` | `10` | Max results |
| `threshold` | `number` | `0.7` | Similarity threshold |

#### getMemories()

```typescript
getMemories(): Promise<Memory[]>
```

Get all memories for the connected account.

#### generateDelegateKey()

```typescript
generateDelegateKey(): Promise<KeyPair>
```

Generate a new delegate keypair.

**KeyPair:**

```typescript
interface KeyPair {
  privateKey: string  // hex
  publicKey: string   // hex
}
```

#### executeTransaction()

```typescript
executeTransaction(
  transaction: Transaction,
  options?: ExecuteOptions
): Promise<ExecuteResult>
```

Execute a Sui transaction.

**ExecuteOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `sponsor` | `boolean` | `false` | Use Enoki sponsorship |
