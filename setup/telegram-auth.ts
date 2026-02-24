/**
 * Step: telegram-auth — Validate a Telegram bot token and write it to .env.
 *
 * Usage: npx tsx setup/index.ts --step telegram-auth -- --token <BOT_TOKEN>
 *
 * Validates the token by calling the Telegram Bot API getMe endpoint.
 * On success, writes TELEGRAM_BOT_TOKEN and TELEGRAM_ONLY=true to .env,
 * and syncs .env to data/env/env for container access.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface GetMeResponse {
  ok: boolean;
  result?: TelegramUser;
  description?: string;
}

function parseArgs(args: string[]): { token: string; telegramOnly: boolean } {
  let token = '';
  let telegramOnly = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) {
      token = args[i + 1];
      i++;
    }
    if (args[i] === '--no-telegram-only') {
      telegramOnly = false;
    }
  }

  return { token, telegramOnly };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { token, telegramOnly } = parseArgs(args);

  if (!token) {
    emitStatus('AUTH_TELEGRAM', {
      STATUS: 'failed',
      ERROR: 'No --token provided',
    });
    process.exit(1);
  }

  logger.info('Validating Telegram bot token');

  // Validate token via Telegram API
  let botUsername = '';
  let botId = 0;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as GetMeResponse;

    if (!data.ok || !data.result) {
      const reason = data.description || 'Unknown error';
      logger.error({ reason }, 'Telegram token validation failed');
      emitStatus('AUTH_TELEGRAM', {
        STATUS: 'failed',
        ERROR: `Token invalid: ${reason}`,
      });
      process.exit(1);
    }

    botUsername = data.result.username || data.result.first_name;
    botId = data.result.id;
    logger.info({ botUsername, botId }, 'Token validated');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to reach Telegram API');
    emitStatus('AUTH_TELEGRAM', {
      STATUS: 'failed',
      ERROR: `Cannot reach Telegram API: ${message}`,
    });
    process.exit(1);
  }

  // Write to .env (append or create)
  const envFile = path.join(projectRoot, '.env');
  let envContent = '';
  if (fs.existsSync(envFile)) {
    envContent = fs.readFileSync(envFile, 'utf-8');
  }

  // Update or append TELEGRAM_BOT_TOKEN
  if (/^TELEGRAM_BOT_TOKEN=/m.test(envContent)) {
    envContent = envContent.replace(
      /^TELEGRAM_BOT_TOKEN=.*/m,
      `TELEGRAM_BOT_TOKEN=${token}`,
    );
  } else {
    envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}TELEGRAM_BOT_TOKEN=${token}\n`;
  }

  // Update or append TELEGRAM_ONLY
  if (telegramOnly) {
    if (/^TELEGRAM_ONLY=/m.test(envContent)) {
      envContent = envContent.replace(
        /^TELEGRAM_ONLY=.*/m,
        'TELEGRAM_ONLY=true',
      );
    } else {
      envContent += 'TELEGRAM_ONLY=true\n';
    }
  }

  fs.writeFileSync(envFile, envContent, 'utf-8');
  logger.info('Wrote TELEGRAM_BOT_TOKEN to .env');

  // Sync .env to data/env/env for container access
  const envDir = path.join(projectRoot, 'data', 'env');
  fs.mkdirSync(envDir, { recursive: true });
  fs.copyFileSync(envFile, path.join(envDir, 'env'));
  logger.info('Synced .env to data/env/env');

  emitStatus('AUTH_TELEGRAM', {
    STATUS: 'success',
    BOT_USERNAME: botUsername,
    BOT_ID: botId,
    TELEGRAM_ONLY: telegramOnly,
  });
}
