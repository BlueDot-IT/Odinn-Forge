import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root,
  base: "/console/",
  publicDir: false,
  build: {
    outDir: resolve(root, "../../../public/console"),
    emptyOutDir: true,
    manifest: "manifest.json",
    minify: false,
    cssMinify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js"
      }
    }
  }
});
