import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: "doc",
      id: "index",
      label: "Overview",
    },
    {
      type: "category",
      label: "Getting Started",
      collapsed: false,
      items: [
        "getting-started/what-is-memwal",
        "getting-started/core-components",
        "getting-started/for-developers",
        "getting-started/installation",
        "getting-started/choose-your-path",
      ],
    },
    {
      type: "category",
      label: "Concepts",
      collapsed: false,
      items: [
        "concepts/explaining-memwal",
        "concepts/storage-structure",
        "concepts/namespace",
        "concepts/ownership-and-access",
        "concepts/security-model",
      ],
    },
    {
      type: "category",
      label: "Architecture",
      collapsed: false,
      items: [
        "concepts/system-overview",
        "concepts/component-responsibilities",
        "concepts/core-flows",
        "concepts/data-flow-security-model",
      ],
    },
    {
      type: "category",
      label: "SDK",
      collapsed: false,
      items: [
        "sdk/overview",
        "sdk/quick-start",
        "sdk/usage",
        "sdk/ai-integration",
        "sdk/basic-usage",
        "sdk/advanced-usage",
        "sdk/research-app-example",
        "sdk/example-map",
      ],
    },
    {
      type: "category",
      label: "Relayer",
      collapsed: false,
      items: [
        "relayer/overview",
        "relayer/public-relayer",
        "relayer/installation-and-setup",
        "relayer/self-hosting",
      ],
    },
    {
      type: "category",
      label: "Smart Contract",
      collapsed: false,
      items: [
        "contract/overview",
        "contract/delegate-key-management",
        "contract/ownership-and-permissions",
      ],
    },
    {
      type: "category",
      label: "Indexer",
      collapsed: false,
      items: [
        "indexer/purpose",
        "indexer/onchain-events",
        "indexer/database-sync",
      ],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: [
        "reference/sdk-api",
        "reference/relayer-api",
        "reference/configuration",
        "reference/environment-variables",
      ],
    },
    {
      type: "category",
      label: "Contributing",
      collapsed: true,
      items: [
        "contributing/run-docs-locally",
        "contributing/run-repo-locally",
        "contributing/docs-workflow",
      ],
    },
  ],
};

export default sidebars;
