import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/feedback_cycle_playground/",
  plugins: [react()]
});
