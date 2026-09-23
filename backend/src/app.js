import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { createTelegramAuthMiddleware } from './telegram-auth.js';
import { normalizePositiveAmount, normalizeTicketNumber } from './validation.js';
import { log } from './logger.js';

export function createApp({ config, supabase, botStatus, bot }) {
  const app = express();
  const requireTelegram = createTelegramAuthMiddleware(config);

  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({ origin: config.frontendUrl, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data'] }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/', (_req, res) => res.json({ service: 'lucky-number-v2', status: 'running' }));
  app.get('/health/live', (_req, res) => res.json({ ok: true }));
  app.get('/health/ready', async (_req, res) => {
    const { error } = await supabase.from('users_v2').select('telegram_id', { head: true, count: 'exact' }).limit(1);
    const ready = !error && botStatus.webhookReady;
    res.status(ready ? 200 : 503).json({ ok: ready, database: !error, telegram: botStatus.webhookReady });
  });

  // This endpoint intentionally exposes only a proof after the database has
  // settled the round. It never returns Telegram IDs or wallet information.
  app.get('/api/draws/:roundCode/proof', async (req, res) => {
    const roundCode = String(req.params.roundCode || '').trim();
    if (!/^DR-\d{4}-\d{2}-\d{3}$/.test(roundCode)) {
      return res.status(400).json({ ok: false, error: 'ROUND_CODE_INVALID' });
    }

    try {
      const { data: round, error: roundError } = await supabase
        .from('monthly_draw_rounds_v3')
        .select('id,round_code,rules_version,status,ticket_price,locked_at,drawn_at,settled_at')
        .eq('round_code', roundCode)
        .maybeSingle();
      if (roundError) throw roundError;
      if (!round || round.status !== 'SETTLED') {
        return res.status(404).json({ ok: false, error: 'DRAW_PROOF_NOT_PUBLISHED' });
      }

      const [proofResult, snapshotResult, winnersResult] = await Promise.all([
        supabase
          .from('draw_proofs_v3')
          .select('ticket_snapshot_hash,server_secret_commitment,public_entropy_source,public_entropy_reference,public_entropy_value,revealed_server_secret,derived_seed_hash,algorithm_version,committed_at,revealed_at,published_at')
          .eq('draw_round_id', round.id)
          .not('published_at', 'is', null)
          .maybeSingle(),
        supabase
          .from('draw_ticket_snapshot_items_v3')
          .select('ticket_id,ticket_number,public_participant_id')
          .eq('draw_round_id', round.id)
          .order('ticket_id', { ascending: true }),
        supabase
          .from('draw_winners_v3')
          .select('ticket_id,prize_tier,rank_in_tier,amount,paid_at')
          .eq('draw_round_id', round.id)
          .order('prize_tier', { ascending: true })
          .order('rank_in_tier', { ascending: true })
      ]);

      const firstError = [proofResult.error, snapshotResult.error, winnersResult.error].find(Boolean);
      if (firstError) throw firstError;
      if (!proofResult.data || !proofResult.data.revealed_server_secret) {
        return res.status(404).json({ ok: false, error: 'DRAW_PROOF_NOT_PUBLISHED' });
      }

      const snapshots = snapshotResult.data || [];
      const snapshotByTicket = new Map(snapshots.map((ticket) => [ticket.ticket_id, ticket]));
      const winners = (winnersResult.data || []).map((winner) => {
        const ticket = snapshotByTicket.get(winner.ticket_id);
        if (!ticket) throw new Error('DRAW_PROOF_SNAPSHOT_MISMATCH');
        return {
          ticketNumber: ticket.ticket_number,
          participantId: ticket.public_participant_id,
          tier: winner.prize_tier,
          rankInTier: winner.rank_in_tier,
          amount: Number(winner.amount),
          paidAt: winner.paid_at
        };
      });

      res.json({
        ok: true,
        round: {
          code: round.round_code,
          rulesVersion: round.rules_version,
          status: round.status,
          ticketPrice: Number(round.ticket_price),
          lockedAt: round.locked_at,
          drawnAt: round.drawn_at,
          settledAt: round.settled_at
        },
        proof: {
          snapshotHash: proofResult.data.ticket_snapshot_hash,
          serverSecretCommitment: proofResult.data.server_secret_commitment,
          publicEntropySource: proofResult.data.public_entropy_source,
          publicEntropyReference: proofResult.data.public_entropy_reference,
          publicEntropyValue: proofResult.data.public_entropy_value,
          revealedServerSecret: proofResult.data.revealed_server_secret,
          derivedSeedHash: proofResult.data.derived_seed_hash,
          algorithmVersion: proofResult.data.algorithm_version,
          committedAt: proofResult.data.committed_at,
          revealedAt: proofResult.data.revealed_at,
          publishedAt: proofResult.data.published_at
        },
        snapshot: snapshots.map((ticket) => ({
          ticketId: ticket.ticket_id,
          ticketNumber: ticket.ticket_number,
          participantId: ticket.public_participant_id
        })),
        winners
      });
    } catch (error) {
      log('error', 'draw.proof.failed', { code: error.code, message: error.message });
      res.status(503).json({ ok: false, error: 'DRAW_PROOF_UNAVAILABLE' });
    }
  });

  app.get('/api/me', requireTelegram, async (req, res) => {
    const id = req.telegramUser.telegramId;
    const [userResult, ticketResult, friendResult, statsResult] = await Promise.all([
      supabase.from('users_v2').select('telegram_id,wallet_balance,referrer_id').eq('telegram_id', id).maybeSingle(),
      supabase.from('tickets_v2').select('ticket_number,booked_at').eq('owner_telegram_id', id).eq('week_start', currentWeekStart()),
      supabase.from('users_v2').select('telegram_id', { count: 'exact', head: true }).eq('referrer_id', id),
      supabase.from('tickets_v2').select('id', { count: 'exact', head: true }).eq('week_start', currentWeekStart())
    ]);

    const firstError = [userResult.error, ticketResult.error, friendResult.error, statsResult.error].find(Boolean);
    if (firstError) {
      log('error', 'api.me.failed', { code: firstError.code, message: firstError.message });
      return res.status(503).json({ ok: false, error: 'DATABASE_QUERY_FAILED' });
    }

    const totalTickets = statsResult.count || 0;
    const prizeFund = totalTickets * 5 * 0.8;
    res.json({
      ok: true,
      user: {
        telegramId: id,
        firstName: req.telegramUser.firstName,
        balance: Number(userResult.data?.wallet_balance || 0)
      },
      friendsCount: friendResult.count || 0,
      tickets: ticketResult.data || [],
      prizes: {
        prize1: round2(prizeFund * 0.3),
        prize2Each: round2((prizeFund * 0.2) / 3),
        prize3Each: round2((prizeFund * 0.4) / 23)
      }
    });
  });

  app.post('/api/tickets/purchase', requireTelegram, async (req, res) => {
    try {
      const ticketNumber = normalizeTicketNumber(req.body?.ticketNumber);
      const { data, error } = await supabase.rpc('purchase_ticket_v2', {
        p_telegram_id: req.telegramUser.telegramId,
        p_ticket_number: ticketNumber
      });
      if (error) throw error;
      res.status(201).json({ ok: true, purchase: data });
    } catch (error) {
      const known = String(error.message || '').match(/(SALES_CLOSED|USER_NOT_FOUND|INSUFFICIENT_BALANCE|TICKET_ALREADY_SOLD|TICKET_NUMBER_INVALID)/)?.[1];
      log('error', 'ticket.purchase.failed', { code: error.code, reason: known || 'PURCHASE_FAILED' });
      res.status(known ? 409 : 503).json({ ok: false, error: known || 'PURCHASE_FAILED' });
    }
  });

  app.post('/internal/admin/topup', requireTelegram, async (req, res) => {
    if (req.telegramUser.telegramId !== config.adminTelegramId) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    try {
      const amount = normalizePositiveAmount(req.body?.amount);
      const targetId = String(req.body?.telegramId || '').trim();
      if (!/^\d{5,20}$/.test(targetId)) throw new Error('TELEGRAM_ID_INVALID');
      const { data, error } = await supabase.rpc('topup_wallet_v2', {
        p_admin_telegram_id: req.telegramUser.telegramId,
        p_target_telegram_id: targetId,
        p_amount: amount
      });
      if (error) throw error;
      res.json({ ok: true, result: data });
    } catch (error) {
      log('error', 'admin.topup.failed', { code: error.code, reason: error.message });
      res.status(400).json({ ok: false, error: error.message || 'TOPUP_FAILED' });
    }
  });

  app.use((req, res, next) => {
    if (req.path !== '/telegram/webhook') return next();
    const received = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
    const expected = config.webhookSecret;
    const valid = received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
    if (!valid) return res.status(403).json({ ok: false, error: 'WEBHOOK_FORBIDDEN' });
    next();
  });
  app.use(bot.webhookCallback('/telegram/webhook'));

  app.use((error, _req, res, _next) => {
    log('error', 'http.unhandled', { message: error.message });
    res.status(500).json({ ok: false, error: 'INTERNAL_SERVER_ERROR' });
  });

  return app;
}

function currentWeekStart() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Vientiane', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

const round2 = (value) => Math.round(value * 100) / 100;
