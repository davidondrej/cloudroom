import { readFileSync } from "fs";
import path from "path";
import { defineConfig, parseSync, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveCurrentDevInstanceConfig } from "@cloudroom/config/runtime";
import { sharedUiEnvSeam } from "../vite-shared-ui-seam.js";

const repoRoot = path.resolve(__dirname, "../../..");
const devInstance = resolveCurrentDevInstanceConfig(repoRoot);
const trustedDevAppHeaders = {
  origin: devInstance.serverUrl,
};

const stories = (): Plugin => ({
  name: "stories",
  configureServer(server) {
    server.watcher.add([
      path.resolve(__dirname, "../src"),
      path.resolve(__dirname, "../../../plugins"),
    ]);
  },
  load(id) {
    const [file, query] = id.split("?");
    if (!file || query !== "names") return;
    const { program, module } = parseSync(file, readFileSync(file, "utf8"));
    const title = program.body
      .flatMap((node) =>
        node.type === "ExportDefaultDeclaration" &&
        node.declaration.type === "ObjectExpression"
          ? node.declaration.properties
          : [],
      )
      .flatMap((property) =>
        property.type === "Property" &&
        property.key.type === "Identifier" &&
        property.key.name === "title" &&
        property.value.type === "Literal" &&
        typeof property.value.value === "string"
          ? [property.value.value]
          : [],
      )[0];
    const names = module.staticExports
      .flatMap((statement) => statement.entries)
      .flatMap((entry) =>
        entry.exportName.kind === "Name" &&
        entry.exportName.name &&
        !entry.isType
          ? [entry.exportName.name]
          : [],
      );
    return `export default ${JSON.stringify({ title, names })}`;
  },
});

export default defineConfig({
  root: __dirname,
  publicDir: "../public",
  plugins: [stories(), sharedUiEnvSeam(), react(), tailwindcss()],
  cacheDir: "../node_modules/.vite/ladle",
  build: {
    outDir: "../build",
    emptyOutDir: true,
    target: "esnext",
  },
  worker: {
    format: "es",
  },
  resolve: {
    conditions: ["source"],
    dedupe: ["react", "react-dom"],
    alias: {
      "@get-bb/plugin-sdk/app": path.resolve(__dirname, "./plugin-sdk-app.ts"),
      "@": path.resolve(__dirname, "../src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 61000,
    allowedHosts: [".cloudroom.run"],
    proxy: {
      "/api": {
        target: devInstance.serverUrl,
        changeOrigin: true,
        headers: trustedDevAppHeaders,
      },
      "/ws": {
        target: devInstance.serverUrl,
        changeOrigin: true,
        ws: true,
        headers: trustedDevAppHeaders,
      },
    },
  },
});
