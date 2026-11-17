////////////////////////////////////////////////////////////////////////////
//
// Copyright 2018 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////

import Realm from 'realm';

import { getRemote } from '../utils/electron-or-remote';

import {
  IPropertyValueHint,
  IRealmKnowledgeBase,
  loadKnowledgeBaseForRealm,
  retrieveRelevantKbContext,
  sampleSafePropertyHints
} from './ai-knowledge-base';
import {
  buildRqlSystemPromptGuide,
  getCurrentRqlTimestampHint,
  validateRqlAgainstRealm
} from './rql-reference';
import { AiProvider, IAiSettings, settings } from './settings';

const AI_KEYS_STORAGE_KEY = 'realm-studio-ai-keys-v1';

interface IStoredKeyEntry {
  encrypted: boolean;
  value: string;
}

type StoredKeyMap = Partial<Record<AiProvider, IStoredKeyEntry>>;

function getSafeStorage(): Electron.SafeStorage | null {
  try {
    const ss = (getRemote() as unknown as { safeStorage?: Electron.SafeStorage })
      .safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function') {
      return ss;
    }
  } catch {
    // ignore outside Electron renderer
  }
  return null;
}

export function isApiKeyEncryptionAvailable(): boolean {
  const ss = getSafeStorage();
  return !!(ss && ss.isEncryptionAvailable());
}

