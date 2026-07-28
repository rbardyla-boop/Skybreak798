#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dir = path.dirname(new URL(import.meta.url).pathname);
const input = path.join(dir, 'run.mjs');
const output = path.join(dir, '.local-strict-run.mjs');
let source = fs.readFileSync(input, 'utf8');

function replaceOne(label, pattern, replacement) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`Local adapter patch ${label} expected exactly one match`);
  }
  source = source.replace(pattern, replacement);
}

replaceOne(
  'version',
  /const EVAL_VERSION = 'stateforge-equal-model-v1';/,
  "const EVAL_VERSION = 'stateforge-local-openai-compatible-v1';"
);
replaceOne(
  'local endpoint configuration',
  /const model = argv\.model \?\? DEFAULT_MODEL;/,
  `const model = argv.model ?? process.env.STATEFORGE_MODEL ?? DEFAULT_MODEL;\nconst baseUrl = argv.baseUrl ?? process.env.STATEFORGE_BASE_URL ?? 'http://127.0.0.1:11434/v1';\nconst apiKey = argv.apiKey ?? process.env.STATEFORGE_API_KEY ?? '';\nconst jsonMode = String(argv.jsonMode ?? process.env.STATEFORGE_JSON_MODE ?? 'false').toLowerCase() === 'true';`
);
replaceOne(
  'smoke-test ordinal control',
  /const maxOrdinal = 13;/,
  `const maxOrdinal = intArg(argv.ordinals, 13);`
);
replaceOne(
  'equal local wall-time control',
  /const wallLimitMs = 22 \* 60 \* 1000;/,
  `const wallLimitMs = intArg(argv.wallLimitMs, 22 * 60 * 1000);`
);
replaceOne(
  'ordered output contract',
  /'Return strict JSON with shape \{"decisions":\[\{"episodeId":"\.\.\.","ranking":\["EMBER","TIDE","LENS","GATE"\],"note":"optional compact memory"\}\]\}\.',/,
  `'Return strict JSON with shape {"decisions":[{"ranking":["EMBER","TIDE","LENS","GATE"],"note":"optional compact memory"}]}. Return exactly one decision per public observation, in the exact supplied array order. Do not echo episode identifiers.',`
);
replaceOne(
  'client construction',
  /api = new ModelClient\(\{ provider, model, token: process\.env\.GITHUB_TOKEN, maxRequests, requestOutputTokens, requestTimeoutMs, globalRequestGapMs \}\);/,
  `api = new ModelClient({ provider, model, apiKey, baseUrl, jsonMode, maxRequests, requestOutputTokens, requestTimeoutMs, globalRequestGapMs });`
);
replaceOne(
  'strict model-call handling',
  /\s*const callStarted = performance\.now\(\);[\s\S]*?budget\.consumeCall\(response\);\s*decisionsByArch\[archName\] = parseDecisions\(response\.text, publicBatch, archName, modelFailures\);/,
  `\n      const response = await api.complete({\n        system: prompt.system,\n        user: prompt.user,\n        metadata: { runIndex, ordinal, archName }\n      });\n      budget.consumeCall(response);\n      decisionsByArch[archName] = parseDecisions(response.text, publicBatch, archName);`
);
replaceOne(
  'remove action fallback',
  /const decision = decisionsByArch\[archName\]\.get\(episodeSpec\.id\) \?\? fallbackDecision\(episodeSpec\.id\);/,
  `const decision = decisionsByArch[archName].get(episodeSpec.id);\n        if (!decision) throw new Error(\`Missing strict ordered decision for \${episodeSpec.id} from \${archName}\`);`
);
replaceOne(
  'OpenAI-compatible client',
  /class ModelClient \{[\s\S]*?\n\}\n\nfunction parseDecisions/,
  `class ModelClient {\n  constructor({ provider, model, apiKey, baseUrl, jsonMode, maxRequests, requestOutputTokens, requestTimeoutMs, globalRequestGapMs }) {\n    this.provider = provider;\n    this.model = model;\n    this.apiKey = apiKey;\n    this.baseUrl = String(baseUrl).replace(/\\/+$/, '');\n    this.endpoint = this.baseUrl.endsWith('/chat/completions') ? this.baseUrl : this.baseUrl + '/chat/completions';\n    this.jsonMode = jsonMode;\n    this.maxRequests = maxRequests;\n    this.requestOutputTokens = requestOutputTokens;\n    this.requestTimeoutMs = requestTimeoutMs;\n    this.globalRequestGapMs = globalRequestGapMs;\n    this.requests = 0;\n    this.lastRequestAt = 0;\n    this.ledger = [];\n  }\n  async complete({ system, user, metadata }) {\n    if (this.requests >= this.maxRequests) throw new Error(\`global model request cap \${this.maxRequests} reached\`);\n    const wait = this.globalRequestGapMs - (Date.now() - this.lastRequestAt);\n    if (wait > 0) await sleep(wait);\n    this.requests++;\n    this.lastRequestAt = Date.now();\n    const started = performance.now();\n    if (this.provider === 'mock') {\n      const text = mockResponse(user);\n      const out = { text, inputTokens: estimateTokens(system + user), outputTokens: estimateTokens(text), latencyMs: performance.now() - started, requestId: \`mock-\${this.requests}\` };\n      this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out), responseHash: sha256(text) });\n      return out;\n    }\n    const controller = new AbortController();\n    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);\n    let bodyText = '';\n    try {\n      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };\n      if (this.apiKey) headers.Authorization = \`Bearer \${this.apiKey}\`;\n      const requestBody = {\n        model: this.model,\n        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],\n        temperature: 0,\n        max_tokens: this.requestOutputTokens,\n        stream: false\n      };\n      if (this.jsonMode) requestBody.response_format = { type: 'json_object' };\n      const response = await fetch(this.endpoint, {\n        method: 'POST',\n        headers,\n        body: JSON.stringify(requestBody),\n        signal: controller.signal\n      });\n      bodyText = await response.text();\n      if (!response.ok) throw new Error(\`Local model HTTP \${response.status}: \${bodyText.slice(0, 1200)}\`);\n      const body = JSON.parse(bodyText);\n      const text = body.choices?.[0]?.message?.content ?? '';\n      if (!text) throw new Error('Local model response contained no choices[0].message.content');\n      const out = {\n        text,\n        inputTokens: body.usage?.prompt_tokens ?? estimateTokens(system + user),\n        outputTokens: body.usage?.completion_tokens ?? estimateTokens(text),\n        latencyMs: performance.now() - started,\n        requestId: response.headers.get('x-request-id') ?? response.headers.get('x-github-request-id') ?? null\n      };\n      this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out), responseHash: sha256(text) });\n      return out;\n    } catch (error) {\n      const out = { text: '', inputTokens: 0, outputTokens: 0, latencyMs: performance.now() - started, error: serializeError(error), httpBodyHash: bodyText ? sha256(bodyText) : null };\n      this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out) });\n      throw error;\n    } finally {\n      clearTimeout(timer);\n    }\n  }\n}\n\nfunction parseDecisions`
);
replaceOne(
  'strict ordered parser',
  /function parseDecisions\(text, batch, archName, modelFailures\) \{[\s\S]*?\n\}\n\s*function fallbackDecision\(id\) \{[^\n]*\}\n/,
  `function parseDecisions(text, batch, archName) {\n  let parsed;\n  try { parsed = JSON.parse(extractJson(text)); }\n  catch (error) { throw new Error(\`\${archName} returned malformed JSON: \${error.message}\`); }\n  if (!Array.isArray(parsed.decisions)) throw new Error(\`\${archName} response has no decisions array\`);\n  if (parsed.decisions.length !== batch.length) throw new Error(\`\${archName} returned \${parsed.decisions.length} ordered decisions for \${batch.length} observations\`);\n  const map = new Map();\n  for (let i = 0; i < batch.length; i++) {\n    const ep = batch[i];\n    const raw = parsed.decisions[i];\n    if (!Array.isArray(raw?.ranking) || raw.ranking.length !== ACTIONS.length) throw new Error(\`\${archName} returned an incomplete ranking at ordered index \${i}\`);\n    const normalized = raw.ranking.map(v => String(v).toUpperCase());\n    if (new Set(normalized).size !== ACTIONS.length || normalized.some(v => !ACTIONS.includes(v))) throw new Error(\`\${archName} returned an invalid ranking at ordered index \${i}\`);\n    map.set(ep.id, { episodeId: ep.id, familyId: ep.familyId, ranking: normalized, note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : '' });\n  }\n  return map;\n}\n`
);
replaceOne(
  'zero failure gate',
  /sameModelCalls:ARCHES\.every\(a=>aggregateMetrics\[a\]\.modelCalls===aggregateMetrics\.stateforge\.modelCalls\)/,
  `sameModelCalls:ARCHES.every(a=>aggregateMetrics[a].modelCalls===aggregateMetrics.stateforge.modelCalls),zeroModelOrParserFailures:runs.every(r=>ARCHES.every(a=>r.metrics[a].modelFailures===0&&r.budgets[a].errors.length===0))`
);

fs.writeFileSync(output, source);
execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' });
console.log(`LOCAL_STRICT_EVALUATOR_SHA256 ${crypto.createHash('sha256').update(source).digest('hex')}`);
await import(`${pathToFileURL(output).href}?local=1`);
