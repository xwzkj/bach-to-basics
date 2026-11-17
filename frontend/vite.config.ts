import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const buildId = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) + "Z";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_BUILD__: JSON.stringify(buildId),
  },
  resolve: {
    alias: {
      "@bach-to-basics/shared": resolve(__dirname, "../shared/types/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@coderline/alphatab"],
    include: ["pixi.js"],
  },
});
