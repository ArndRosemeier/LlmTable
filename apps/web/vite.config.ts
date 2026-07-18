import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@llm-table/shared": path.resolve(__dirname, "../../shared/src/index.ts"),
      "@llm-table/conversation": path.resolve(
        __dirname,
        "../../modules/conversation/src/index.ts",
      ),
      "@llm-table/poker": path.resolve(__dirname, "../../modules/poker/src/index.ts"),
      "@llm-table/rpg": path.resolve(__dirname, "../../modules/rpg/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