function readStoredKeys(): StoredKeyMap {
  try {
    const raw = localStorage.getItem(AI_KEYS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredKeyMap;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return {};
}

function writeStoredKeys(map: StoredKeyMap) {
  try {
    localStorage.setItem(AI_KEYS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function getAiApiKey(provider: AiProvider): string {
  const entry = readStoredKeys()[provider];
  if (!entry || typeof entry.value !== 'string' || !entry.value) {
    return '';
  }
  if (entry.encrypted) {
    const ss = getSafeStorage();
    if (ss && ss.isEncryptionAvailable()) {
      try {
        return ss.decryptString(Buffer.from(entry.value, 'base64'));
      } catch {
        return '';
      }
    }
    return '';
  }
  return entry.value;
}

export function setAiApiKey(provider: AiProvider, rawKey: string) {
  const trimmed = rawKey.trim();
  const map = readStoredKeys();
  if (!trimmed) {
    delete map[provider];
    writeStoredKeys(map);
    return;
  }
  const ss = getSafeStorage();
  if (ss && ss.isEncryptionAvailable()) {
    const encrypted = ss.encryptString(trimmed).toString('base64');
    map[provider] = { encrypted: true, value: encrypted };
  } else {
    map[provider] = { encrypted: false, value: trimmed };
  }
  writeStoredKeys(map);
}

export interface ISerializeSchemaOptions {
  maxClasses?: number;
  objectCounts?: Record<string, number>;
  knowledgeBase?: IRealmKnowledgeBase | null;
  propertyHints?: IPropertyValueHint[];
}

export function isLocalAiEndpoint(config: IAiSettings): boolean {
  if (config.provider === 'ollama') {
    return true;
  }
  if (config.provider === 'openai') {
    return (
      config.openaiBaseUrl.includes('127.0.0.1') ||
      config.openaiBaseUrl.includes('localhost')
    );
  }
  return false;
}

const PRIMITIVE_SHORTHAND_TYPES = new Set([
  'bool',
  'int',
  'float',
  'double',
  'decimal128',
  'string',
  'data',
  'date',
  'objectId',
  'uuid',
  'mixed'
]);

function getNormalizedProp(
  rawProp: string | Realm.ObjectSchemaProperty,
  knownClassNames?: Set<string>
): Realm.ObjectSchemaProperty {
  if (typeof rawProp !== 'string') {
    return rawProp as Realm.ObjectSchemaProperty;
  }
  const trimmed = rawProp.trim();
  const collectionMatch = /^(.+?)(\??)(\[\]|<>|\{\})$/.exec(trimmed);
  if (collectionMatch) {
    const [, target, optMark, container] = collectionMatch;
    const type =
      container === '[]'
        ? 'list'
        : container === '<>'
          ? 'set'
          : 'dictionary';
    return {
      type,
      objectType: target,
      optional: optMark === '?'
    } as Realm.ObjectSchemaProperty;
  }
  const optional = trimmed.endsWith('?');
  const base = optional ? trimmed.slice(0, -1) : trimmed;
  if (
    knownClassNames?.has(base) ||
    (!PRIMITIVE_SHORTHAND_TYPES.has(base) && /^[A-Z]/.test(base))
  ) {
    return {
      type: 'object',
      objectType: base,
      optional
    } as Realm.ObjectSchemaProperty;
  }
  return { type: base, optional } as Realm.ObjectSchemaProperty;
}

/**
 * Prioritizes `activeClassName` plus up to 2 relationship hops and incoming backlinks,
 * enriched with optional row counts, KB descriptions, and on-device safe enum hints.
 */
export function serializeSchemaForAi(
  classes: Realm.ObjectSchema[],
  activeClassName: string,
  options: ISerializeSchemaOptions = {}
): string {
  const maxClasses = options.maxClasses ?? 30;
  const nonSystem = classes.filter((c) => !c.name.startsWith('__'));
  const byName = new Map(nonSystem.map((c) => [c.name, c]));
  const knownClassNames = new Set(byName.keys());
  const included: string[] = [];
  const includedSet = new Set<string>();

  const addClass = (name: string) => {
    if (!name || includedSet.has(name) || !byName.has(name)) {
      return false;
    }
    includedSet.add(name);
    included.push(name);
    return true;
  };

  // BFS up to 2 relationship hops starting from activeClassName (both outgoing & incoming links)
  const incomingLinks = new Map<string, Array<{ fromClass: string; propName: string }>>();
  for (const c of nonSystem) {
    for (const [propName, rawProp] of Object.entries(c.properties)) {
      const prop = getNormalizedProp(rawProp, knownClassNames);
      if (
        prop.objectType &&
        knownClassNames.has(prop.objectType) &&
        prop.type !== 'linkingObjects'
      ) {
        const list = incomingLinks.get(prop.objectType) || [];
        list.push({ fromClass: c.name, propName });
        incomingLinks.set(prop.objectType, list);
      }
    }
  }

  if (activeClassName && byName.has(activeClassName)) {
    const queue: Array<{ name: string; depth: number }> = [
      { name: activeClassName, depth: 0 }
    ];
    while (queue.length > 0 && included.length < maxClasses) {
      const current = queue.shift()!;
      if (!addClass(current.name) || current.depth >= 2) {
        continue;
      }
      const schema = byName.get(current.name)!;
      for (const rawProp of Object.values(schema.properties)) {
        const prop = getNormalizedProp(rawProp, knownClassNames);
        if (
          prop.objectType &&
          knownClassNames.has(prop.objectType) &&
          !includedSet.has(prop.objectType)
        ) {
          queue.push({ name: prop.objectType, depth: current.depth + 1 });
        }
      }
      for (const incoming of incomingLinks.get(current.name) || []) {
        if (!includedSet.has(incoming.fromClass)) {
          queue.push({ name: incoming.fromClass, depth: current.depth + 1 });
        }
      }
    }
  }

  for (const c of nonSystem) {
    if (included.length >= maxClasses) {
      break;
    }
    addClass(c.name);
  }

  const hintByProp = new Map(
    (options.propertyHints || []).map((h) => [h.propertyName, h.values])
  );

  const lines: string[] = [];
  for (const name of included) {
    const schema = byName.get(name)!;
    const marker = name === activeClassName ? ' [ACTIVE CLASS]' : '';
    const kind = schema.embedded
      ? 'Embedded'
      : schema.asymmetric
        ? 'Asymmetric'
        : 'Standard';
    const countVal = options.objectCounts?.[schema.name];
    const countPart =
      typeof countVal === 'number' ? `, ${countVal} rows` : '';
    const pkPart = schema.primaryKey ? `, primaryKey: ${schema.primaryKey}` : '';
    lines.push(`Class ${schema.name}${marker} [${kind}${countPart}${pkPart}]:`);

    const classKb = options.knowledgeBase?.classes?.[schema.name];
    if (classKb?.description?.trim()) {
      lines.push(`  # Domain Note: ${classKb.description.trim()}`);
    }

    const backlinks = incomingLinks.get(schema.name) || [];
    if (name === activeClassName && backlinks.length > 0) {
      const formatted = backlinks
        .slice(0, 6)
        .map((b) => `@links.${b.fromClass}.${b.propName}`)
        .join(', ');
      lines.push(`  # Available Backlinks: ${formatted}`);
    }

    for (const [propName, rawProp] of Object.entries(schema.properties)) {
      const prop = getNormalizedProp(rawProp, knownClassNames);
      const target = prop.objectType ? `<${prop.objectType}>` : '';
      const flags = [
        prop.optional ? 'optional' : 'required',
        prop.indexed ? 'indexed' : '',
        schema.primaryKey === propName ? 'primaryKey' : ''
      ]
        .filter(Boolean)
        .join(', ');

      const propNote = classKb?.properties?.[propName]?.trim();
      const noteSuffix = propNote ? ` // ${propNote}` : '';
      const sampleValues =
        name === activeClassName ? hintByProp.get(propName) : undefined;
      const hintSuffix =
        sampleValues && sampleValues.length > 0
          ? ` [observed values: ${sampleValues.map((v) => JSON.stringify(v)).join(', ')}]`
          : '';

      lines.push(
        `  - ${propName}: ${prop.type}${target} (${flags})${hintSuffix}${noteSuffix}`
      );
    }
  }

  const omitted = nonSystem
    .map((c) => c.name)
    .filter((name) => !includedSet.has(name));
  if (omitted.length > 0) {
    lines.push('');
    lines.push(`Other classes in Realm: ${omitted.join(', ')}`);
  }

  return lines.join('\n');
}

function createTimeoutSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort);
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  };
}

interface IChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ICallProviderOptions {
  responseFormat?: 'json';
}

function stripModelThinkTags(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function callAiProvider(
  config: IAiSettings,
  apiKey: string,
  messages: IChatMessage[],
  signal: AbortSignal,
  callOptions: ICallProviderOptions = {}
): Promise<string> {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  switch (config.provider) {
    case 'ollama': {
      const body: Record<string, unknown> = {
        model: config.model,
        stream: false,
        options: {
          temperature: 0.1,
          num_ctx: config.ollamaNumCtx
        },
        messages: messages.map((m) => ({ role: m.role, content: m.content }))
      };
      if (callOptions.responseFormat === 'json') {
        body.format = 'json';
      }
      const res = await fetch(`${config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Ollama error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        message?: { content?: string };
        error?: string;
      };
      if (data.error) {
        throw new Error(data.error);
      }
      return data.message?.content?.trim() || '';
    }

    case 'gemini': {
      if (!apiKey) {
        throw new Error(
          'Gemini API key is missing. Please add it in AI Settings.'
        );
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        config.model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const generationConfig: Record<string, unknown> = { temperature: 0.1 };
      if (callOptions.responseFormat === 'json') {
        generationConfig.responseMimeType = 'application/json';
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          systemInstruction: systemText
            ? { parts: [{ text: systemText }] }
            : undefined,
          contents: conversationMessages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          generationConfig
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Gemini error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    }

    case 'openai': {
      const isLocalOpenAi = isLocalAiEndpoint(config);
      if (!apiKey && !isLocalOpenAi) {
        throw new Error(
          'OpenAI API key is missing. Please add it in AI Settings.'
        );
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: config.model,
          temperature: 0.1,
          messages: messages.map((m) => ({ role: m.role, content: m.content }))
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`OpenAI error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() || '';
    }

    case 'anthropic': {
      if (!apiKey) {
        throw new Error(
          'Anthropic API key is missing. Please add it in AI Settings.'
        );
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal,
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1024,
          temperature: 0.1,
          system: systemText || undefined,
          messages: conversationMessages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
          }))
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Anthropic error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      return (
        data.content?.find((c) => c.type === 'text')?.text?.trim() || ''
      );
    }
  }
}

export async function listOllamaModels(
  ollamaUrl: string,
  externalSignal?: AbortSignal
): Promise<string[]> {
  const base = ollamaUrl.trim().replace(/\/+$/, '');
  const { signal, cleanup } = createTimeoutSignal(5000, externalSignal);
  try {
    const res = await fetch(`${base}/api/tags`, { signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      models?: Array<{ name?: string }>;
    };
    return (data.models || [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === 'string' && !!name);
  } finally {
    cleanup();
  }
}

export async function testAiConnection(
  config: IAiSettings,
  apiKey: string,
  externalSignal?: AbortSignal
): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const start = Date.now();
  const { signal, cleanup, didTimeout } = createTimeoutSignal(
    Math.min(config.timeoutMs, 15000),
    externalSignal
  );
  try {
    if (config.provider === 'ollama') {
      const models = await listOllamaModels(config.ollamaUrl, signal);
      const latencyMs = Date.now() - start;
      if (models.length === 0) {
        return {
          ok: true,
          latencyMs,
          message: `Connected to Ollama, but no models are installed yet (run: ollama pull ${config.model}).`
        };
      }
      const hasExact = models.some(
        (m) => m === config.model || m.startsWith(`${config.model}:`)
      );
      return {
        ok: true,
        latencyMs,
        message: hasExact
          ? `Connected to Ollama (${latencyMs} ms). Model "${config.model}" is ready.`
          : `Connected to Ollama (${latencyMs} ms). Available: ${models
              .slice(0, 4)
              .join(', ')}.`
      };
    }

    const reply = await callAiProvider(
      config,
      apiKey,
      [
        {
          role: 'user',
          content: 'Reply with exactly: OK'
        }
      ],
      signal
    );
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      latencyMs,
      message: `Connected to ${config.model} (${latencyMs} ms): "${reply.slice(0, 40)}"`
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (didTimeout()) {
      return { ok: false, latencyMs, message: 'Connection timed out.' };
    }
    return {
      ok: false,
      latencyMs,
      message: err instanceof Error ? err.message : String(err)
    };
  } finally {
    cleanup();
  }
}

export interface IGeneratedRealmQuery {
  query: string;
  explanation: string;
  validated?: boolean;
  matchedCount?: number;
  totalInClass?: number;
  attempts?: number;
  validationError?: string;
  correctionHint?: string;
  usedLocalHints?: boolean;
  kbSummary?: string[];
}

export function parseGeneratedQueryResponse(
  raw: string
): Pick<IGeneratedRealmQuery, 'query' | 'explanation'> {
  const withoutThink = stripModelThinkTags(raw);
  const cleaned = withoutThink
    .replace(/^```(?:json|rql|sql|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        query?: unknown;
        explanation?: unknown;
      };
      if (typeof parsed.query === 'string' && parsed.query.trim()) {
        return {
          query: parsed.query.trim(),
          explanation:
            typeof parsed.explanation === 'string'
              ? parsed.explanation.trim()
              : ''
        };
      }
    }
  } catch {
    // Fall back to plain-text query extraction below
  }

  const firstLine = cleaned.split('\n').find((l) => l.trim().length > 0) || '';
  return {
    query: firstLine.replace(/^["'`]|["'`]$/g, '').trim(),
    explanation: ''
  };
}

function buildKnowledgeBasePromptSection(
  kbCtx: ReturnType<typeof retrieveRelevantKbContext>
): string {
  const sections: string[] = [];

  if (kbCtx.projectNotes) {
    sections.push(`Project Notes:\n${kbCtx.projectNotes}`);
  }
  if (kbCtx.codeSnippets.length > 0) {
    sections.push(
      'Matched Source Code / Enum Definitions:\n' +
        kbCtx.codeSnippets
          .map((s) => `// ${s.filePath} (${s.name})\n${s.snippet}`)
          .join('\n\n')
    );
  }
  if (kbCtx.examples.length > 0) {
    sections.push(
      'Reference RQL Examples from This Project:\n' +
        kbCtx.examples
          .map((ex) => `- Intent: "${ex.naturalLanguage}" => RQL: ${ex.rql}`)
          .join('\n')
    );
  }

  return sections.join('\n\n');
}

function collectObjectCountsFromRealm(
  realm: Realm | undefined,
  classes: Realm.ObjectSchema[]
): Record<string, number> | undefined {
  if (!realm) {
    return undefined;
  }
  const counts: Record<string, number> = {};
  for (const s of classes) {
    if (s.name.startsWith('__') || s.embedded || s.asymmetric) {
      continue;
    }
    try {
      counts[s.name] = realm.objects(s.name).length;
    } catch {
      // ignore unreadable schema class
    }
  }
  return counts;
}

export async function generateRealmQuery(params: {
  prompt: string;
  classes: Realm.ObjectSchema[];
  activeClassName: string;
  realm?: Realm;
  kbOverrideDir?: string;
  signal?: AbortSignal;
  onProgress?: (status: string) => void;
}): Promise<IGeneratedRealmQuery> {
  const config = settings.getAiSettings();
  const apiKey = getAiApiKey(config.provider);
  const realmPath = params.realm?.path || '';
  const kb = loadKnowledgeBaseForRealm(
    realmPath,
    params.classes,
    params.kbOverrideDir
  );
  const kbCtx = retrieveRelevantKbContext({
    kb,
    prompt: params.prompt,
    activeClassName: params.activeClassName,
    classes: params.classes
  });

  const canUseLocalHints =
    !!params.realm &&
    config.enableLocalDataHints &&
    isLocalAiEndpoint(config);
  const propertyHints =
    canUseLocalHints && params.realm
      ? sampleSafePropertyHints(params.realm, params.activeClassName)
      : [];
  const objectCounts = collectObjectCountsFromRealm(
    params.realm,
    params.classes
  );

  const schemaSummary = serializeSchemaForAi(
    params.classes,
    params.activeClassName,
    {
      maxClasses: 30,
      objectCounts,
      knowledgeBase: kb,
      propertyHints
    }
  );

  const systemPrompt = [
    'You are an expert Realm Query Language (RQL) assistant for Realm Studio Plus.',
    'Translate the user request (Thai or English) into a single valid Realm Query Language (RQL) filter predicate for the ACTIVE CLASS.',
    buildRqlSystemPromptGuide(),
    getCurrentRqlTimestampHint(),
    'Rules:',
    '- Use ONLY exact property names present on the schema (or valid keypaths across related classes / @links).',
    '- Respect observed enum values / Domain Notes when mapping Thai or business terms (e.g. active/suspended status codes).',
    '- Return ONLY valid JSON in this exact structure: {"query": "<RQL string>", "explanation": "<concise 1-sentence explanation in the same language as the user>"}'
  ].join('\n\n');

  const kbSection = buildKnowledgeBasePromptSection(kbCtx);
  const userPromptParts = [
    `Active Class: ${params.activeClassName}`,
    '',
    'Schema:',
    schemaSummary
  ];
  if (kbSection) {
    userPromptParts.push('', 'Domain Knowledge Base:', kbSection);
  }
  userPromptParts.push('', `User Request: ${params.prompt.trim()}`);

  const messages: IChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPromptParts.join('\n') }
  ];

  const activeSchema = params.classes.find(
    (c) => c.name === params.activeClassName
  );
  const availableProps = activeSchema
    ? Object.keys(activeSchema.properties)
    : [];

  const maxAttempts = params.realm && config.enableSelfCorrection ? 3 : 1;
  const effectiveTimeout =
    maxAttempts > 1 ? Math.max(config.timeoutMs, 30000) : config.timeoutMs;

  const { signal, cleanup, didTimeout } = createTimeoutSignal(
    effectiveTimeout,
    params.signal
  );

  try {
    let lastResult: IGeneratedRealmQuery | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt === 1) {
        params.onProgress?.('Generating RQL...');
      }

      const raw = await callAiProvider(config, apiKey, messages, signal, {
        responseFormat: 'json'
      });
      const parsed = parseGeneratedQueryResponse(raw);
      if (!parsed.query) {
        if (attempt < maxAttempts) {
          messages.push({ role: 'assistant', content: raw || '{}' });
          messages.push({
            role: 'user',
            content:
              'Your response did not contain a valid non-empty "query" JSON field. Return ONLY JSON: {"query": "<valid RQL>", "explanation": "<short explanation>"}.'
          });
          continue;
        }
        throw new Error('AI returned an empty query. Please try rephrasing.');
      }

      if (!params.realm || !config.enableSelfCorrection) {
        return {
          ...parsed,
          validated: false,
          attempts: attempt,
          usedLocalHints: propertyHints.length > 0,
          kbSummary: kbCtx.summaryParts
        };
      }

      const validation = validateRqlAgainstRealm(
        params.realm,
        params.activeClassName,
        parsed.query
      );

      if (validation.valid) {
        return {
          ...parsed,
          validated: true,
          matchedCount: validation.matchedCount,
          totalInClass: validation.totalInClass,
          attempts: attempt,
          usedLocalHints: propertyHints.length > 0,
          kbSummary: kbCtx.summaryParts
        };
      }

      lastResult = {
        ...parsed,
        validated: false,
        attempts: attempt,
        validationError: validation.errorMessage,
        correctionHint: validation.correctionHint,
        usedLocalHints: propertyHints.length > 0,
        kbSummary: kbCtx.summaryParts
      };

      if (attempt < maxAttempts) {
        params.onProgress?.(
          `RQL check failed — auto-fixing (attempt ${attempt + 1}/${maxAttempts})...`
        );
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: [
            `Realm rejected your RQL query: ${parsed.query}`,
            `Exact Realm Engine Error: ${validation.errorMessage}`,
            validation.correctionHint
              ? `Fix Hint: ${validation.correctionHint}`
              : '',
            availableProps.length > 0
              ? `Valid Properties on ${params.activeClassName}: ${availableProps.join(', ')}`
              : '',
            'Fix ONLY the predicate so it parses cleanly in Realm RQL and return ONLY JSON {"query": "...", "explanation": "..."}.'
          ]
            .filter(Boolean)
            .join('\n')
        });
      }
    }

    if (lastResult) {
      return lastResult;
    }
    throw new Error('AI returned an empty query. Please try rephrasing.');
  } catch (err) {
    if (didTimeout()) {
      throw new Error(
        `AI request timed out after ${Math.round(effectiveTimeout / 1000)}s.`
      );
    }
    throw err;
  } finally {
    cleanup();
  }
}

