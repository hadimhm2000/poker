import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Static security headers. The Content-Security-Policy (with a per-request nonce) is set in
// src/proxy.ts because it has to change on every request.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // No X-Frame-Options: the CSP frame-ancestors in src/proxy.ts allows only Telegram Web
  // (for the Mini App) and replaces it in every current browser.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

// Next 16 blocks dev resources (HMR, client chunks) for any host other than localhost, so a page
// opened at http://127.0.0.1:3100 or a LAN address renders but never becomes interactive (side pot
// calculator, language switcher...). Extra dev hosts can be added with DEV_ORIGINS=192.168.1.20,mypc.local
const devOrigins = ["127.0.0.1", "[::1]", ...(process.env.DEV_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean)];

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  transpilePackages: ["@poker/domain", "@poker/db"],
  serverExternalPackages: ["@node-rs/argon2", "@resvg/resvg-js", "postgres", "exceljs", "playwright-core"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
