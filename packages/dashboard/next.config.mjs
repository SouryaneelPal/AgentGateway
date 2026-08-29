/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // The gateway binds PORT (default 3000) on the host; the dashboard runs on 3002.
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:3000',
  },
};

export default nextConfig;
