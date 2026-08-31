/**
 * Operator script: create a merchant and mint its first API key (Phase 4.5).
 *
 * WHY THIS IS A SCRIPT AND NOT A ROUTE. Merchant creation cannot live behind
 * /v1/merchant/* — that whole surface now requires a merchant API key, and you cannot
 * present a key for a merchant that does not exist yet. Bootstrapping is therefore an
 * operator action with direct database access, which is also the honest trust model: in
 * production a merchant is onboarded by Razorpay, not by an anonymous HTTP call.
 *
 *   npm run merchant:create --workspace=gateway -- --name "My Merchant"
 *   npm run merchant:create --workspace=gateway -- --list
 *   npm run merchant:create --workspace=gateway -- --key-for <merchantId>
 *
 * The plaintext API key is printed ONCE. Only its SHA-256 hash is stored, so it cannot
 * be recovered afterwards — mint a new one instead.
 */

import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { generateApiKey } from '../src/auth/merchant-auth.js';
import { encryptSecret, isEncrypted, parseEncryptionKey } from '../src/crypto/secret-box.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function printKey(label: string, plaintext: string, merchantId: string): void {
  console.log('\n============================================================');
  console.log('  MERCHANT API KEY — SHOWN ONCE, NOT RECOVERABLE');
  console.log('============================================================');
  console.log(`  merchant id   ${merchantId}`);
  console.log(`  label         ${label}`);
  console.log('');
  console.log(`  ${plaintext}`);
  console.log('');
  console.log('  Use it as:  Authorization: Bearer <key>');
  console.log('============================================================\n');
}

async function mintKey(merchantId: string, label: string): Promise<void> {
  const generated = generateApiKey();
  await prisma.merchantApiKey.create({
    data: {
      merchantId,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      label,
    },
  });
  printKey(label, generated.plaintext, merchantId);
}

async function main(): Promise<void> {
  const encryptionKey = parseEncryptionKey(env.MERCHANT_SECRET_ENCRYPTION_KEY);

  if (process.argv.includes('--list')) {
    const merchants = await prisma.merchant.findMany({
      select: {
        id: true,
        name: true,
        razorpayKeySecretEncrypted: true,
        apiKeys: {
          select: { keyPrefix: true, label: true, revokedAt: true, lastUsedAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (merchants.length === 0) {
      console.log('No merchants. Create one with: -- --name "My Merchant"');
      return;
    }

    for (const merchant of merchants) {
      console.log(`\n${merchant.name}  (${merchant.id})`);
      console.log(
        `  secret at rest : ${isEncrypted(merchant.razorpayKeySecretEncrypted) ? 'ENCRYPTED (v1 AES-256-GCM)' : '*** PLAINTEXT ***'}`,
      );
      if (merchant.apiKeys.length === 0) {
        console.log('  api keys       : none — mint one with -- --key-for <merchantId>');
      }
      for (const key of merchant.apiKeys) {
        const state = key.revokedAt === null ? 'active' : 'REVOKED';
        const used = key.lastUsedAt?.toISOString() ?? 'never used';
        console.log(
          `  api key        : ${key.keyPrefix}…  ${state}  (${used})  ${key.label ?? ''}`,
        );
      }
    }
    console.log('');
    return;
  }

  const keyFor = argValue('--key-for');
  if (keyFor !== undefined) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: keyFor },
      select: { id: true },
    });
    if (merchant === null) {
      console.error(`No merchant with id ${keyFor}`);
      process.exitCode = 1;
      return;
    }
    await mintKey(merchant.id, argValue('--label') ?? 'cli-minted');
    return;
  }

  const name = argValue('--name');
  if (name === undefined || name.length === 0) {
    console.error('Usage: -- --name "My Merchant" | --list | --key-for <merchantId>');
    process.exitCode = 1;
    return;
  }

  // The Razorpay secret is encrypted BEFORE it touches the database. The column has
  // been named `_encrypted` since §2.3; until Phase 4.5 nothing actually encrypted it.
  const razorpaySecret = argValue('--razorpay-secret') ?? env.RAZORPAY_KEY_SECRET;

  const merchant = await prisma.merchant.create({
    data: {
      name,
      razorpayKeyId: argValue('--razorpay-key-id') ?? env.RAZORPAY_KEY_ID,
      razorpayKeySecretEncrypted: encryptSecret(razorpaySecret, encryptionKey),
      enabledProtocols: ['x402', 'ap2', 'fallback'],
    },
    select: { id: true, name: true },
  });

  console.log(`Created merchant "${merchant.name}" (${merchant.id})`);
  console.log('Razorpay secret stored ENCRYPTED (AES-256-GCM, envelope v1).');

  await mintKey(merchant.id, argValue('--label') ?? 'initial');
}

main()
  .catch((error: unknown) => {
    console.error('\nfailed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
