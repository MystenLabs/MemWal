# Memory Space

A memory space is a narrower retrieval boundary inside a broader namespace.

Like namespace, memory space is currently best treated as a **practical integration model**
rather than a dedicated SDK object in the beta surface.

## Use It For

- separating chat memory from research memory
- isolating different assistants or workflows
- limiting which memories should be considered for a given query

## Relationship to Namespace

- namespace: broad application or product boundary
- memory space: focused retrieval context inside that boundary

## Example

Inside a single namespace, you might define separate memory spaces for:

- user profile and preference memory
- research artifacts and summaries
- tool-specific operational memory
