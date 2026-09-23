import crypto from 'node:crypto';

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function validateTelegramInitData(initData, botToken, options = {}) {
  if (!initData || typeof initData !== 'string') {
    throw new Error('TELEGRAM_INIT_DATA_MISSING');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('TELEGRAM_HASH_MISSING');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!timingSafeHexEqual(calculatedHash, receivedHash)) {
    throw new Error('TELEGRAM_SIGNATURE_INVALID');
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? 86400;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > maxAgeSeconds) {
    throw new Error('TELEGRAM_INIT_DATA_EXPIRED');
  }

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    throw new Error('TELEGRAM_USER_INVALID');
  }
  if (!user?.id) throw new Error('TELEGRAM_USER_MISSING');

  return {
    telegramId: String(user.id),
    firstName: String(user.first_name || ''),
    lastName: String(user.last_name || ''),
    username: String(user.username || ''),
    languageCode: String(user.language_code || '')
  };
}

export function createTelegramAuthMiddleware(config) {
  return (req, res, next) => {
    try {
      const initData = req.get('X-Telegram-Init-Data') || '';
      req.telegramUser = validateTelegramInitData(initData, config.botToken, {
        maxAgeSeconds: config.initDataMaxAgeSeconds
      });
      next();
    } catch (error) {
      res.status(401).json({ ok: false, error: error.message });
    }
  };
}

