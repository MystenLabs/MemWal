# Advanced Usage

## Delegate Keys

Delegate keys allow AI agents to access your MemWal without compromising your wallet:

```typescript
// Generate a delegate key
const keyPair = await memwal.generateDelegateKey()

console.log('Private Key:', keyPair.privateKey)
console.log('Public Key:', keyPair.publicKey)

// The delegate key is registered onchain
```

## Custom Encryption

Use custom encryption with SEAL:

```typescript
import { Seal } from '@mysten/seal'

const seal = new Seal()

// Encrypt data
const encrypted = await seal.encrypt(data, {
  recipients: ['0x...address...']
})

// Decrypt data
const decrypted = await seal.decrypt(encrypted)
```

## Batch Operations

Store multiple memories at once:

```typescript
const memories = await memwal.addMemories([
  { content: 'Memory 1', metadata: { type: 'note' } },
  { content: 'Memory 2', metadata: { type: 'note' } },
  { content: 'Memory 3', metadata: { type: 'note' } },
])
```

## Custom Storage

Use Walrus directly for large data:

```typescript
import { Walrus } from '@mysten/walrus'

const walrus = new Walrus()

// Upload to Walrus
const { blobId } = await walrus.upload(data)

// Retrieve from Walrus
const data = await walrus.download(blobId)
```

## Gasless Transactions

Using Enoki sponsored transactions:

```typescript
// Transactions are sponsored by Enoki
const result = await memwal.executeTransaction(
  transaction,
  { sponsor: true }
)
```
