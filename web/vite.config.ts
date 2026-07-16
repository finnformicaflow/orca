import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { API_PORT } from "../server/ports";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: Number(process.env.ORCA_UI_PORT ?? 8788),
    // HTTP /api only. The interactive terminal's WebSocket does NOT go through here: Vite runs under
    // Bun (the Node-is-blocked rule), and Bun's proxy doesn't complete WS upgrades, so the terminal
    // connects straight to the bridge port instead (see Terminal.tsx / apiPort in /api/config).
    proxy: { "/api": `http://localhost:${API_PORT}` },
  },
});
