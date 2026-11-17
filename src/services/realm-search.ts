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

import {
  isSensitivePropertyName,
  serializeRealmValue
} from '../utils/realm-serialize';

export interface ISearchObjectIdentifier {
  key: string;
  value: string;
  isPrimaryKey: boolean;
}

export interface IIncomingLinkCount {
  fromClass: string;
  propName: string;
  count: number;
}

export interface ISearchSample {
  object: Realm.Object;
  identifier: ISearchObjectIdentifier | null;
  matchedFields: string[];
  preview: string;
  serialized?: Record<string, unknown>;
}

export interface IClassSearchResult {
  className: string;
  primaryKeyField: string | null;
  count: number;
  samples: ISearchSample[];
}

export interface ISearchAcrossRealmOptions {
  maxSamplesPerClass?: number;
  includeSensitiveFields?: boolean;
  includeSerializedRow?: boolean;
}

const CANDIDATE_ID_KEYS = [
  '_id',
  'id',
  'uuid',
  'uid',
  'key',
  'code',
  'slug',
  'name',
  'title',
  'username',
  'email'
];

export function extractSearchObjectIdentifier(
  object: Realm.Object | null | undefined
): ISearchObjectIdentifier | null {
  if (!object || typeof object.isValid !== 'function' || !object.isValid()) {
    return null;
  }
  const schema = object.objectSchema();
  const record = object as unknown as Record<string, unknown>;

  if (schema.primaryKey) {
    const raw = record[schema.primaryKey];
    if (raw !== undefined && raw !== null) {
      return {
        key: schema.primaryKey,
        value: String(raw),
        isPrimaryKey: true
      };
    }
  }

  const propNames = Object.keys(schema.properties);
  for (const candidate of CANDIDATE_ID_KEYS) {
    const match = propNames.find(
      (p) => p.toLowerCase() === candidate.toLowerCase()
    );
    if (match) {
      const raw = record[match];
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        return {
          key: match,
          value: String(raw),
          isPrimaryKey: false
        };
      }
    }
  }

  return null;
}

function formatScalarPreview(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  const str = String(val);
  return str.length > 44 ? `${str.slice(0, 44)}…` : str;
}

function buildObjectPreview(
  obj: Realm.Object,
  schema: Realm.ObjectSchema,
  queryLower: string,
  includeSensitive: boolean
): string {
  const record = obj as unknown as Record<string, unknown>;
  const snippets: string[] = [];
  for (const key of Object.keys(schema.properties)) {
    if (key === schema.primaryKey) {
      continue;
    }
    if (!includeSensitive && isSensitivePropertyName(key)) {
      continue;
    }
    const val = record[key];
    if (
      val !== null &&
      val !== undefined &&
      (typeof val === 'string' ||
        typeof val === 'number' ||
        typeof val === 'boolean' ||
        val instanceof Date ||
        val instanceof Realm.BSON.ObjectId ||
        val instanceof Realm.BSON.UUID ||
        val instanceof Realm.BSON.Decimal128)
    ) {
      const formatted = formatScalarPreview(val);
      if (
        String(val).toLowerCase().includes(queryLower) ||
        snippets.length < 3
      ) {
        snippets.push(`${key}: ${formatted}`);
      }
    }
    if (snippets.length >= 4) {
      break;
    }
  }
  return snippets.join('  •  ');
}

function findMatchedFieldsOnObject(
  obj: Realm.Object,
  schema: Realm.ObjectSchema,
  trimmed: string,
  includeSensitive: boolean
): string[] {
  const lower = trimmed.toLowerCase();
  const isNumeric = /^-?\d+(\.\d+)?$/.test(trimmed);
  const record = obj as unknown as Record<string, unknown>;
  const matched: string[] = [];

  for (const propName of Object.keys(schema.properties)) {
    if (!includeSensitive && isSensitivePropertyName(propName)) {
      continue;
    }
    const val = record[propName];
    if (val === null || val === undefined) {
      continue;
    }
    if (
      typeof val === 'string' ||
      val instanceof Realm.BSON.ObjectId ||
      val instanceof Realm.BSON.UUID
    ) {
      if (String(val).toLowerCase().includes(lower)) {
        matched.push(propName);
      }
    } else if (typeof val === 'number' || val instanceof Realm.BSON.Decimal128) {
      if (isNumeric && Number(val) === Number(trimmed)) {
        matched.push(propName);
      }
    } else if (typeof val === 'boolean') {
      if (
        (lower === 'true' && val) ||
        (lower === 'false' && !val)
      ) {
        matched.push(propName);
      }
    } else if (val instanceof Realm.List || Array.isArray(val)) {
      const arr = Array.from(val as Iterable<unknown>);
      if (
        arr.some(
          (item) =>
            item !== null &&
            item !== undefined &&
            (typeof item === 'string' ||
              typeof item === 'number' ||
              item instanceof Realm.BSON.ObjectId ||
              item instanceof Realm.BSON.UUID) &&
            String(item).toLowerCase().includes(lower)
        )
      ) {
        matched.push(propName);
      }
    }
  }

  return matched;
}

