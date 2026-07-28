#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ACTIONS = ['EMBER', 'TIDE', 'LENS', 'GATE'];
const ARCHES = ['stateforge', 'loop', 'static'];
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const SCHEMA_NAMES = ['linear', 'gate', 'xor', 'permLinear'];
const EVAL_VERSION = 'stateforge-equal-model-v1';
const argv = parseArgs(process.argv.slice(2));
const provider = argv.provider ?? (process.env.GITHUB_TOKEN ? 'github-models' : 'mock');
const model = argv.model ?? DEFAULT_MODEL;
const runCount = intArg(argv.runs, 3);
const outputDir = path.resolve(argv.output ?? 'artifacts/stateforge-equal-model');
const maxAttemptsPerEpisode = intArg(argv.actions, 2);
const requestOutputTokens = intArg(argv.maxOutputTokens, 2400);
const requestTimeoutMs = intArg(argv.requestTimeoutMs, 90000);
const maxRequests = intArg(argv.maxRequests, 140);
const globalRequestGapMs = intArg(argv.requestGapMs, provider === 'github-models' ? 4300 : 0);
const familyCount = 8;
const episodesPerRun = 100;
const maxOrdinal = 13;
const tokenLimits = Object.freeze({ input: 96000, output: 30000 });
const wallLimitMs = 22 * 60 * 1000;

fs.mkdirSync(outputDir, { recursive: true });

const runStarted = new Date().toISOString();
const commitSha = process.env.GITHUB_SHA ?? null;
const workflowRunId = process.env.GITHUB_RUN_ID ?? null;
const repository = process.env.GITHUB_REPOSITORY ?? null;
const sourceHash = sha256(fs.readFileSync(new URL(import.meta.url)));
const releaseCommitment = sha256(JSON.stringify({ evaluator: EVAL_VERSION, sourceHash, model, runCount, familyCount, episodesPerRun, maxAttemptsPerEpisode, tokenLimits, wallLimitMs, commitSha }));

const globalCandidates = buildCandidateLibrary();
const devSeed = sha256Buffer(`stateforge-static-dev-v1|${sourceHash}`);
const staticTuning = tuneStaticGraph(devSeed, globalCandidates);
let api;

const experiment = {
  schemaVersion: 1, evaluator: EVAL_VERSION, status: 'running', startedAt: runStarted, completedAt: null,
  provider, model, repository, commitSha, workflowRunId, sourceHash, releaseCommitment,
  design: {
    paired: true,
    blindLabels: { A: 'sealed-until-analysis', B: 'sealed-until-analysis', C: 'sealed-until-analysis' },
    runs: runCount, episodesPerRun, familiesPerRun: familyCount, totalPairedEpisodesPlanned: runCount * episodesPerRun,
    sameModel: model, temperature: 0, commonTool: 'rank_actions', actions: ACTIONS,
    actionLimitPerEpisode: maxAttemptsPerEpisode, modelCallsPerArchitecturePerRun: maxOrdinal,
    inputTokenLimitPerArchitecturePerRun: tokenLimits.input, outputTokenLimitPerArchitecturePerRun: tokenLimits.output,
    activeWallTimeLimitPerArchitecturePerRunMs: wallLimitMs, observationsIdenticalByPair: true,
    unpublishedHoldout: 'Family parameters generated from runner-local cryptographic randomness after the frozen evaluator commit starts. Parameters are held only inside the evaluator until artifacts are written after scoring.',
    familyGrammarDisclosedEqually: SCHEMA_NAMES,
    confidenceInterval: 'paired cluster bootstrap over run-family clusters, 20,000 resamples',
    staticGraphTuning: staticTuning.summary
  },
  environment: { node: process.version, runnerName: process.env.RUNNER_NAME ?? null, runnerOs: process.env.RUNNER_OS ?? process.platform, runnerArch: process.env.RUNNER_ARCH ?? process.arch },
  requestLedger: [], runs: [], aggregate: null, errors: []
};

async function main() {
  api = new ModelClient({ provider, model, token: process.env.GITHUB_TOKEN, maxRequests, requestOutputTokens, requestTimeoutMs, globalRequestGapMs });
  writeJson('run-manifest.json', experiment);
  console.log(`STATEFORGE_RELEASE_COMMITMENT ${releaseCommitment}`);
  console.log(`Evaluator ${EVAL_VERSION}; candidates=${globalCandidates.length}; static=${staticTuning.program.id}`);
  try {
    for (let runIndex = 0; runIndex < runCount; runIndex++) {
      const result = await executeRun(runIndex);
      experiment.runs.push(result);
      writeJson('partial-results.json', experiment);
    }
    experiment.aggregate = analyse(experiment.runs);
    experiment.status = experiment.aggregate.gates.allPassed ? 'passed' : 'completed-gates-failed';
  } catch (error) {
    experiment.status = 'failed';
    experiment.errors.push(serializeError(error));
    console.error(error);
  } finally {
    experiment.completedAt = new Date().toISOString();
    experiment.requestLedger = api.ledger;
    if (experiment.runs.length && !experiment.aggregate) experiment.aggregate = analyse(experiment.runs);
    writeJson('results.json', experiment);
    fs.writeFileSync(path.join(outputDir, 'report.md'), renderReport(experiment));
    fs.writeFileSync(path.join(outputDir, 'checksums.sha256'), checksums(outputDir));
  }
  if (experiment.status === 'failed') process.exitCode = 1;
}

