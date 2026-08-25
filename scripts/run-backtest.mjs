import { createServer } from "vite";

const server = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true }, logLevel: "error" });
try {
  const module = await server.ssrLoadModule("/scripts/backtest.ts");
  const result = await module.main(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await server.close();
}
