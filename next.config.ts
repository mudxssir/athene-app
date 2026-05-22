import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // 'unsafe-eval' is required by Clerk's iframe SDK in local dev only.
      // Strip it in production to block XSS code-injection attacks.
      process.env.NODE_ENV === "production"
        ? "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.clerk.dev https://*.clerk.accounts.dev https://*.nango.dev",
      "frame-src 'self' https://*.nango.dev",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Cap incoming request body at 4 MB.
  // Without this Next.js has no built-in body size limit, so a single
  // authenticated request could send an arbitrarily large payload and exhaust
  // serverless function memory. Files are uploaded via multipart to /api/files/upload
  // which streams directly to Supabase Storage; 4 MB covers all JSON API routes.
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  images: {
    // SVG is intentionally excluded — use <img> tags for SVG assets to avoid XSS risk
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // Allow @xenova/transformers to run in the Node.js server runtime
  // without being bundled by webpack (it uses dynamic requires + FS access)
  serverExternalPackages: ["@xenova/transformers"],
  webpack: (config) => {
    // Prevent webpack from trying to bundle ONNX .wasm files
    config.resolve.alias = {
      ...config.resolve.alias,
      "sharp$": false,
      "onnxruntime-node$": false,
    };
    return config;
  },
};

export default nextConfig;
