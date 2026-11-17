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

import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import Realm from 'realm';

import { isSensitivePropertyName } from '../utils/realm-serialize';
import { resolveSharedUserDataDir } from '../utils/user-data-path';

export interface IClassKnowledge {
  description?: string;
  properties?: Record<string, string>;
}

export interface IIndexedCodeSymbol {
  id: string;
  name: string;
  kind: 'class' | 'enum' | 'doc';
  filePath: string;
  snippet: string;
  tokens: string[];
}

export interface IQueryMemoryExample {
  naturalLanguage: string;
  rql: string;
  className?: string;
  updatedAt?: string;
}

export interface IRealmKnowledgeBase {
  version: 1;
  id: string;
  realmName: string;
  schemaHash: string;
  lastPath?: string;
  projectNotes: string;
  sourceDir?: string;
  lastIndexedAt?: string;
  classes: Record<string, IClassKnowledge>;
  indexedSymbols: IIndexedCodeSymbol[];
  customExamples: IQueryMemoryExample[];
  updatedAt: string;
}

export interface IRetrievedKnowledgeContext {
  projectNotes: string;
  activeClassDescription?: string;
  propertyDescriptions: Record<string, Record<string, string>>;
  codeSnippets: Array<{ name: string; filePath: string; snippet: string }>;
  examples: IQueryMemoryExample[];
  summaryParts: string[];
}

export interface IPropertyValueHint {
  propertyName: string;
  type: string;
  values: Array<string | number>;
}

const MAX_KB_EXAMPLES = 30;
const MAX_INDEX_FILES = 600;
const MAX_INDEX_FILE_BYTES = 200 * 1024;
const MAX_INDEX_DEPTH = 10;
const MAX_INDEX_SYMBOLS = 220;
const MAX_ENUM_DISTINCT = 10;
const MAX_SAMPLE_ROWS = 200;
const MAX_HINT_STR_LEN = 36;

const IGNORED_SOURCE_DIRS = new Set([
  '.git',
  'node_modules',
  'Pods',
  'build',
  'dist',
  '.build',
  'DerivedData',
  '.dart_tool',
  '.gradle',
  'target',
  '.next',
  '.idea',
  '.vscode',
  'coverage'
]);

const SOURCE_EXTENSIONS = new Set([
  '.swift',
  '.kt',
  '.kts',
  '.java',
  '.dart',
  '.ts',
  '.tsx',
  '.js',
  '.md'
]);

const PII_FIELD_PATTERN =
  /(^|[_-])(email|e[-_]?mail|phone|mobile|tel|ssn|citizen|nationalid|passport|address|street|zipcode|postal|lat|lng|latitude|longitude|url|uri|avatar|image|photo|full[-_]?name|first[-_]?name|last[-_]?name|display[-_]?name|username|user[-_]?name|device[-_]?id|fcm|push[-_]?token|imei|mac)([_-]|$)/i;

const RECENT_QUERIES_STORAGE_KEY = 'realm-studio-recent-queries';
const SAVED_QUERIES_STORAGE_KEY = 'realm-studio-saved-queries-v1';

export function getAiKnowledgeBaseDir(overrideDir?: string): string {
  if (overrideDir && overrideDir.trim()) {
    return path.resolve(overrideDir.trim());
  }
  if (process.env.REALM_STUDIO_AI_KB_DIR?.trim()) {
    return path.resolve(process.env.REALM_STUDIO_AI_KB_DIR.trim());
  }
  return path.join(resolveSharedUserDataDir(), 'ai-kb');
}

