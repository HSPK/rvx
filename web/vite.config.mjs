import {defineConfig} from "vite";

/** Match the native login route before Vite's application fallback, including return-path queries. */
function loginRoute(request, _response, next) {
  if (/^\/login(?:\?|$)/.test(request.url ?? "")) request.url = request.url.replace(/^\/login/, "/login/");
  next();
}

export default defineConfig({
  plugins: [{
    name: "rvx-login-route",
    configureServer(server) {server.middlewares.use(loginRoute);},
    configurePreviewServer(server) {server.middlewares.use(loginRoute);},
  }],
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
      "/api": {target: "http://127.0.0.1:9110", changeOrigin: false},
    },
  },
});
