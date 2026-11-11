// Diagnose X posting: verifies credentials with one cheap authenticated read (GET /2/users/me).
//   node scripts/x-check.mjs        (or: npm run x-check, or the "diagnose" option of the workflow)
import { xConfigured, missingXCreds, xWhoAmI, explainXError, XError } from '../src/x.mjs';

if (!xConfigured()) { console.log(`X: credentials missing -> ${missingXCreds().join(', ')}`); process.exit(0); }
try {
  const me = await xWhoAmI();
  console.log(`X: credentials OK - authenticated as @${me?.username} (id ${me?.id})`);
  console.log('Note: posting still needs API credits (pay-per-use). Posts with a link cost ~$0.20 each, plain posts ~$0.015.');
} catch (e) {
  console.error(`X: FAILED - ${e.message}`);
  const hint = explainXError(e);
  if (hint) console.error(`Fix: ${hint}`);
  if (e instanceof XError && e.status === 402) console.error('(A 402 on this check means the account has no credits even for reads.)');
  process.exitCode = 1;
}
