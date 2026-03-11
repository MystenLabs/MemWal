import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  serverExternalPackages: [
    "@cmdoss/memwal-v2",
    "@mysten/seal",
    "@mysten/walrus",
    "@mysten/sui",
  ],
};

export default nextConfig;
