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

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import Realm from 'realm';

import { serializeRealmValue } from '../utils/realm-serialize';
import { getAppUserDataCandidates } from '../utils/user-data-path';

import { listActiveRealmSessions } from './active-realms';
import { findExistingKnowledgeBase } from './ai-knowledge-base';
import { getCandidateKeysForPath } from './encryption-keys';
import { diagnoseRqlError } from './rql-reference';

export const MAX_MCP_QUERY_LIMIT = 50;
const HEX_128_REGEX = /^[a-fA-F0-9]{128}$/;

export interface IRecentRealmSummary {
  path: string;
  openedAt: string;
  exists: boolean;
  sizeBytes?: number;
}

export interface IClassOverviewSummary {
  name: string;
  embedded: boolean;
  asymmetric: boolean;
  primaryKey: string | null;
  propertyCount: number;
  rowCount: number | null;
  description?: string;
}

export type RealmTargetSource = 'explicit-path' | 'open-window' | 'recent-file';

export interface IRealmOverviewResult {
  path: string;
  source: RealmTargetSource;
  activeClassName: string | null;
  sizeBytes: number;
  schemaVersion: number;
  knowledgeBaseNotes?: string;
  classes: IClassOverviewSummary[];
}

export interface IPropertyDetail {
  name: string;
  type: string;
  objectType: string | null;
  optional: boolean;
  indexed: boolean;
  isPrimaryKey: boolean;
  description?: string;
}

export interface IClassSchemaDetail {
  name: string;
  embedded: boolean;
  asymmetric: boolean;
  primaryKey: string | null;
  description?: string;
  properties: IPropertyDetail[];
}

export interface IQueryRealmResult {
  path: string;
  source: RealmTargetSource;
  className: string;
  query: string | null;
  totalInClass: number;
  totalMatched: number;
  offset: number;
  limit: number;
  sensitiveFieldsMasked: boolean;
  rows: unknown[];
}

interface IResolvedTargetRealm {
  path: string;
  source: RealmTargetSource;
  activeClassName?: string;
}

export function resolveTargetRealm(rawPath?: string): IResolvedTargetRealm {
  const openSessions = listActiveRealmSessions();

  if (rawPath && rawPath.trim()) {
    const resolved = resolveUserRealmPath(rawPath);
    const matchingSession = openSessions.find((s) => s.path === resolved);
    return {
      path: resolved,
      source: 'explicit-path',
      activeClassName: matchingSession?.activeClassName
    };
  }

  for (const session of openSessions) {
    if (fs.existsSync(session.path)) {
      return {
        path: session.path,
        source: 'open-window',
        activeClassName: session.activeClassName
      };
    }
  }

  for (const recent of listRecentRealmsHeadless()) {
    if (recent.exists) {
      return {
        path: recent.path,
        source: 'recent-file'
      };
    }
  }

  throw new Error(
    'No Realm file specified, no Realm Studio Ultimate window is currently open, and no recent .realm file was found. Open a .realm file in Realm Studio Ultimate or pass "path".'
  );
}

export function resolveUserRealmPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const expanded =
    trimmed === '~'
      ? os.homedir()
      : trimmed.startsWith('~/')
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  return path.resolve(expanded);
}

