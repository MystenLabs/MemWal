import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'MemWal',
  description: 'Privacy-preserving decentralized memory protocol for humans and AI agents',
  base: '/',
  outDir: './dist',
  cleanUrls: false,
  markdown: {
    config(md) {
      const defaultFence =
        md.renderer.rules.fence?.bind(md.renderer.rules) ??
        ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const info = token.info.trim()

        if (info === 'mermaid') {
          return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`
        }

        return defaultFence(tokens, idx, options, env, self)
      }
    },
  },
  themeConfig: {
    siteTitle: 'MemWal',
    nav: [],
    sidebar: [
      { text: 'Overview', link: '/' },
      {
        text: 'Getting Started',
        collapsed: false,
        items: [
          { text: 'What is MemWal', link: '/getting-started/what-is-memwal' },
          { text: 'Product Status', link: '/getting-started/product-status' },
          { text: 'Core Components', link: '/getting-started/core-components' },
          { text: 'Build Your First Integration', link: '/getting-started/for-developers' },
          { text: 'Installation', link: '/getting-started/installation' },
          { text: 'Choose Your Path', link: '/getting-started/choose-your-path' },
        ],
      },
      {
        text: 'Concepts',
        collapsed: false,
        items: [
          { text: 'Explaining MemWal', link: '/concepts/explaining-memwal' },
          { text: 'Storage Structure', link: '/concepts/storage-structure' },
          { text: 'Namespace', link: '/concepts/namespace' },
          { text: 'Ownership and Access', link: '/concepts/ownership-and-access' },
          { text: 'Security Model', link: '/concepts/security-model' },
        ],
      },
      {
        text: 'Architecture',
        collapsed: false,
        items: [
          { text: 'System Overview', link: '/concepts/system-overview' },
          { text: 'Component Responsibilities', link: '/concepts/component-responsibilities' },
          { text: 'Core Flows', link: '/concepts/core-flows' },
          { text: 'Data Flow Security Model', link: '/concepts/data-flow-security-model' },
        ],
      },
      {
        text: 'SDK',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/sdk/overview' },
          { text: 'Quickstart', link: '/sdk/quick-start' },
          { text: 'Usage', link: '/sdk/usage' },
          { text: 'AI Integration', link: '/sdk/ai-integration' },
          { text: 'Basic Usage', link: '/sdk/basic-usage' },
          { text: 'Advanced Usage', link: '/sdk/advanced-usage' },
          { text: 'Research App Example', link: '/sdk/research-app-example' },
          { text: 'Example Map', link: '/sdk/example-map' },
        ],
      },
      {
        text: 'Relayer',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/relayer/overview' },
          { text: 'Public Relayer', link: '/relayer/public-relayer' },
          { text: 'Installation and Setup', link: '/relayer/installation-and-setup' },
          { text: 'Self-Hosting', link: '/relayer/self-hosting' },
        ],
      },
      {
        text: 'Smart Contract',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/contract/overview' },
          { text: 'Delegate Key Management', link: '/contract/delegate-key-management' },
          { text: 'Ownership and Permissions', link: '/contract/ownership-and-permissions' },
        ],
      },
      {
        text: 'Indexer',
        collapsed: false,
        items: [
          { text: 'Purpose', link: '/indexer/purpose' },
          { text: 'Onchain Events', link: '/indexer/onchain-events' },
          { text: 'Database Sync', link: '/indexer/database-sync' },
        ],
      },
      {
        text: 'Reference',
        collapsed: false,
        items: [
          { text: 'SDK API', link: '/reference/sdk-api' },
          { text: 'Relayer API', link: '/reference/relayer-api' },
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Environment Variables', link: '/reference/environment-variables' },
        ],
      },
      {
        text: 'Contributing',
        collapsed: true,
        items: [
          { text: 'Run Docs Locally', link: '/contributing/run-docs-locally' },
          { text: 'Run the Repo Locally', link: '/contributing/run-repo-locally' },
          { text: 'Docs Workflow', link: '/contributing/docs-workflow' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/CommandOSSLabs/personal-data-wallet' },
    ],
    footer: {
      message: 'Released under the Apache 2.0 License.',
    },
  },
})
