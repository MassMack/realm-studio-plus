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

import { serializeRealmValue } from '../utils/realm-serialize';

import {
  buildKnowledgeBasePromptSection,
  callAiProviderDetailed,
  collectObjectCountsFromRealm,
  createTimeoutSignal,
  generateRealmQuery,
  getAiApiKey,
  IAiToolDefinition,
  IChatMessage,
  isLocalAiEndpoint,
  serializeSchemaForAi,
  stripModelThinkTags,
  ToolUnsupportedError
} from './ai';
import {
  loadKnowledgeBaseForRealm,
  retrieveRelevantKbContext
} from './ai-knowledge-base';
import {
  extractCandidateSearchTokens,
  extractSearchObjectIdentifier,
  findIncomingLinksForObject,
  IIncomingLinkCount,
  searchAcrossRealm
} from './realm-search';
import {
  buildRqlSystemPromptGuide,
  getCurrentRqlTimestampHint,
  validateRqlAgainstRealm
} from './rql-reference';
import { IAiSettings, settings } from './settings';

export type AiAssistantMode = 'auto' | 'search' | 'rql';

export interface IAiChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface IAiFoundObjectHit {
  className: string;
  primaryKeyLabel: string;
  primaryKeyValue: string;
  matchedFields: string[];
  preview: string;
  relatedLinks?: IIncomingLinkCount[];
  object?: Realm.Object;
}

export interface IAiSuggestedQuery {
  className: string;
  rql: string;
  explanation: string;
  validated: boolean;
  matchedCount?: number;
  totalInClass?: number;
  validationError?: string;
}

export interface IAiAssistantResult {
  mode: 'answer' | 'rql';
  answer: string;
  suggestedQuery?: IAiSuggestedQuery;
  hits: IAiFoundObjectHit[];
  toolsUsed: string[];
  attempts: number;
  capabilityLimited: boolean;
  limitationReason?: string;
}

const MAX_TOOL_STEPS = 4;
const MAX_TOOL_HITS = 18;
const MAX_QUERY_ROWS = 15;

const ASSISTANT_TOOLS: IAiToolDefinition[] = [
  {
    name: 'search_realm_everywhere',
    description:
      'Search an ID, primary key, UUID, ObjectId, number, or keyword across EVERY class in the currently open Realm database to find which class/column contains it.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Exact ID, value, or keyword to search across all classes.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_schema_overview',
    description:
      'Inspect Realm classes, exact row counts, properties, types, primary keys, links, backlinks, and Knowledge Base notes.',
    parameters: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Optional class name to focus on. Leave empty for overview of all classes.'
        }
      }
    }
  },
  {
    name: 'query_class_objects',
    description:
      'Run a read-only Realm Query Language (RQL) query on a class to inspect counts or sample matching rows. Uses Realm RQL syntax, NOT SQL.',
    parameters: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Target Realm class name.'
        },
        rql: {
          type: 'string',
          description:
            'Optional RQL predicate (e.g. status ==[c] "active" AND amount > 100). Omit to inspect top rows.'
        },
        sortBy: {
          type: 'string',
          description: 'Optional property name or dotted keypath to sort by.'
        },
        descending: {
          type: 'boolean',
          description: 'Set true to sort descending.'
        },
        limit: {
          type: 'number',
          description: 'Max rows to return (1-15, default 8).'
        }
      },
      required: ['className']
    }
  },
  {
    name: 'propose_table_filter',
    description:
      'Validate an RQL filter against the Realm engine and attach an editable Apply Filter button for the user.',
    parameters: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Target Realm class name for the filter.'
        },
        rql: {
          type: 'string',
          description: 'RQL filter predicate string (NOT SQL).'
        },
        explanation: {
          type: 'string',
          description: 'Short explanation of what the filter shows.'
        }
      },
      required: ['className', 'rql']
    }
  }
];

function appendHitDeduplicated(
  hits: IAiFoundObjectHit[],
  candidate: IAiFoundObjectHit
) {
  if (hits.length >= MAX_TOOL_HITS) {
    return;
  }
  const exists = hits.some(
    (h) =>
      h.className === candidate.className &&
      h.primaryKeyValue === candidate.primaryKeyValue &&
      h.preview === candidate.preview
  );
  if (!exists) {
    hits.push(candidate);
  }
}

