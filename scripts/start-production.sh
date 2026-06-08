#!/bin/bash
# Production entry point — runs the Discord bot directly.
# A minimal HTTP server on $PORT handles health checks so Replit
# can verify the process is alive (ping this with UptimeRobot).

PORT="${PORT:-8080}"

node -e "
const http = require('http');
http.createServer((req, res) => {
  const ok = req.url === '/healthz' || req.url === '/api/healthz';
  res.writeHead(ok ? 200 : 404);
  res.end(ok ? 'ok' : 'not found');
}).listen($PORT, () => console.log('[health] listening on port $PORT'));
" &

exec pnpm --filter @workspace/discord-bot run start
