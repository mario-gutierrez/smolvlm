import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

const REPO_NAME ='/smolvlm/'
// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: REPO_NAME,
  build: {
    target: 'esnext' // WebGPU requires modern browser support
  },
  worker: {
    format: 'es' // Ensure workers are bundled as ES modules
  }
});
