import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The invitation token is in the URL, so the page must not leak it in a Referer header.
  async headers() {
    return [
      {
        source: "/invitations/accept",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
