import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist", emptyOutDir: true },
  server: {
    port: 5173,
    // The trailing slash is necessary. Without it, the rule also matches the UI module /api.ts.
    proxy: { "/api/": `http://localhost:${process.env.PORT ?? 3000}` },
  },
});
