import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@llm-table/shared": path.resolve(__dirname, "../../shared/src/index.ts"),
      "@llm-table/poker": path.resolve(__dirname, "../../modules/poker/src/index.ts"),
      "@llm-table/rpg": path.resolve(__dirname, "../../modules/rpg/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});
