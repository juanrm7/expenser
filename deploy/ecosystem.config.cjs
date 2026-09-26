// pm2 process file for the droplet. Started/reloaded by deploy/deploy.sh:
//   pm2 startOrReload deploy/ecosystem.config.cjs --update-env
const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'expenser-backend',
      cwd: path.join(__dirname, '../apps/backend'),
      script: 'dist/server.js',
      // Runtime config (TURSO_*, PORT, WEBAPP_URL, cookie flags) lives in apps/backend/.env.
      // Variables set in `env` below take precedence over the file.
      node_args: '--env-file=.env',
      env: {
        NODE_ENV: 'production',
        // Only reachable through the nginx reverse proxy.
        HOST: '127.0.0.1',
      },
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '300M',
      time: true,
    },
  ],
}