export function parseEncryptionKeyHex(rawHex?: string): Uint8Array | undefined {
  const effective = (rawHex ?? '').trim();
  if (!effective) {
    return undefined;
  }
  if (!HEX_128_REGEX.test(effective)) {
    throw new Error(
      'Invalid encryptionKeyHex: expected exactly 128 hexadecimal characters (64 bytes).'
    );
  }
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    bytes[i] = parseInt(effective.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function listRecentRealmsHeadless(): IRecentRealmSummary[] {
  for (const dir of getAppUserDataCandidates()) {
    const filePath = path.join(dir, 'recent-files.json');
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const data = fs.readJsonSync(filePath) as {
        files?: Array<{ path?: unknown; openedAt?: unknown }>;
      };
      if (!data || !Array.isArray(data.files)) {
        continue;
      }
      return data.files
        .filter(
          (entry): entry is { path: string; openedAt?: number } =>
            !!entry && typeof entry.path === 'string'
        )
        .sort((a, b) => (Number(b.openedAt) || 0) - (Number(a.openedAt) || 0))
        .map((entry) => {
          let exists = false;
          let sizeBytes: number | undefined;
          try {
            const stat = fs.statSync(entry.path);
            exists = stat.isFile();
            if (exists) {
              sizeBytes = stat.size;
            }
          } catch {
            // file no longer exists on disk
          }
          return {
            path: entry.path,
            openedAt: entry.openedAt
              ? new Date(Number(entry.openedAt)).toISOString()
              : '',
            exists,
            sizeBytes
          };
        });
    } catch {
      // ignore malformed recent-files.json
    }
  }
  return [];
}

function isSyncHistoryError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.message.includes('Incompatible histories.') ||
    err.message.includes('History type not consistent') ||
    err.message.startsWith(
      'History type (as specified by the Replication implementation passed to the DB constructor) was not consistent across the session'
    ) ||
    err.message.includes('Synchronized Realms cannot be opened in non-sync mode')
  );
}

function openRealmReadOnlySync(
  resolvedPath: string,
  encryptionKey?: Uint8Array,
  openSynced = false
): Realm {
  const baseConfig: Record<string, unknown> = {
    path: resolvedPath,
    readOnly: true,
    disableFormatUpgrade: true
  };
  if (encryptionKey) {
    baseConfig.encryptionKey = encryptionKey;
  }
  if (openSynced) {
    baseConfig.openSyncedRealmLocally = true;
  }
  try {
    return new Realm(baseConfig as unknown as Realm.Configuration);
  } catch (err) {
    if (!openSynced && isSyncHistoryError(err)) {
      return openRealmReadOnlySync(resolvedPath, encryptionKey, true);
    }
    throw err;
  }
}

function isDecryptionOrInvalidFormatError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /decrypt|encryption|invalid realm|bad header|hmac|not a realm file/i.test(
    err.message
  );
}

function collectCandidateKeys(
  resolvedPath: string,
  explicitKeyHex?: string
): Array<Uint8Array | undefined> {
  const seenHex = new Set<string>();
  const keyBuffers: Uint8Array[] = [];

  const pushHex = (hex?: string) => {
    const parsed = parseEncryptionKeyHex(hex);
    if (!parsed) {
      return;
    }
    const normalized = hex!.trim().toLowerCase();
    if (!seenHex.has(normalized)) {
      seenHex.add(normalized);
      keyBuffers.push(parsed);
    }
  };

  pushHex(explicitKeyHex);
  pushHex(process.env.REALM_ENCRYPTION_KEY);
  for (const vaultKey of getCandidateKeysForPath(resolvedPath)) {
    try {
      pushHex(vaultKey);
    } catch {
      // ignore invalid key entries in vault
    }
  }

  const hasExplicitKey =
    !!explicitKeyHex?.trim() || !!process.env.REALM_ENCRYPTION_KEY?.trim();

  if (hasExplicitKey) {
    return [...keyBuffers, undefined];
  }
  return [undefined, ...keyBuffers];
}

