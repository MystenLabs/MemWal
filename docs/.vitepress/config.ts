import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'MemWal',
  description: 'Privacy-preserving AI memory for agents',
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
    nav: [
      { text: 'Getting Started', link: '/about/what-is-memwal' },
      { text: 'System', link: '/concepts/explaining-memwal' },
      { text: 'SDK', link: '/sdk/overview' },
      { text: 'Relayer', link: '/relayer/overview' },
      { text: 'Reference', link: '/reference/sdk-api' },
    ],
    sidebar: {
      '/about/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/about/what-is-memwal' },
            { text: 'Product Status', link: '/about/product-status' },
            { text: 'Core Components', link: '/about/core-components' },
          ],
        },
        {
          text: 'Build Your First Integration',
          items: [
            { text: 'Build Your First Integration', link: '/getting-started/for-developers' },
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Choose Your Path', link: '/getting-started/choose-your-path' },
          ],
        },
      ],
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/about/what-is-memwal' },
            { text: 'Product Status', link: '/about/product-status' },
            { text: 'Core Components', link: '/about/core-components' },
          ],
        },
        {
          text: 'Build Your First Integration',
          items: [
            { text: 'Build Your First Integration', link: '/getting-started/for-developers' },
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Choose Your Path', link: '/getting-started/choose-your-path' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Concepts', link: '/concepts/explaining-memwal' },
            { text: 'Storage Structure', link: '/concepts/storage-structure' },
            { text: 'Namespace', link: '/concepts/namespace' },
            { text: 'Ownership and Access', link: '/concepts/ownership-and-access' },
            { text: 'Security Model', link: '/concepts/security-model' },
          ],
        },
        {
          text: 'Architecture',
          items: [
            { text: 'System Overview', link: '/architecture/system-overview' },
            { text: 'Component Responsibilities', link: '/architecture/component-responsibilities' },
            { text: 'Core Flows', link: '/architecture/core-flows' },
            { text: 'Data Flow Security Model', link: '/architecture/data-flow-security-model' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Concepts', link: '/concepts/explaining-memwal' },
            { text: 'Storage Structure', link: '/concepts/storage-structure' },
            { text: 'Namespace', link: '/concepts/namespace' },
            { text: 'Ownership and Access', link: '/concepts/ownership-and-access' },
            { text: 'Security Model', link: '/concepts/security-model' },
          ],
        },
        {
          text: 'Architecture',
          items: [
            { text: 'System Overview', link: '/architecture/system-overview' },
            { text: 'Component Responsibilities', link: '/architecture/component-responsibilities' },
            { text: 'Core Flows', link: '/architecture/core-flows' },
            { text: 'Data Flow Security Model', link: '/architecture/data-flow-security-model' },
          ],
        },
      ],
      '/sdk/': [
        {
          text: 'SDK',
          items: [
            { text: 'Overview', link: '/sdk/overview' },
            { text: 'Quickstart', link: '/sdk/quick-start' },
            { text: 'Usage', link: '/sdk/usage' },
            { text: 'AI Integration', link: '/sdk/ai-integration' },
          ],
        },
        {
          text: 'Examples',
          items: [
            { text: 'Basic Usage', link: '/examples/basic-usage' },
            { text: 'Advanced Usage', link: '/examples/advanced-usage' },
            { text: 'Research App Example', link: '/examples/research-app-example' },
            { text: 'Example Map', link: '/examples/example-map' },
          ],
        },
      ],
      '/relayer/': [
        {
          text: 'Relayer',
          items: [
            { text: 'Overview', link: '/relayer/overview' },
            { text: 'Public Relayer', link: '/relayer/public-relayer' },
            { text: 'Installation and Setup', link: '/relayer/installation-and-setup' },
            { text: 'Operate Your Own Relayer', link: '/relayer/self-hosting' },
          ],
        },
      ],
      '/contract/': [
        {
          text: 'Smart Contract',
          items: [
            { text: 'Overview', link: '/contract/overview' },
            { text: 'Delegate Key Management', link: '/contract/delegate-key-management' },
            { text: 'Ownership and Permissions', link: '/contract/ownership-and-permissions' },
          ],
        },
      ],
      '/indexer/': [
        {
          text: 'Indexer',
          items: [
            { text: 'Purpose', link: '/indexer/purpose' },
            { text: 'Onchain Events', link: '/indexer/onchain-events' },
            { text: 'Database Sync', link: '/indexer/database-sync' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'SDK',
          items: [
            { text: 'Overview', link: '/sdk/overview' },
            { text: 'Quickstart', link: '/sdk/quick-start' },
            { text: 'Usage', link: '/sdk/usage' },
            { text: 'AI Integration', link: '/sdk/ai-integration' },
          ],
        },
        {
          text: 'Examples',
          items: [
            { text: 'Basic Usage', link: '/examples/basic-usage' },
            { text: 'Advanced Usage', link: '/examples/advanced-usage' },
            { text: 'Research App Example', link: '/examples/research-app-example' },
            { text: 'Example Map', link: '/examples/example-map' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'SDK API', link: '/reference/sdk-api' },
            { text: 'Relayer API', link: '/reference/relayer-api' },
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'Environment Variables', link: '/reference/environment-variables' },
          ],
        },
      ],
      '/contributing/': [
        {
          text: 'Local Development and Contributing',
          items: [
            { text: 'Run Docs Locally', link: '/contributing/run-docs-locally' },
            { text: 'Run the Repo Locally', link: '/contributing/run-repo-locally' },
            { text: 'Docs Workflow', link: '/contributing/docs-workflow' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/CommandOSSLabs/personal-data-wallet' },
    ],
    footer: {
      message: 'Released under the Apache 2.0 License.',
    },
  },
})
