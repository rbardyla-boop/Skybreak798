#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const scoreLauncherPath = path.join(root, 'ollama-score-runner.mjs');
const transformPath = path.join(root, '.ollama-direct-choice-transform.mjs');
const launcher = fs.readFileSync(scoreLauncherPath, 'utf8');
const payloadMatch = launcher.match(/const payload = '([^']+)'/);
if (!payloadMatch) throw new Error('Could not locate compressed v3 score adapter payload');

let transform = zlib.gunzipSync(Buffer.from(payloadMatch[1], 'base64')).toString('utf8');

function replaceOne(label, pattern, replacement) {
  const matches = transform.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`Direct-choice launcher patch ${label} expected exactly one match`);
  }
  transform = transform.replace(pattern, replacement);
}

function replaceNamedBlock(oldLabel, newLabel, patternSource, replacementSource) {
  const escaped = oldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`replaceOne\\(\\n  '${escaped}',[\\s\\S]*?\\n\\);`);
  const block = [
    'replaceOne(',
    `  '${newLabel}',`,
    `  ${patternSource},`,
    `  ${JSON.stringify(replacementSource)}`,
    ');'
  ].join('\n');
  replaceOne(`block ${oldLabel}`, pattern, block);
}

replaceOne('generated evaluator path', /\.ollama-score-sensitivity\.mjs/g, '.ollama-direct-choice-sensitivity.mjs');
replaceOne('version', /stateforge-local-score-sensitivity-v3/g, 'stateforge-local-direct-choice-sensitivity-v4');
replaceOne('protocol commitment', /alias-randomized-scores-v1/g, 'alias-randomized-direct-top2-v1');
replaceOne('tool name', /score_actions/g, 'choose_actions');
replaceOne(
  'protocol description',
  /four numeric scores; evaluator ranks with randomized tie order/g,
  'two distinct alias choices; evaluator appends remaining aliases in randomized hidden order'
);
replaceOne('configuration wording', /Score sensitivity evaluator/g, 'Direct-choice sensitivity evaluator');
replaceOne('missing decision wording', /Missing score decision/g, 'Missing direct-choice decision');
replaceOne('hash label', /OLLAMA_SCORE_SENSITIVITY_SHA256/g, 'OLLAMA_DIRECT_CHOICE_SHA256');
replaceOne('import query', /score-sensitivity=1/g, 'direct-choice=1');
replaceOne('adapter error name', /Score adapter patch/g, 'Direct-choice adapter patch');

const promptReplacement = [
  'function buildPrompt({ archName, arch, publicBatch, ordinal, runIndex, aliasPlan }) {',
  '  const commonSystem = [',
  "    'You are the single shared decision model in a paired hidden-rule benchmark.',",
  "    'Choose the best temporary action alias for the first attempt and a different alias for the backup attempt.',",
  "    'The evaluator tries first, then second only if first is rejected.',",
  "    'A rejected action means only that it is not the hidden correct action.',",
  "    'All competitors receive identical public observations, aliases, action limit, model, temperature, token ceiling and wall-time ceiling.',",
  "    'Known rule grammar: each family is one fixed hidden program chosen from linear, gate, xor, or permLinear. At ruleCue 1, one parameter mutates.',",
  "    'Use only supplied evidence. first and second must be different and each must be exactly one of A, B, C or D.',",
  "    'Return only a JSON object with exactly three keys: first, second and note.',",
  "    'Do not assign numeric scores, do not return a ranking array and do not write prose outside JSON.'",
  "  ].join('\\n');",
  '',
  '  const baseUser = [',
  '    `RUN ${runIndex + 1}; EPISODE INDEX ${ordinal}.`,',
  '    `ARCHITECTURE WRAPPER: ${archName}.`,',
  '    arch.promptCard(publicBatch),',
  "    'PUBLIC OBSERVATION:',",
  '    JSON.stringify(publicBatch[0]),',
  '    `AVAILABLE ALIASES (display order only): ${aliasPlan.schemaOrder.join(\', \')}.`,',
  "    'Choose the best first attempt and one different backup attempt.',",
  "    'Return the JSON object now.'",
  "  ].join('\\n\\n');",
  '',
  '  return {',
  '    system: commonSystem,',
  '    user: aliasText(baseUser, aliasPlan)',
  '  };',
  '}',
  '',
  'class StateForgeArchitecture'
].join('\n');

