const path = require("path");
const os = require("os");

const home = os.homedir();
const appName = process.env.TG_PM2_APP_NAME || "telegram-gateway";
const logDir = process.env.TG_LOG_DIR || path.join(home, ".claude", "logs", "telegram-gateway");

module.exports = {
  apps: [
    {
      name: appName,
      cwd: __dirname,
      script: "dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 20,
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      kill_timeout: 5000,
      merge_logs: true,
      time: true,
      out_file: path.join(logDir, "pm2-out.log"),
      error_file: path.join(logDir, "pm2-error.log"),
      log_file: path.join(logDir, "pm2-combined.log"),
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
      },
    },
  ],
};
