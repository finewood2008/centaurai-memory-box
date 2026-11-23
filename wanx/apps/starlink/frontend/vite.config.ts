import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { workbench: "index.html", "starxiaotu-ontology": "src/ontologyDialogue.ts" },
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: chunk => chunk.name === "starxiaotu-ontology" ? "starxiaotu-ontology.mjs" : "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8090" },
  },
});
