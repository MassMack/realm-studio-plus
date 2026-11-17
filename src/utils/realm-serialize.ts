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

const SENSITIVE_TOKEN_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'authtoken',
  'apikey',
  'pin',
  'pincode',
  'privatekey',
  'publickey',
  'signingkey',
  'encryptionkey',
  'passcode',
  'passphrase',
  'otp',
  'cvv',
  'ssn',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'jwt',
  'bearer'
]);

export interface ISerializeRealmOptions {
  maxDepth?: number;
  maskSensitiveFields?: boolean;
}

export function isSensitivePropertyName(name: string): boolean {
  const normalized = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (SENSITIVE_TOKEN_WORDS.has(normalized)) {
    return true;
  }
  // Split camelCase / PascalCase / snake_case / kebab-case boundaries
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (SENSITIVE_TOKEN_WORDS.has(words[i])) {
      return true;
    }
    if (
      i + 1 < words.length &&
      SENSITIVE_TOKEN_WORDS.has(`${words[i]}${words[i + 1]}`)
    ) {
      return true;
    }
  }
  return false;
}

function serializeEntryValue(
  key: string,
  value: unknown,
  options: ISerializeRealmOptions,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (options.maskSensitiveFields && isSensitivePropertyName(key)) {
    return value === null || value === undefined ? null : '[MASKED]';
  }
  return serializeRealmValue(value, options, depth + 1, seen);
}

/**
 * Converts a Realm value (object, collection, BSON, Date, ArrayBuffer, primitive)
 * into a JSON-safe plain JavaScript structure without UI dependencies.
 */
export function serializeRealmValue(
  val: unknown,
  options: ISerializeRealmOptions = {},
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  const maxDepth = options.maxDepth ?? 2;

  if (val === null || val === undefined) {
    return null;
  }
  if (
    typeof val === 'string' ||
    typeof val === 'number' ||
    typeof val === 'boolean'
  ) {
    return val;
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (val instanceof ArrayBuffer) {
    return Buffer.from(val).toString('base64');
  }
  if (
    typeof (val as { toHexString?: unknown }).toHexString === 'function' ||
    val instanceof Realm.BSON.ObjectId ||
    val instanceof Realm.BSON.UUID ||
    val instanceof Realm.BSON.Decimal128
  ) {
    return String(val);
  }
  if (typeof val === 'object') {
    if (seen.has(val as object)) {
      return '[Circular]';
    }
    if (depth > maxDepth) {
      return String(val);
    }
    seen.add(val as object);

    if (
      Array.isArray(val) ||
      val instanceof Realm.List ||
      val instanceof Realm.Set
    ) {
      return Array.from(val as Iterable<unknown>).map((item) =>
        serializeRealmValue(item, options, depth + 1, seen)
      );
    }

    if (typeof (val as Realm.Object).objectSchema === 'function') {
      const realmObj = val as Realm.Object;
      if (!realmObj.isValid()) {
        return null;
      }
      const schema = realmObj.objectSchema();
      const record = realmObj as unknown as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(schema.properties)) {
        out[key] = serializeEntryValue(key, record[key], options, depth, seen);
      }
      return out;
    }

    const plain: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      plain[k] = serializeEntryValue(k, v, options, depth, seen);
    }
    return plain;
  }
  return String(val);
}
