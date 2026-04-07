import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const daemonUrl = process.env.OPENRIG_URL ?? process.env.RIGGED_URL ?? "http://localhost:7433";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: daemonUrl,
        changeOrigin: true,
      },
      "/healthz": {
        target: daemonUrl,
        changeOrigin: true,
      },
    },
  },
});