replaceNamedBlock(
  'score prompt',
  'direct-choice prompt',
  "/function buildPrompt\\(\\{ archName, arch, publicBatch, ordinal, runIndex \\}\\) \\{[\\s\\S]*?\\n\\}\\n\\nclass StateForgeArchitecture/",
  promptReplacement
);

const clientReplacement = [
  'class ModelClient {',
  '  constructor({ provider, model, apiKey, baseUrl, maxRequests, requestOutputTokens, requestTimeoutMs, globalRequestGapMs }) {',
  '    this.provider = provider;',
  '    this.model = model;',
  '    this.apiKey = apiKey;',
  "    this.baseUrl = String(baseUrl).replace(/\\/+$/, '');",
  "    this.endpoint = this.baseUrl.endsWith('/chat') ? this.baseUrl : this.baseUrl + '/chat';",
  '    this.maxRequests = maxRequests;',
  '    this.requestOutputTokens = requestOutputTokens;',
  '    this.requestTimeoutMs = requestTimeoutMs;',
  '    this.globalRequestGapMs = globalRequestGapMs;',
  '    this.requests = 0;',
  '    this.lastRequestAt = 0;',
  '    this.ledger = [];',
  '  }',
  '',
  '  async complete({ system, user, metadata }) {',
  '    if (this.requests >= this.maxRequests) throw new Error(`global model request cap ${this.maxRequests} reached`);',
  '    const wait = this.globalRequestGapMs - (Date.now() - this.lastRequestAt);',
  '    if (wait > 0) await sleep(wait);',
  '    this.requests++;',
  '    this.lastRequestAt = Date.now();',
  '    const started = performance.now();',
  '    const controller = new AbortController();',
  '    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);',
  "    let bodyText = '';",
  '',
  '    try {',
  "      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };",
  '      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;',
  '      const response = await fetch(this.endpoint, {',
  "        method: 'POST',",
  '        headers,',
  '        body: JSON.stringify({',
  '          model: this.model,',
  "          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],",
  '          stream: false,',
  "          format: 'json',",
  '          options: {',
  '            temperature: 0,',
  '            seed: 0,',
  '            num_predict: this.requestOutputTokens',
  '          }',
  '        }),',
  '        signal: controller.signal',
  '      });',
  '',
  '      bodyText = await response.text();',
  '      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${bodyText.slice(0, 1200)}`);',
  '      const body = JSON.parse(bodyText);',
  "      const text = body.message?.content ?? '';",
  "      if (!text) throw new Error('Ollama response contained no message.content');",
  '      const out = {',
  '        text,',
  '        inputTokens: body.prompt_eval_count ?? estimateTokens(system + user),',
  '        outputTokens: body.eval_count ?? estimateTokens(text),',
  '        latencyMs: performance.now() - started,',
  '        requestId: null',
  '      };',
  '      this.ledger.push({',
  '        ...metadata,',
  '        request: this.requests,',
  '        ...withoutText(out),',
  '        responseHash: sha256(text),',
  '        rawResponse: text',
  '      });',
  '      return out;',
  '    } catch (error) {',
  '      const out = {',
  "        text: '',",
  '        inputTokens: 0,',
  '        outputTokens: 0,',
  '        latencyMs: performance.now() - started,',
  '        error: serializeError(error),',
  '        httpBodyHash: bodyText ? sha256(bodyText) : null',
  '      };',
  '      this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out), rawHttpBody: bodyText.slice(0, 4000) });',
  '      throw error;',
  '    } finally {',
  '      clearTimeout(timer);',
  '    }',
  '  }',
  '}',
  '',
  'function parseDecisions'
].join('\n');

replaceNamedBlock(
  'native ollama score client',
  'native ollama direct-choice client',
  '/class ModelClient \\{[\\s\\S]*?\\n\\}\\n\\nfunction parseDecisions/',
  clientReplacement
);

