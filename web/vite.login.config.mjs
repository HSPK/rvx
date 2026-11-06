import {defineConfig} from "vite";
import {fileURLToPath} from "node:url";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("./login", import.meta.url)),
  base: "/login/",
  resolve: {alias: {"@": fileURLToPath(new URL("./src", import.meta.url))}},
  plugins: [tailwindcss()],
  build: {
    target: "es2022",
    outDir: fileURLToPath(new URL("./dist/login", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 2048,
  },
});