function sanitizeSlug(name: string): string {
  const cleaned = name
    .replace(/\.realm$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'realm';
}

export function computeSchemaFingerprint(
  classes: Realm.ObjectSchema[]
): string {
  const signature = classes
    .filter((c) => !c.name.startsWith('__'))
    .map((c) => {
      const props = Object.keys(c.properties).sort().join(',');
      return `${c.name}:${props}`;
    })
    .sort()
    .join('|');
  if (!signature) {
    return 'empty';
  }
  return crypto.createHash('sha1').update(signature).digest('hex').slice(0, 12);
}

export function createEmptyKnowledgeBase(
  realmPath: string,
  classes: Realm.ObjectSchema[] = []
): IRealmKnowledgeBase {
  const realmName = realmPath ? path.basename(realmPath) : 'default.realm';
  const schemaHash = computeSchemaFingerprint(classes);
  const id = `${sanitizeSlug(realmName)}-${schemaHash}`;
  return {
    version: 1,
    id,
    realmName,
    schemaHash,
    lastPath: realmPath || undefined,
    projectNotes: '',
    classes: {},
    indexedSymbols: [],
    customExamples: [],
    updatedAt: new Date().toISOString()
  };
}

function normalizeKbRecord(
  raw: Partial<IRealmKnowledgeBase> | null | undefined,
  fallbackPath: string,
  classes: Realm.ObjectSchema[]
): IRealmKnowledgeBase {
  const base = createEmptyKnowledgeBase(fallbackPath, classes);
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  return {
    version: 1,
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    realmName:
      typeof raw.realmName === 'string' && raw.realmName
        ? raw.realmName
        : base.realmName,
    schemaHash:
      typeof raw.schemaHash === 'string' && raw.schemaHash
        ? raw.schemaHash
        : base.schemaHash,
    lastPath:
      typeof raw.lastPath === 'string' && raw.lastPath
        ? raw.lastPath
        : base.lastPath,
    projectNotes:
      typeof raw.projectNotes === 'string' ? raw.projectNotes : '',
    sourceDir: typeof raw.sourceDir === 'string' ? raw.sourceDir : undefined,
    lastIndexedAt:
      typeof raw.lastIndexedAt === 'string' ? raw.lastIndexedAt : undefined,
    classes:
      raw.classes && typeof raw.classes === 'object' ? raw.classes : {},
    indexedSymbols: Array.isArray(raw.indexedSymbols)
      ? raw.indexedSymbols
      : [],
    customExamples: Array.isArray(raw.customExamples)
      ? raw.customExamples
      : [],
    updatedAt:
      typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

function readAllKbFiles(kbDir: string): Array<{
  filePath: string;
  data: Partial<IRealmKnowledgeBase>;
}> {
  if (!fs.existsSync(kbDir)) {
    return [];
  }
  try {
    const entries = fs.readdirSync(kbDir);
    const out: Array<{
      filePath: string;
      data: Partial<IRealmKnowledgeBase>;
    }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(kbDir, entry);
      try {
        const data = fs.readJsonSync(filePath) as Partial<IRealmKnowledgeBase>;
        if (data && typeof data === 'object') {
          out.push({ filePath, data });
        }
      } catch {
        // ignore corrupted kb file
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function findExistingKnowledgeBase(
  realmPath: string,
  classes: Realm.ObjectSchema[] = [],
  overrideDir?: string
): IRealmKnowledgeBase | null {
  const kbDir = getAiKnowledgeBaseDir(overrideDir);
  if (!fs.existsSync(kbDir)) {
    return null;
  }

  const targetName = realmPath ? path.basename(realmPath) : '';
  const targetHash = computeSchemaFingerprint(classes);
  const directId = `${sanitizeSlug(targetName || 'realm')}-${targetHash}`;
  const directPath = path.join(kbDir, `${directId}.json`);

  if (fs.existsSync(directPath)) {
    try {
      const raw = fs.readJsonSync(directPath) as Partial<IRealmKnowledgeBase>;
      return normalizeKbRecord(raw, realmPath, classes);
    } catch {
      // fall through
    }
  }

  const candidates = readAllKbFiles(kbDir);
  if (candidates.length === 0) {
    return null;
  }

  // 1) Exact lastPath match (helps when schema changed after annotation)
  if (realmPath) {
    const byPath = candidates.find((c) => c.data.lastPath === realmPath);
    if (byPath) {
      return normalizeKbRecord(byPath.data, realmPath, classes);
    }
  }

  // 2) Same schemaHash (handles new CoreSimulator container UUIDs or ADB temp pulls)
  if (targetHash !== 'empty') {
    const byHash = candidates.find((c) => c.data.schemaHash === targetHash);
    if (byHash) {
      return normalizeKbRecord(byHash.data, realmPath, classes);
    }
  }

  // 3) Filename fallback only if at least one annotated class matches
  if (targetName) {
    const classNames = new Set(classes.map((c) => c.name));
    const byName = candidates.find((c) => {
      if (c.data.realmName !== targetName) {
        return false;
      }
      if (classNames.size === 0) {
        return true;
      }
      const kbClasses = Object.keys(c.data.classes || {});
      return kbClasses.some((cls) => classNames.has(cls));
    });
    if (byName) {
      return normalizeKbRecord(byName.data, realmPath, classes);
    }
  }

  return null;
}

export function loadKnowledgeBaseForRealm(
  realmPath: string,
  classes: Realm.ObjectSchema[] = [],
  overrideDir?: string
): IRealmKnowledgeBase {
  return (
    findExistingKnowledgeBase(realmPath, classes, overrideDir) ||
    createEmptyKnowledgeBase(realmPath, classes)
  );
}

export function saveKnowledgeBase(
  kb: IRealmKnowledgeBase,
  overrideDir?: string
): IRealmKnowledgeBase {
  const kbDir = getAiKnowledgeBaseDir(overrideDir);
  fs.ensureDirSync(kbDir);
  const next: IRealmKnowledgeBase = {
    ...kb,
    version: 1,
    updatedAt: new Date().toISOString()
  };
  const filePath = path.join(kbDir, `${sanitizeSlug(next.id)}.json`);
  fs.writeJsonSync(filePath, next, { spaces: 2 });
  return next;
}

/**
 * Splits camelCase, snake_case, kebab-case, and whitespace into normalized search tokens.
 */
export function tokenizeText(text: string): string[] {
  if (!text) {
    return [];
  }
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./\\(){}[\]:;,"'`<>]+/g, ' ')
    .toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of expanded.split(/\s+/)) {
    const token = raw.trim();
    if (token.length >= 2 && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function collectLeadingComments(lines: string[], lineIdx: number): string[] {
  const comments: string[] = [];
  for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 8); i--) {
    const t = lines[i].trim();
    if (!t) {
      if (comments.length > 0) {
        break;
      }
      continue;
    }
    if (
      t.startsWith('//') ||
      t.startsWith('///') ||
      t.startsWith('*') ||
      t.startsWith('/*') ||
      t.startsWith('#')
    ) {
      comments.unshift(t);
    } else if (t.startsWith('@')) {
      // keep decorators/annotations adjacent to model declarations
      comments.unshift(t);
    } else {
      break;
    }
  }
  return comments;
}

function walkSourceFiles(
  rootDir: string,
  depth = 0,
  acc: string[] = []
): string[] {
  if (depth > MAX_INDEX_DEPTH || acc.length >= MAX_INDEX_FILES) {
    return acc;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (acc.length >= MAX_INDEX_FILES) {
      break;
    }
    if (IGNORED_SOURCE_DIRS.has(name)) {
      continue;
    }
    const full = path.join(rootDir, name);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        walkSourceFiles(full, depth + 1, acc);
      } else if (stat.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext) && stat.size <= MAX_INDEX_FILE_BYTES) {
          acc.push(full);
        }
      }
    } catch {
      // ignore unreadable entry
    }
  }
  return acc;
}

/**
 * Indexes a local project folder (Swift/Kotlin/Dart/Java/TS models, enums, and Markdown docs)
 * into compact searchable symbols for on-device RAG retrieval.
 */
export function indexProjectSourceDir(
  sourceDir: string,
  classes: Realm.ObjectSchema[] = []
): { symbols: IIndexedCodeSymbol[]; scannedFiles: number } {
  const resolvedRoot = path.resolve(sourceDir.trim());
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Source directory does not exist: ${resolvedRoot}`);
  }

  const schemaClassNames = classes
    .filter((c) => !c.name.startsWith('__'))
    .map((c) => c.name);
  const schemaClassLower = new Set(schemaClassNames.map((n) => n.toLowerCase()));

  const files = walkSourceFiles(resolvedRoot);
  const symbols: IIndexedCodeSymbol[] = [];
  const seenIds = new Set<string>();

  const declRegex =
    /^\s*(?:export\s+)?(?:(?:public|private|internal|open|final|data|abstract|sealed|static)\s+)*\b(class|struct|enum|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/;

  for (const filePath of files) {
    if (symbols.length >= MAX_INDEX_SYMBOLS) {
      break;
    }
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const relPath = path.relative(resolvedRoot, filePath);
    const ext = path.extname(filePath).toLowerCase();
    const lines = content.split(/\r?\n/);

    if (ext === '.md') {
      // Chunk Markdown documentation sections mentioning schema classes or domain rules
      let currentHeading = path.basename(filePath);
      let chunk: string[] = [];
      const flushMd = () => {
        const text = chunk.join('\n').trim();
        if (text.length < 20) {
          chunk = [];
          return;
        }
        const trimmed = text.slice(0, 420);
        const tokens = tokenizeText(`${currentHeading} ${trimmed}`);
        const id = `doc:${relPath}:${currentHeading}`.slice(0, 120);
        if (!seenIds.has(id) && symbols.length < MAX_INDEX_SYMBOLS) {
          seenIds.add(id);
          symbols.push({
            id,
            name: currentHeading,
            kind: 'doc',
            filePath: relPath,
            snippet: trimmed,
            tokens
          });
        }
        chunk = [];
      };

      for (const line of lines) {
        if (/^#{1,3}\s+/.test(line)) {
          flushMd();
          currentHeading = line.replace(/^#+\s+/, '').trim();
        } else {
          chunk.push(line);
          if (chunk.length >= 14) {
            flushMd();
          }
        }
      }
      flushMd();
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      if (symbols.length >= MAX_INDEX_SYMBOLS) {
        break;
      }
      const match = declRegex.exec(lines[i]);
      if (!match) {
        continue;
      }
      const declKind = match[1];
      const symbolName = match[2];
      const isEnum = declKind === 'enum';
      const isKnownClass = schemaClassLower.has(symbolName.toLowerCase());
      const relatedToSchema =
        isKnownClass ||
        schemaClassNames.some((cls) =>
          symbolName.toLowerCase().includes(cls.toLowerCase())
        );

      if (!isEnum && !relatedToSchema) {
        continue;
      }

      const comments = collectLeadingComments(lines, i);
      const bodySlice = lines.slice(i, Math.min(lines.length, i + 18));
      const snippet = [...comments, ...bodySlice].join('\n').slice(0, 450).trim();
      if (!snippet) {
        continue;
      }

      const id = `${isEnum ? 'enum' : 'class'}:${relPath}:${symbolName}:${i}`;
      if (seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      symbols.push({
        id,
        name: symbolName,
        kind: isEnum ? 'enum' : 'class',
        filePath: relPath,
        snippet,
        tokens: tokenizeText(`${symbolName} ${snippet}`)
      });
    }
  }

  return { symbols, scannedFiles: files.length };
}

function scoreOverlap(
  queryTokens: string[],
  targetTokens: string[],
  boost = 0
): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) {
    return boost;
  }
  const targetSet = new Set(targetTokens);
  let hits = 0;
  for (const t of queryTokens) {
    if (targetSet.has(t)) {
      hits += 1;
    }
  }
  return hits / Math.sqrt(targetTokens.length + 4) + boost;
}

export function loadLocalStorageQueryHistory(
  activeSchema?: Realm.ObjectSchema
): string[] {
  const candidates: string[] = [];
  try {
    if (typeof localStorage === 'undefined') {
      return candidates;
    }
    for (const key of [SAVED_QUERIES_STORAGE_KEY, RECENT_QUERIES_STORAGE_KEY]) {
      const raw = localStorage.getItem(key);
      if (!raw) {
        continue;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.trim()) {
            candidates.push(item.trim());
          }
        }
      }
    }
  } catch {
    // ignore outside browser or malformed localStorage
  }

  const deduped = Array.from(new Set(candidates));
  if (!activeSchema) {
    return deduped.slice(0, 5);
  }
  const propNames = Object.keys(activeSchema.properties);
  return deduped
    .filter((q) => {
      if (/^TRUEPREDICATE\b/i.test(q)) {
        return true;
      }
      return propNames.some((prop) =>
        new RegExp(`\\b${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)
      );
    })
    .slice(0, 5);
}

