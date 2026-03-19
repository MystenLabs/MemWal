---
layout: doc
---

<div class="overview-hero">

<h1 class="overview-title">MemWal</h1>

**Privacy-Preserving Decentralized Memory**

Private. Decentralized. Owned. A memory protocol for humans and AI agents — powered by Walrus and Sui.


</div>

## Navigate the Docs

<div class="overview-grid">
  <div class="overview-card">
    <h3><a href="/getting-started/what-is-memwal">Getting Started</a></h3>
    <ul>
      <li>What is MemWal</li>
      <li>Installation</li>
      <li>Build your first integration</li>
    </ul>
  </div>
  <div class="overview-card">
    <h3><a href="/concepts/explaining-memwal">Concepts</a></h3>
    <ul>
      <li>Storage structure</li>
      <li>Namespaces</li>
      <li>Ownership and access</li>
      <li>Security model</li>
    </ul>
  </div>
  <div class="overview-card">
    <h3><a href="/concepts/system-overview">Architecture</a></h3>
    <ul>
      <li>System overview</li>
      <li>Component responsibilities</li>
      <li>Core flows</li>
      <li>Data flow security</li>
    </ul>
  </div>
  <div class="overview-card">
    <h3><a href="/sdk/overview">SDK</a></h3>
    <ul>
      <li>Quickstart</li>
      <li>Usage patterns</li>
      <li>AI integration</li>
      <li>Examples</li>
    </ul>
  </div>
  <div class="overview-card">
    <h3><a href="/relayer/overview">Relayer</a></h3>
    <ul>
      <li>Public relayer</li>
      <li>Installation and setup</li>
      <li>Self-hosting</li>
    </ul>
  </div>
  <div class="overview-card">
    <h3><a href="/contract/overview">Smart Contract</a></h3>
    <ul>
      <li>Onchain ownership model</li>
      <li>Delegate key management</li>
      <li>Permissions</li>
    </ul>
  </div>
  <div class="overview-card">
    <h3><a href="/indexer/purpose">Indexer</a></h3>
    <ul>
      <li>Event indexing</li>
      <li>Onchain events</li>
      <li>Database sync</li>
    </ul>
  </div>
  <div class="overview-card">
    <h3><a href="/reference/sdk-api">Reference</a></h3>
    <ul>
      <li>SDK API</li>
      <li>Relayer API</li>
      <li>Configuration</li>
      <li>Environment variables</li>
    </ul>
  </div>
</div>

<style>
.overview-hero {
  text-align: center;
  padding: 2rem 0 1rem;
}

.overview-title {
  font-size: 2.5rem;
  border-bottom: none;
  margin: 0;
}


.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  margin-top: 1rem;
}

.overview-card {
  padding: 1.25rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  transition: border-color 0.25s, box-shadow 0.25s;
}

.overview-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.overview-card h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}

.overview-card ul {
  margin: 0;
  padding-left: 1.25rem;
  list-style: disc;
}

.overview-card li {
  font-size: 0.875rem;
  color: var(--vp-c-text-2);
  line-height: 1.75;
}

@media (max-width: 640px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
