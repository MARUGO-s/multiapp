import { createServer } from "vite";

// Install before Vite's HTML fallback: otherwise a supposed fixture silently
// mounts the normal app (including its network/bootstrap code).
export async function offlineBrowserFixture(port, title) {
  const server = await createServer({
    plugins: [
      {
        name: "synthetic-offline-fixture",
        configureServer(vite) {
          vite.middlewares.use("/offline-fixture", (_request, response) => {
            response.setHeader("Content-Type", "text/html;charset=utf-8");
            response.end(
              `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>SYNTHETIC LOCAL FIXTURE — no device microphone / no live API / no AI</h1>`,
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  });
  await server.listen();
  return server;
}

export async function localOnlyPage(browser) {
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  return context.newPage();
}
