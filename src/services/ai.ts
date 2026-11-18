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

import os from 'os';
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

const sessionApiKeys: Partial<Record<AiProvider, string>> = {};

export function getAiApiKey(provider: AiProvider): string {
  const sessionKey = sessionApiKeys[provider];
  if (sessionKey) {
    return sessionKey;
  }
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
  return '';
}

export function setAiApiKey(provider: AiProvider, rawKey: string) {
  const trimmed = rawKey.trim();
  const map = readStoredKeys();
  if (!trimmed) {
    delete sessionApiKeys[provider];
    delete map[provider];
    writeStoredKeys(map);
    return;
  }
  const ss = getSafeStorage();
  if (ss && ss.isEncryptionAvailable()) {
    delete sessionApiKeys[provider];
    const encrypted = ss.encryptString(trimmed).toString('base64');
    map[provider] = { encrypted: true, value: encrypted };
    writeStoredKeys(map);
  } else {
    // Do not persist unencrypted API keys to localStorage; keep session-only in memory
    sessionApiKeys[provider] = trimmed;
    delete map[provider];
    writeStoredKeys(map);
  }
}

export interface ISerializeSchemaOptions {
  maxClasses?: number;
  objectCounts?: Record<string, number>;
  knowledgeBase?: IRealmKnowledgeBase | null;
  propertyHints?: IPropertyValueHint[];
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '[::1]' ||
    host === '::1'
  );
}

export function isLocalAiEndpoint(config: IAiSettings): boolean {
  try {
    if (config.provider === 'ollama') {
      const parsed = validateSafeHttpUrl(config.ollamaUrl);
      return isLoopbackHostname(parsed.hostname);
    }
    if (config.provider === 'openai') {
      const parsed = validateSafeHttpUrl(config.openaiBaseUrl);
      return isLoopbackHostname(parsed.hostname);
    }
  } catch {
    return false;
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

export function createTimeoutSignal(
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

export interface IAiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface IAiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface IChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: IAiToolCall[];
}

export interface ICallProviderOptions {
  responseFormat?: 'json';
  tools?: IAiToolDefinition[];
}

export interface IProviderChatResult {
  text: string;
  toolCalls: IAiToolCall[];
}

export class ToolUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolUnsupportedError';
  }
}

export function stripModelThinkTags(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed JSON args
    }
  }
  return {};
}

function safeToolResponseObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

