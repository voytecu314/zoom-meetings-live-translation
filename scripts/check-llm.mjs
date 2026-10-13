// Usage: npm run check-llm            (uses .env / environment)
//        LLM_MODEL=some-model npm run check-llm
// Diagnoses the LLM translation setup: key, model list, one test request,
// rate-limit headers. Prints facts; never prints your API key.
import { config } from '../server/config.js';
import { checkLlm, explainCheck } from '../server/translation/llm.js';

const { baseUrl, apiKey, model } = config.llm;
console.log(`Base URL : ${baseUrl}`);
console.log(`Model    : ${model}`);
console.log(`API key  : ${apiKey ? `set (${apiKey.length} chars, starts "${apiKey.slice(0, 7)}…")` : 'MISSING (set LLM_API_KEY)'}`);
if (!apiKey) process.exit(1);

const r = await checkLlm(config.llm);

if (r.models) {
  console.log(`\nModels visible to this key (${r.models.length}):`);
  console.log('  ' + r.models.join('\n  '));
  console.log(`\nIs "${model}" in that list? ${r.modelListed ? 'yes' : 'NO — check the id spelling'}`);
} else {
  console.log(`\nCould not list models (${r.modelsStatus ?? r.modelsError ?? 'unknown'}).`);
}

console.log(`\nTest request: ${explainCheck(r)}`);
if (Object.keys(r.headers).length) console.log('Rate-limit headers:', r.headers);
process.exit(r.ok ? 0 : 1);
