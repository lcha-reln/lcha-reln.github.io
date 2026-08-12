import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://lcha-reln.github.io",
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
  prerenderConflictBehavior: "error",
  vite: {
    build: {
      // Mermaid 的可选图表引擎会被拆成按需加载的独立 chunk。
      chunkSizeWarningLimit: 700,
    },
  },
  integrations: [sitemap()],
  markdown: {
    syntaxHighlight: {
      type: "shiki",
      excludeLangs: ["mermaid", "math"],
    },
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "vesper",
      },
      wrap: false,
    },
  },
});
