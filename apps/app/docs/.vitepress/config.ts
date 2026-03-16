import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'MemWal',
  description: 'Privacy-preserving AI memory for agents',
  base: '/docs/',
  outDir: './public/docs',
  cleanUrls: false,
  themeConfig: {
    siteTitle: 'MemWal',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Examples', link: '/examples/basic-usage' },
      { text: 'API Reference', link: '/api/reference' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Basic Usage', link: '/examples/basic-usage' },
            { text: 'Advanced', link: '/examples/advanced' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Reference', link: '/api/reference' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/CommandOSSLabs/personal-data-wallet' },
    ],
    footer: {
      message: 'Released under the Apache 2.0 License.',
      copyright: 'Copyright © 2026 CommandOSS Labs',
    },
  },
})
