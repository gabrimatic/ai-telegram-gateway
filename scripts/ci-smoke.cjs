#!/usr/bin/env node

const path = require("path");

function load(relPath) {
  return require(path.join(__dirname, "..", relPath));
}

try {
  const configModule = load("dist/config.js");
  const pollerModule = load("dist/poller.js");
  const commandsModule = load("dist/commands.js");

  if (typeof configModule.loadConfig !== "function") {
    throw new Error("loadConfig export missing");
  }

  const cfg = configModule.loadConfig();
  if (!cfg || typeof cfg !== "object") {
    throw new Error("config did not load");
  }

  if (typeof pollerModule.createBot !== "function") {
    throw new Error("createBot export missing");
  }

  if (typeof commandsModule.handleCommand !== "function") {
    throw new Error("handleCommand export missing");
  }

  process.stdout.write("Smoke check passed\n");
} catch (error) {
  process.stderr.write(`Smoke check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
