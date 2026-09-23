const required = [
  'PUBLIC_BACKEND_URL',
  'FRONTEND_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_WEBHOOK_SECRET',
  'ADMIN_TELEGRAM_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
];

export function loadConfig(env = process.env) {
  const missing = required.filter((key) => !String(env[key] || '').trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const backendUrl = String(env.PUBLIC_BACKEND_URL).trim().replace(/\/$/, '');
  const frontendUrl = String(env.FRONTEND_URL).trim().replace(/\/$/, '');

  const webhookSecret = String(env.TELEGRAM_WEBHOOK_SECRET).trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16-256 characters using A-Z, a-z, 0-9, _ or -');
  }

  return Object.freeze({
    nodeEnv: String(env.NODE_ENV || 'production').trim(),
    port: Number(env.PORT || 10000),
    backendUrl,
    frontendUrl,
    botToken: String(env.TELEGRAM_BOT_TOKEN).trim(),
    botUsername: String(env.TELEGRAM_BOT_USERNAME).trim().replace(/^@/, ''),
    webhookSecret,
    channelUrl: String(env.TELEGRAM_CHANNEL_URL || '').trim(),
    adminTelegramId: String(env.ADMIN_TELEGRAM_ID).trim(),
    supabaseUrl: String(env.SUPABASE_URL).trim().replace(/\/$/, ''),
    supabaseServiceRoleKey: String(env.SUPABASE_SERVICE_ROLE_KEY).trim(),
    initDataMaxAgeSeconds: Number(env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS || 86400)
  });
}
