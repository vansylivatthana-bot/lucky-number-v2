import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTelegramAuthMiddleware } from './telegram-auth.js';
import { log } from './logger.js';

export function createApp({ config, supabase, botStatus, bot }) {
  const app = express();
  const requireTelegram = createTelegramAuthMiddleware(config);
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

  app.disable('x-powered-by');
  app.use(helmet({
    crossOriginResourcePolicy: false,
    // Telegram Desktop embeds the Mini App in an iframe. Helmet's default
    // X-Frame-Options: SAMEORIGIN would block that frame, so CSP below is the
    // single framing control and explicitly allows only Telegram web clients.
    frameguard: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://telegram.org'],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'self'", 'https://web.telegram.org', 'https://webk.telegram.org', 'https://webz.telegram.org']
      }
    }
  }));
  // Helmet/hosting layers can otherwise leave SAMEORIGIN behind. The CSP
  // frame-ancestors rule above is the single, allow-listed framing policy.
  app.use((_req, res, next) => {
    res.removeHeader('X-Frame-Options');
    next();
  });
  app.use(cors({
    origin: config.frontendUrl,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Telegram-Init-Data']
  }));
  app.use(express.json({ limit: '32kb' }));

  // The same Render service hosts the Telegram Mini App. Protected API
  // endpoints still validate Telegram initData on the server.
  app.use(express.static(publicDir, { index: 'index.html', fallthrough: true, maxAge: 0 }));
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
    const [userResult, friendResult, roundResult] = await Promise.all([
      supabase.from('users_v2').select('telegram_id,wallet_balance,referrer_id').eq('telegram_id', id).maybeSingle(),
      supabase.from('users_v2').select('telegram_id', { count: 'exact', head: true }).eq('referrer_id', id),
      supabase.from('monthly_draw_rounds_v3')
        .select('id,round_code,status,ticket_price')
        .in('status', ['OPEN', 'CLOSED', 'ROLLED_OVER', 'LOCKED'])
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);

    const firstError = [userResult.error, friendResult.error, roundResult.error].find(Boolean);
    if (firstError) {
      log('error', 'api.me.failed', { code: firstError.code, message: firstError.message });
      return res.status(503).json({ ok: false, error: 'DATABASE_QUERY_FAILED' });
    }

    const round = roundResult.data;
    const [ticketResult, roundTicketsResult] = round
      ? await Promise.all([
          supabase.from('draw_tickets_v3')
            .select('ticket_number,state,booked_at')
            .eq('owner_telegram_id', id)
            .eq('draw_round_id', round.id)
            .in('state', ['ACTIVE', 'LOCKED']),
          supabase.from('draw_tickets_v3')
            .select('price_paid')
            .eq('draw_round_id', round.id)
            .in('state', ['ACTIVE', 'LOCKED'])
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
    const ticketError = [ticketResult.error, roundTicketsResult.error].find(Boolean);
    if (ticketError) {
      log('error', 'api.me.v3_ticket_query_failed', { code: ticketError.code, message: ticketError.message });
      return res.status(503).json({ ok: false, error: 'DATABASE_QUERY_FAILED' });
    }

    // This is a live estimate for display only. Actual payouts use the stored
    // per-ticket allocations in the immutable financial ledger.
    const standardPool = (roundTicketsResult.data || []).reduce(
      (sum, ticket) => sum + Number(ticket.price_paid || 0) * 0.72, 0
    );
    res.json({
      ok: true,
      user: {
        telegramId: id,
        firstName: req.telegramUser.firstName,
        balance: Number(userResult.data?.wallet_balance || 0)
      },
      isAdmin: id === config.adminTelegramId,
      friendsCount: friendResult.count || 0,
      tickets: ticketResult.data || [],
      round: round ? {
        code: round.round_code,
        status: round.status,
        ticketPrice: Number(round.ticket_price)
      } : null,
      prizes: {
        prize1: round6(standardPool / 3),
        prize2Each: round6((standardPool * 2 / 9) / 3),
        prize3Each: round6((standardPool - round6(standardPool / 3) - round6(standardPool * 2 / 9)) / 23)
      }
    });
  });

  // Admin data is protected twice: Telegram initData is verified first, then
  // the verified Telegram ID must match the server-side administrator ID.
  // No wallet or ticket records are returned for individual users here.
  app.get('/api/admin/overview', requireTelegram, async (req, res) => {
    if (req.telegramUser.telegramId !== config.adminTelegramId) {
      return res.status(403).json({ ok: false, error: 'ADMIN_FORBIDDEN' });
    }

    try {
      const [roundResult, userCountResult] = await Promise.all([
        supabase.from('monthly_draw_rounds_v3')
          .select('id,round_code,status,ticket_price,opened_at')
          .in('status', ['OPEN', 'CLOSED', 'ROLLED_OVER', 'LOCKED'])
          .order('opened_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from('users_v2').select('telegram_id', { count: 'exact', head: true })
      ]);
      const firstError = roundResult.error || userCountResult.error;
      if (firstError) throw firstError;

      const round = roundResult.data;
      const ticketResult = round
        ? await supabase.from('draw_tickets_v3')
          .select('price_paid')
          .eq('draw_round_id', round.id)
          .in('state', ['ACTIVE', 'LOCKED'])
        : { data: [], error: null };
      if (ticketResult.error) throw ticketResult.error;

      const tickets = ticketResult.data || [];
      res.json({
        ok: true,
        usersCount: userCountResult.count || 0,
        round: round ? {
          code: round.round_code,
          status: round.status,
          ticketPrice: Number(round.ticket_price),
          ticketCount: tickets.length,
          grossSales: round6(tickets.reduce((sum, ticket) => sum + Number(ticket.price_paid || 0), 0))
        } : null
      });
    } catch (error) {
      log('error', 'admin.overview.failed', { code: error.code, message: error.message });
      res.status(503).json({ ok: false, error: 'ADMIN_OVERVIEW_UNAVAILABLE' });
    }
  });

  // This is a planning check only. It deliberately does not close, lock, draw
  // or settle anything. The same thresholds are enforced again inside the
  // database lock procedure, so a browser can never bypass them.
  app.get('/api/admin/draw-readiness', requireTelegram, async (req, res) => {
    if (req.telegramUser.telegramId !== config.adminTelegramId) {
      return res.status(403).json({ ok: false, error: 'ADMIN_FORBIDDEN' });
    }

    try {
      const roundResult = await supabase
        .from('monthly_draw_rounds_v3')
        .select('id,round_code,status,min_eligible_tickets,min_distinct_accounts')
        .in('status', ['OPEN', 'CLOSED', 'ROLLED_OVER', 'LOCKED'])
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (roundResult.error) throw roundResult.error;

      const round = roundResult.data;
      if (!round) {
        return res.json({ ok: true, readiness: { roundCode: null, status: 'NO_ACTIVE_ROUND' } });
      }

      const ticketsResult = await supabase
        .from('draw_tickets_v3')
        .select('owner_telegram_id')
        .eq('draw_round_id', round.id)
        .in('state', ['ACTIVE', 'LOCKED']);
      if (ticketsResult.error) throw ticketsResult.error;

      const tickets = ticketsResult.data || [];
      const ticketCount = tickets.length;
      const accountCount = new Set(tickets.map((ticket) => ticket.owner_telegram_id)).size;
      const minTickets = Number(round.min_eligible_tickets);
      const minAccounts = Number(round.min_distinct_accounts);
      const eligible = ticketCount >= minTickets && accountCount >= minAccounts;

      res.json({
        ok: true,
        readiness: {
          roundCode: round.round_code,
          status: round.status,
          ticketCount,
          accountCount,
          minTickets,
          minAccounts,
          eligible,
          nextOutcome: eligible ? 'LOCK_AND_DRAW_ELIGIBLE' : 'ROLLOVER_REQUIRED'
        }
      });
    } catch (error) {
      log('error', 'admin.draw_readiness.failed', { code: error.code, message: error.message });
      res.status(503).json({ ok: false, error: 'DRAW_READINESS_UNAVAILABLE' });
    }
  });

  // The close action is intentionally absent here. Sales close only through
  // the scheduled database rule, and a lock can only happen once readiness
  // has been satisfied. This endpoint prepares an encrypted secret escrow
  // and commits its hash with the immutable ticket snapshot.
  app.post('/api/admin/draws/lock', requireTelegram, async (req, res) => {
    if (req.telegramUser.telegramId !== config.adminTelegramId) {
      return res.status(403).json({ ok: false, error: 'ADMIN_FORBIDDEN' });
    }

    const roundCode = String(req.body?.roundCode || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!/^DR-\d{4}-\d{2}-\d{3}$/.test(roundCode) || confirmation !== `LOCK ${roundCode}`) {
      return res.status(400).json({ ok: false, error: 'DRAW_LOCK_CONFIRMATION_INVALID' });
    }

    try {
      const key = drawSecretKey(config.drawSecretEncryptionKey);
      if (!key) return res.status(409).json({ ok: false, error: 'DRAW_SECRET_KEY_NOT_CONFIGURED' });
      const { data: round, error: roundError } = await supabase
        .from('monthly_draw_rounds_v3')
        .select('id,status')
        .eq('round_code', roundCode)
        .maybeSingle();
      if (roundError) throw roundError;
      if (!round) return res.status(404).json({ ok: false, error: 'ROUND_NOT_FOUND' });

      let secret;
      let escrow;
      if (round.status === 'LOCKED') {
        const { data: existingEscrow, error: escrowError } = await supabase
          .from('draw_secret_escrow_v3')
          .select('ciphertext,iv,auth_tag')
          .eq('draw_round_id', round.id)
          .maybeSingle();
        if (escrowError) throw escrowError;
        if (!existingEscrow) return res.status(409).json({ ok: false, error: 'DRAW_SECRET_ESCROW_MISSING' });
        secret = decryptDrawSecret(existingEscrow, key);
        escrow = existingEscrow;
      } else {
        secret = crypto.randomBytes(32).toString('base64url');
        escrow = encryptDrawSecret(secret, key);
      }
      const commitment = crypto.createHash('sha256').update(secret).digest('hex');
      const { data, error } = await supabase.rpc('lock_monthly_draw_round_with_escrow_v3', {
        p_round_id: round.id,
        p_server_secret_commitment: commitment,
        p_ciphertext: escrow.ciphertext,
        p_iv: escrow.iv,
        p_auth_tag: escrow.authTag,
        p_actor_telegram_id: req.telegramUser.telegramId
      });
      if (error) throw error;
      res.json({ ok: true, lock: {
        roundCode,
        status: data?.status,
        eligibleTickets: Number(data?.eligibleTickets || 0),
        distinctAccounts: Number(data?.distinctAccounts || 0),
        idempotent: Boolean(data?.idempotent)
      } });
    } catch (error) {
      const known = String(error.message || '').match(/(ROUND_NOT_READY_TO_LOCK|DRAW_SECRET_ESCROW_MISSING|DRAW_SECRET_COMMITMENT_MISMATCH)/)?.[1];
      log('error', 'admin.draw.lock.failed', { code: error.code, reason: known || 'DRAW_LOCK_FAILED', message: error.message });
      res.status(known ? 409 : 503).json({ ok: false, error: known || 'DRAW_LOCK_FAILED' });
    }
  });

  // Settlement accepts public entropy supplied by the administrator. The
  // encrypted secret is read only after the round is already immutable/LOCKED.
  app.post('/api/admin/draws/settle', requireTelegram, async (req, res) => {
    if (req.telegramUser.telegramId !== config.adminTelegramId) {
      return res.status(403).json({ ok: false, error: 'ADMIN_FORBIDDEN' });
    }

    const roundCode = String(req.body?.roundCode || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    const entropyReference = String(req.body?.entropyReference || '').trim();
    const entropyValue = String(req.body?.entropyValue || '').trim();
    if (!/^DR-\d{4}-\d{2}-\d{3}$/.test(roundCode) || confirmation !== `SETTLE ${roundCode}`) {
      return res.status(400).json({ ok: false, error: 'DRAW_SETTLE_CONFIRMATION_INVALID' });
    }

    try {
      const key = drawSecretKey(config.drawSecretEncryptionKey);
      if (!key) return res.status(409).json({ ok: false, error: 'DRAW_SECRET_KEY_NOT_CONFIGURED' });
      const { data: round, error: roundError } = await supabase
        .from('monthly_draw_rounds_v3')
        .select('id,status')
        .eq('round_code', roundCode)
        .maybeSingle();
      if (roundError) throw roundError;
      if (!round) return res.status(404).json({ ok: false, error: 'ROUND_NOT_FOUND' });
      if (round.status !== 'LOCKED') return res.status(409).json({ ok: false, error: 'ROUND_NOT_LOCKED' });

      const { data: escrow, error: escrowError } = await supabase
        .from('draw_secret_escrow_v3')
        .select('ciphertext,iv,auth_tag')
        .eq('draw_round_id', round.id)
        .maybeSingle();
      if (escrowError) throw escrowError;
      if (!escrow) return res.status(409).json({ ok: false, error: 'DRAW_SECRET_ESCROW_MISSING' });

      const secret = decryptDrawSecret(escrow, key);
      const { data, error } = await supabase.rpc('execute_verifiable_draw_and_settle_v3', {
        p_round_id: round.id,
        p_revealed_server_secret: secret,
        p_public_entropy_source: 'NIST_BEACON_V2',
        p_public_entropy_reference: entropyReference,
        p_public_entropy_value: entropyValue,
        p_actor_telegram_id: req.telegramUser.telegramId
      });
      if (error) throw error;
      res.json({ ok: true, settlement: {
        roundCode,
        status: data?.status,
        winnerCount: Number(data?.winnerCount || 0),
        prizePool: Number(data?.prizePool || 0),
        derivedSeedHash: data?.derivedSeedHash || null,
        idempotent: Boolean(data?.idempotent)
      } });
    } catch (error) {
      const known = String(error.message || '').match(/(ROUND_NOT_LOCKED|DRAW_SECRET_ESCROW_MISSING|PUBLIC_ENTROPY_NOT_VERIFIABLE|SERVER_SECRET_COMMITMENT_MISMATCH)/)?.[1];
      log('error', 'admin.draw.settle.failed', { code: error.code, reason: known || 'DRAW_SETTLE_FAILED', message: error.message });
      res.status(known ? 409 : 503).json({ ok: false, error: known || 'DRAW_SETTLE_FAILED' });
    }
  });

  // A read-only reconciliation view for TEST operations. It deliberately
  // returns aggregate checks only: no other user's wallet or ticket details
  // are exposed to the Mini App.
  app.get('/api/admin/ledger-verification', requireTelegram, async (req, res) => {
    if (req.telegramUser.telegramId !== config.adminTelegramId) {
      return res.status(403).json({ ok: false, error: 'ADMIN_FORBIDDEN' });
    }

    try {
      const roundResult = await supabase
        .from('monthly_draw_rounds_v3')
        .select('id,round_code')
        .in('status', ['OPEN', 'CLOSED', 'ROLLED_OVER', 'LOCKED'])
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (roundResult.error) throw roundResult.error;

      const round = roundResult.data;
      const ticketResult = round
        ? await supabase
          .from('draw_tickets_v3')
          .select('price_paid,purchase_transaction_id')
          .eq('draw_round_id', round.id)
          .in('state', ['ACTIVE', 'LOCKED'])
        : { data: [], error: null };
      if (ticketResult.error) throw ticketResult.error;

      const tickets = ticketResult.data || [];
      const transactionIds = tickets.map((ticket) => ticket.purchase_transaction_id).filter(Boolean);
      const entriesResult = transactionIds.length
        ? await supabase
          .from('financial_entries_v3')
          .select('transaction_id,direction,amount')
          .in('transaction_id', transactionIds)
        : { data: [], error: null };
      const walletResult = await supabase
        .from('wallet_ledger_v2')
        .select('amount,entry_type,reference_type,created_at')
        .eq('telegram_id', req.telegramUser.telegramId)
        .order('created_at', { ascending: false })
        .limit(20);
      const firstError = entriesResult.error || walletResult.error;
      if (firstError) throw firstError;

      const totalsByTransaction = new Map();
      for (const entry of entriesResult.data || []) {
        const current = totalsByTransaction.get(entry.transaction_id) || { debit: 0, credit: 0 };
        current[entry.direction === 'DEBIT' ? 'debit' : 'credit'] += Number(entry.amount || 0);
        totalsByTransaction.set(entry.transaction_id, current);
      }
      const balancedTicketTransactions = transactionIds.filter((id) => {
        const totals = totalsByTransaction.get(id);
        return totals && round6(totals.debit) === round6(totals.credit);
      }).length;
      const grossSales = round6(tickets.reduce((sum, ticket) => sum + Number(ticket.price_paid || 0), 0));

      res.json({
        ok: true,
        verification: {
          roundCode: round?.round_code || null,
          ticketCount: tickets.length,
          grossSales,
          balancedTicketTransactions,
          ticketTransactions: transactionIds.length,
          walletEntryCount: (walletResult.data || []).length,
          passed: balancedTicketTransactions === transactionIds.length
        }
      });
    } catch (error) {
      log('error', 'admin.ledger_verification.failed', { code: error.code, message: error.message });
      res.status(503).json({ ok: false, error: 'LEDGER_VERIFICATION_UNAVAILABLE' });
    }
  });

  // This is deliberately limited to the authenticated administrator's own
  // test wallet. The browser never receives a database key, and the SQL
  // procedure records an idempotent, balanced financial transaction.
  app.post('/api/admin/test-credit', requireTelegram, async (req, res) => {
    if (req.telegramUser.telegramId !== config.adminTelegramId) {
      return res.status(403).json({ ok: false, error: 'ADMIN_FORBIDDEN' });
    }

    const idempotencyKey = String(req.get('Idempotency-Key') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
      return res.status(400).json({ ok: false, error: 'IDEMPOTENCY_KEY_INVALID' });
    }

    try {
      const { data, error } = await supabase.rpc('credit_test_wallet_v3', {
        p_actor_telegram_id: req.telegramUser.telegramId,
        p_target_telegram_id: req.telegramUser.telegramId,
        p_amount: 10,
        p_idempotency_key: idempotencyKey,
        p_reason: 'Admin Mini App test credit'
      });
      if (error) throw error;
      res.status(data?.idempotent ? 200 : 201).json({ ok: true, credit: {
        transactionId: data.transactionId,
        balance: Number(data.balance || 0),
        amount: Number(data.amount || 10),
        idempotent: Boolean(data.idempotent)
      } });
    } catch (error) {
      const known = String(error.message || '').match(/(USER_NOT_FOUND|TEST_CREDIT_AMOUNT_INVALID|TEST_CREDIT_SELF_ONLY)/)?.[1];
      log('error', 'admin.test_credit.failed', {
        code: error.code,
        reason: known || 'TEST_CREDIT_FAILED',
        message: String(error.message || 'unknown error')
      });
      res.status(known ? 409 : 503).json({ ok: false, error: known || 'TEST_CREDIT_FAILED' });
    }
  });

  app.post('/api/tickets/purchase', requireTelegram, async (req, res) => {
    try {
      const idempotencyKey = String(req.get('Idempotency-Key') || '').trim().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
        return res.status(400).json({ ok: false, error: 'IDEMPOTENCY_KEY_INVALID' });
      }

      let purchase;
      let lastError;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const ticketNumber = crypto.randomInt(0, 100000).toString().padStart(5, '0');
        const { data, error } = await supabase.rpc('purchase_monthly_ticket_v3', {
          p_telegram_id: req.telegramUser.telegramId,
          p_ticket_number: ticketNumber,
          p_idempotency_key: idempotencyKey
        });
        if (!error) {
          purchase = data;
          break;
        }
        lastError = error;
        if (!String(error.message || '').includes('TICKET_ALREADY_SOLD')) throw error;
      }
      if (!purchase) throw lastError || new Error('TICKET_GENERATION_RETRY_EXHAUSTED');

      const { data: ticket, error: ticketError } = await supabase
        .from('draw_tickets_v3')
        .select('id,ticket_number,draw_round_id,state,booked_at')
        .eq('id', purchase.ticketId)
        .maybeSingle();
      if (ticketError || !ticket) throw ticketError || new Error('PURCHASE_TICKET_NOT_FOUND');
      res.status(purchase.idempotent ? 200 : 201).json({ ok: true, purchase: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticket_number,
        roundId: ticket.draw_round_id,
        state: ticket.state,
        bookedAt: ticket.booked_at,
        idempotent: Boolean(purchase.idempotent)
      } });
    } catch (error) {
      const known = String(error.message || '').match(/(SALES_CLOSED|USER_NOT_FOUND|INSUFFICIENT_BALANCE|TICKET_ALREADY_SOLD|TICKET_NUMBER_INVALID|TICKET_GENERATION_RETRY_EXHAUSTED)/)?.[1];
      log('error', 'ticket.purchase.failed', {
        code: error.code,
        reason: known || 'PURCHASE_FAILED',
        message: String(error.message || 'unknown error')
      });
      res.status(known ? 409 : 503).json({ ok: false, error: known || 'PURCHASE_FAILED' });
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

const round6 = (value) => Math.round(value * 1_000_000) / 1_000_000;

function drawSecretKey(encoded) {
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('DRAW_SECRET_KEY_INVALID');
  return key;
}

function encryptDrawSecret(secret, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

function decryptDrawSecret(escrow, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(escrow.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(escrow.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(escrow.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}
