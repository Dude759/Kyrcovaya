import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: loadEnv(mode, process.cwd(), "VITE_").VITE_BASE_PATH || "/",
  plugins: [react()],
  ...(mode === "server"
    ? { define: { "import.meta.env.VITE_API_MODE": JSON.stringify("http") } }
    : {}),
  server: {
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
}));
