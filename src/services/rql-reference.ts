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

export interface IRqlValidationResult {
  valid: boolean;
  matchedCount?: number;
  totalInClass?: number;
  errorMessage?: string;
  correctionHint?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Realm Query Language parses date literals (`YYYY-MM-DD@HH:MM:SS`) in UTC.
 */
export function formatRqlDateLiteral(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
    `@${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  );
}

/**
 * Generates current UTC + local-boundary date hints so relative requests like
 * "วันนี้", "7 วันล่าสุด", or "เดือนนี้" produce valid RQL date literals.
 */
export function getCurrentRqlTimestampHint(now = new Date()): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMins = Math.abs(offsetMinutes);
  const tzLabel = `UTC${sign}${pad2(Math.floor(absMins / 60))}:${pad2(absMins % 60)}`;

  const startOfLocalToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0
  );
  const startOfLocalYesterday = new Date(startOfLocalToday.getTime() - 86400000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const startOfLocalMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);

  return [
    `Reference Clock (Timezone ${tzLabel}; all RQL date literals are parsed as UTC):`,
    `- Now (UTC literal): ${formatRqlDateLiteral(now)}`,
    `- Start of Today (${tzLabel} -> UTC): ${formatRqlDateLiteral(startOfLocalToday)}`,
    `- Start of Yesterday: ${formatRqlDateLiteral(startOfLocalYesterday)}`,
    `- 7 Days Ago: ${formatRqlDateLiteral(sevenDaysAgo)}`,
    `- 30 Days Ago: ${formatRqlDateLiteral(thirtyDaysAgo)}`,
    `- Start of This Month: ${formatRqlDateLiteral(startOfLocalMonth)}`
  ].join('\n');
}

/**
 * Authoritative RQL syntax guide verified against Realm JS v20 (Realm Core parser).
 */
export function buildRqlSystemPromptGuide(): string {
  return [
    'Authoritative Realm Query Language (RQL) Rules (Realm Core v20):',
    '1. Comparison & Logic:',
    '   - Use ==, !=, >, >=, <, <=, AND (or &&), OR (or ||), NOT (or !), IN {...}, BETWEEN {min, max}, null / nil.',
    '   - NEVER use SQL syntax (no SELECT, FROM, WHERE, ORDER BY, GROUP BY, IS NULL, single =, ILIKE, or % wildcards).',
    '2. String Matching (append [c] on the operator for case-insensitive matching by default):',
    '   - ==[c], !=[c], IN[c] {"a", "b"}, CONTAINS[c], BEGINSWITH[c], ENDSWITH[c], LIKE[c].',
    '   - LIKE / LIKE[c] wildcards are * (0+ chars) and ? (1 char), e.g. name LIKE[c] "A*n".',
    '3. Date, ObjectId & UUID Literals (CRITICAL):',
    '   - Date literals MUST include time in UTC format YYYY-MM-DD@HH:MM:SS (unquoted!), e.g. createdAt >= 2026-11-17@00:00:00.',
    '   - NEVER write bare YYYY-MM-DD without @HH:MM:SS, and NEVER wrap a date literal in quotes.',
    '   - ObjectId: oid(<24-hex>), e.g. _id == oid(507f1f77bcf86cd799439011).',
    '   - UUID: uuid(<uuid>), e.g. id == uuid(123e4567-e89b-12d3-a456-426614174000).',
    '4. Relationships, Lists, Dictionaries, Mixed & Backlinks:',
    '   - Forward links: owner.name ==[c] "Ann" OR category.code IN {"A", "B"}.',
    '   - Collection size & aggregates: items.@count > 0, items.@size > 0, items.@avg.price > 50, nums.@sum > 10.',
    '   - Object-link lists (`list<Class>`): SUBQUERY(items, $x, $x.price > 100 AND $x.active == true).@count > 0 or ANY items.price > 100.',
    '   - Primitive lists (`string[]`, `int[]`, etc.): NEVER use SUBQUERY on primitive lists; use ANY tags ==[c] "vip", NONE tags == "ban", or "vip" IN tags.',
    '   - Dictionaries: dict["key"] == 1, ANY dict.@keys == "key", dict.@count > 0.',
    '   - Mixed properties: prop.@type == "string" (or "int", "bool", "date", "object", etc.).',
    '   - Backlinks (inverse links): @links.<SourceClass>.<sourceProp>.@count > 0.',
    '5. Modifiers (SORT, DISTINCT, LIMIT, TRUEPREDICATE):',
    '   - Place SORT(prop ASC|DESC, ...), DISTINCT(prop), LIMIT(n) after a valid predicate.',
    '   - If filtering all rows with sort/limit/distinct only, ALWAYS begin with TRUEPREDICATE (e.g. TRUEPREDICATE SORT(createdAt DESC) LIMIT(20)).'
  ].join('\n');
}

/**
 * Diagnoses a failed RQL expression from Realm Core and produces targeted guidance
 * for deterministic feedback or LLM self-correction.
 */
export function diagnoseRqlError(
  query: string,
  errorMessage: string,
  availableProperties: string[] = []
): string {
  const hints: string[] = [];
  const lowerErr = errorMessage.toLowerCase();

  if (/\b(?:select|where|order\s+by|is\s+(?:not\s+)?null|ilike)\b/i.test(query)) {
    hints.push(
      'Remove SQL keywords. Return only a Realm predicate (e.g. "prop == null" or "TRUEPREDICATE SORT(prop DESC)").'
    );
  }
  if (/^\s*(?:sort|limit|distinct)\s*\(/i.test(query)) {
    hints.push(
      'SORT/LIMIT/DISTINCT cannot stand alone without a predicate; prepend "TRUEPREDICATE " before SORT/LIMIT/DISTINCT.'
    );
  }
  if (
    /\b\d{4}-\d{2}-\d{2}\b(?!@\d{2}:\d{2}:\d{2})/.test(query) ||
    /['"]\d{4}-\d{2}-\d{2}/.test(query)
  ) {
    hints.push(
      'Date literals MUST be unquoted UTC YYYY-MM-DD@HH:MM:SS (e.g. 2026-11-17@00:00:00), never bare YYYY-MM-DD or quoted strings.'
    );
  }
  if (lowerErr.includes('subquery can not operate on a list of primitive')) {
    hints.push(
      'SUBQUERY only supports lists of Realm Objects. For primitive lists (string[]/int[]), use `ANY listProp == "val"` or `"val" IN listProp`.'
    );
  }
  if (
    lowerErr.includes('no property') ||
    lowerErr.includes('invalid property name') ||
    lowerErr.includes('has no property')
  ) {
    if (availableProperties.length > 0) {
      hints.push(
        `Use only exact property names on this class: ${availableProperties.join(', ')}.`
      );
    }
  }
  if (query.includes('%') && /\blike\b/i.test(query)) {
    hints.push('RQL LIKE uses * and ? wildcards instead of SQL %.');
  }
  if (/[^!<>=]=[^=]/.test(query)) {
    hints.push('Use == for equality in RQL, not single =.');
  }

  return hints.join(' ');
}

export function validateRqlAgainstRealm(
  realm: Realm,
  className: string,
  query: string
): IRqlValidationResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { valid: false, errorMessage: 'Query string is empty.' };
  }

  const schema = realm.schema.find((s) => s.name === className);
  if (!schema) {
    return {
      valid: false,
      errorMessage: `Class "${className}" does not exist in this Realm.`
    };
  }
  if (schema.embedded || schema.asymmetric) {
    return {
      valid: false,
      errorMessage: `Class "${className}" is ${schema.embedded ? 'Embedded' : 'Asymmetric'} and cannot be filtered directly at top level.`
    };
  }

  const availableProps = Object.keys(schema.properties);

  try {
    const all = realm.objects(className);
    const totalInClass = all.length;
    const matched = all.filtered(trimmed);
    return {
      valid: true,
      matchedCount: matched.length,
      totalInClass
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const correctionHint = diagnoseRqlError(trimmed, errorMessage, availableProps);
    return {
      valid: false,
      errorMessage,
      correctionHint: correctionHint || undefined
    };
  }
}
