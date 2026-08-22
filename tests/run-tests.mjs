import { createServer } from "vite";

const server = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true }, logLevel: "error" });
try {
  await server.ssrLoadModule("/tests/workbench.test.ts");
} finally {
  await server.close();
}