async function executeRun(runIndex) {
  const sealedSeed = crypto.randomBytes(32);
  const seedCommitment = sha256(sealedSeed);
  console.log(`RUN ${runIndex + 1} SEED_COMMITMENT ${seedCommitment}`);
  const rng = makeRng(sealedSeed);
  const specs = buildSealedRun(rng, runIndex);
  const architectures = {
    stateforge: new StateForgeArchitecture(globalCandidates, specs.families),
    loop: new LoopArchitecture(specs.families),
    static: new StaticArchitecture(staticTuning.program, specs.families)
  };
  const budgets = Object.fromEntries(ARCHES.map(name => [name, new Budget(name)]));
  const episodes = Object.fromEntries(ARCHES.map(name => [name, []]));
  const transitions = Object.fromEntries(ARCHES.map(name => [name, []]));
  const modelFailures = Object.fromEntries(ARCHES.map(name => [name, 0]));
  const orderSchedule = [];

  for (let ordinal = 0; ordinal < maxOrdinal; ordinal++) {
    const publicBatch = specs.episodes.filter(e => e.ordinal === ordinal).map(publicEpisode);
    if (!publicBatch.length) continue;
    const order = rotate(ARCHES, (runIndex + ordinal) % ARCHES.length);
    orderSchedule.push({ ordinal, order });
    const decisionsByArch = {};
    for (const archName of order) {
      const budget = budgets[archName]; budget.assertWithin();
      const prompt = buildPrompt({ archName, arch: architectures[archName], publicBatch, ordinal, runIndex });
      const callStarted = performance.now();
      let response;
      try { response = await api.complete({ system: prompt.system, user: prompt.user, metadata: { runIndex, ordinal, archName } }); }
      catch (error) { modelFailures[archName]++; response = { text: '', inputTokens: 0, outputTokens: 0, latencyMs: performance.now() - callStarted, error: serializeError(error) }; }
      budget.consumeCall(response);
      decisionsByArch[archName] = parseDecisions(response.text, publicBatch, archName, modelFailures);
      if (archName === 'loop') architectures.loop.setNotes(decisionsByArch[archName]);
    }
    for (const episodeSpec of specs.episodes.filter(e => e.ordinal === ordinal)) {
      for (const archName of ARCHES) {
        const arch = architectures[archName], budget = budgets[archName];
        const decision = decisionsByArch[archName].get(episodeSpec.id) ?? fallbackDecision(episodeSpec.id);
        const result = playEpisode({ episodeSpec, archName, arch, decision, budget, runIndex });
        episodes[archName].push(result.episode); transitions[archName].push(...result.transitions); arch.observeEpisode(result.episode, result.transitions);
      }
    }
  }

  const integrity = {};
  for (const archName of ARCHES) integrity[archName] = {
    actionCount: episodes[archName].reduce((n, e) => n + e.actionsUsed, 0), transitionLogCount: transitions[archName].length,
    unloggedControlTransitions: episodes[archName].reduce((n, e) => n + e.actionsUsed, 0) - transitions[archName].length,
    duplicateTransitionIds: countDuplicates(transitions[archName].map(t => t.id)), pairedEpisodeCount: episodes[archName].length,
    counterexampleRegressions: archName === 'stateforge' ? architectures.stateforge.regressionCount() : null,
    machineVersions: archName === 'stateforge' ? architectures.stateforge.versionSnapshot() : null
  };
  const metrics = Object.fromEntries(ARCHES.map(name => [name, summarizeEpisodes(episodes[name], budgets[name], modelFailures[name])]));
  const blindMap = makeBlindMap(rng);
  const blinded = Object.fromEntries(Object.entries(blindMap).map(([label, arch]) => [label, metrics[arch]]));
  const sealedParameters = specs.families.map(f => ({ id: f.id, marker: f.marker, baseProgram: f.baseProgram, driftProgram: f.driftProgram, episodeCount: f.episodeCount, driftOrdinal: f.driftOrdinal }));
  return {
    runIndex, seedCommitment, seedReveal: sealedSeed.toString('hex'), familyParametersReleasedAfterScoring: sealedParameters,
    familySpecsHash: sha256(JSON.stringify(sealedParameters)), orderSchedule, blindMap, blinded, metrics,
    budgets: Object.fromEntries(ARCHES.map(name => [name, budgets[name].snapshot()])), integrity, episodes, transitions,
    stateforgeMachines: architectures.stateforge.exportMachines(), loopMemories: architectures.loop.exportMemories(), staticGraph: staticTuning.program
  };
}

