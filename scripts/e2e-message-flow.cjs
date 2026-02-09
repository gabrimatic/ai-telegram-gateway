#!/usr/bin/env node
"use strict";

const path = require("path");
const dotenv = require("dotenv");

const projectRoot = path.join(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const { loadConfig } = require(path.join(projectRoot, "dist", "config"));
const { loadAllowlist } = require(path.join(projectRoot, "dist", "storage"));
const { createBot } = require(path.join(projectRoot, "dist", "poller"));

async function main() {
  loadConfig();

  const token = process.env.TELEGRAM_BOT_TOKEN || "000000:offline";
  const allowlist = await loadAllowlist();
  const firstUser = allowlist.allowedUsers?.[0];

  if (!firstUser) {
    throw new Error("allowlist has no users (cannot construct authorized test message)");
  }

  const userId = Number(firstUser);
  if (!Number.isFinite(userId)) {
    throw new Error(`allowlist user id is not numeric: ${firstUser}`);
  }

  const bot = await createBot(token, {
    skipSetMyCommands: true,
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "GatewayE2E",
      username: "gateway_e2e_bot",
    },
  });
  const captured = [];
  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === "sendMessage") {
      captured.push(String(payload?.text ?? ""));
    }
    return result;
  });
  await bot.init();

  const update = {
    update_id: Date.now(),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      text: "/stats",
      entities: [{ offset: 0, length: 6, type: "bot_command" }],
      chat: { id: userId, type: "private" },
      from: {
        id: userId,
        is_bot: false,
        first_name: "E2E",
        username: "e2e_runner",
      },
    },
  };

  await bot.handleUpdate(update);

  const fullText = captured.join("\n");
  const expectedMarker = "Messages:";

  if (!fullText.includes(expectedMarker)) {
    throw new Error(
      `expected output marker missing: ${expectedMarker}; captured=${JSON.stringify(captured)}`
    );
  }

  process.stdout.write(
    `[e2e-message] ok input=/stats output_marker='${expectedMarker}' replies=${captured.length}\n`
  );
}

main().catch((err) => {
  process.stderr.write(
    `[e2e-message] failed: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
