// pm2 process file for the droplet. (Re)started by deploy/deploy.sh:
//   pm2 start deploy/ecosystem.config.cjs
const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'expenser-backend',
      cwd: path.join(__dirname, '../apps/backend'),
      // The release binary built by deploy.sh. It reads its runtime config (TURSO_*, PORT,
      // WEBAPP_URL, cookie flags) from apps/backend/.env itself; variables set in `env` below
      // take precedence over the file.
      script: 'target/release/expenser-backend',
      interpreter: 'none',
      env: {
        // Only reachable through the nginx reverse proxy.
        HOST: '127.0.0.1',
      },
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '300M',
    },
  ],
}
