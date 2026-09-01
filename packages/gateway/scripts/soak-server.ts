/**
 * The gateway under soak, in its OWN process.
 *
 * Deliberately separate from the load generator. The Phase 7 baseline ran both in one
 * process, which is fine for latency but useless for a leak check: the generator's own
 * allocations land in the same RSS as the server's, so an upward trend proves nothing
 * about the gateway. Here the driver (soak.ts) spawns this file and samples THIS pid.
 *
 * Razorpay is stubbed at the SDK boundary, exactly as in the Phase 7 gateway-only
 * baseline, so the soak measures our own code rather than a third party's availability.
 *
 * Not a general-purpose entrypoint — measurement only.
 */

import { buildServer } from '../src/server.js';
import { setRazorpayClientForTesting } from '../src/adapters/adapter-support.js';
import { RazorpayClient } from '../src/razorpay/razorpay-client.js';
import { createStubSdk } from './razorpay-stub.js';

const PORT = Number(process.env['SOAK_PORT'] ?? 3199);

// Replace the Razorpay boundary before the server takes any traffic.
setRazorpayClientForTesting(new RazorpayClient({ client: createStubSdk() }));

const app = await buildServer();
await app.listen({ port: PORT, host: '127.0.0.1' });

// Tell the driver we are ready, and on which pid.
process.stdout.write(`SOAK_SERVER_READY pid=${process.pid} port=${PORT}\n`);

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
