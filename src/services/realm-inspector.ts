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
}

export interface IRealmOverviewResult {
  path: string;
  sizeBytes: number;
  schemaVersion: number;
  classes: IClassOverviewSummary[];
}

export interface IPropertyDetail {
  name: string;
  type: string;
  objectType: string | null;
  optional: boolean;
  indexed: boolean;
  isPrimaryKey: boolean;
}

export interface IClassSchemaDetail {
  name: string;
  embedded: boolean;
  asymmetric: boolean;
  primaryKey: string | null;
  properties: IPropertyDetail[];
}

export interface IQueryRealmResult {
  path: string;
  className: string;
  query: string | null;
  totalInClass: number;
  totalMatched: number;
  offset: number;
  limit: number;
  sensitiveFieldsMasked: boolean;
  rows: unknown[];
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
  const effective = (rawHex ?? process.env.REALM_ENCRYPTION_KEY ?? '').trim();
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

function getAppUserDataCandidates(): string[] {
  const home = os.homedir();
  const names = ['Realm Studio Plus', 'realm-studio-plus'];
  if (process.platform === 'darwin') {
    return names.map((n) =>
      path.join(home, 'Library/Application Support', n)
    );
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
    return names.map((n) => path.join(appData, n));
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return names.map((n) => path.join(configHome, n));
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

export function withOpenedRealm<T>(
  rawPath: string,
  encryptionKeyHex: string | undefined,
  fn: (realm: Realm, resolvedPath: string, fileSizeBytes: number) => T
): T {
  const resolvedPath = resolveUserRealmPath(rawPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Realm file not found: ${resolvedPath}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolvedPath}`);
  }

  const encryptionKey = parseEncryptionKeyHex(encryptionKeyHex);
  const realm = openRealmReadOnlySync(resolvedPath, encryptionKey);
  try {
    return fn(realm, resolvedPath, stat.size);
  } finally {
    if (!realm.isClosed) {
      realm.close();
    }
  }
}

export function inspectRealmOverview(params: {
  path: string;
  encryptionKeyHex?: string;
}): IRealmOverviewResult {
  return withOpenedRealm(
    params.path,
    params.encryptionKeyHex,
    (realm, resolvedPath, sizeBytes) => {
      const classes: IClassOverviewSummary[] = realm.schema
        .filter((s) => !s.name.startsWith('__'))
        .map((schema) => ({
          name: schema.name,
          embedded: !!schema.embedded,
          asymmetric: !!schema.asymmetric,
          primaryKey: schema.primaryKey || null,
          propertyCount: Object.keys(schema.properties).length,
          rowCount:
            schema.embedded || schema.asymmetric
              ? null
              : realm.objects(schema.name).length
        }));

      return {
        path: resolvedPath,
        sizeBytes,
        schemaVersion: realm.schemaVersion,
        classes
      };
    }
  );
}

export function getRealmClassSchemas(params: {
  path: string;
  className?: string;
  encryptionKeyHex?: string;
}): IClassSchemaDetail[] {
  return withOpenedRealm(params.path, params.encryptionKeyHex, (realm) => {
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

    return schemas.map((schema) => ({
      name: schema.name,
      embedded: !!schema.embedded,
      asymmetric: !!schema.asymmetric,
      primaryKey: schema.primaryKey || null,
      properties: Object.entries(schema.properties).map(([propName, raw]) => {
        const prop =
          typeof raw === 'string'
            ? ({ type: raw } as Realm.ObjectSchemaProperty)
            : (raw as Realm.ObjectSchemaProperty);
        return {
          name: propName,
          type: prop.type,
          objectType: prop.objectType || null,
          optional: !!prop.optional,
          indexed: !!prop.indexed,
          isPrimaryKey: schema.primaryKey === propName
        };
      })
    }));
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
    results = results.filtered(trimmedQuery);
  }
  const trimmedSort = sortBy?.trim();
  if (trimmedSort) {
    results = results.sorted(trimmedSort, descending);
  }
  return { totalInClass, collection: results };
}

export function queryRealmObjects(params: {
  path: string;
  className: string;
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
    (realm, resolvedPath) => {
      const { totalInClass, collection } = getFilteredCollection(
        realm,
        params.className,
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
        path: resolvedPath,
        className: params.className,
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
  path: string;
  className: string;
  query?: string;
  encryptionKeyHex?: string;
}): { path: string; className: string; query: string | null; count: number } {
  return withOpenedRealm(
    params.path,
    params.encryptionKeyHex,
    (realm, resolvedPath) => {
      const { collection } = getFilteredCollection(
        realm,
        params.className,
        params.query
      );
      return {
        path: resolvedPath,
        className: params.className,
        query: params.query?.trim() || null,
        count: collection.length
      };
    }
  );
}
