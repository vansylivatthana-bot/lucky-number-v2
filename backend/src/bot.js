import { Telegraf, Markup } from 'telegraf';
import { normalizePositiveAmount, normalizeTicketNumber } from './validation.js';
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

  bot.command('topup', async (ctx) => {
    if (String(ctx.from.id) !== config.adminTelegramId) return ctx.reply('❌ ທ່ານບໍ່ມີສິດນຳໃຊ້ຄຳສັ່ງນີ້.');
    try {
      const [, targetId, rawAmount] = ctx.message.text.trim().split(/\s+/);
      if (!/^\d{5,20}$/.test(targetId || '')) throw new Error('TELEGRAM_ID_INVALID');
      const amount = normalizePositiveAmount(rawAmount);
      const { data, error } = await supabase.rpc('topup_wallet_v2', {
        p_admin_telegram_id: config.adminTelegramId,
        p_target_telegram_id: targetId,
        p_amount: amount
      });
      if (error) throw error;
      await ctx.reply(`✅ ເຕີມເງິນສຳເລັດ\nID: ${targetId}\nຈຳນວນ: ${amount} USDT\nBalance: ${data.balance} USDT`);
    } catch (error) {
      log('error', 'bot.topup.failed', { code: error.code, reason: error.message });
      await ctx.reply('⚠️ ຮູບແບບ: /topup [Telegram ID] [ຈຳນວນເງິນ]');
    }
  });

  bot.command('draw', async (ctx) => {
    if (String(ctx.from.id) !== config.adminTelegramId) return ctx.reply('❌ ທ່ານບໍ່ມີສິດນຳໃຊ້ຄຳສັ່ງນີ້.');
    try {
      const [, rawNumber] = ctx.message.text.trim().split(/\s+/);
      const winningNumber = normalizeTicketNumber(rawNumber);
      const { data, error } = await supabase.rpc('record_draw_v2', {
        p_admin_telegram_id: config.adminTelegramId,
        p_winning_number: winningNumber
      });
      if (error) throw error;
      for (const winner of data.winners || []) {
        await bot.telegram.sendMessage(winner.telegram_id, `🎉 ຊົມເຊີຍ! ໝາຍເລກ ${winningNumber} ຂອງທ່ານຖືກລາງວັນ.`).catch(() => {});
      }
      await ctx.reply(`✅ ບັນທຶກຜົນ ${winningNumber} ສຳເລັດ; ຜູ້ຊະນະ ${data.winner_count} ຄົນ.`);
    } catch (error) {
      log('error', 'bot.draw.failed', { code: error.code, reason: error.message });
      await ctx.reply('⚠️ ຮູບແບບ: /draw [ໝາຍເລກ 5 ຫຼັກ]');
    }
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
