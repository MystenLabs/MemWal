import type { SuiCodegenConfig } from '@mysten/codegen';

const config: SuiCodegenConfig = {
  output: './src/generated',
  generateSummaries: false,
  prune: true,
  packages: [
    {
      package: '@local-pkg/pdw',
      path: '../../smart-contract',
    },
  ],
};

export default config;