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
    // Tree-shake large barrel-export packages so only imported symbols land in
    // client bundles. Lucide ships 1,000+ icons as a single export — without
    // this every route that imports one icon pulls in all of them.
    optimizePackageImports: [
      "lucide-react",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-tabs",
      "@radix-ui/react-popover",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-accordion",
      "@radix-ui/react-checkbox",
    ],
  },
  images: {
    // SVG is intentionally excluded — use <img> tags for SVG assets to avoid XSS risk
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // Keep heavy server-only libraries out of the webpack bundle entirely.
  // These run in Node.js server routes and must not be included in client JS.
  serverExternalPackages: [
    "@xenova/transformers",
    "pdf-parse",
    "mammoth",
    "exceljs",
    "xlsx",
  ],
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