export function withOpenedRealm<T>(
  rawPath: string | undefined,
  encryptionKeyHex: string | undefined,
  fn: (
    realm: Realm,
    target: IResolvedTargetRealm,
    fileSizeBytes: number
  ) => T
): T {
  const target = resolveTargetRealm(rawPath);
  const resolvedPath = target.path;

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Realm file not found: ${resolvedPath}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolvedPath}`);
  }

  const attempts = collectCandidateKeys(resolvedPath, encryptionKeyHex);
  let lastError: unknown;
  let realm: Realm | null = null;

  for (const keyBuf of attempts) {
    try {
      realm = openRealmReadOnlySync(resolvedPath, keyBuf);
      break;
    } catch (err) {
      lastError = err;
      if (!isDecryptionOrInvalidFormatError(err) && keyBuf === undefined) {
        // Non-crypto failure (e.g. permissions / format upgrade / lock)
        break;
      }
    }
  }

  if (!realm) {
    if (isDecryptionOrInvalidFormatError(lastError)) {
      throw new Error(
        `Cannot decrypt Realm file (${path.basename(resolvedPath)}). Open/unlock it in Realm Studio Ultimate (or save its key in Key Vault), set REALM_ENCRYPTION_KEY in your MCP "env" config, or pass encryptionKeyHex.`
      );
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  try {
    return fn(realm, target, stat.size);
  } finally {
    if (!realm.isClosed) {
      realm.close();
    }
  }
}

export function inspectRealmOverview(params: {
  path?: string;
  encryptionKeyHex?: string;
}): IRealmOverviewResult {
  return withOpenedRealm(
    params.path,
    params.encryptionKeyHex,
    (realm, target, sizeBytes) => {
      const kb = findExistingKnowledgeBase(target.path, realm.schema);
      const projectNotes = kb?.projectNotes?.trim() || undefined;
      const classes: IClassOverviewSummary[] = realm.schema
        .filter((s) => !s.name.startsWith('__'))
        .map((schema) => {
          const desc = kb?.classes?.[schema.name]?.description?.trim();
          return {
            name: schema.name,
            embedded: !!schema.embedded,
            asymmetric: !!schema.asymmetric,
            primaryKey: schema.primaryKey || null,
            propertyCount: Object.keys(schema.properties).length,
            rowCount:
              schema.embedded || schema.asymmetric
                ? null
                : realm.objects(schema.name).length,
            ...(desc ? { description: desc } : {})
          };
        });

      return {
        path: target.path,
        source: target.source,
        activeClassName: target.activeClassName || null,
        sizeBytes,
        schemaVersion: realm.schemaVersion,
        ...(projectNotes ? { knowledgeBaseNotes: projectNotes } : {}),
        classes
      };
    }
  );
}

export function getRealmClassSchemas(params: {
  path?: string;
  className?: string;
  encryptionKeyHex?: string;
}): {
  path: string;
  source: RealmTargetSource;
  activeClassName: string | null;
  classes: IClassSchemaDetail[];
} {
  return withOpenedRealm(params.path, params.encryptionKeyHex, (realm, target) => {
    const kb = findExistingKnowledgeBase(target.path, realm.schema);
    const schemas = realm.schema.filter((s) => {
      if (s.name.startsWith('__')) {
        return false;
      }
      return params.className ? s.name === params.className : true;
    });

    if (params.className && schemas.length === 0) {
      const available = realm.schema
        .filter((s) => !s.name.startsWith('__'))
        .map((s) => s.name)
        .join(', ');
      throw new Error(
        `Class "${params.className}" not found. Available classes: ${available}`
      );
    }

    return {
      path: target.path,
      source: target.source,
      activeClassName: target.activeClassName || null,
      classes: schemas.map((schema) => {
        const classKb = kb?.classes?.[schema.name];
        const classDesc = classKb?.description?.trim();
        return {
          name: schema.name,
          embedded: !!schema.embedded,
          asymmetric: !!schema.asymmetric,
          primaryKey: schema.primaryKey || null,
          ...(classDesc ? { description: classDesc } : {}),
          properties: Object.entries(schema.properties).map(([propName, raw]) => {
            const prop =
              typeof raw === 'string'
                ? ({ type: raw } as Realm.ObjectSchemaProperty)
                : (raw as Realm.ObjectSchemaProperty);
            const propDesc = classKb?.properties?.[propName]?.trim();
            return {
              name: propName,
              type: prop.type,
              objectType: prop.objectType || null,
              optional: !!prop.optional,
              indexed: !!prop.indexed,
              isPrimaryKey: schema.primaryKey === propName,
              ...(propDesc ? { description: propDesc } : {})
            };
          })
        };
      })
    };
  });
}

function getFilteredCollection(
  realm: Realm,
  className: string,
  query?: string,
  sortBy?: string,
  descending = false
) {
  const schema = realm.schema.find((s) => s.name === className);
  if (!schema) {
    const available = realm.schema
      .filter((s) => !s.name.startsWith('__'))
      .map((s) => s.name)
      .join(', ');
    throw new Error(
      `Class "${className}" not found. Available classes: ${available}`
    );
  }
  if (schema.embedded || schema.asymmetric) {
    throw new Error(
      `Class "${className}" is ${schema.embedded ? 'Embedded' : 'Asymmetric'} and cannot be queried directly at top level. Query its parent class instead.`
    );
  }

  let results = realm.objects(className);
  const totalInClass = results.length;

  const trimmedQuery = query?.trim();
  if (trimmedQuery) {
    try {
      results = results.filtered(trimmedQuery);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const hint = diagnoseRqlError(
        trimmedQuery,
        errMsg,
        Object.keys(schema.properties)
      );
      throw new Error(hint ? `${errMsg} (Hint: ${hint})` : errMsg);
    }
  }
  const trimmedSort = sortBy?.trim();
  if (trimmedSort) {
    results = results.sorted(trimmedSort, descending);
  }
  return { totalInClass, collection: results };
}

function resolveEffectiveClassName(
  realm: Realm,
  requestedClassName: string | undefined,
  activeClassName: string | undefined
): string {
  const candidate = requestedClassName?.trim() || activeClassName?.trim();
  if (candidate) {
    return candidate;
  }
  const firstStandard = realm.schema.find(
    (s) => !s.name.startsWith('__') && !s.embedded && !s.asymmetric
  );
  if (firstStandard) {
    return firstStandard.name;
  }
  throw new Error('No queryable Realm class found in this file.');
}

export function queryRealmObjects(params: {
  path?: string;
  className?: string;
  query?: string;
  sortBy?: string;
  descending?: boolean;
  limit?: number;
  offset?: number;
  includeSensitiveFields?: boolean;
  encryptionKeyHex?: string;
}): IQueryRealmResult {
  const safeLimit = Math.min(
    MAX_MCP_QUERY_LIMIT,
    Math.max(1, Math.floor(params.limit ?? 20))
  );
  const safeOffset = Math.max(0, Math.floor(params.offset ?? 0));
  const maskSensitiveFields = !params.includeSensitiveFields;

  return withOpenedRealm(
    params.path,
    params.encryptionKeyHex,
    (realm, target) => {
      const effectiveClassName = resolveEffectiveClassName(
        realm,
        params.className,
        target.activeClassName
      );
      const { totalInClass, collection } = getFilteredCollection(
        realm,
        effectiveClassName,
        params.query,
        params.sortBy,
        !!params.descending
      );
      const totalMatched = collection.length;
      const end = Math.min(totalMatched, safeOffset + safeLimit);
      const rows: unknown[] = [];

      for (let i = safeOffset; i < end; i++) {
        rows.push(
          serializeRealmValue(collection[i], {
            maxDepth: 2,
            maskSensitiveFields
          })
        );
      }

      return {
        path: target.path,
        source: target.source,
        className: effectiveClassName,
        query: params.query?.trim() || null,
        totalInClass,
        totalMatched,
        offset: safeOffset,
        limit: safeLimit,
        sensitiveFieldsMasked: maskSensitiveFields,
        rows
      };
    }
  );
}

export function countRealmObjects(params: {
  path?: string;
  className?: string;
  query?: string;
  encryptionKeyHex?: string;
}): {
  path: string;
  source: RealmTargetSource;
  className: string;
  query: string | null;
  count: number;
} {
  return withOpenedRealm(
    params.path,
    params.encryptionKeyHex,
    (realm, target) => {
      const effectiveClassName = resolveEffectiveClassName(
        realm,
        params.className,
        target.activeClassName
      );
      const { collection } = getFilteredCollection(
        realm,
        effectiveClassName,
        params.query
      );
      return {
        path: target.path,
        source: target.source,
        className: effectiveClassName,
        query: params.query?.trim() || null,
        count: collection.length
      };
    }
  );
}