function playEpisode({ episodeSpec, archName, arch, decision, budget, runIndex }) {
  const transitions = [], expected = evaluateProgram(episodeSpec.program, episodeSpec.observation), ranking = normalizeRanking(decision.ranking);
  let completed = false, actionsUsed = 0, invalidActions = 0; const attempted = [];
  for (const action of ranking.slice(0, maxAttemptsPerEpisode)) {
    budget.consumeAction(); actionsUsed++; attempted.push(action);
    const accepted = action === ACTIONS[expected]; if (!accepted) invalidActions++;
    const event = {
      id: `r${runIndex}-e${episodeSpec.id}-${archName}-a${actionsUsed}`, runIndex, episodeId: episodeSpec.id, familyId: episodeSpec.familyId,
      ordinal: episodeSpec.ordinal, arch: archName, observation: episodeSpec.observation, action, accepted, actionIndex: actionsUsed - 1,
      ruleCue: episodeSpec.observation.ruleCue, timestampLogical: `${runIndex}:${episodeSpec.ordinal}:${episodeSpec.familyId}:${actionsUsed}`
    };
    transitions.push(event); arch.observeTransition(event); if (accepted) { completed = true; break; }
  }
  return { episode: { id: episodeSpec.id, familyId: episodeSpec.familyId, ordinal: episodeSpec.ordinal, marker: episodeSpec.marker, observation: episodeSpec.observation, expectedActionHash: sha256(ACTIONS[expected]), completed, actionsUsed, invalidActions, attempted, modelRanking: ranking, controlTransitionsLogged: transitions.length }, transitions };
}

function buildPrompt({ archName, arch, publicBatch, ordinal, runIndex }) {
  const commonSystem = [
    'You are the single shared decision model in a paired hidden-rule benchmark.',
    'Your only tool is rank_actions. For every episode, return a complete ranking of the four action labels.',
    'The evaluator tries at most the first two ranked actions. A rejected action means only that it is not the hidden correct action.',
    'All competitors receive the exact same public observations, action labels, action limit, model, temperature, token ceiling and active wall-time ceiling.',
    'Known rule grammar: each family is one fixed hidden program chosen from linear, gate, xor, or permLinear. At ruleCue 1, one parameter mutates. Family parameters and correct actions are hidden.',
    'Use only supplied evidence. Never invent an action outside EMBER, TIDE, LENS, GATE.',
    'Return strict JSON with shape {"decisions":[{"episodeId":"...","ranking":["EMBER","TIDE","LENS","GATE"],"note":"optional compact memory"}]}.',
    'Every ranking must contain each action exactly once. No prose outside JSON.'
  ].join('\n');
  return { system: commonSystem, user: [`RUN ${runIndex + 1}; ORDINAL ${ordinal}.`, `ARCHITECTURE WRAPPER: ${archName}.`, arch.promptCard(publicBatch), 'PUBLIC OBSERVATIONS (identical across all wrappers):', JSON.stringify(publicBatch), 'Return one decision for every episodeId.'].join('\n\n') };
}

