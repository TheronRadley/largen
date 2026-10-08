/**
 * Entry point: `npm start`. Loads .env (if present), validates config, starts the HTTP server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configWarnings, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader so there is no dotenv dependency. Existing env vars win. */
export function loadDotEnv(file = path.resolve(here, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

async function main() {
  loadDotEnv();
  const config = loadConfig(process.env);
  const logger = createLogger({ debug: config.debug });

  for (const w of configWarnings(config)) logger.warn(w);

  const { server } = await createApp({ config, logger });
  server.listen(config.port, config.host, () => {
    logger.info(`Largen is running on http://localhost:${config.port} (bound to ${config.host})`);
    logger.info(`AI provider: ${config.ai.provider}${config.ai.provider === 'none' ? '' : ` (${config.ai.model})`} · Search provider: ${config.search.provider}`);
    if (config.debug) logger.info('Debug logging is ON');
  });

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Largen could not start: ${err.message}`);
    process.exit(1);
  });
}
