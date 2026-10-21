import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  // Pages supplies its actual base: custom domains use /, project sites /<repo>/.
  base: mode === "production" ? process.env.VITE_BASE_PATH || "/" : "/",
  plugins: [react()],
  // The audio worker lazy-loads the AC-3 decoder, which needs code splitting.
  worker: { format: "es" },
  // Worker-only deps are otherwise discovered mid-upload, reloading the dev page.
  optimizeDeps: { include: ["mediabunny", "@mediabunny/ac3"] },
  server: {
    host: "127.0.0.1",
    port: 5188,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4318" },
  },
}));
