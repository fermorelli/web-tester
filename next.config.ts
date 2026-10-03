import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["cheerio", "lighthouse", "chrome-launcher"],
  poweredByHeader: false,
};
export default config;