export function searchAcrossRealm(
  realm: Realm,
  classes: Realm.ObjectSchema[],
  rawQuery: string,
  options: ISearchAcrossRealmOptions = {}
): IClassSearchResult[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return [];
  }

  const maxSamplesPerClass = options.maxSamplesPerClass ?? 5;
  const includeSensitive = options.includeSensitiveFields ?? false;
  const includeSerializedRow = options.includeSerializedRow ?? false;

  const isNumeric = /^-?\d+(\.\d+)?$/.test(trimmed);
  const isHex24 = /^[0-9a-fA-F]{24}$/.test(trimmed);
  const isUuid =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      trimmed
    );
  const lower = trimmed.toLowerCase();
  const results: IClassSearchResult[] = [];

  for (const schema of classes) {
    if (schema.embedded || schema.asymmetric || schema.name.startsWith('__')) {
      continue;
    }
    const clauses: string[] = [];
    const args: unknown[] = [trimmed];

    for (const propName of Object.keys(schema.properties)) {
      const prop = schema.properties[propName] as Realm.ObjectSchemaProperty;
      if (!prop || typeof prop !== 'object') {
        continue;
      }
      if (!includeSensitive && isSensitivePropertyName(propName)) {
        continue;
      }

      if (prop.type === 'list' || prop.type === 'set') {
        if (prop.objectType === 'string') {
          clauses.push(`ANY ${propName} CONTAINS[c] $0`);
        } else if (
          isNumeric &&
          (prop.objectType === 'int' ||
            prop.objectType === 'float' ||
            prop.objectType === 'double' ||
            prop.objectType === 'decimal128')
        ) {
          clauses.push(`ANY ${propName} == ${Number(trimmed)}`);
        }
        continue;
      }

      if (prop.type === 'string') {
        clauses.push(`${propName} CONTAINS[c] $0`);
      } else if (
        isNumeric &&
        (prop.type === 'int' ||
          prop.type === 'float' ||
          prop.type === 'double' ||
          prop.type === 'decimal128')
      ) {
        clauses.push(`${propName} == ${Number(trimmed)}`);
      } else if (
        prop.type === 'bool' &&
        (lower === 'true' || lower === 'false')
      ) {
        clauses.push(`${propName} == ${lower}`);
      } else if (prop.type === 'objectId' && isHex24) {
        try {
          const oid = new Realm.BSON.ObjectId(trimmed);
          const idx = args.length;
          args.push(oid);
          clauses.push(`${propName} == $${idx}`);
        } catch {
          // ignore
        }
      } else if (prop.type === 'uuid' && isUuid) {
        try {
          const uuidVal = new Realm.BSON.UUID(trimmed);
          const idx = args.length;
          args.push(uuidVal);
          clauses.push(`${propName} == $${idx}`);
        } catch {
          // ignore
        }
      }
    }

    if (clauses.length === 0) {
      continue;
    }

    try {
      const matched = realm
        .objects(schema.name)
        .filtered(clauses.join(' OR '), ...args);
      if (matched.length > 0) {
        const sampleCount = Math.min(matched.length, maxSamplesPerClass);
        const samples: ISearchSample[] = [];
        const seenObjs = new Set<number>();

        // Put exact PrimaryKey match first when present
        if (schema.primaryKey) {
          for (let i = 0; i < Math.min(matched.length, 25); i++) {
            const candidate = matched[i];
            const idInfo = extractSearchObjectIdentifier(candidate);
            if (
              idInfo?.isPrimaryKey &&
              idInfo.value.toLowerCase() === lower
            ) {
              seenObjs.add(i);
              samples.push({
                object: candidate,
                identifier: idInfo,
                matchedFields: findMatchedFieldsOnObject(
                  candidate,
                  schema,
                  trimmed,
                  includeSensitive
                ),
                preview: buildObjectPreview(
                  candidate,
                  schema,
                  lower,
                  includeSensitive
                ),
                serialized: includeSerializedRow
                  ? (serializeRealmValue(candidate, {
                      maxDepth: 1,
                      maskSensitiveFields: !includeSensitive
                    }) as Record<string, unknown>)
                  : undefined
              });
              if (samples.length >= sampleCount) {
                break;
              }
            }
          }
        }

        for (
          let i = 0;
          i < matched.length && samples.length < sampleCount;
          i++
        ) {
          if (seenObjs.has(i)) {
            continue;
          }
          const obj = matched[i];
          samples.push({
            object: obj,
            identifier: extractSearchObjectIdentifier(obj),
            matchedFields: findMatchedFieldsOnObject(
              obj,
              schema,
              trimmed,
              includeSensitive
            ),
            preview: buildObjectPreview(obj, schema, lower, includeSensitive),
            serialized: includeSerializedRow
              ? (serializeRealmValue(obj, {
                  maxDepth: 1,
                  maskSensitiveFields: !includeSensitive
                }) as Record<string, unknown>)
              : undefined
          });
        }

        results.push({
          className: schema.name,
          primaryKeyField: schema.primaryKey ?? null,
          count: matched.length,
          samples
        });
      }
    } catch {
      // skip unreadable class/query combination
    }
  }

  // Rank classes where a primaryKey exact match occurred before partial matches
  return results.sort((a, b) => {
    const aPk = a.samples.some(
      (s) =>
        s.identifier?.isPrimaryKey && s.identifier.value.toLowerCase() === lower
    );
    const bPk = b.samples.some(
      (s) =>
        s.identifier?.isPrimaryKey && s.identifier.value.toLowerCase() === lower
    );
    if (aPk !== bPk) {
      return aPk ? -1 : 1;
    }
    return b.count - a.count;
  });
}

