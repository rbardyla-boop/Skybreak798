#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dir = path.dirname(new URL(import.meta.url).pathname);
const input = path.join(dir, 'run.mjs');
const output = path.join(dir, '.strict-run.mjs');
let source = fs.readFileSync(input, 'utf8');

function replaceOne(label, pattern, replacement) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) throw new Error(`Strict patch ${label} expected exactly one match`);
  source = source.replace(pattern, replacement);
}

replaceOne('version', /const EVAL_VERSION = 'stateforge-equal-model-v1';/, "const EVAL_VERSION = 'stateforge-equal-model-v2-strict';");
replaceOne(
  'model-call failures',
  /\s*const callStarted = performance\.now\(\);[\s\S]*?budget\.consumeCall\(response\);\s*decisionsByArch\[archName\] = parseDecisions\(response\.text, publicBatch, archName, modelFailures\);/,
  `\n      const response = await api.complete({\n        system: prompt.system,\n        user: prompt.user,\n        metadata: { runIndex, ordinal, archName }\n      });\n      budget.consumeCall(response);\n      decisionsByArch[archName] = parseDecisions(response.text, publicBatch, archName);`
);
replaceOne(
  'missing decision fallback',
  /const decision = decisionsByArch\[archName\]\.get\(episodeSpec\.id\) \?\? fallbackDecision\(episodeSpec\.id\);/,
  `const decision = decisionsByArch[archName].get(episodeSpec.id);\n        if (!decision) throw new Error(\`Missing strict decision for \${episodeSpec.id} from \${archName}\`);`
);
replaceOne(
  'strict response parser',
  /function parseDecisions\(text, batch, archName, modelFailures\) \{[\s\S]*?\n\}\n\s*function fallbackDecision\(id\) \{[^\n]*\}\n/,
  `function parseDecisions(text, batch, archName) {\n  let parsed;\n  try { parsed = JSON.parse(extractJson(text)); }\n  catch (error) { throw new Error(\`\${archName} returned malformed JSON: \${error.message}\`); }\n  if (!Array.isArray(parsed.decisions)) throw new Error(\`\${archName} response has no decisions array\`);\n  const map = new Map();\n  for (const ep of batch) {\n    const matches = parsed.decisions.filter(d => d?.episodeId === ep.id);\n    if (matches.length !== 1) throw new Error(\`\${archName} returned \${matches.length} decisions for \${ep.id}\`);\n    const raw = matches[0];\n    if (!Array.isArray(raw.ranking) || raw.ranking.length !== ACTIONS.length) throw new Error(\`\${archName} returned an incomplete ranking for \${ep.id}\`);\n    const normalized = raw.ranking.map(v => String(v).toUpperCase());\n    if (new Set(normalized).size !== ACTIONS.length || normalized.some(v => !ACTIONS.includes(v))) throw new Error(\`\${archName} returned an invalid ranking for \${ep.id}\`);\n    map.set(ep.id, { episodeId: ep.id, familyId: ep.familyId, ranking: normalized, note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : '' });\n  }\n  return map;\n}\n`
);
replaceOne(
  'zero model failures gate',
  /sameModelCalls:ARCHES\.every\(a=>aggregateMetrics\[a\]\.modelCalls===aggregateMetrics\.stateforge\.modelCalls\)/,
  `sameModelCalls:ARCHES.every(a=>aggregateMetrics[a].modelCalls===aggregateMetrics.stateforge.modelCalls),zeroModelOrParserFailures:runs.every(r=>ARCHES.every(a=>r.metrics[a].modelFailures===0&&r.budgets[a].errors.length===0))`
);

fs.writeFileSync(output, source);
execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' });
console.log(`STRICT_EVALUATOR_SHA256 ${crypto.createHash('sha256').update(source).digest('hex')}`);
await import(`${pathToFileURL(output).href}?strict=1`);
