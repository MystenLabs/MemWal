import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "MemWal",
  tagline:
    "Privacy-preserving decentralized memory protocol for humans and AI agents",
  favicon: "img/favicon.ico",
  url: "https://memwal.dev",
  baseUrl: "/",
  organizationName: "CommandOSSLabs",
  projectName: "personal-data-wallet",
  onBrokenLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  markdown: {
    mermaid: true,
  },
  themes: ["@docusaurus/theme-mermaid"],

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl:
            "https://github.com/CommandOSSLabs/personal-data-wallet/tree/main/docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    announcementBar: {
      id: 'beta',
      content: '<strong>MemWal is in active beta.</strong> APIs and features may evolve between releases.',
      backgroundColor: '#98efe4',
      textColor: '#191a23',
      isCloseable: false,
    },
    navbar: {
      title: "MemWal",
      items: [
        {
          href: "https://github.com/CommandOSSLabs/personal-data-wallet",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "light",
      copyright: "Released under the Apache 2.0 License.",
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "typescript"],
    },
    mermaid: {
      theme: { light: "neutral", dark: "dark" },
      options: {
        fontSize: 18,
        flowchart: {
          nodeSpacing: 40,
          rankSpacing: 55,
          padding: 18,
          useMaxWidth: true,
        },
        sequence: {
          diagramMarginX: 30,
          diagramMarginY: 20,
          actorMargin: 60,
          width: 180,
          height: 70,
          boxMargin: 12,
          boxTextMargin: 8,
          noteMargin: 12,
          messageMargin: 40,
        },
      },
    },
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