export async function callAiProviderDetailed(
  config: IAiSettings,
  apiKey: string,
  messages: IChatMessage[],
  signal: AbortSignal,
  callOptions: ICallProviderOptions = {}
): Promise<IProviderChatResult> {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const conversationMessages = messages.filter((m) => m.role !== 'system');
  const hasTools = Boolean(callOptions.tools && callOptions.tools.length > 0);

  switch (config.provider) {
    case 'ollama': {
      const mappedMessages = messages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'tool',
            tool_name: m.name || 'tool',
            content: m.content
          };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content || '',
            tool_calls: m.toolCalls.map((tc, index) => ({
              id: tc.id,
              type: 'function',
              function: {
                index,
                name: tc.name,
                arguments: tc.arguments
              }
            }))
          };
        }
        return { role: m.role, content: m.content };
      });

      const body: Record<string, unknown> = {
        model: config.model,
        stream: false,
        options: {
          temperature: 0.1,
          num_ctx: config.ollamaNumCtx
        },
        messages: mappedMessages
      };
      if (hasTools && callOptions.tools) {
        body.tools = callOptions.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }
        }));
      } else if (callOptions.responseFormat === 'json') {
        body.format = 'json';
      }

      const ollamaBase = validateSafeHttpUrl(config.ollamaUrl).origin;
      const res = await fetch(`${ollamaBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        if (hasTools && /does not support tools|tool.*not support/i.test(text)) {
          throw new ToolUnsupportedError(`Ollama (${res.status}): ${text}`);
        }
        throw new Error(`Ollama error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: unknown };
          }>;
        };
        error?: string;
      };
      if (data.error) {
        throw new Error(data.error);
      }
      const rawCalls = Array.isArray(data.message?.tool_calls)
        ? data.message!.tool_calls
        : [];
      const toolCalls: IAiToolCall[] = rawCalls
        .map((tc, idx) => {
          const fn = tc?.function;
          if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) {
            return null;
          }
          return {
            id: tc.id || `ollama_call_${idx + 1}`,
            name: fn.name.trim(),
            arguments: parseToolArguments(fn.arguments)
          };
        })
        .filter((x): x is IAiToolCall => x !== null);
      return {
        text: data.message?.content?.trim() || '',
        toolCalls
      };
    }

    case 'gemini': {
      if (!apiKey) {
        throw new Error(
          'Gemini API key is missing. Please add it in AI Settings.'
        );
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        config.model
      )}:generateContent`;
      const generationConfig: Record<string, unknown> = { temperature: 0.1 };
      if (!hasTools && callOptions.responseFormat === 'json') {
        generationConfig.responseMimeType = 'application/json';
      }
      const geminiContents = conversationMessages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: m.name || 'tool',
                  response: safeToolResponseObject(m.content)
                }
              }
            ]
          };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const parts: Array<Record<string, unknown>> = [];
          if (m.content) {
            parts.push({ text: m.content });
          }
          for (const tc of m.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments
              }
            });
          }
          return { role: 'model', parts };
        }
        return {
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        };
      });

      const payload: Record<string, unknown> = {
        systemInstruction: systemText
          ? { parts: [{ text: systemText }] }
          : undefined,
        contents: geminiContents,
        generationConfig
      };
      if (hasTools && callOptions.tools) {
        payload.tools = [
          {
            functionDeclarations: callOptions.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }))
          }
        ];
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        signal,
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        if (hasTools && /function|tool.*not support/i.test(text)) {
          throw new ToolUnsupportedError(`Gemini (${res.status}): ${text}`);
        }
        throw new Error(`Gemini error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              functionCall?: { name?: string; args?: Record<string, unknown> };
            }>;
          };
        }>;
      };
      const parts = data.candidates?.[0]?.content?.parts || [];
      const textParts: string[] = [];
      const toolCalls: IAiToolCall[] = [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text.trim()) {
          textParts.push(part.text.trim());
        }
        if (part.functionCall && typeof part.functionCall.name === 'string') {
          toolCalls.push({
            id: `gemini_call_${toolCalls.length + 1}`,
            name: part.functionCall.name,
            arguments: parseToolArguments(part.functionCall.args)
          });
        }
      }
      return {
        text: textParts.join('\n').trim(),
        toolCalls
      };
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
      const mappedMessages = messages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: m.toolCallId || m.name || 'call_1',
            content: m.content
          };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }))
          };
        }
        return { role: m.role, content: m.content };
      });
      const body: Record<string, unknown> = {
        model: config.model,
        temperature: 0.1,
        messages: mappedMessages
      };
      if (hasTools && callOptions.tools) {
        body.tools = callOptions.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }
        }));
        body.tool_choice = 'auto';
      } else if (callOptions.responseFormat === 'json') {
        body.response_format = { type: 'json_object' };
      }

      const parsedOpenAi = validateSafeHttpUrl(config.openaiBaseUrl);
      if (
        !isLoopbackHostname(parsedOpenAi.hostname) &&
        parsedOpenAi.protocol !== 'https:'
      ) {
        throw new Error(
          'Remote OpenAI-compatible endpoints must use https:// to protect your API key and schema.'
        );
      }
      const openaiBase = `${parsedOpenAi.origin}${parsedOpenAi.pathname}`.replace(
        /\/+$/,
        ''
      );
      const res = await fetch(`${openaiBase}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        if (hasTools && /does not support tools|tool.*not support/i.test(text)) {
          throw new ToolUnsupportedError(`OpenAI (${res.status}): ${text}`);
        }
        throw new Error(`OpenAI error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: unknown };
            }>;
          };
        }>;
      };
      const msg = data.choices?.[0]?.message;
      const rawCalls = Array.isArray(msg?.tool_calls) ? msg!.tool_calls : [];
      const toolCalls: IAiToolCall[] = rawCalls
        .map((tc, idx) => {
          const fn = tc?.function;
          if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) {
            return null;
          }
          return {
            id: tc.id || `openai_call_${idx + 1}`,
            name: fn.name.trim(),
            arguments: parseToolArguments(fn.arguments)
          };
        })
        .filter((x): x is IAiToolCall => x !== null);
      return {
        text: typeof msg?.content === 'string' ? msg.content.trim() : '',
        toolCalls
      };
    }

    case 'anthropic': {
      if (!apiKey) {
        throw new Error(
          'Anthropic API key is missing. Please add it in AI Settings.'
        );
      }
      const mappedMessages = conversationMessages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.toolCallId || 'tool_1',
                content: m.content
              }
            ]
          };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const blocks: Array<Record<string, unknown>> = [];
          if (m.content) {
            blocks.push({ type: 'text', text: m.content });
          }
          for (const tc of m.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments
            });
          }
          return { role: 'assistant', content: blocks };
        }
        return {
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content
        };
      });
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: 1536,
        temperature: 0.1,
        system: systemText || undefined,
        messages: mappedMessages
      };
      if (hasTools && callOptions.tools) {
        body.tools = callOptions.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters
        }));
      }

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        if (hasTools && /tool.*not support/i.test(text)) {
          throw new ToolUnsupportedError(`Anthropic (${res.status}): ${text}`);
        }
        throw new Error(`Anthropic error (${res.status}): ${text}`);
      }
      const data = (await res.json()) as {
        content?: Array<{
          type?: string;
          id?: string;
          name?: string;
          text?: string;
          input?: Record<string, unknown>;
        }>;
      };
      const blocks = data.content || [];
      const textParts: string[] = [];
      const toolCalls: IAiToolCall[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          textParts.push(b.text.trim());
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          toolCalls.push({
            id: b.id || `anthropic_call_${toolCalls.length + 1}`,
            name: b.name,
            arguments: parseToolArguments(b.input)
          });
        }
      }
      return {
        text: textParts.join('\n').trim(),
        toolCalls
      };
    }
  }
}

