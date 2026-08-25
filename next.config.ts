import type { NextConfig } from "next";
import path from "node:path";

/**
 * next.config is only used by the primary Next.js / Vercel path (`npm run build`).
 * vinext uses vite.config.ts instead, so it is safe to always shim
 * cloudflare:workers here for local + Vercel builds.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  webpack(config, { webpack }) {
    const shim = path.resolve(process.cwd(), "lib/persistence/cloudflare-workers-shim.ts");
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "cloudflare:workers": shim,
    };
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^cloudflare:workers$/, shim));
    return config;
  },
};

export default nextConfig;
