import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Enable the built-in instrumentation hook (instrumentation.ts) for OTel (O-01)
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
