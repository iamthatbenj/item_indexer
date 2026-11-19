import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@libsql/client", "pdfkit", "fontkit"],
  outputFileTracingIncludes: { "/collections/*/inventory/**": ["./assets/inventory-fonts/**/*"], "/collections/*/catalogue/**": ["./assets/inventory-fonts/**/*"], "/collections/*/archive/**": ["./assets/portable-archive/FORMAT.md", "./assets/portable-archive/verify.py"] },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "Cache-Control", value: "private, no-store" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'" },
    ] }];
  },
};

export default nextConfig;
