import {defineConfig} from "vite";

export default defineConfig({
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    assetsInlineLimit: 2048,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:9110",
      "/hostmon": "http://127.0.0.1:9110",
    },
  },
});