const parserReplacement = [
  'function parseDecisions(text, batch, archName, aliasPlan) {',
  "  if (batch.length !== 1) throw new Error('direct-choice parser requires exactly one observation');",
  '  let parsed;',
  '  try { parsed = JSON.parse(extractJson(text)); }',
  '  catch (error) { throw new Error(`${archName} returned malformed direct-choice JSON: ${error.message}`); }',
  '',
  "  const first = String(parsed?.first ?? '').toUpperCase();",
  "  const second = String(parsed?.second ?? '').toUpperCase();",
  "  if (!ALIASES.includes(first)) throw new Error(`${archName} returned invalid first alias: ${first || '<empty>'}`);",
  "  if (!ALIASES.includes(second)) throw new Error(`${archName} returned invalid second alias: ${second || '<empty>'}`);",
  "  if (first === second) throw new Error(`${archName} returned duplicate first and second aliases: ${first}`);",
  '',
  '  const remaining = aliasPlan.tieOrder.filter(alias => alias !== first && alias !== second);',
  '  const aliasRanking = [first, second, ...remaining];',
  '  const ranking = aliasRanking.map(alias => aliasPlan.aliasToAction[alias]);',
  '  const ep = batch[0];',
  '',
  '  return new Map([[ep.id, {',
  '    episodeId: ep.id,',
  '    familyId: ep.familyId,',
  '    ranking,',
  '    aliasRanking,',
  '    first,',
  '    second,',
  "    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 500) : ''",
  '  }]]);',
  '}',
  '',
  'function makeAliasPlan(rng, episodeId) {',
  '  const actionOrder = shuffle(rng, [...ACTIONS]);',
  '  const aliasOrder = shuffle(rng, [...ALIASES]);',
  '  const aliasToAction = Object.fromEntries(aliasOrder.map((alias, i) => [alias, actionOrder[i]]));',
  '  const actionToAlias = Object.fromEntries(Object.entries(aliasToAction).map(([alias, action]) => [action, alias]));',
  '  return {',
  '    episodeId,',
  '    aliasToAction,',
  '    actionToAlias,',
  '    schemaOrder: shuffle(rng, [...ALIASES]),',
  '    tieOrder: shuffle(rng, [...ALIASES])',
  '  };',
  '}',
  '',
  'function aliasText(text, aliasPlan) {',
  '  let out = String(text);',
  '  const placeholders = {};',
  '  for (const action of ACTIONS) {',
  '    const placeholder = `__ACTION_ALIAS_${action}__`;',
  '    placeholders[action] = placeholder;',
  '    out = out.split(action).join(placeholder);',
  '  }',
  '  for (const action of ACTIONS) {',
  '    out = out.split(placeholders[action]).join(aliasPlan.actionToAlias[action]);',
  '  }',
  '  return out;',
  '}',
  ''
].join('\n');

replaceNamedBlock(
  'score parser and alias helpers',
  'direct-choice parser and alias helpers',
  '/function parseDecisions\\(text, batch, archName, modelFailures\\) \\{[\\s\\S]*?\\n\\}\\n\\s*function fallbackDecision\\(id\\) \\{[^\\n]*\\}\\n/',
  parserReplacement
);

const evidenceReplacement = [
  'modelRanking: ranking,',
  '    aliasRanking: decision.aliasRanking,',
  '    modelChoice: { first: decision.first, second: decision.second },',
  '    controlTransitionsLogged: transitions.length'
].join('\n');

replaceNamedBlock(
  'episode score evidence',
  'episode direct-choice evidence',
  '/modelRanking: ranking, controlTransitionsLogged: transitions\\.length/',
  evidenceReplacement
);

fs.writeFileSync(transformPath, transform);
execFileSync(process.execPath, ['--check', transformPath], { stdio: 'inherit' });
console.log(`OLLAMA_DIRECT_CHOICE_TRANSFORM_SHA256 ${crypto.createHash('sha256').update(transform).digest('hex')}`);
await import(`${pathToFileURL(transformPath).href}?direct-choice-transform=1`);
