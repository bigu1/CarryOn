import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.XUSHANG_PORT ?? 43173);

export default defineConfig({
  plugins: [react()],
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${port}`,
    },
  },
});