function summarizeHitForLlm(
  hit: IAiFoundObjectHit,
  row: Record<string, unknown> | undefined,
  allowRowContents: boolean,
  isPrimaryKeyMatch: boolean
): Record<string, unknown> {
  const safeIdValue =
    allowRowContents || isPrimaryKeyMatch
      ? hit.primaryKeyValue
      : '(matched record)';
  const base: Record<string, unknown> = {
    className: hit.className,
    idField: allowRowContents || isPrimaryKeyMatch ? hit.primaryKeyLabel : 'record',
    idValue: safeIdValue,
    matchedFields: hit.matchedFields,
    relatedLinks: hit.relatedLinks
  };
  if (allowRowContents && row) {
    base.row = row;
  } else if (allowRowContents && hit.preview) {
    base.preview = hit.preview;
  }
  return base;
}

function looksLikeSearchOrLookup(prompt: string, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  if (
    /อยู่ตรงไหน|อยู่ไหน|คลาสไหน|ตารางไหน|table ไหน|class ไหน|มีไหม|หา|ค้นหา|เช็ค|ตรวจ|where|find|locate|search|look up|lookup|\bid\b|ไอดี|รหัส/i.test(
      prompt
    )
  ) {
    return true;
  }
  // Automatic search for unmistakable UUIDs, ObjectIds, or quoted IDs even in short prompts like "usr_9981?"
  return tokens.some(
    (t) =>
      /^[0-9a-fA-F]{24}$/.test(t) ||
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        t
      ) ||
      /[_-]/.test(t)
  );
}

function looksLikePureAnalyticsOutOfScope(prompt: string): boolean {
  return /(?:sum|average|avg|group\s+by|ค่าเฉลี่ย|ผลรวมทั้ง|รวมยอดทุก|เปรียบเทียบ.*เดือน)/i.test(
    prompt
  );
}

function buildCapabilityLimitationMessage(
  config: IAiSettings,
  detail: string
): string {
  return [
    `Local AI (${config.model}) ยังมีข้อจำกัดสำหรับคำขอนี้: ${detail}`,
    '• ถ้าเป็นการค้นหาข้ามหลายตาราง, สรุปรวมผล (SUM/GROUP BY), หรือวางแผนซับซ้อน แนะนำใช้ MCP Server ร่วมกับ GitHub Copilot / Claude / GPT (ตั้งค่าใน AI Settings → MCP) หรือใช้โมเดล Local ขนาดใหญ่ขึ้น (เช่น qwen2.5:14b)'
  ].join('\n');
}

function buildFallbackSearchSummary(
  hits: IAiFoundObjectHit[],
  searchedTokens: string[],
  model: string,
  failureDetail: string
): string {
  if (hits.length > 0) {
    const lines = hits.slice(0, 6).map((h) => {
      const colInfo =
        h.matchedFields.length > 0 ? ` [ตรงที่คอลัมน์: ${h.matchedFields.join(', ')}]` : '';
      const linkInfo =
        h.relatedLinks && h.relatedLinks.length > 0
          ? ` (ถูกอ้างอิงโดย: ${h.relatedLinks
              .map((l) => `${l.fromClass}.${l.propName} (${l.count})`)
              .join(', ')})`
          : '';
      return `• ${h.className} (${h.primaryKeyLabel}: ${h.primaryKeyValue})${colInfo}${linkInfo}`;
    });
    return [
      `ระบบค้นหาโดยตรงในฐานข้อมูล Realm พบ ${hits.length} รายการ (แต่โมเดล Local AI "${model}" ไม่สามารถสรุปคำตอบต่อได้: ${failureDetail}):`,
      ...lines
    ].join('\n');
  }

  return `ไม่สามารถใช้ Local AI "${model}" ค้นหาหรือวิเคราะห์คำถามนี้จนจบได้ (${failureDetail})${
    searchedTokens.length > 0
      ? ` — ลองค้นหาคำว่า "${searchedTokens.join(', ')}" ทั่วทั้งฐานข้อมูลแล้วไม่พบข้อมูลตรงกัน`
      : ''
  }`;
}

