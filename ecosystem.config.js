module.exports = {
  apps: [
    {
      name: 'satmat-backend',
      script: 'dist/main.js',
      cwd: __dirname,
      // ⚠️ SQLite is single-writer. NEVER run more than one instance: cluster
      // mode ('max') would open the same DB file from multiple processes and
      // cause SQLITE_BUSY errors / corruption. Keep instances: 1, exec_mode: fork.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '512M',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8080,
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
