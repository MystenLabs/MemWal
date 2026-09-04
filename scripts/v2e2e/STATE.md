# V2 testnet E2E spike (local)

Not production. Package is a **new** testnet publish, not staging V1.

## Sui testnet objects

| What | ID |
|---|---|
| Package | `0xdf67385f0842bcdd7234b73d9822f1b29f7d7991115c219a589118d8c5501dfc` |
| AccountRegistry | `0x0e04320f37466a449d7bf6980bf8dad22d563da41faf98a0aab8b82c802eff86` |
| NamespaceRegistry | `0x1d0a9f1bf04832387fa911cbb83e59c99332439d93e89e1e868f23f5a08cb995` |
| AdminCap (Y) | `0x74089d4fea9a3e856f897647bfb4d31e7b1ccd9879f61595a9c4b43b13485544` |
| UpgradeCap (Y) | `0xede7fecc08f00a72409ec276196690166f8ba85c004d667f365a14a5b292ba97` |
| MemWalAccount | `0x35fa85566a1033da3ece08d84cd93b15d737d9c989ae3019d44298f43fddaca1` |
| MemoryNamespace `e2e-testnet` | `0xc433d725f44ef039394e420e8ca240cf777b786608a8c9aa91cdf9525dd5c95b` |

## Wallets

| Role | Alias | Address |
|---|---|---|
| Y owner | `memwal-master` | `0x158a78f06e4a85cdef1a1f10bc30c41e4860c1a19f3b049a05098aca588593e7` |
| B granted READ | `ducnmm` | `0x3103b5ddad293bb00cf9b54061684293a829f2a65a7c560925e954f6e14a781f` |

## Digests (pass)

| Step | Digest |
|---|---|
| publish | `6B46Uz8RMyNvrK4PTi445Qmm8NjBj2ZFknGHmKwyVnjv` |
| pin empty root | `J8vTaEANdSgAnJDhaZqaREF5YczGXiivCxiHkuqjDMxE` |
| finalize_migration | `3Jr6y5itV5PPJrb37ybYMtvyaaJHHBpENE5WBH55FcZF` |
| create_account | `BPZcPknoLybNynrS6Aer6qtL5FetYYQWiqnGdyaKMjYG` |
| create_namespace | `6iph2CZfKCChCipEWdZ5xEGhKQ4wzKTu7HyG2PPa5MGZ` |
| initialize_key (dummy DEK) | `CbYyrAS2SmcXTADNskJ18T7fNMgCqqLKaxE2uwWWwprT` |
| grant_access B READ | `FZjghMzpzMqMG1KTvAPiYCtvUTGFTBWM1nnz6t3rvAuV` |
| write_fence | `3XaJrdR8dPPoXVuMooeKx7g37vaUsY3MriU5JcvUcm4K` |
| B seal_approve | `6XDyLmM5oVreTHA5GagQJqD9fVHDLXXA25rCKFWYz1z7` |

`write_fence` commitment is blake2b-256 of `fake-seal-ciphertext-memwal-v2` (32 bytes). Not bound to a Walrus `Blob`.

## Oyster + Walrus testnet (local oysterd + Pearl)

Pearl wallet (funded 2 SUI + 20 WAL from `memwal-master`):
`0xb2b7ffddc0ef91ba853c67d1a6e11fcfce3121053e7ba282be37cde8e1f87383`

| What | Value |
|---|---|
| Oyster account | `b8b16ac3-c643-45a1-8d77-b748462a9e0e` |
| Bucket | `v2e2e-ns` |
| Key | `mem-1` |
| `blob_id` (Walrus content hash, base64url) | `xdmLE4twdasDCZaDCp8c2xqdf_B9q-05Q3928gvifJk` |
| `pooled_blob_object_id` | `0xe4b2b8f1a6cf6f355a9d53e68800ff446e2787e5fd4ef8c2468fd1b2372b8e26` |
| PUT / GET / GET-by-blob-id | 201 / 200 / 200, body = `fake-seal-ciphertext-memwal-v2` |
| `expires_at` | **not in 0.14.2 JSON** (even on-chain path) |
| `encoded_size` | 66034000 (Walrus min unit) |

## Not in this spike

- Real Seal wrap of the AES DEK (`initialize_key` used dummy bytes). B **can** `seal_approve` (ACL). Committee unwrap of a real DEK is the next glue step (`rotate_key` + `@mysten/seal`).
- Relayer V2 write path / Postgres index.
- Console UI.
