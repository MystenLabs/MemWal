---
title: "Unsigned Health Check Rationale"
description: >-
  Design rationale for leaving the Walrus Memory health and version endpoints
  unauthenticated, covering security considerations, load balancer compatibility,
  and rate limiting implications.
keywords:
  - Walrus Memory
  - MemWal
  - health check
  - security
  - unauthenticated endpoint
  - API design
goal:
  description: Understand why the health and version endpoints are intentionally left unauthenticated and the security trade-offs involved.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - "Why are the Walrus Memory health and version endpoints unauthenticated?"
  - "What information do the MemWal health check endpoints expose?"
  - "How is rate limiting handled for the unsigned health endpoint?"
answer: >-
  The health and version endpoints are intentionally unauthenticated because they expose
  no sensitive information, only service status and version metadata. They must remain
  unsigned for compatibility with standard load balancers and orchestrators like
  Kubernetes that cannot sign requests dynamically. Rate limiting for these public
  routes must be handled at the ingress or reverse proxy level.
---

# Unsigned Health Check Rationale

## Endpoint
`GET /health` and `GET /version`

## Design Decision
The health and version endpoints are intentionally left unauthenticated and unsigned. They do not require a valid Ed25519 signature in headers like the rest of the API.

## Security Considerations

1. **No Sensitive Information:** 
   The endpoints return service status, package/API versions, SDK compatibility metadata, feature flags, and documented deprecation notices. They do not expose secrets, environment values, uptime, database state, wallet addresses, or credentials.

2. **Load Balancer Integration:**
   Standard load balancers, orchestrators (e.g. Kubernetes, Railway), and uptime monitoring tools cannot easily sign requests dynamically. Leaving the endpoint public ensures compatibility with external infrastructure components that rely on straightforward HTTP GET probes.

3. **Rate Limiting:**
   Since it is a public unauthenticated route, it bypasses the standard account-based rate limiter middleware. However, because it performs no Database, Redis, LLM, or Walrus operations, the computational path is negligible. If layer 7 DDoS protection is required, it must be handled at the ingress or frontend reverse proxy level.
