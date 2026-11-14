#!/usr/bin/env node
/**
 * EduOS production configuration preflight.
 * Validates the same fail-closed application configuration used at runtime.
 * Never prints environment values or secrets.
 */
import { pathToFileURL } from 'node:url';

try {
  const { config } = await import('../src/config.js');
  if (config.nodeEnv !== 'production') {
    throw new Error('Set NODE_ENV=production before running the production preflight');
  }
  if (!config.publicOrigin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must use HTTPS');
  if (!config.oidcIssuer.startsWith('https://')) throw new Error('OIDC_ISSUER must use HTTPS');
  if (config.demoMode) throw new Error('EDUOS_DEMO_MODE must be disabled');
  if (config.webhookAllowInsecureLoopback) throw new Error('Insecure webhook loopback must be disabled');
  if (config.nodeTier === 'school' && config.edenHubUrl && !config.edenHubUrl.startsWith('https://')) {
    throw new Error('EDEN_HUB_URL must use HTTPS');
  }
  if (config.webhookSigningKey && config.webhookSigningKey.length < 32) {
    throw new Error('WEBHOOK_SIGNING_KEY must contain at least 32 characters when configured');
  }
  if (config.metricsToken && config.metricsToken.length < 16) {
    throw new Error('METRICS_TOKEN must contain at least 16 characters when configured');
  }
  console.log('EduOS production configuration preflight: PASS');
  console.log(`Validated production configuration for ${new URL(config.publicOrigin).host}.`);
  console.log('No environment values or secrets were printed.');
} catch (error) {
  console.error(`EduOS production configuration preflight: FAIL — ${error.message}`);
  process.exitCode = 1;
}
