# Unsigned Health Check Rationale

## Endpoint
`GET /health`

## Design Decision
The health check endpoint is intentionally left unauthenticated and unsigned. It does not require a valid Ed25519 signature in headers like the rest of the API.

## Security Considerations

1. **No Sensitive Information:** 
   The endpoint only returns a standard `{"status": "ok"}` payload. Following security audits (INFO-6), sensitive environment state such as `process.uptime()` has been removed to prevent system reconnaissance.

2. **Load Balancer Integration:**
   Standard load balancers, orchestrators (e.g. Kubernetes, Railway), and uptime monitoring tools cannot easily sign requests dynamically. Leaving the endpoint public ensures compatibility with external infrastructure components that rely on straightforward HTTP GET probes.

3. **Rate Limiting:**
   Since it is a public unauthenticated route, it bypasses the standard account-based rate limiter middleware. However, because it performs no Database, Redis, LLM, or Walrus operations, the computational path is negligible. If layer 7 DDoS protection is required, it must be handled at the ingress or frontend reverse proxy level.
