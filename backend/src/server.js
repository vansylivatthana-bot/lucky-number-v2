import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createBot } from './bot.js';
import { log } from './logger.js';

try {
  const config = loadConfig();
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const botStatus = { webhookReady: false };
  const { bot, configureWebhook } = createBot({ config, supabase, botStatus });
  const app = createApp({ config, supabase, botStatus, bot });

  const server = app.listen(config.port, '0.0.0.0', () => {
    log('info', 'server.started', { port: config.port, environment: config.nodeEnv });
    void configureWebhook();
  });

  const shutdown = (signal) => {
    log('info', 'server.shutdown', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  log('error', 'server.start_failed', { message: error.message });
  process.exit(1);
}