async function callAiProvider(
  config: IAiSettings,
  apiKey: string,
  messages: IChatMessage[],
  signal: AbortSignal,
  callOptions: ICallProviderOptions = {}
): Promise<string> {
  const result = await callAiProviderDetailed(
    config,
    apiKey,
    messages,
    signal,
    callOptions
  );
  return result.text;
}

const SAFE_OLLAMA_MODEL_TAG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,120}$/;

export interface ILocalModelPreset {
  tag: string;
  label: string;
  approxSizeGb: string;
  minRamGb: number;
  recommended: boolean;
  note: string;
}

export const LOCAL_MODEL_PRESETS: readonly ILocalModelPreset[] = [
  {
    tag: 'qwen3.5:9b',
    label: 'Qwen 3.5 · 9B',
    approxSizeGb: '~6.6 GB',
    minRamGb: 12,
    recommended: true,
    note: 'Newest balanced model for Thai/English reasoning, ID search & RQL (16 GB+ RAM).'
  },
  {
    tag: 'qwen3:8b',
    label: 'Qwen 3 · 8B',
    approxSizeGb: '~5.2 GB',
    minRamGb: 12,
    recommended: false,
    note: 'Fast tool calling & Q&A with lower memory usage.'
  },
  {
    tag: 'qwen3.5:4b',
    label: 'Qwen 3.5 · 4B (Light)',
    approxSizeGb: '~3.4 GB',
    minRamGb: 8,
    recommended: false,
    note: 'Compact download for 8 GB RAM laptops.'
  },
  {
    tag: 'qwen3:14b',
    label: 'Qwen 3 · 14B (High Accuracy)',
    approxSizeGb: '~9.3 GB',
    minRamGb: 24,
    recommended: false,
    note: 'Stronger multi-step reasoning for 24–32 GB+ RAM Macs.'
  },
  {
    tag: 'qwen2.5:7b',
    label: 'Qwen 2.5 · 7B (Classic)',
    approxSizeGb: '~4.7 GB',
    minRamGb: 12,
    recommended: false,
    note: 'Classic baseline Qwen 2.5 model.'
  }
];

export function getSystemRamGb(): number {
  try {
    const bytes = os.totalmem();
    if (Number.isFinite(bytes) && bytes > 0) {
      return Math.round(bytes / (1024 * 1024 * 1024));
    }
  } catch {
    // ignore outside Node/Electron
  }
  return 16;
}

export function getLocalModelRecommendation(): {
  ramGb: number;
  recommendedTag: string;
  presets: ILocalModelPreset[];
} {
  const ramGb = getSystemRamGb();
  const recommendedTag =
    ramGb < 12 ? 'qwen3.5:4b' : ramGb >= 24 ? 'qwen3:14b' : 'qwen3.5:9b';
  return {
    ramGb,
    recommendedTag,
    presets: LOCAL_MODEL_PRESETS.map((p) => ({
      ...p,
      recommended: p.tag === recommendedTag
    }))
  };
}

