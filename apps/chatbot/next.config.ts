import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  cacheComponents: true,
  images: {
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
      {
        protocol: "https",
        //https://nextjs.org/docs/messages/next-image-unconfigured-host
        hostname: "*.public.blob.vercel-storage.com",
      },
    ],
  },
};

// BotId is Vercel-only (requires OIDC token), skip on Railway/other platforms
const isVercel = !!process.env.VERCEL;
if (isVercel) {
  const { withBotId } = require("botid/next/config");
  module.exports = withBotId(nextConfig);
} else {
  module.exports = nextConfig;
}

export default nextConfig;

