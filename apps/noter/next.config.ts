import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    // No remote hosts. `/_next/image` fetches and decodes whatever host it is
    // handed, unauthenticated, so `hostname: "**"` let anyone feed the optimizer
    // an arbitrary image — GHSA-2xp9-vwfh-vxw4 turned that into remote code
    // execution through the AVIF path in sharp's libheif.
    //
    // Noter renders no remote image today. `user.avatar` is displayed, but
    // nothing ever writes it: the Google JWT `picture` claim is declared in a
    // type and never read, and the profile-edit schema that accepts an avatar
    // URL is wired to nothing. An empty list is therefore both the tightest
    // setting and the one the code actually supports. If avatars are wired up
    // later, add the one host they come from here, not a wildcard.
    remotePatterns: [],
  },
  serverExternalPackages: [
    "@mysten-incubation/memwal",
    "@mysten/seal",
    "@mysten/walrus",
    "@mysten/sui",
  ],
};

export default nextConfig;