export function validateSafeHttpUrl(
  rawUrl: string,
  options: { localHostOnly?: boolean } = {}
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid endpoint URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked unsafe URL scheme "${parsed.protocol}". Only http and https are allowed.`
    );
  }
  if (options.localHostOnly) {
    const host = parsed.hostname.toLowerCase();
    const isLocalHost =
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '[::1]' ||
      host === '::1';
    if (!isLocalHost) {
      throw new Error(
        `Refused non-local model download target "${parsed.hostname}". Model downloads are restricted to localhost/127.0.0.1 for security.`
      );
    }
  }
  return parsed;
}

export function isValidOllamaModelTag(tag: string): boolean {
  const trimmed = tag.trim();
  return (
    SAFE_OLLAMA_MODEL_TAG_REGEX.test(trimmed) &&
    !trimmed.includes('..') &&
    !trimmed.startsWith('/')
  );
}

export function isOllamaModelInstalled(
  installedTags: string[],
  targetModel: string
): boolean {
  const target = targetModel.trim().toLowerCase();
  if (!target) {
    return false;
  }
  const targetHasTag = target.includes(':');
  return installedTags.some((item) => {
    const lower = item.toLowerCase();
    if (lower === target) {
      return true;
    }
    if (!targetHasTag && lower === `${target}:latest`) {
      return true;
    }
    if (target.endsWith(':latest') && lower === target.slice(0, -':latest'.length)) {
      return true;
    }
    return false;
  });
}

export interface IOllamaPullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
}

export async function pullOllamaModel(params: {
  ollamaUrl: string;
  model: string;
  signal?: AbortSignal;
  onProgress?: (progress: IOllamaPullProgress) => void;
}): Promise<void> {
  const parsedUrl = validateSafeHttpUrl(params.ollamaUrl, {
    localHostOnly: true
  });
  const modelTag = params.model.trim();
  if (!isValidOllamaModelTag(modelTag)) {
    throw new Error(`Invalid Ollama model tag "${params.model}".`);
  }

  const res = await fetch(`${parsedUrl.origin}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: params.signal,
    body: JSON.stringify({ model: modelTag, stream: true })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama pull failed (${res.status}): ${text}`);
  }

  const MAX_STREAM_LINE_CHARS = 1024 * 1024;
  const handleLine = (line: string) => {
    const clean = line.trim();
    if (!clean || clean.length > MAX_STREAM_LINE_CHARS) {
      return;
    }
    let obj: {
      status?: unknown;
      completed?: unknown;
      total?: unknown;
      error?: unknown;
    };
    try {
      obj = JSON.parse(clean);
    } catch {
      return;
    }
    if (typeof obj.error === 'string' && obj.error) {
      throw new Error(obj.error);
    }
    const status = typeof obj.status === 'string' ? obj.status : 'Downloading...';
    const completedBytes =
      typeof obj.completed === 'number' && Number.isFinite(obj.completed)
        ? obj.completed
        : undefined;
    const totalBytes =
      typeof obj.total === 'number' &&
      Number.isFinite(obj.total) &&
      obj.total > 0
        ? obj.total
        : undefined;
    const percent =
      completedBytes !== undefined && totalBytes !== undefined
        ? Math.min(100, Math.max(0, Math.round((completedBytes / totalBytes) * 100)))
        : status === 'success'
          ? 100
          : undefined;
    params.onProgress?.({ status, completedBytes, totalBytes, percent });
  };

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_STREAM_LINE_CHARS) {
        throw new Error('Ollama progress stream line exceeded safe buffer limit.');
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line);
      }
    }
    if (buffer.trim()) {
      handleLine(buffer);
    }
  } else {
    const fullText = await res.text();
    for (const line of fullText.split('\n')) {
      handleLine(line);
    }
  }
}

export async function listOllamaModels(
  ollamaUrl: string,
  externalSignal?: AbortSignal
): Promise<string[]> {
  const base = validateSafeHttpUrl(ollamaUrl).origin;
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

export function buildKnowledgeBasePromptSection(
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

export function collectObjectCountsFromRealm(
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
  const isLocal = isLocalAiEndpoint(config);
  const kbCtx = retrieveRelevantKbContext({
    kb,
    prompt: params.prompt,
    activeClassName: params.activeClassName,
    classes: params.classes,
    includeCodeSnippets: isLocal,
    includeQueryHistory: isLocal
  });

  const canUseLocalHints =
    !!params.realm && config.enableLocalDataHints && isLocal;
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
    'You are an expert Realm Query Language (RQL) assistant for Realm Studio Ultimate.',
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