/**
 * Retrieves compact, query-relevant domain notes, code/enum definitions, and
 * verified few-shot examples via BM25-style token scoring so even 7B models stay accurate.
 */
export function retrieveRelevantKbContext(params: {
  kb: IRealmKnowledgeBase;
  prompt: string;
  activeClassName: string;
  classes: Realm.ObjectSchema[];
  includeCodeSnippets?: boolean;
  includeQueryHistory?: boolean;
}): IRetrievedKnowledgeContext {
  const {
    kb,
    prompt,
    activeClassName,
    classes,
    includeCodeSnippets = true,
    includeQueryHistory = true
  } = params;
  const activeSchema = classes.find((c) => c.name === activeClassName);
  const activePropNames = activeSchema
    ? Object.keys(activeSchema.properties)
    : [];
  const queryTokens = tokenizeText(
    `${prompt} ${activeClassName} ${activePropNames.join(' ')}`
  );

  const propertyDescriptions: Record<string, Record<string, string>> = {};
  for (const [clsName, meta] of Object.entries(kb.classes || {})) {
    if (meta?.properties && Object.keys(meta.properties).length > 0) {
      propertyDescriptions[clsName] = { ...meta.properties };
    }
  }

  const scoredSymbols = includeCodeSnippets
    ? (kb.indexedSymbols || [])
        .map((sym) => {
          const nameMatchBoost =
            sym.name.toLowerCase() === activeClassName.toLowerCase()
              ? 2.0
              : sym.name.toLowerCase().includes(activeClassName.toLowerCase())
                ? 1.0
                : 0;
          const enumBoost = sym.kind === 'enum' ? 0.25 : 0;
          return {
            sym,
            score: scoreOverlap(queryTokens, sym.tokens, nameMatchBoost + enumBoost)
          };
        })
        .filter((item) => item.score > 0.25)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .map((item) => ({
          name: item.sym.name,
          filePath: item.sym.filePath,
          snippet: item.sym.snippet
        }))
    : [];

  const exampleScored = (kb.customExamples || [])
    .map((ex) => {
      const sameClassBoost = ex.className === activeClassName ? 1.5 : 0;
      const exTokens = tokenizeText(`${ex.naturalLanguage} ${ex.rql}`);
      return {
        ex,
        score: scoreOverlap(queryTokens, exTokens, sameClassBoost)
      };
    })
    .filter(
      (item) =>
        item.ex.className === activeClassName || item.score > 0.45
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((item) => item.ex);

  const historyQueries = includeQueryHistory
    ? loadLocalStorageQueryHistory(activeSchema)
    : [];
  const existingRql = new Set(exampleScored.map((e) => e.rql));
  for (const q of historyQueries) {
    if (!existingRql.has(q) && exampleScored.length < 6) {
      existingRql.add(q);
      exampleScored.push({
        naturalLanguage: `Saved/recent query on ${activeClassName}`,
        rql: q,
        className: activeClassName
      });
    }
  }

  const activeClassDescription = kb.classes?.[activeClassName]?.description;
  const summaryParts: string[] = [];
  if (kb.projectNotes.trim()) {
    summaryParts.push('Project notes');
  }
  const annotatedPropCount = Object.keys(
    propertyDescriptions[activeClassName] || {}
  ).length;
  if (activeClassDescription || annotatedPropCount > 0) {
    summaryParts.push(
      `${annotatedPropCount || 1} field note${annotatedPropCount === 1 ? '' : 's'}`
    );
  }
  if (scoredSymbols.length > 0) {
    summaryParts.push(`${scoredSymbols.length} code/enum snippet${scoredSymbols.length === 1 ? '' : 's'}`);
  }
  if (exampleScored.length > 0) {
    summaryParts.push(`${exampleScored.length} RQL example${exampleScored.length === 1 ? '' : 's'}`);
  }

  return {
    projectNotes: kb.projectNotes.trim(),
    activeClassDescription,
    propertyDescriptions,
    codeSnippets: scoredSymbols,
    examples: exampleScored,
    summaryParts
  };
}

export function recordVerifiedQueryExample(params: {
  realmPath: string;
  classes: Realm.ObjectSchema[];
  className: string;
  naturalLanguage: string;
  rql: string;
  overrideDir?: string;
}): IRealmKnowledgeBase {
  const nl = params.naturalLanguage.trim();
  const rql = params.rql.trim();
  const kb = loadKnowledgeBaseForRealm(
    params.realmPath,
    params.classes,
    params.overrideDir
  );
  if (!nl || !rql) {
    return kb;
  }
  const now = new Date().toISOString();
  const filtered = kb.customExamples.filter(
    (ex) => !(ex.className === params.className && ex.rql === rql)
  );
  const next: IRealmKnowledgeBase = {
    ...kb,
    lastPath: params.realmPath || kb.lastPath,
    customExamples: [
      {
        naturalLanguage: nl,
        rql,
        className: params.className,
        updatedAt: now
      },
      ...filtered
    ].slice(0, MAX_KB_EXAMPLES)
  };
  return saveKnowledgeBase(next, params.overrideDir);
}

function isSafeNonPiiEnumValue(value: unknown): value is string | number {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HINT_STR_LEN) {
    return false;
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    return false;
  }
  // Exclude emails, URLs, long hex IDs, or JWT tokens
  if (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ||
    /^https?:\/\//i.test(trimmed) ||
    /^[a-fA-F0-9]{20,}$/.test(trimmed) ||
    trimmed.startsWith('eyJ')
  ) {
    return false;
  }
  return true;
}

