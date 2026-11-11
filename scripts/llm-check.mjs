// Diagnose the AI setup: lists what each provider really offers and pings every model in every role.
//   node scripts/llm-check.mjs        (or: npm run llm-check, or the "diagnose" option of the workflow)
import { probeAll, getProviders } from '../src/llm.mjs';

const rows = await probeAll();
const w = (s, n) => String(s).padEnd(n);
console.log('\n' + w('PROVIDER', 12) + w('ROLE', 8) + w('MODEL', 36) + 'RESULT');
console.log('-'.repeat(100));
for (const r of rows) console.log(w(r.provider, 12) + w(r.role, 8) + w(r.model, 36) + (r.ok ? 'OK   ' : 'FAIL ') + r.note);

const usable = (role) => rows.filter((r) => r.role === role && r.ok).length;
console.log(`\nWorking models -> text: ${usable('text')}, check: ${usable('check')}, vision: ${usable('vision')}`);
if (!usable('text')) { console.error('\nNo working text model. Check LLM_API_KEY and that the key is valid for the provider.'); process.exitCode = 1; }
if (!usable('vision')) console.log('No vision model works: image vetting will use file metadata only. Gemini keys normally provide vision.');
void getProviders;
