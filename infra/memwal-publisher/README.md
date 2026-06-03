# MemWal Publisher

Custom local/private Walrus publisher wrapper for MemWal.

It runs the stock `walrus publisher` internally on `127.0.0.1:31415`, exposes a
MemWal-aware HTTP publisher on `31416`, and preserves restore metadata:

1. verify the relayer JWT;
2. forward the blob bytes to the internal stock publisher without
   `send_object_to`;
3. run one Sui PTB that sets `memwal_*` attributes and transfers the Blob
   object to the memory owner.

Local support stack:

```bash
cp services/server/.env.example services/server/.env
cp services/server/.env.walrus-publisher.example services/server/.env.walrus-publisher
# Fill the same WALRUS_PUBLISHER_JWT_SECRET in both files.
# Put a funded PUBLISHER_SUI_PRIVATE_KEY in .env.walrus-publisher.
docker compose -f services/server/docker-compose.yml --profile publisher up -d postgres redis memwal-publisher
```

Standalone local mainnet runner:

```bash
infra/memwal-publisher/run-local-mainnet.sh
```

Relayer env:

```env
WALRUS_UPLOAD_BACKEND=publisher
# Host-run relayer:
WALRUS_PUBLISHER_URL=http://127.0.0.1:31416
# Relayer container in the same compose/network:
# WALRUS_PUBLISHER_URL=http://memwal-publisher:31416
WALRUS_PUBLISHER_JWT_SECRET=replace-with-32-byte-random-secret
WALRUS_PUBLISHER_SETS_MEMWAL_METADATA=true
WALRUS_PUBLISHER_SEND_OBJECT_TO_OWNER=true
```

The internal stock publisher is unauthenticated because it is only bound inside
the container. The exposed MemWal publisher requires JWT auth.
