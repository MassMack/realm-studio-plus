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

import * as remote from '@electron/remote';
import Realm from 'realm';

import { AiProvider, IAiSettings, settings } from './settings';

const AI_KEYS_STORAGE_KEY = 'realm-studio-ai-keys-v1';

interface IStoredKeyEntry {
  encrypted: boolean;
  value: string;
}

type StoredKeyMap = Partial<Record<AiProvider, IStoredKeyEntry>>;

function getSafeStorage(): Electron.SafeStorage | null {
  try {
    const ss = (remote as unknown as { safeStorage?: Electron.SafeStorage })
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

export function serializeSchemaForAi(
  classes: Realm.ObjectSchema[],
  activeClassName: string
): string {
  const byName = new Map(classes.map((c) => [c.name, c]));
  const active = byName.get(activeClassName);
  const included = new Set<string>();
  if (active) {
    included.add(active.name);
    for (const prop of Object.values(active.properties)) {
      if (typeof prop === 'object' && prop.objectType) {
        included.add(prop.objectType);
      }
    }
  }
  // Include remaining non-system classes if schema is small
  for (const c of classes) {
    if (!c.name.startsWith('__') && included.size < 15) {
      included.add(c.name);
    }
  }

  const lines: string[] = [];
  for (const name of included) {
    const schema = byName.get(name);
    if (!schema) {
      continue;
    }
    const marker = name === activeClassName ? ' [ACTIVE CLASS]' : '';
    const pk = schema.primaryKey ? ` (primaryKey: ${schema.primaryKey})` : '';
    lines.push(`Class ${schema.name}${marker}${pk}:`);
    for (const [propName, rawProp] of Object.entries(schema.properties)) {
      const prop =
        typeof rawProp === 'string'
          ? ({ type: rawProp } as Realm.ObjectSchemaProperty)
          : (rawProp as Realm.ObjectSchemaProperty);
      const target = prop.objectType ? `<${prop.objectType}>` : '';
      const flags = [
        prop.optional ? 'optional' : 'required',
        prop.indexed ? 'indexed' : ''
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`  - ${propName}: ${prop.type}${target} (${flags})`);
    }
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
  role: 'system' | 'user';
  content: string;
}

async function callAiProvider(
  config: IAiSettings,
  apiKey: string,
  messages: IChatMessage[],
  signal: AbortSignal
): Promise<string> {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');

  switch (config.provider) {
    case 'ollama': {
      const res = await fetch(`${config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: config.model,
          stream: false,
          options: { temperature: 0.1 },
          messages: messages.map((m) => ({ role: m.role, content: m.content }))
        })
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          systemInstruction: systemText
            ? { parts: [{ text: systemText }] }
            : undefined,
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: { temperature: 0.1 }
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
      const isLocalOpenAi =
        config.openaiBaseUrl.includes('127.0.0.1') ||
        config.openaiBaseUrl.includes('localhost');
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
          max_tokens: 512,
          temperature: 0.1,
          system: systemText || undefined,
          messages: [{ role: 'user', content: userText }]
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
}

function parseGeneratedQueryResponse(raw: string): IGeneratedRealmQuery {
  const cleaned = raw
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

export async function generateRealmQuery(params: {
  prompt: string;
  classes: Realm.ObjectSchema[];
  activeClassName: string;
  signal?: AbortSignal;
}): Promise<IGeneratedRealmQuery> {
  const config = settings.getAiSettings();
  const apiKey = getAiApiKey(config.provider);
  const schemaSummary = serializeSchemaForAi(
    params.classes,
    params.activeClassName
  );

  const systemPrompt = [
    'You are an expert Realm Query Language (RQL) assistant for Realm Studio.',
    'Convert the user request (which may be in Thai or English) into a single valid Realm Query Language (RQL) filter string for the ACTIVE CLASS.',
    'Rules:',
    '- Use exact property names from the schema.',
    '- Supported operators: ==, !=, >, >=, <, <=, AND, OR, NOT, IN, BETWEEN, CONTAINS[c], BEGINSWITH[c], ENDSWITH[c], LIKE[c], @count, null.',
    '- Sorting/limiting: SORT(prop ASC|DESC), LIMIT(n). If sorting all rows with no filter, start with TRUEPREDICATE SORT(...).',
    '- Dates use YYYY-MM-DD or YYYY-MM-DD@HH:MM:SS. ObjectId uses oid(<hex>). UUID uses uuid(<uuid>).',
    '- Do NOT invent property names that are not in the schema.',
    '- Return ONLY JSON in this exact format: {"query": "<RQL string>", "explanation": "<short 1-sentence explanation in the same language as the user>"}'
  ].join('\n');

  const userPrompt = [
    `Active Class: ${params.activeClassName}`,
    '',
    'Schema:',
    schemaSummary,
    '',
    `User Request: ${params.prompt.trim()}`
  ].join('\n');

  const { signal, cleanup, didTimeout } = createTimeoutSignal(
    config.timeoutMs,
    params.signal
  );

  try {
    const raw = await callAiProvider(
      config,
      apiKey,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      signal
    );
    const result = parseGeneratedQueryResponse(raw);
    if (!result.query) {
      throw new Error('AI returned an empty query. Please try rephrasing.');
    }
    return result;
  } catch (err) {
    if (didTimeout()) {
      throw new Error(
        `AI request timed out after ${Math.round(config.timeoutMs / 1000)}s.`
      );
    }
    throw err;
  } finally {
    cleanup();
  }
}
