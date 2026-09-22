import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    // The only remote image Noter renders is the signed-in user's avatar, which
    // comes from the `picture` claim of a Google JWT (Google is the sole entry in
    // OAUTH_PROVIDERS). A wildcard here is not a convenience: `/_next/image`
    // fetches and decodes whatever host it is handed, unauthenticated, so
    // `hostname: "**"` let anyone feed the optimizer an arbitrary image —
    // GHSA-2xp9-vwfh-vxw4 turned that into remote code execution through the
    // AVIF path in sharp's libheif. Keep this list to hosts we actually serve
    // images from.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
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
