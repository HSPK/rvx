import {defineConfig} from "vite";
import {fileURLToPath} from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./login", import.meta.url)),
  base: "/login/",
  build: {
    target: "es2022",
    outDir: fileURLToPath(new URL("./dist/login", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 2048,
  },
});
