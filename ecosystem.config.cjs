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
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