export async function analyzeSchemaWithAi(params: {
  classes: Realm.ObjectSchema[];
  objectCounts: Record<string, number>;
  realmPath?: string;
  kbOverrideDir?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const config = settings.getAiSettings();
  const apiKey = getAiApiKey(config.provider);
  const kb = loadKnowledgeBaseForRealm(
    params.realmPath || '',
    params.classes,
    params.kbOverrideDir
  );

  const schemaText = serializeSchemaForAi(params.classes, '', {
    maxClasses: 45,
    objectCounts: params.objectCounts,
    knowledgeBase: kb
  });

  const systemPrompt = [
    'You are a senior Realm Database Architect.',
    'Analyze the given Realm schema (plus any domain notes from Knowledge Base; no personal row data is provided) and reply concisely in Thai with clear bullet points under these 3 headings:',
    '1. สรุปความสัมพันธ์ของ Class (Relationships)',
    '2. แนะนำการเพิ่ม Index เพื่อความเร็ว (Index Recommendations)',
    '3. ข้อสังเกตและแนวทางปรับปรุง Schema (Schema Notes)',
    'Only reference class names and property names that actually exist in the schema.'
  ].join('\n');

  const userParts = [`Realm Schema:\n${schemaText}`];
  if (kb.projectNotes.trim()) {
    userParts.push(`\nProject Domain Notes:\n${kb.projectNotes.trim()}`);
  }

  const effectiveTimeout = Math.max(config.timeoutMs, 45000);
  const { signal, cleanup, didTimeout } = createTimeoutSignal(
    effectiveTimeout,
    params.signal
  );

  try {
    const reply = await callAiProvider(
      config,
      apiKey,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userParts.join('\n') }
      ],
      signal
    );
    const cleaned = stripModelThinkTags(reply);
    if (!cleaned) {
      throw new Error('AI returned an empty analysis.');
    }
    return cleaned;
  } catch (err) {
    if (didTimeout()) {
      throw new Error(
        `AI Schema analysis timed out after ${Math.round(effectiveTimeout / 1000)}s.`
      );
    }
    throw err;
  } finally {
    cleanup();
  }
}