class StateForgeArchitecture {
  constructor(candidates, families) { this.machines = new Map(families.map(f => [f.id, new VersionedMachine(f.id, candidates)])); }
  promptCard(batch) { return ['Use an explicit, versioned StateForge statechart. Prefer its hard guards and candidate votes; repair only from logged transition evidence.', 'LIVE MACHINE CARDS:', JSON.stringify(batch.map(ep => this.machines.get(ep.familyId).card(ep.observation)))].join('\n'); }
  observeTransition(event) { this.machines.get(event.familyId).apply(event); }
  observeEpisode() {}
  regressionCount() { return [...this.machines.values()].reduce((n, m) => n + m.regressionCount(), 0); }
  versionSnapshot() { return Object.fromEntries([...this.machines].map(([id, m]) => [id, m.version])); }
  exportMachines() { return Object.fromEntries([...this.machines].map(([id, m]) => [id, m.export()])); }
}
class LoopArchitecture {
  constructor(families) { this.memories = new Map(families.map(f => [f.id, { traces: [], note: '' }])); }
  promptCard(batch) { return ['You are an unrestricted observe-think-act loop. You may infer any rule from raw traces and keep an unstructured compact scratchpad. No explicit statechart is supplied.', 'RAW LOOP MEMORY:', JSON.stringify(batch.map(ep => { const m = this.memories.get(ep.familyId); return { familyId: ep.familyId, scratchpad: m.note, rawRecentTransitions: m.traces.slice(-36) }; }))].join('\n'); }
  observeTransition(event) { this.memories.get(event.familyId).traces.push({ o: event.observation, a: event.action, ok: event.accepted }); }
  observeEpisode() {}
  setNotes(decisions) { for (const d of decisions.values()) if (d.familyId && d.note && this.memories.has(d.familyId)) this.memories.get(d.familyId).note = String(d.note).slice(0, 500); }
  exportMemories() { return Object.fromEntries(this.memories); }
}
class StaticArchitecture {
  constructor(program) { this.program = program; }
  promptCard(batch) { return ['Use this competitively tuned but immutable static graph. It never learns from episode outcomes and has no mutable memory.', `STATIC GRAPH: ${JSON.stringify(this.program)}`, `STATIC RECOMMENDATIONS: ${JSON.stringify(batch.map(ep => ({ episodeId: ep.id, fixedGraphRecommendation: ACTIONS[evaluateProgram(this.program, ep.observation)] })))}`].join('\n'); }
  observeTransition() {} observeEpisode() {}
}
class VersionedMachine {
  constructor(familyId, candidates) {
    this.familyId = familyId; this.library = candidates;
    this.byCue = new Map([[0, candidates.map((_, i) => i)], [1, candidates.map((_, i) => i)]]);
    this.evidence = []; this.rejections = new Map(); this.version = 1;
    this.revisions = [{ version: 1, reason: 'initial grammar hypothesis set', evidenceCount: 0 }];
  }
  key(obs) { return `${obs.stage}|${obs.glyph}|${obs.polarity}|${obs.cadence}|${obs.phase}|${obs.ruleCue}`; }
  prediction(obs) {
    const ids = this.byCue.get(obs.ruleCue) ?? [], votes = [0,0,0,0], schemas = {};
    for (const id of ids) { const p = this.library[id]; votes[evaluateProgram(p, obs)]++; schemas[p.schema] = (schemas[p.schema] ?? 0) + 1; }
    const forbidden = this.rejections.get(this.key(obs)) ?? new Set();
    const order = [0,1,2,3].sort((a,b) => votes[b] - votes[a] || a - b);
    const guarded = [...order.filter(i => !forbidden.has(i)), ...order.filter(i => forbidden.has(i))], total = Math.max(1, ids.length);
    return { actionIndex: guarded[0], ranking: guarded.map(i => ACTIONS[i]), votes: Object.fromEntries(ACTIONS.map((a,i) => [a, +(votes[i]/total).toFixed(4)])), candidateCount: ids.length, schemaMass: Object.fromEntries(Object.entries(schemas).map(([k,v]) => [k, +(v/total).toFixed(4)])), hardForbidden: [...forbidden].map(i => ACTIONS[i]) };
  }
  card(obs) { const p = this.prediction(obs); return { familyId: this.familyId, statechartVersion: this.version, state: `cue-${obs.ruleCue}`, recommendation: ACTIONS[p.actionIndex], ranking: p.ranking, candidateCount: p.candidateCount, voteConfidence: p.votes, schemaMass: p.schemaMass, hardForbidden: p.hardForbidden, retainedCounterexamples: this.evidence.filter(e => !e.accepted).length, recentEvidence: this.evidence.slice(-18).map(e => ({ o: e.observation, a: e.action, ok: e.accepted })), lastRevision: this.revisions.at(-1) }; }
  apply(event) {
    const cue = event.observation.ruleCue, before = this.prediction(event.observation);
    if (!event.accepted) { const key = this.key(event.observation); if (!this.rejections.has(key)) this.rejections.set(key, new Set()); this.rejections.get(key).add(ACTIONS.indexOf(event.action)); }
    this.evidence.push({ observation: event.observation, action: event.action, accepted: event.accepted });
    const actionIndex = ACTIONS.indexOf(event.action), previous = this.byCue.get(cue) ?? [];
    let filtered = previous.filter(id => { const predicted = evaluateProgram(this.library[id], event.observation); return event.accepted ? predicted === actionIndex : predicted !== actionIndex; });
    let reason = event.accepted ? 'accepted transition narrowed guards' : 'counterexample rejected candidate transitions';
    if (!filtered.length) { filtered = this.rebuildCue(cue); reason = 'repair rebuilt cue branch from retained evidence'; }
    this.byCue.set(cue, filtered); const after = this.prediction(event.observation);
    if (filtered.length !== previous.length || before.actionIndex !== after.actionIndex) { this.version++; this.revisions.push({ version: this.version, reason, evidenceCount: this.evidence.length, cue, candidates: filtered.length }); }
  }
  rebuildCue(cue) {
    const relevant = this.evidence.filter(e => e.observation.ruleCue === cue), retained = [];
    for (let id = 0; id < this.library.length; id++) { const p = this.library[id]; let ok = true; for (const e of relevant) { const pred = evaluateProgram(p, e.observation), ai = ACTIONS.indexOf(e.action); if ((e.accepted && pred !== ai) || (!e.accepted && pred === ai)) { ok = false; break; } } if (ok) retained.push(id); }
    return retained.length ? retained : this.library.map((_, i) => i);
  }
  regressionCount() { let count = 0; for (const e of this.evidence) if (!e.accepted && this.prediction(e.observation).actionIndex === ACTIONS.indexOf(e.action)) count++; return count; }
  export() { return { familyId: this.familyId, version: this.version, revisions: this.revisions, evidence: this.evidence, cueCandidateCounts: Object.fromEntries([...this.byCue].map(([k,v]) => [k,v.length])), regressions: this.regressionCount() }; }
}
class Budget {
  constructor(name) { this.name = name; this.actions = 0; this.modelCalls = 0; this.inputTokens = 0; this.outputTokens = 0; this.activeModelMs = 0; this.errors = []; }
  consumeAction() { this.actions++; }
  consumeCall(response) { this.modelCalls++; this.inputTokens += response.inputTokens ?? 0; this.outputTokens += response.outputTokens ?? 0; this.activeModelMs += response.latencyMs ?? 0; if (response.error) this.errors.push(response.error); this.assertWithin(); }
  assertWithin() { if (this.inputTokens > tokenLimits.input) throw new Error(`${this.name} input token limit exceeded`); if (this.outputTokens > tokenLimits.output) throw new Error(`${this.name} output token limit exceeded`); if (this.activeModelMs > wallLimitMs) throw new Error(`${this.name} active wall-time limit exceeded`); }
  snapshot() { return { actions: this.actions, modelCalls: this.modelCalls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, activeModelMs: Math.round(this.activeModelMs), limits: { inputTokens: tokenLimits.input, outputTokens: tokenLimits.output, activeWallMs: wallLimitMs, actionLimitPerEpisode: maxAttemptsPerEpisode }, errors: this.errors }; }
}
class ModelClient {
  constructor({ provider, model, token, maxRequests, requestOutputTokens, requestTimeoutMs, globalRequestGapMs }) { this.provider = provider; this.model = model; this.token = token; this.maxRequests = maxRequests; this.requestOutputTokens = requestOutputTokens; this.requestTimeoutMs = requestTimeoutMs; this.globalRequestGapMs = globalRequestGapMs; this.requests = 0; this.lastRequestAt = 0; this.ledger = []; if (provider === 'github-models' && !token) throw new Error('GITHUB_TOKEN is required for github-models provider'); }
  async complete({ system, user, metadata }) {
    if (this.requests >= this.maxRequests) throw new Error(`global model request cap ${this.maxRequests} reached`);
    const wait = this.globalRequestGapMs - (Date.now() - this.lastRequestAt); if (wait > 0) await sleep(wait);
    this.requests++; this.lastRequestAt = Date.now(); const started = performance.now();
    if (this.provider === 'mock') { const text = mockResponse(user), out = { text, inputTokens: estimateTokens(system + user), outputTokens: estimateTokens(text), latencyMs: performance.now() - started, requestId: `mock-${this.requests}` }; this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out), responseHash: sha256(text) }); return out; }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.requestTimeoutMs); let bodyText = '';
    try {
      const response = await fetch('https://models.github.ai/inference/chat/completions', { method: 'POST', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: this.requestOutputTokens }), signal: controller.signal });
      bodyText = await response.text(); if (!response.ok) throw new Error(`GitHub Models HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
      const body = JSON.parse(bodyText), text = body.choices?.[0]?.message?.content ?? '';
      const out = { text, inputTokens: body.usage?.prompt_tokens ?? estimateTokens(system + user), outputTokens: body.usage?.completion_tokens ?? estimateTokens(text), latencyMs: performance.now() - started, requestId: response.headers.get('x-github-request-id') ?? null };
      this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out), responseHash: sha256(text) }); return out;
    } catch (error) { const out = { text: '', inputTokens: 0, outputTokens: 0, latencyMs: performance.now() - started, error: serializeError(error), httpBodyHash: bodyText ? sha256(bodyText) : null }; this.ledger.push({ ...metadata, request: this.requests, ...withoutText(out) }); throw error; }
    finally { clearTimeout(timer); }
  }
}

function parseDecisions(text, batch, archName, modelFailures) {
  const map = new Map(); let parsed;
  try { parsed = JSON.parse(extractJson(text)); } catch { modelFailures[archName]++; parsed = { decisions: [] }; }
  for (const ep of batch) { const raw = Array.isArray(parsed.decisions) ? parsed.decisions.find(d => d.episodeId === ep.id) : null; map.set(ep.id, { episodeId: ep.id, familyId: ep.familyId, ranking: normalizeRanking(raw?.ranking), note: typeof raw?.note === 'string' ? raw.note.slice(0,500) : '' }); }
  return map;
}
function fallbackDecision(id) { return { episodeId: id, ranking: [...ACTIONS], note: '' }; }
function normalizeRanking(value) { const clean = Array.isArray(value) ? value.map(v => String(v).toUpperCase()).filter(v => ACTIONS.includes(v)) : []; return [...new Set(clean), ...ACTIONS.filter(a => !clean.includes(a))]; }
function buildSealedRun(rng, runIndex) {
  const counts = [13,13,13,13,12,12,12,12], families = [], episodes = [];
  for (let i = 0; i < familyCount; i++) {
    const schema = SCHEMA_NAMES[(i + runIndex) % SCHEMA_NAMES.length], baseProgram = randomProgram(schema, rng), driftProgram = mutateProgram(baseProgram, rng), id = `r${runIndex}-f${i}`, marker = crypto.randomBytes(4).toString('hex'), driftOrdinal = 8;
    const family = { id, marker, schema, baseProgram, driftProgram, episodeCount: counts[i], driftOrdinal }; families.push(family);
    for (let ordinal = 0; ordinal < counts[i]; ordinal++) { const ruleCue = ordinal >= driftOrdinal ? 1 : 0; const observation = { familyMarker: marker, stage: ordinal % 3, glyph: randInt(rng,4), polarity: randInt(rng,2), cadence: randInt(rng,2), phase: randInt(rng,4), ruleCue }; episodes.push({ id: `${id}-e${ordinal}`, familyId: id, marker, ordinal, observation, program: ruleCue ? driftProgram : baseProgram }); }
  }
  episodes.sort((a,b) => a.ordinal - b.ordinal || rng() - 0.5); return { families, episodes };
}
function publicEpisode(ep) { return { id: ep.id, familyId: ep.familyId, marker: ep.marker, ordinal: ep.ordinal, observation: ep.observation, actionLimit: maxAttemptsPerEpisode }; }
function buildCandidateLibrary() {
  const out = []; let id = 0;
  for (let a=0;a<4;a++) for (let b=0;b<4;b++) for (let c=0;c<4;c++) for (let d=0;d<4;d++) for (let o0=0;o0<4;o0++) for (let o1=0;o1<4;o1++) for (let o2=0;o2<4;o2++) out.push({ id:`p${id++}`, schema:'linear', a,b,c,d, offsets:[o0,o1,o2] });
  for (let alpha=0;alpha<4;alpha++) for (let same=0;same<4;same++) for (let diff=0;diff<4;diff++) for (let o0=0;o0<4;o0++) for (let o1=0;o1<4;o1++) for (let o2=0;o2<4;o2++) out.push({ id:`p${id++}`, schema:'gate', alpha,same,diff,offsets:[o0,o1,o2] });
  for (const perm of permutations([0,1,2,3])) for (let pm=0;pm<4;pm++) for (let cm=0;cm<4;cm++) for (let qm=0;qm<4;qm++) for (let sm=0;sm<4;sm++) out.push({ id:`p${id++}`, schema:'xor', perm,pm,cm,qm,sm });
  for (const perm of permutations([0,1,2,3])) for (let bp=0;bp<4;bp++) for (let bc=0;bc<4;bc++) for (let bq=0;bq<4;bq++) for (let bs=0;bs<4;bs++) out.push({ id:`p${id++}`, schema:'permLinear', perm,bp,bc,bq,bs });
  return out;
}
function evaluateProgram(p, o) { switch (p.schema) { case 'linear': return mod4(p.a*o.glyph + p.b*o.polarity + p.c*o.cadence + p.d*o.phase + p.offsets[o.stage]); case 'gate': return mod4(o.glyph + p.alpha*o.phase + p.offsets[o.stage] + (o.polarity===o.cadence ? p.same : p.diff)); case 'xor': return (p.perm[o.glyph] ^ (o.polarity*p.pm) ^ (o.cadence*p.cm) ^ ((o.phase*p.qm)&3) ^ ((o.stage*p.sm)&3)) & 3; case 'permLinear': return p.perm[mod4(o.glyph + p.bp*o.polarity + p.bc*o.cadence + p.bq*o.phase + p.bs*o.stage)]; default: throw new Error(`unknown schema ${p.schema}`); } }
function randomProgram(schema, rng) { if (schema === 'linear') return { id:'hidden', schema, a:randInt(rng,4), b:randInt(rng,4), c:randInt(rng,4), d:randInt(rng,4), offsets:[randInt(rng,4),randInt(rng,4),randInt(rng,4)] }; if (schema === 'gate') return { id:'hidden', schema, alpha:randInt(rng,4), same:randInt(rng,4), diff:randInt(rng,4), offsets:[randInt(rng,4),randInt(rng,4),randInt(rng,4)] }; if (schema === 'xor') return { id:'hidden', schema, perm:shuffle(rng,[0,1,2,3]), pm:randInt(rng,4), cm:randInt(rng,4), qm:randInt(rng,4), sm:randInt(rng,4) }; return { id:'hidden', schema, perm:shuffle(rng,[0,1,2,3]), bp:randInt(rng,4), bc:randInt(rng,4), bq:randInt(rng,4), bs:randInt(rng,4) }; }
function mutateProgram(program, rng) { const p = structuredClone(program), keys = Object.keys(p).filter(k => !['id','schema'].includes(k)), key = keys[randInt(rng, keys.length)]; if (Array.isArray(p[key])) { if (key === 'perm') { const i=randInt(rng,4); let j=randInt(rng,4); if (j===i) j=(j+1)%4; [p[key][i],p[key][j]]=[p[key][j],p[key][i]]; } else { const i=randInt(rng,p[key].length); p[key][i]=(p[key][i]+1+randInt(rng,3))%4; } } else p[key]=(p[key]+1+randInt(rng,3))%4; return p; }
function tuneStaticGraph(seed, candidates) { const rng = makeRng(seed), sampleCandidates = shuffle(rng, candidates.map((_,i)=>i)).slice(0,1536), dev=[]; for(let f=0;f<48;f++){const program=randomProgram(SCHEMA_NAMES[f%SCHEMA_NAMES.length],rng);for(let i=0;i<120;i++){const o={stage:randInt(rng,3),glyph:randInt(rng,4),polarity:randInt(rng,2),cadence:randInt(rng,2),phase:randInt(rng,4),ruleCue:0};dev.push({o,y:evaluateProgram(program,o)});}} let bestId=sampleCandidates[0],best=-1;for(const id of sampleCandidates){let score=0;for(const row of dev)if(evaluateProgram(candidates[id],row.o)===row.y)score++;if(score>best){best=score;bestId=id;}} return { program:candidates[bestId], summary:{method:'frozen random-search over 1,536 graph programs on 5,760 development transitions from all disclosed grammar schemas',developmentAccuracy:best/dev.length,candidateId:candidates[bestId].id,devSeedHash:sha256(seed)} }; }
function summarizeEpisodes(episodes,budget,failures){const n=episodes.length,completed=episodes.filter(e=>e.completed).length;return{episodes:n,completed,completionRate:n?completed/n:0,invalidActions:episodes.reduce((s,e)=>s+e.invalidActions,0),totalActions:episodes.reduce((s,e)=>s+e.actionsUsed,0),meanActions:n?episodes.reduce((s,e)=>s+e.actionsUsed,0)/n:0,modelFailures:failures,tokens:{input:budget.inputTokens,output:budget.outputTokens},activeModelMs:Math.round(budget.activeModelMs),modelCalls:budget.modelCalls};}
function analyse(runs){const rows=[];for(const run of runs)for(const arch of ARCHES)for(const ep of run.episodes[arch])rows.push({runIndex:run.runIndex,arch,...ep});const paired=[];for(const run of runs){const maps=Object.fromEntries(ARCHES.map(a=>[a,new Map(run.episodes[a].map(e=>[e.id,e]))]));for(const id of maps.stateforge.keys())paired.push({runIndex:run.runIndex,familyId:maps.stateforge.get(id).familyId,episodeId:id,stateforge:+maps.stateforge.get(id).completed,loop:+maps.loop.get(id).completed,static:+maps.static.get(id).completed});}const aggregateMetrics={};for(const arch of ARCHES){const eps=rows.filter(r=>r.arch===arch),completed=eps.reduce((s,e)=>s+e.completed,0);aggregateMetrics[arch]={episodes:eps.length,completed,completionRate:completed/Math.max(1,eps.length),invalidActions:eps.reduce((s,e)=>s+e.invalidActions,0),totalActions:eps.reduce((s,e)=>s+e.actionsUsed,0),inputTokens:runs.reduce((s,r)=>s+r.metrics[arch].tokens.input,0),outputTokens:runs.reduce((s,r)=>s+r.metrics[arch].tokens.output,0),activeModelMs:runs.reduce((s,r)=>s+r.metrics[arch].activeModelMs,0),modelCalls:runs.reduce((s,r)=>s+r.metrics[arch].modelCalls,0)};}const sfLoop=clusterBootstrap(paired,'stateforge','loop',20000),sfStatic=clusterBootstrap(paired,'stateforge','static',20000);const integrity={unloggedControlTransitions:runs.reduce((s,r)=>s+ARCHES.reduce((z,a)=>z+Math.abs(r.integrity[a].unloggedControlTransitions),0),0),duplicateTransitionIds:runs.reduce((s,r)=>s+ARCHES.reduce((z,a)=>z+r.integrity[a].duplicateTransitionIds,0),0),retainedCounterexampleRegressions:runs.reduce((s,r)=>s+r.integrity.stateforge.counterexampleRegressions,0)};const gates={enoughPairedEpisodes:paired.length>=200,stateforgeBeatsLoopPositive95CI:sfLoop.low>0,stateforgeBeatsStaticPositive95CI:sfStatic.low>0,fewerInvalidThanLoop:aggregateMetrics.stateforge.invalidActions<aggregateMetrics.loop.invalidActions,fewerInvalidThanStatic:aggregateMetrics.stateforge.invalidActions<aggregateMetrics.static.invalidActions,zeroUnloggedTransitions:integrity.unloggedControlTransitions===0,zeroCounterexampleRegression:integrity.retainedCounterexampleRegressions===0,sameModelCalls:ARCHES.every(a=>aggregateMetrics[a].modelCalls===aggregateMetrics.stateforge.modelCalls)};gates.allPassed=Object.values(gates).every(Boolean);return{totalPairedEpisodes:paired.length,metrics:aggregateMetrics,pairedCompletionDifference:{stateforgeMinusLoop:sfLoop,stateforgeMinusStatic:sfStatic},integrity,gates};}
function clusterBootstrap(rows,a,b,reps){if(!rows.length)return{estimate:0,low:0,high:0,reps:0,clusters:0};const clusters=new Map();for(const r of rows){const k=`${r.runIndex}|${r.familyId}`;if(!clusters.has(k))clusters.set(k,[]);clusters.get(k).push(r);}const arr=[...clusters.values()],estimate=rows.reduce((s,r)=>s+r[a]-r[b],0)/rows.length,rng=makeRng(sha256Buffer(`bootstrap|${a}|${b}|${rows.length}`)),vals=[];for(let z=0;z<reps;z++){let sum=0,n=0;for(let i=0;i<arr.length;i++){const c=arr[randInt(rng,arr.length)];for(const r of c){sum+=r[a]-r[b];n++;}}vals.push(sum/n);}vals.sort((x,y)=>x-y);return{estimate,low:quantile(vals,.025),high:quantile(vals,.975),reps,clusters:arr.length};}
function renderReport(exp){const a=exp.aggregate,lines=[`# StateForge equal-model sealed evaluation`,'',`Status: **${exp.status}**`,'',`Model: \`${exp.model}\` via \`${exp.provider}\``,`Frozen evaluator: \`${exp.sourceHash}\``,`Release commitment: \`${exp.releaseCommitment}\``,`Runs completed: ${exp.runs.length}/${exp.design.runs}`,''];if(!a)return lines.concat(['No aggregate result was produced.','','Errors:','```json',JSON.stringify(exp.errors,null,2),'```']).join('\n');lines.push('## Aggregate','','| Architecture | Completion | Invalid actions | Model calls | Input tokens | Output tokens | Active model time |','|---|---:|---:|---:|---:|---:|---:|');for(const arch of ARCHES){const m=a.metrics[arch];lines.push(`| ${arch} | ${(m.completionRate*100).toFixed(1)}% (${m.completed}/${m.episodes}) | ${m.invalidActions} | ${m.modelCalls} | ${m.inputTokens} | ${m.outputTokens} | ${(m.activeModelMs/1000).toFixed(1)}s |`);}lines.push('','## Paired 95% confidence intervals','',`- StateForge − loop: ${(a.pairedCompletionDifference.stateforgeMinusLoop.estimate*100).toFixed(1)} pp, 95% CI [${(a.pairedCompletionDifference.stateforgeMinusLoop.low*100).toFixed(1)}, ${(a.pairedCompletionDifference.stateforgeMinusLoop.high*100).toFixed(1)}] pp.`,`- StateForge − static: ${(a.pairedCompletionDifference.stateforgeMinusStatic.estimate*100).toFixed(1)} pp, 95% CI [${(a.pairedCompletionDifference.stateforgeMinusStatic.low*100).toFixed(1)}, ${(a.pairedCompletionDifference.stateforgeMinusStatic.high*100).toFixed(1)}] pp.`,'','## Integrity','',`- Unlogged control transitions: ${a.integrity.unloggedControlTransitions}`,`- Duplicate transition IDs: ${a.integrity.duplicateTransitionIds}`,`- Retained counterexample regressions: ${a.integrity.retainedCounterexampleRegressions}`,'','## Gates','');for(const[k,v]of Object.entries(a.gates))lines.push(`- ${v?'PASS':'FAIL'} — ${k}`);if(exp.errors.length)lines.push('','## Errors','```json',JSON.stringify(exp.errors,null,2),'```');return lines.join('\n');}
function mockResponse(user){const marker='PUBLIC OBSERVATIONS (identical across all wrappers):',idx=user.indexOf(marker);let episodes=[];if(idx>=0){const rest=user.slice(idx+marker.length),start=rest.indexOf('['),end=rest.indexOf('\n\nReturn one decision');try{episodes=JSON.parse(rest.slice(start,end));}catch{}}const recs=new Map();for(const m of user.matchAll(/"episodeId":"([^"]+)","fixedGraphRecommendation":"([^"]+)"/g))recs.set(m[1],m[2]);const machine=new Map([...user.matchAll(/"familyId":"([^"]+)"[^}]*?"recommendation":"([^"]+)"/g)].map(m=>[m[1],m[2]]));return JSON.stringify({decisions:episodes.map(ep=>{const first=recs.get(ep.id)??machine.get(ep.familyId)??ACTIONS[(ep.observation.glyph+ep.observation.phase+ep.observation.stage)%4];return{episodeId:ep.id,ranking:[first,...ACTIONS.filter(a=>a!==first)],note:'mock'};})});}
function makeBlindMap(rng){const s=shuffle(rng,[...ARCHES]);return{A:s[0],B:s[1],C:s[2]};}function countDuplicates(xs){return xs.length-new Set(xs).size;}function rotate(xs,n){return xs.map((_,i)=>xs[(i+n)%xs.length]);}function permutations(xs){if(xs.length<=1)return[xs];const out=[];for(let i=0;i<xs.length;i++){const rest=xs.slice(0,i).concat(xs.slice(i+1));for(const p of permutations(rest))out.push([xs[i],...p]);}return out;}function mod4(n){return((n%4)+4)%4;}function randInt(rng,n){return Math.floor(rng()*n);}function shuffle(rng,xs){const a=[...xs];for(let i=a.length-1;i>0;i--){const j=randInt(rng,i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}function makeRng(seed){const s=crypto.createHash('sha256').update(seed).digest();let counter=0;return()=>crypto.createHash('sha256').update(s).update(Buffer.from(String(counter++))).digest().readUInt32LE(0)/0x100000000;}function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}function sha256Buffer(value){return crypto.createHash('sha256').update(value).digest();}function quantile(sorted,q){if(!sorted.length)return 0;const p=(sorted.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);return sorted[lo]+(sorted[hi]-sorted[lo])*(p-lo);}function sleep(ms){return new Promise(r=>setTimeout(r,ms));}function estimateTokens(s){return Math.ceil(String(s).length/4);}function extractJson(text){const s=String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<a)throw new Error('no JSON object');return s.slice(a,b+1);}function serializeError(e){return{name:e?.name??'Error',message:e?.message??String(e),stack:e?.stack??null};}function withoutText(o){const{text,...rest}=o;return rest;}function parseArgs(args){const out={};for(let i=0;i<args.length;i++){const a=args[i];if(!a.startsWith('--'))continue;const[k,v]=a.slice(2).split('=');if(v!==undefined)out[k]=v;else if(args[i+1]&&!args[i+1].startsWith('--'))out[k]=args[++i];else out[k]=true;}return out;}function intArg(v,d){const n=Number(v);return Number.isFinite(n)?Math.trunc(n):d;}function writeJson(name,obj){fs.writeFileSync(path.join(outputDir,name),JSON.stringify(obj,null,2));}function checksums(dir){return fs.readdirSync(dir).filter(f=>f!=='checksums.sha256').sort().map(f=>`${sha256(fs.readFileSync(path.join(dir,f)))}  ${f}`).join('\n')+'\n';}

await main();