export function findIncomingLinksForObject(
  classes: Realm.ObjectSchema[],
  targetClassName: string,
  targetObject: Realm.Object
): IIncomingLinkCount[] {
  if (!targetObject || !targetObject.isValid()) {
    return [];
  }
  const links: IIncomingLinkCount[] = [];
  for (const schema of classes) {
    if (schema.name.startsWith('__') || schema.asymmetric) {
      continue;
    }
    for (const [propName, rawProp] of Object.entries(schema.properties)) {
      const prop =
        typeof rawProp === 'string'
          ? null
          : (rawProp as Realm.ObjectSchemaProperty);
      const propObjectType = prop?.objectType;
      const isDirectObjectLink =
        prop?.type === 'object' ||
        prop?.type === 'list' ||
        prop?.type === 'set';
      if (!isDirectObjectLink || propObjectType !== targetClassName) {
        continue;
      }
      try {
        const backlinks = targetObject.linkingObjects(schema.name, propName);
        if (backlinks && backlinks.length > 0) {
          links.push({
            fromClass: schema.name,
            propName,
            count: backlinks.length
          });
        }
      } catch {
        // ignore if linkingObjects not applicable (e.g. embedded without reverse link metadata)
      }
    }
  }
  return links;
}

const TOKEN_STOPWORDS = new Set([
  'id',
  'pk',
  'key',
  'uuid',
  'oid',
  'objectid',
  'class',
  'table',
  'realm',
  'rql',
  'sql',
  'where',
  'find',
  'search',
  'locate',
  'show',
  'this',
  'that',
  'what',
  'which',
  'from',
  'true',
  'false',
  'null'
]);

/**
 * Extracts high-signal ID or literal search tokens from natural-language prompts
 * such as "id usr_9981 อยู่ตรงไหน" or "หา 65f0a1b2c3d4e5f601234567 ให้หน่อย".
 */
export function extractCandidateSearchTokens(prompt: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (tok: string) => {
    const clean = tok.trim().replace(/^[,.;:!?()[\]{}]+|[,.;:!?()[\]{}]+$/g, '');
    if (
      clean.length < 2 ||
      clean.length > 128 ||
      TOKEN_STOPWORDS.has(clean.toLowerCase()) ||
      seen.has(clean)
    ) {
      return;
    }
    seen.add(clean);
    candidates.push(clean);
  };

  // 1. Quoted literals ("..." / '...' / `...`)
  const quoteRegex = /["'`]([^"'`\n]{2,100})["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRegex.exec(prompt)) !== null) {
    add(m[1]);
  }

  // 2. UUIDs and 24-hex ObjectIds
  const uuidRegex =
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
  while ((m = uuidRegex.exec(prompt)) !== null) {
    add(m[0]);
  }
  const hex24Regex = /\b[0-9a-fA-F]{24}\b/g;
  while ((m = hex24Regex.exec(prompt)) !== null) {
    add(m[0]);
  }

  // 3. Explicit ID / Key / Hash markers: "id usr_9981", "pk=123", "#402", "รหัส: ABC-12"
  const afterIdRegex =
    /(?:id|pk|key|รหัส|ไอดี|คีย์|#|หา|search|find)\s*(?:=|:|คือ|ว่า)?\s*([a-zA-Z0-9._:@/+=-]{2,80})/gi;
  while ((m = afterIdRegex.exec(prompt)) !== null) {
    add(m[1]);
  }

  // 4. Standalone mixed alphanumeric tokens with separators/digits (usr_102, ORD-2026, user99)
  const asciiTokens = prompt.match(/[A-Za-z0-9][A-Za-z0-9._:@/+-]{1,79}/g) || [];
  for (const tok of asciiTokens) {
    const hasDigit = /\d/.test(tok);
    const hasSep = /[_:@/-]/.test(tok);
    if (hasDigit || hasSep) {
      add(tok);
    }
  }

  return candidates.slice(0, 4);
}
