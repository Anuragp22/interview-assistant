import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin the file-tracing root to this project. Without it, Next.js walks up
  // looking for a lockfile and may pick a stray pnpm-lock.yaml in the user's
  // home directory as the workspace root, which breaks output tracing.
  outputFileTracingRoot: path.join(__dirname),

  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
