import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Output goes to dist/. Whoever serves the app copies it where they need it: Tonoman Cloud
// builds this at a pinned ref and serves it from its own origin, and a self-hosted gateway
// can serve the same bundle itself. The app never assumes WHO is serving it — /api/config
// on that origin tells it which identity provider to use.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // getUserMedia needs a secure context. localhost qualifies, so dev over plain HTTP is
    // fine — but testing from a PHONE needs real HTTPS.
    host: true,
  },
});
