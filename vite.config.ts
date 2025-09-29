import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: base must match your GitHub Pages repo name
export default defineConfig({
  plugins: [react()],
  base: "/phone-check/",  // <-- ensures assets resolve on school120.github.io/phone-check/
});
