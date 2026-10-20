import { defineConfig } from "astro/config";

// SITE_URL / BASE_PATH are set by the deploy workflow (e.g. GitHub Pages project sites live under /<repo>/).
export default defineConfig({
  site: process.env.SITE_URL || "https://example.com",
  base: process.env.BASE_PATH || "/",
  trailingSlash: "ignore",
  build: { format: "directory" },
  devToolbar: { enabled: false },
});
