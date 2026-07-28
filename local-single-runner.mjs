#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.dirname(new URL(import.meta.url).pathname);
const input = path.join(root, 'experiments/stateforge-equal-model/run.mjs');
const output = path.join(root, 'experiments/stateforge-equal-model/.local-single-run.mjs');
let source = fs.readFileSync(input, 'utf8');

function replaceOne(label, pattern, replacement) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`Single-observation adapter patch ${label} expected exactly one match`);
  }
  source = source.replace(pattern, replacement);
}

replaceOne(
  'version',
  /const EVAL_VERSION = 'stateforge-equal-model-v1';/,
  "const EVAL_VERSION = 'stateforge-local-single-observation-v1';"
);
replaceOne(
  'local endpoint and batch configuration',
  /const model = argv\.model \?\? DEFAULT_MODEL;/,
  `const model = argv.model ?? process.env.STATEFORGE_MODEL ?? DEFAULT_MODEL;
const baseUrl = argv.baseUrl ?? process.env.STATEFORGE_BASE_URL ?? 'http://127.0.0.1:11434/v1';
const apiKey = argv.apiKey ?? process.env.STATEFORGE_API_KEY ?? '';
const jsonMode = String(argv.jsonMode ?? process.env.STATEFORGE_JSON_MODE ?? 'true').toLowerCase() === 'true';
const batchSize = Math.max(1, intArg(argv.batchSize, 1));
const episodeLimit = Math.max(1, Math.min(episodesPerRun, intArg(argv.episodes, episodesPerRun)));`
);
replaceOne(
  'configurable token ceilings',
  /const tokenLimits = Object\.freeze\(\{ input: 96000, output: 30000 \}\);/,
  `const tokenLimits = Object.freeze({ input: intArg(argv.inputTokenLimit, 1000000), output: intArg(argv.outputTokenLimit, 120000) });`
);
replaceOne(
  'configurable wall ceiling',
  /const wallLimitMs = 22 \* 60 \* 1000;/,
  `const wallLimitMs = intArg(argv.wallLimitMs, 21600000);`
);
replaceOne(
  'release commitment includes local execution shape',
  /wallLimitMs, commitSha \}\)\);/,
  `wallLimitMs, batchSize, episodeLimit, commitSha }));`
);
replaceOne(
  'design episode count',
  /runs: runCount, episodesPerRun, familiesPerRun: familyCount, totalPairedEpisodesPlanned: runCount \* episodesPerRun,/,
  `runs: runCount, episodesPerRun: episodeLimit, familiesPerRun: familyCount, totalPairedEpisodesPlanned: runCount * episodeLimit,`
);
replaceOne(
  'design call count',
  /modelCallsPerArchitecturePerRun: maxOrdinal,/,
  `modelCallsPerArchitecturePerRun: Math.ceil(episodeLimit / batchSize),`
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
  'single-observation execution loop',
  /  for \(let ordinal = 0; ordinal < maxOrdinal; ordinal\+\+\) \{[\s\S]*?\n  \}\n\n  const integrity = \{\};/,
  `  const selectedEpisodes = specs.episodes.slice(0, episodeLimit);
  const evaluationBatches = [];
  for (let i = 0; i < selectedEpisodes.length; i += batchSize) {
    evaluationBatches.push(selectedEpisodes.slice(i, i + batchSize));
  }

  for (let batchIndex = 0; batchIndex < evaluationBatches.length; batchIndex++) {
    const episodeBatch = evaluationBatches[batchIndex];
    const publicBatch = episodeBatch.map(publicEpisode);
    const order = rotate(ARCHES, (runIndex + batchIndex) % ARCHES.length);
    orderSchedule.push({
      ordinal: batchIndex,
      sourceOrdinals: episodeBatch.map(e => e.ordinal),
      episodeIds: episodeBatch.map(e => e.id),
      order
    });
    const decisionsByArch = {};
    for (const archName of order) {
      const budget = budgets[archName];
      budget.assertWithin();
      const prompt = buildPrompt({ archName, arch: architectures[archName], publicBatch, ordinal: batchIndex, runIndex });
      const response = await api.complete({
        system: prompt.system,
        user: prompt.user,
        metadata: { runIndex, ordinal: batchIndex, archName }
      });
      budget.consumeCall(response);
      decisionsByArch[archName] = parseDecisions(response.text, publicBatch, archName);
      if (archName === 'loop') architectures.loop.setNotes(decisionsByArch[archName]);
    }
    for (const episodeSpec of episodeBatch) {
      for (const archName of ARCHES) {
        const arch = architectures[archName], budget = budgets[archName];
        const decision = decisionsByArch[archName].get(episodeSpec.id);
        if (!decision) throw new Error(\`Missing strict decision for \${episodeSpec.id} from \${archName}\`);
        const result = playEpisode({ episodeSpec, archName, arch, decision, budget, runIndex });
        episodes[archName].push(result.episode);
        transitions[archName].push(...result.transitions);
        arch.observeEpisode(result.episode, result.transitions);
      }
    }
  }

  const integrity = {};`
);
replaceOne(
  'OpenAI-compatible client',
  /class ModelClient \{[\s\S]*?\n\}\n\nfunction parseDecisions/,
  `class ModelClient {
  constructor({ provider, model, apiKey, baseUrl, jsonMode, maxRequests, requestOutputTokens, requestTimeoutMs, globalRequestGapMs }) {
    this.provider = provider;
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\\/+$/, '');
    this.endpoint = this.baseUrl.endsWith('/chat/completions') ? this.baseUrl : this.baseUrl + '/chat/completions';
    this.jsonMode = jsonMode;
    this.maxRequests = maxRequests;
    this.requestOutputTokens = requestOutputTokens;
    this.requestTimeoutMs = requestTimeoutMs;
    this.globalRequestGapMs = globalRequestGapMs;
    this.requests = 0;
    this.lastRequestAt = 0;
    this.ledger = [];
  }
  async complete({ system, user, metadata }) {
    if (this.requests >= this.maxRequests) throw new Error(\`global model request cap \${this.maxRequests} reached\`);
    const wait = this.globalRequestGapMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.requests++;
    this.lastRequestAt = Date.now();
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let bodyText = '';
    try {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (this.apiKey) headers.Authorization = \`Bearer \${this.apiKey}\`;
      const requestBody = {
        model: this.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0,
        max_tokens: this.requestOutputTokens,
        stream: false
      };
      if (this.jsonMode) requestBody.response_format = { type: 'json_object' };
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      bodyText = await response.text();
      if (!response.ok) throw new Error(\`Local model HTTP \${response.status}: \${bodyText.slice(0, 1200)}\`);
      const body = JSON.parse(bodyText);
      const text = body.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('Local model response contained no choices[0].message.content');
      const out = {
        text,
        inputTokens: body.usage?.prompt_tokens ?? estimateTokens(system + user),
        outputTokens: body.usage?.completion_tokens ?? estimateTokens(text),
        latencyMs: performance.now() - started,
        requestId: response.headers.get('x-request-id') ?? null
      };
      this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out), responseHash: sha256(text) });
      return out;
    } catch (error) {
      const out = {
        text: '', inputTokens: 0, outputTokens: 0,
        latencyMs: performance.now() - started,
        error: serializeError(error),
        httpBodyHash: bodyText ? sha256(bodyText) : null
      };
      this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out) });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseDecisions`
);
replaceOne(
  'strict ordered parser',
  /function parseDecisions\(text, batch, archName, modelFailures\) \{[\s\S]*?\n\}\n\s*function fallbackDecision\(id\) \{[^\n]*\}\n/,
  `function parseDecisions(text, batch, archName) {
  let parsed;
  try { parsed = JSON.parse(extractJson(text)); }
  catch (error) { throw new Error(\`\${archName} returned malformed JSON: \${error.message}\`); }
  if (!Array.isArray(parsed.decisions)) throw new Error(\`\${archName} response has no decisions array\`);
  if (parsed.decisions.length !== batch.length) throw new Error(\`\${archName} returned \${parsed.decisions.length} ordered decisions for \${batch.length} observations\`);
  const map = new Map();
  for (let i = 0; i < batch.length; i++) {
    const ep = batch[i];
    const raw = parsed.decisions[i];
    if (!Array.isArray(raw?.ranking) || raw.ranking.length !== ACTIONS.length) throw new Error(\`\${archName} returned an incomplete ranking at ordered index \${i}\`);
    const normalized = raw.ranking.map(v => String(v).toUpperCase());
    if (new Set(normalized).size !== ACTIONS.length || normalized.some(v => !ACTIONS.includes(v))) throw new Error(\`\${archName} returned an invalid ranking at ordered index \${i}\`);
    map.set(ep.id, {
      episodeId: ep.id,
      familyId: ep.familyId,
      ranking: normalized,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : ''
    });
  }
  return map;
}
`
);
replaceOne(
  'zero failure gate',
  /sameModelCalls:ARCHES\.every\(a=>aggregateMetrics\[a\]\.modelCalls===aggregateMetrics\.stateforge\.modelCalls\)/,
  `sameModelCalls:ARCHES.every(a=>aggregateMetrics[a].modelCalls===aggregateMetrics.stateforge.modelCalls),zeroModelOrParserFailures:runs.every(r=>ARCHES.every(a=>r.metrics[a].modelFailures===0&&r.budgets[a].errors.length===0))`
);

fs.writeFileSync(output, source);
execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' });
console.log(`LOCAL_SINGLE_EVALUATOR_SHA256 ${crypto.createHash('sha256').update(source).digest('hex')}`);
await import(`${pathToFileURL(output).href}?local-single=1`);
