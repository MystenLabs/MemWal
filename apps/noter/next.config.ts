import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  serverExternalPackages: [
    "@mysten-incubation/memwal",
    "@mysten/seal",
    "@mysten/walrus",
    "@mysten/sui",
  ],
};

export default nextConfig;