export async function askAiAssistant(params: {
  prompt: string;
  mode?: AiAssistantMode;
  classes: Realm.ObjectSchema[];
  activeClassName?: string;
  history?: IAiChatTurn[];
  realm?: Realm;
  kbOverrideDir?: string;
  signal?: AbortSignal;
  onProgress?: (status: string) => void;
}): Promise<IAiAssistantResult> {
  const mode = params.mode ?? 'auto';
  const activeClass =
    params.activeClassName ||
    params.classes.find((c) => !c.name.startsWith('__') && !c.embedded)?.name ||
    '';

  if (mode === 'rql') {
    if (!activeClass) {
      throw new Error('Please select a Class in the sidebar for RQL Filter mode.');
    }
    const rqlResult = await generateRealmQuery({
      prompt: params.prompt,
      classes: params.classes,
      activeClassName: activeClass,
      realm: params.realm,
      kbOverrideDir: params.kbOverrideDir,
      signal: params.signal,
      onProgress: params.onProgress
    });
    return {
      mode: 'rql',
      answer: rqlResult.explanation,
      suggestedQuery: {
        className: activeClass,
        rql: rqlResult.query,
        explanation: rqlResult.explanation,
        validated: Boolean(rqlResult.validated),
        matchedCount: rqlResult.matchedCount,
        totalInClass: rqlResult.totalInClass,
        validationError: rqlResult.validationError
      },
      hits: [],
      toolsUsed: ['generate_rql'],
      attempts: rqlResult.attempts ?? 1,
      capabilityLimited: Boolean(rqlResult.validationError),
      limitationReason: rqlResult.validationError
        ? `RQL ที่สร้างยังไม่ผ่านตัวตรวจของ Realm: ${rqlResult.validationError}`
        : undefined
    };
  }

  const config = settings.getAiSettings();
  const apiKey = getAiApiKey(config.provider);
  const isLocal = isLocalAiEndpoint(config);
  const allowRowContentsInPrompt = isLocal && config.enableLocalDataHints;

  const realmPath = params.realm?.path || '';
  const kb = loadKnowledgeBaseForRealm(
    realmPath,
    params.classes,
    params.kbOverrideDir
  );
  const kbCtx = retrieveRelevantKbContext({
    kb,
    prompt: params.prompt,
    activeClassName: activeClass,
    classes: params.classes,
    includeCodeSnippets: isLocal,
    includeQueryHistory: isLocal
  });
  const objectCounts = collectObjectCountsFromRealm(
    params.realm,
    params.classes
  );
  const schemaSummary = serializeSchemaForAi(params.classes, activeClass, {
    maxClasses: 24,
    objectCounts,
    knowledgeBase: kb
  });
  const kbSection = buildKnowledgeBasePromptSection(kbCtx);

  const collectedHits: IAiFoundObjectHit[] = [];
  const toolsUsedSet = new Set<string>();
  let proposedFilter: IAiSuggestedQuery | undefined;

  const candidateTokens = extractCandidateSearchTokens(params.prompt);
  const shouldPreSearch =
    !!params.realm &&
    looksLikeSearchOrLookup(params.prompt, candidateTokens);

  const preSearchPromptBlocks: string[] = [];

  if (shouldPreSearch && params.realm) {
    params.onProgress?.('Searching database on-device...');
    toolsUsedSet.add('search_realm_everywhere');
    for (const token of candidateTokens.slice(0, 3)) {
      const results = searchAcrossRealm(params.realm, params.classes, token, {
        maxSamplesPerClass: 4,
        includeSensitiveFields: false,
        includeSerializedRow: allowRowContentsInPrompt
      });
      const serializedGroups = results.map((group) => ({
        className: group.className,
        primaryKeyField: group.primaryKeyField,
        matchCount: group.count,
        samples: group.samples.map((sample) => {
          const idLabel = sample.identifier?.key ?? group.primaryKeyField ?? 'row';
          const idValue =
            sample.identifier?.value ??
            (allowRowContentsInPrompt
              ? sample.preview.slice(0, 32) || 'match'
              : 'matched record');
          const relatedLinks = findIncomingLinksForObject(
            params.classes,
            group.className,
            sample.object
          );
          const hit: IAiFoundObjectHit = {
            className: group.className,
            primaryKeyLabel: idLabel,
            primaryKeyValue: idValue,
            matchedFields: sample.matchedFields,
            preview: sample.preview,
            relatedLinks,
            object: sample.object
          };
          appendHitDeduplicated(collectedHits, hit);
          return summarizeHitForLlm(
            hit,
            sample.serialized,
            allowRowContentsInPrompt,
            Boolean(sample.identifier?.isPrimaryKey)
          );
        })
      }));
      preSearchPromptBlocks.push(
        `Pre-Search for "${token}": ${JSON.stringify(serializedGroups)}`
      );
    }
  }

  const executeTool = (
    name: string,
    args: Record<string, unknown>
  ): Record<string, unknown> => {
    if (!params.realm) {
      return { error: 'No Realm database is currently open.' };
    }
    toolsUsedSet.add(name);

    switch (name) {
      case 'search_realm_everywhere': {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          return { error: 'Argument "query" must be a non-empty string.' };
        }
        const results = searchAcrossRealm(params.realm, params.classes, query, {
          maxSamplesPerClass: 4,
          includeSensitiveFields: false,
          includeSerializedRow: allowRowContentsInPrompt
        });
        const totalMatches = results.reduce((sum, r) => sum + r.count, 0);
        return {
          query,
          totalMatches,
          classes: results.map((group) => ({
            className: group.className,
            primaryKeyField: group.primaryKeyField,
            matchCount: group.count,
            samples: group.samples.map((sample) => {
              const idLabel =
                sample.identifier?.key ?? group.primaryKeyField ?? 'row';
              const idValue =
                sample.identifier?.value ??
                (allowRowContentsInPrompt
                  ? sample.preview.slice(0, 32) || 'match'
                  : 'matched record');
              const relatedLinks = findIncomingLinksForObject(
                params.classes,
                group.className,
                sample.object
              );
              const hit: IAiFoundObjectHit = {
                className: group.className,
                primaryKeyLabel: idLabel,
                primaryKeyValue: idValue,
                matchedFields: sample.matchedFields,
                preview: sample.preview,
                relatedLinks,
                object: sample.object
              };
              appendHitDeduplicated(collectedHits, hit);
              return summarizeHitForLlm(
                hit,
                sample.serialized,
                allowRowContentsInPrompt,
                Boolean(sample.identifier?.isPrimaryKey)
              );
            })
          }))
        };
      }

      case 'get_schema_overview': {
        const filterClass =
          typeof args.className === 'string' && args.className.trim()
            ? args.className.trim()
            : '';
        const selected = filterClass
          ? params.classes.filter((c) => c.name === filterClass)
          : params.classes.filter((c) => !c.name.startsWith('__'));
        if (filterClass && selected.length === 0) {
          return {
            error: `Class "${filterClass}" not found. Available classes: ${params.classes
              .filter((c) => !c.name.startsWith('__'))
              .map((c) => c.name)
              .join(', ')}`
          };
        }
        return {
          totalClasses: params.classes.filter((c) => !c.name.startsWith('__'))
            .length,
          schemaSummary: serializeSchemaForAi(selected, activeClass, {
            maxClasses: 30,
            objectCounts,
            knowledgeBase: kb
          })
        };
      }

      case 'query_class_objects': {
        const className =
          typeof args.className === 'string' && args.className.trim()
            ? args.className.trim()
            : activeClass;
        const rql = typeof args.rql === 'string' ? args.rql.trim() : '';
        const limitRaw = typeof args.limit === 'number' ? args.limit : 8;
        const limit = Math.min(MAX_QUERY_ROWS, Math.max(1, Math.round(limitRaw)));
        const sortBy = typeof args.sortBy === 'string' ? args.sortBy.trim() : '';
        const descending = Boolean(args.descending);

        if (!className) {
          return { error: 'Class name is required.' };
        }
        const schema = params.classes.find((c) => c.name === className);
        if (!schema) {
          return { error: `Unknown class "${className}".` };
        }

        if (rql) {
          const check = validateRqlAgainstRealm(params.realm, className, rql);
          if (!check.valid) {
            return {
              error: check.errorMessage,
              fixHint: check.correctionHint,
              validProperties: Object.keys(schema.properties)
            };
          }
        }
        const results = rql
          ? params.realm.objects(className).filtered(rql)
          : params.realm.objects(className);

        const totalMatched = results.length;
        let sorted = results;
        if (sortBy) {
          try {
            sorted = results.sorted(sortBy, descending);
          } catch (sortErr) {
            return {
              error: `Invalid sortBy property "${sortBy}": ${
                sortErr instanceof Error ? sortErr.message : String(sortErr)
              }`,
              validProperties: Object.keys(schema.properties)
            };
          }
        }
        const rows: unknown[] = [];
        const take = Math.min(limit, totalMatched);
        for (let i = 0; i < take; i++) {
          const obj = sorted[i];
          const idInfo = extractSearchObjectIdentifier(obj);
          const idLabel = idInfo?.key ?? schema.primaryKey ?? 'row';
          const idValue = idInfo?.value ?? `#${i + 1}`;
          if (i < 5) {
            appendHitDeduplicated(collectedHits, {
              className,
              primaryKeyLabel: idLabel,
              primaryKeyValue: idValue,
              matchedFields: rql ? ['RQL match'] : [],
              preview: allowRowContentsInPrompt
                ? `${idLabel}: ${idValue}`
                : 'Matched record',
              object: obj
            });
          }
          if (allowRowContentsInPrompt) {
            rows.push(
              serializeRealmValue(obj, {
                maxDepth: 1,
                maskSensitiveFields: true
              })
            );
          } else {
            rows.push({
              [idLabel]: idValue,
              redacted:
                'Row payload hidden for non-local/privacy mode; click Jump in UI to view'
            });
          }
        }

        if (rql) {
          proposedFilter = {
            className,
            rql,
            explanation: '',
            validated: true,
            matchedCount: totalMatched,
            totalInClass: params.realm.objects(className).length
          };
        }

        return {
          className,
          rql: rql || '(all rows)',
          totalMatched,
          returned: rows.length,
          rows
        };
      }

      case 'propose_table_filter': {
        const className =
          typeof args.className === 'string' && args.className.trim()
            ? args.className.trim()
            : activeClass;
        const rql = typeof args.rql === 'string' ? args.rql.trim() : '';
        const explanation =
          typeof args.explanation === 'string' ? args.explanation.trim() : '';
        if (!className || !rql) {
          return { error: 'Both className and rql are required.' };
        }
        const check = validateRqlAgainstRealm(params.realm, className, rql);
        if (!check.valid) {
          return {
            valid: false,
            errorMessage: check.errorMessage,
            correctionHint: check.correctionHint
          };
        }
        proposedFilter = {
          className,
          rql,
          explanation,
          validated: true,
          matchedCount: check.matchedCount,
          totalInClass: check.totalInClass
        };
        return {
          valid: true,
          className,
          rql,
          matchedCount: check.matchedCount,
          totalInClass: check.totalInClass
        };
      }

      default:
        return { error: `Unknown tool "${name}".` };
    }
  };

  const privacyNote = allowRowContentsInPrompt
    ? 'Row inspection is enabled locally on-device (sensitive keys masked).'
    : 'Privacy mode: row values are redacted; only schema, counts, matched fields, and primaryKey values are exposed.';

  const systemPrompt = [
    'You are the intelligent assistant inside Realm Studio Plus (a local Realm database viewer).',
    'You can:',
    '1. Find where any ID, keyword, or value lives across the Realm database (`search_realm_everywhere`), check incoming links, and inspect rows (`query_class_objects`).',
    '2. Explain the database schema, counts, relationships, Knowledge Base notes, or answer general Realm / RQL / debugging questions concisely.',
    '3. Propose verified Realm Query Language (RQL) table filters via `propose_table_filter` when the user wants to filter records.',
    '',
    'CRITICAL HONESTY RULES:',
    '- NEVER guess or invent row values, object counts, or which class contains an ID without observing tool output or Pre-Search Grounding results.',
    '- Note Realm RQL does NOT support SQL JOIN, GROUP BY, SUM, AVG, or aggregations. If the user asks for calculations or deep cross-table analytics that cannot be answered accurately with the available tools, honestly say you cannot compute it reliably instead of guessing.',
    '- Respond in the same language as the user (Thai or English), clearly and concisely.',
    '',
    buildRqlSystemPromptGuide(),
    getCurrentRqlTimestampHint(),
    privacyNote
  ].join('\n');

  const userParts = [
    activeClass ? `Active Class in Table: ${activeClass}` : 'Active Class: (none)',
    '',
    'Schema & Row Counts:',
    schemaSummary
  ];
  if (kbSection) {
    userParts.push('', 'Domain Knowledge Base:', kbSection);
  }
  if (preSearchPromptBlocks.length > 0) {
    userParts.push('', 'Verified Database Pre-Search Results:', ...preSearchPromptBlocks);
  }
  userParts.push('', `User Question: ${params.prompt.trim()}`);

  const messages: IChatMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const turn of (params.history || []).slice(-6)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: userParts.join('\n') });

  const effectiveTimeout = Math.max(config.timeoutMs, 35000);
  const { signal, cleanup, didTimeout } = createTimeoutSignal(
    effectiveTimeout,
    params.signal
  );

  const calledCache = new Map<string, string>();
  const invokeToolOnce = (toolName: string, args: Record<string, unknown>) => {
    const cacheKey = `${toolName}:${JSON.stringify(args)}`;
    const prevResult = calledCache.get(cacheKey);
    if (prevResult) {
      return JSON.stringify({
        cachedNotice:
          'Already executed with identical arguments. Summarize your findings for the user or try a different query/tool.',
        previousResult: JSON.parse(prevResult)
      });
    }
    const output = executeTool(toolName, args);
    const serialized = JSON.stringify(output);
    calledCache.set(cacheKey, serialized);
    return serialized;
  };

  let attempts = 0;

  try {
    let useJsonFallback = !params.realm;
    if (params.realm) {
      params.onProgress?.('Thinking & checking Realm tools...');
      for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
        attempts = step;
        try {
          const reply = await callAiProviderDetailed(
            config,
            apiKey,
            messages,
            signal,
            useJsonFallback ? { responseFormat: 'json' } : { tools: ASSISTANT_TOOLS }
          );
          const cleanedText = stripModelThinkTags(reply.text);

          if (!useJsonFallback && reply.toolCalls.length > 0) {
            messages.push({
              role: 'assistant',
              content: cleanedText,
              toolCalls: reply.toolCalls
            });
            for (const tc of reply.toolCalls.slice(0, 4)) {
              params.onProgress?.(`Running ${tc.name}...`);
              const toolOutput = invokeToolOnce(tc.name, tc.arguments);
              messages.push({
                role: 'tool',
                name: tc.name,
                toolCallId: tc.id,
                content: toolOutput
              });
            }
            continue;
          }

          // Check if model returned JSON ReAct envelope in fallback mode or text
          if (cleanedText.startsWith('{')) {
            try {
              const obj = JSON.parse(cleanedText) as {
                action?: unknown;
                name?: unknown;
                args?: Record<string, unknown>;
                answer?: unknown;
              };
              if (
                obj.action === 'tool' &&
                typeof obj.name === 'string' &&
                step < MAX_TOOL_STEPS
              ) {
                params.onProgress?.(`Running ${obj.name}...`);
                const toolOutput = invokeToolOnce(obj.name, obj.args || {});
                messages.push({ role: 'assistant', content: cleanedText });
                messages.push({
                  role: 'user',
                  content: `Tool "${obj.name}" Result:\n${toolOutput}\nNow answer the user concisely or run another tool via JSON.`
                });
                continue;
              }
              if (typeof obj.answer === 'string' && obj.answer.trim()) {
                const limitNote =
                  looksLikePureAnalyticsOutOfScope(params.prompt) &&
                  toolsUsedSet.size === 0
                    ? buildCapabilityLimitationMessage(
                        config,
                        'Realm RQL และ Local AI ไม่รองรับการคำนวณสรุปรวม (SUM/AVG/GROUP BY) ข้ามหลายตารางโดยตรง'
                      )
                    : undefined;
                return {
                  mode: proposedFilter ? 'rql' : 'answer',
                  answer: obj.answer.trim(),
                  suggestedQuery: proposedFilter,
                  hits: collectedHits,
                  toolsUsed: Array.from(toolsUsedSet),
                  attempts,
                  capabilityLimited: Boolean(limitNote),
                  limitationReason: limitNote
                };
              }
              const objWithQuery = obj as {
                query?: unknown;
                explanation?: unknown;
                className?: unknown;
              };
              if (
                typeof objWithQuery.query === 'string' &&
                objWithQuery.query.trim() &&
                activeClass
              ) {
                const targetCls =
                  typeof objWithQuery.className === 'string' &&
                  objWithQuery.className.trim()
                    ? objWithQuery.className.trim()
                    : activeClass;
                const check = validateRqlAgainstRealm(
                  params.realm,
                  targetCls,
                  objWithQuery.query.trim()
                );
                const expl =
                  typeof objWithQuery.explanation === 'string'
                    ? objWithQuery.explanation.trim()
                    : '';
                return {
                  mode: 'rql',
                  answer: expl || `RQL filter for ${targetCls}`,
                  suggestedQuery: {
                    className: targetCls,
                    rql: objWithQuery.query.trim(),
                    explanation: expl,
                    validated: check.valid,
                    matchedCount: check.matchedCount,
                    totalInClass: check.totalInClass,
                    validationError: check.valid ? undefined : check.errorMessage
                  },
                  hits: collectedHits,
                  toolsUsed: Array.from(toolsUsedSet),
                  attempts,
                  capabilityLimited: !check.valid,
                  limitationReason: check.valid
                    ? undefined
                    : `RQL ที่ได้ยังไม่ถูกต้อง: ${check.errorMessage}`
                };
              }
            } catch {
              // Not a ReAct JSON envelope; fall through to plain answer
            }
          }

          if (cleanedText) {
            if (proposedFilter && !proposedFilter.explanation) {
              proposedFilter.explanation = cleanedText;
            }
            return {
              mode: proposedFilter ? 'rql' : 'answer',
              answer: cleanedText,
              suggestedQuery: proposedFilter,
              hits: collectedHits,
              toolsUsed: Array.from(toolsUsedSet),
              attempts,
              capabilityLimited: false
            };
          }

          if (step < MAX_TOOL_STEPS) {
            messages.push({
              role: 'user',
              content:
                'Please provide your concise final answer in plain text based on the database tools/schema.'
            });
          }
        } catch (err) {
          if (err instanceof ToolUnsupportedError && !useJsonFallback) {
            // Switch seamlessly to JSON ReAct fallback for smaller local models
            useJsonFallback = true;
            messages.push({
              role: 'user',
              content: [
                'Native tool-calling is unavailable for this model. Respond in JSON using one of:',
                '1) {"action":"tool","name":"search_realm_everywhere|get_schema_overview|query_class_objects|propose_table_filter","args":{...}}',
                '2) {"action":"final","answer":"<concise answer in user language>"}'
              ].join('\n')
            });
            continue;
          }
          throw err;
        }
      }

      // Exceeded tool steps without a clear final text answer
      const stepDetail = `ใช้ครบ ${MAX_TOOL_STEPS} ขั้นตอนแล้วแต่โมเดลยังไม่สรุปคำตอบ`;
      return {
        mode: 'answer',
        answer: buildFallbackSearchSummary(
          collectedHits,
          candidateTokens,
          config.model,
          stepDetail
        ),
        suggestedQuery: proposedFilter,
        hits: collectedHits,
        toolsUsed: Array.from(toolsUsedSet),
        attempts,
        capabilityLimited: true,
        limitationReason: buildCapabilityLimitationMessage(config, stepDetail)
      };
    }

    // No Realm file open — answer general Realm / RQL questions directly
    attempts = 1;
    params.onProgress?.('Asking AI...');
    const reply = await callAiProviderDetailed(config, apiKey, messages, signal);
    const cleaned = stripModelThinkTags(reply.text);
    if (!cleaned) {
      return {
        mode: 'answer',
        answer: `Local AI (${config.model}) ไม่ได้ส่งคำตอบกลับมา`,
        hits: [],
        toolsUsed: [],
        attempts,
        capabilityLimited: true,
        limitationReason: buildCapabilityLimitationMessage(
          config,
          'โมเดลตอบกลับมาเป็นค่าว่าง'
        )
      };
    }
    return {
      mode: 'answer',
      answer: cleaned,
      hits: [],
      toolsUsed: [],
      attempts,
      capabilityLimited: false
    };
  } catch (err) {
    if (params.signal?.aborted && !didTimeout()) {
      throw err;
    }
    const errMsg = didTimeout()
      ? `หมดเวลา (${Math.round(effectiveTimeout / 1000)} วินาที)`
      : err instanceof Error
        ? err.message
        : String(err);

    // If deterministic search or schema tools already gathered facts, surface them honestly instead of blank failure
    if (collectedHits.length > 0 || shouldPreSearch) {
      return {
        mode: 'answer',
        answer: buildFallbackSearchSummary(
          collectedHits,
          candidateTokens,
          config.model,
          errMsg
        ),
        suggestedQuery: proposedFilter,
        hits: collectedHits,
        toolsUsed: Array.from(toolsUsedSet),
        attempts: Math.max(attempts, 1),
        capabilityLimited: true,
        limitationReason: buildCapabilityLimitationMessage(config, errMsg)
      };
    }

    throw new Error(
      didTimeout()
        ? `AI request timed out after ${Math.round(effectiveTimeout / 1000)}s.`
        : errMsg
    );
  } finally {
    cleanup();
  }
}
