/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7865",
      "/v1": "http://127.0.0.1:7865"
    }
  },
  test: {
    setupFiles: ["./test/helpers/server-test-hooks.ts"],
    include: [
      "test/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "test/**/*.scenarios.ts"
    ]
  }
});
