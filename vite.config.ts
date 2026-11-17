import { defineConfig } from "vite";

// The web app is index.html; the browser extension (extension/) is built separately by scripts/build-extension.ts.
export default defineConfig({
  optimizeDeps: { entries: ["index.html"] },
  build: { rollupOptions: { input: "index.html" } },
});
