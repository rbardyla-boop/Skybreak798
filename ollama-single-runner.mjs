#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.dirname(new URL(import.meta.url).pathname);
const input = path.join(root, 'local-single-runner.mjs');
const output = path.join(root, '.ollama-single-adapter.mjs');
let source = fs.readFileSync(input, 'utf8');

function replaceOne(label, pattern, replacement) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`Ollama adapter patch ${label} expected exactly one match`);
  }
  source = source.replace(pattern, replacement);
}

replaceOne(
  'evaluator version',
  /stateforge-local-single-observation-v1/,
  'stateforge-local-single-observation-v2-ollama-schema'
);

replaceOne(
  'native Ollama base URL',
  /http:\/\/127\.0\.0\.1:11434\/v1/,
  'http://127.0.0.1:11434/api'
);

replaceOne(
  'decision cardinality metadata',
  /metadata: \{ runIndex, ordinal: batchIndex, archName \}/,
  'metadata: { runIndex, ordinal: batchIndex, archName, decisionCount: publicBatch.length }'
);

replaceOne(
  'native chat endpoint',
  /this\.endpoint = this\.baseUrl\.endsWith\('\/chat\/completions'\) \? this\.baseUrl : this\.baseUrl \+ '\/chat\/completions';/,
  "this.endpoint = this.baseUrl.endsWith('/chat') ? this.baseUrl : this.baseUrl + '/chat';"
);

replaceOne(
  'schema constrained request',
  /      const requestBody = \{\n        model: this\.model,\n        messages: \[\{ role: 'system', content: system \}, \{ role: 'user', content: user \}\],\n        temperature: 0,\n        max_tokens: this\.requestOutputTokens,\n        stream: false\n      \};\n      if \(this\.jsonMode\) requestBody\.response_format = \{ type: 'json_object' \};/,
  `      const legalRankings = [];
      for (const a of ACTIONS) for (const b of ACTIONS) for (const c of ACTIONS) for (const d of ACTIONS) {
        if (new Set([a, b, c, d]).size === ACTIONS.length) legalRankings.push([a, b, c, d]);
      }
      const decisionCount = Math.max(1, Number(metadata?.decisionCount ?? 1));
      const outputSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          decisions: {
            type: 'array',
            minItems: decisionCount,
            maxItems: decisionCount,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ranking: { type: 'array', enum: legalRankings },
                note: { type: 'string', maxLength: 500 }
              },
              required: ['ranking', 'note']
            }
          }
        },
        required: ['decisions']
      };
      const requestBody = {
        model: this.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: false,
        options: {
          temperature: 0,
          seed: 0,
          num_predict: this.requestOutputTokens
        }
      };
      if (this.jsonMode) requestBody.format = outputSchema;`
);

replaceOne(
  'native response content',
  /const text = body\.choices\?\.\[0\]\?\.message\?\.content \?\? '';/,
  "const text = body.message?.content ?? '';"
);

replaceOne(
  'native empty response error',
  /Local model response contained no choices\[0\]\.message\.content/,
  'Ollama response contained no message.content'
);

replaceOne(
  'native token usage',
  /inputTokens: body\.usage\?\.prompt_tokens \?\? estimateTokens\(system \+ user\),\n        outputTokens: body\.usage\?\.completion_tokens \?\? estimateTokens\(text\),/,
  `inputTokens: body.prompt_eval_count ?? estimateTokens(system + user),
        outputTokens: body.eval_count ?? estimateTokens(text),`
);

fs.writeFileSync(output, source);
execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' });
console.log(`OLLAMA_SCHEMA_ADAPTER_SHA256 ${crypto.createHash('sha256').update(source).digest('hex')}`);
await import(`${pathToFileURL(output).href}?ollama-schema=1`);
