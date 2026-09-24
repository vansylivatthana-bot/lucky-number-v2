import { Telegraf, Markup } from 'telegraf';
import { log } from './logger.js';

export function createBot({ config, supabase, botStatus }) {
  const bot = new Telegraf(config.botToken);

  bot.start(async (ctx) => {
    const telegramId = String(ctx.from.id);
    const requestedReferrerId = /^\d{5,20}$/.test(ctx.startPayload || '') && ctx.startPayload !== telegramId
      ? ctx.startPayload
      : null;

    let referrerId = null;
    if (requestedReferrerId) {
      const referrerResult = await supabase
        .from('users_v2')
        .select('telegram_id')
        .eq('telegram_id', requestedReferrerId)
        .maybeSingle();
      if (!referrerResult.error && referrerResult.data) referrerId = requestedReferrerId;
    }

    const newUser = {
      telegram_id: telegramId,
      first_name: ctx.from.first_name || null,
      username: ctx.from.username || null,
      ...(referrerId ? { referrer_id: referrerId } : {})
    };
    const insertResult = await supabase.from('users_v2').upsert(newUser, {
      onConflict: 'telegram_id',
      ignoreDuplicates: true
    });
    const profileResult = await supabase.from('users_v2').update({
      first_name: ctx.from.first_name || null,
      username: ctx.from.username || null,
      updated_at: new Date().toISOString()
    }).eq('telegram_id', telegramId);
    const error = insertResult.error || profileResult.error;

    if (error) {
      log('error', 'bot.start.upsert_failed', { code: error.code, message: error.message });
      return ctx.reply('❌ ລະບົບຖານຂໍ້ມູນຂັດຂ້ອງຊົ່ວຄາວ.');
    }

    const referralLink = `https://t.me/${config.botUsername}?start=${telegramId}`;
    const channelText = config.channelUrl ? `\n📢 Channel: ${config.channelUrl}` : '';
    await ctx.reply(
      `ຍິນດີຕ້ອນຮັບສູ່ Lucky Number VIP 🎉${channelText}\n\n🤝 Link ແນະນຳຂອງທ່ານ:\n${referralLink}`,
      Markup.keyboard([[Markup.button.webApp('📲 ເປີດແອັບຊື້ຕົວເລກ', config.frontendUrl)]]).resize()
    );
  });

  bot.catch((error) => log('error', 'bot.update.failed', { message: error.message }));

  async function configureWebhook() {
    try {
      const identity = await bot.telegram.getMe();
      if (identity.username.toLowerCase() !== config.botUsername.toLowerCase()) {
        throw new Error(`BOT_USERNAME_MISMATCH:${identity.username}`);
      }
      await bot.telegram.setWebhook(`${config.backendUrl}/telegram/webhook`, {
        allowed_updates: ['message'],
        secret_token: config.webhookSecret
      });
      botStatus.webhookReady = true;
      log('info', 'telegram.webhook.ready', { botId: identity.id, username: identity.username });
    } catch (error) {
      botStatus.webhookReady = false;
      log('error', 'telegram.webhook.failed', { code: error.response?.error_code, message: error.response?.description || error.message });
    }
  }

  return { bot, configureWebhook };
}
