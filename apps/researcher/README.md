# Researcher

Researcher is a demonstration application for Walrus Memory research workflows. It is not a production credential wallet and must not be deployed with production delegate private keys or exposed as a key-recovery service.

Authentication cookies contain identity claims only. Reusable delegate credentials remain in the server-side database and are loaded only for authenticated server operations. The application deliberately does not expose a delegate-key export endpoint.

For any production deployment, use dedicated least-privilege accounts, short-lived sessions, managed secret storage, deployment-specific rate limits, and a separate security review.