/**
 * Samples low-cardinality non-PII enum-like values (status/type codes) on-device
 * so Local AI knows exact stored values (e.g. "ACTIVE" vs 1) without exposing user data.
 */
export function sampleSafePropertyHints(
  realm: Realm,
  className: string
): IPropertyValueHint[] {
  const schema = realm.schema.find((s) => s.name === className);
  if (!schema || schema.embedded || schema.asymmetric) {
    return [];
  }

  let objects: ReturnType<Realm['objects']>;
  try {
    objects = realm.objects(className);
  } catch {
    return [];
  }
  if (objects.length === 0) {
    return [];
  }

  const candidateProps: Array<{ name: string; type: string }> = [];
  for (const [propName, rawProp] of Object.entries(schema.properties)) {
    const prop =
      typeof rawProp === 'string'
        ? ({ type: rawProp } as Realm.ObjectSchemaProperty)
        : (rawProp as Realm.ObjectSchemaProperty);
    if (
      schema.primaryKey === propName ||
      isSensitivePropertyName(propName) ||
      PII_FIELD_PATTERN.test(propName)
    ) {
      continue;
    }
    if (prop.type === 'string' || prop.type === 'int') {
      candidateProps.push({ name: propName, type: prop.type });
    }
  }
  if (candidateProps.length === 0) {
    return [];
  }

  const sampleLimit = Math.min(objects.length, MAX_SAMPLE_ROWS);
  const buckets = new Map<
    string,
    { type: string; values: Set<string | number>; disqualified: boolean }
  >();
  for (const p of candidateProps) {
    buckets.set(p.name, {
      type: p.type,
      values: new Set(),
      disqualified: false
    });
  }

  for (let i = 0; i < sampleLimit; i++) {
    const row = objects[i] as unknown as Record<string, unknown>;
    if (!row) {
      continue;
    }
    for (const p of candidateProps) {
      const bucket = buckets.get(p.name)!;
      if (bucket.disqualified) {
        continue;
      }
      const val = row[p.name];
      if (val === null || val === undefined) {
        continue;
      }
      if (!isSafeNonPiiEnumValue(val)) {
        bucket.disqualified = true;
        continue;
      }
      bucket.values.add(val);
      if (bucket.values.size > MAX_ENUM_DISTINCT) {
        // High cardinality => likely real user/transactional data, not an enum
        bucket.disqualified = true;
      }
    }
  }

  const hints: IPropertyValueHint[] = [];
  for (const p of candidateProps) {
    const bucket = buckets.get(p.name)!;
    if (!bucket.disqualified && bucket.values.size > 0) {
      hints.push({
        propertyName: p.name,
        type: bucket.type,
        values: Array.from(bucket.values).slice(0, 6)
      });
    }
  }
  return hints;
}
