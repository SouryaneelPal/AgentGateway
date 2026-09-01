/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
   * The dev-tools badge defaults to bottom-left, which is exactly where the sidebar's
   * theme toggle sits — it covered the control outright during `next dev`. Moved rather
   * than switched off: the badge is genuinely useful while developing, and it does not
   * ship in `next build` anyway. This only matters for a demo recorded off the dev server.
   */
  devIndicators: { position: 'bottom-right' },
  env: {
    // The gateway binds PORT (default 3000) on the host; the dashboard runs on 3002.
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:3000',
  },
};

export default nextConfig;
