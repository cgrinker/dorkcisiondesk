import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Dev server proxies API calls to wrangler dev.
  server: {
    proxy: {
      "^/(summary|races|polls|history|meta|docs)": "http://localhost:8787",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
