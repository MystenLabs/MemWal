# Delegate Key Management

Delegate keys are lightweight Ed25519 keys used for SDK authentication.

## Why They Exist

- apps need a usable key for API calls
- users should not hand over the owner wallet for day-to-day memory access

## Main Lifecycle

- create a delegate key
- register the public key onchain
- use the private key in the SDK
- revoke the delegate key when it should stop working

## Practical Result

Removing a delegate key from the onchain account should prevent future relayer access from that
key.
