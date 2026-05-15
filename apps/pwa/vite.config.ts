import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "");

  return {
    envDir: "../..",
    define: {
      __DEBUG_MODE__: JSON.stringify(env.DEBUG_MODE === "true"),
    },
    plugins: [react()],
  };
});
