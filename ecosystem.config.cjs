module.exports = {
  apps: [
    {
      name: "inistate-mcp",
      cwd: __dirname,
      script: "build/http.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
  deploy: {},
  module_conf: {
    "pm2-logrotate": {
      max_size: "10M",
      retain: "7",
      compress: true,
      dateFormat: "YYYY-MM-DD_HH-mm-ss",
      workerInterval: "3600",
      rotateInterval: "0 0 * * *",
    },
  },
};
