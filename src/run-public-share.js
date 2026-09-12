const { spawn } = require("node:child_process");
const process = require("node:process");
const localtunnel = require("localtunnel");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const APP_START_TIMEOUT_MS = 15000;

async function waitForApp() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < APP_START_TIMEOUT_MS) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // Keep polling until the child app becomes ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`App did not become ready on port ${PORT} within ${APP_START_TIMEOUT_MS}ms.`);
}

async function main() {
  const appProcess = spawn("node", ["src/app.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
    },
    stdio: "inherit",
  });

  let tunnel;

  const cleanup = async () => {
    if (tunnel) {
      await tunnel.close();
    }
    if (!appProcess.killed) {
      appProcess.kill("SIGTERM");
    }
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  appProcess.on("exit", async (code) => {
    if (tunnel) {
      await tunnel.close();
    }
    process.exit(code ?? 0);
  });

  await waitForApp();
  tunnel = await localtunnel({ port: PORT });

  console.log("");
  console.log(`Public app URL: ${tunnel.url}`);
  console.log(`Public registration URL: ${tunnel.url}/register`);
  console.log(`Public admin login URL: ${tunnel.url}/login`);
  console.log("Keep this command running while people are using the app.");

  tunnel.on("close", () => {
    console.log("Public tunnel closed.");
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
