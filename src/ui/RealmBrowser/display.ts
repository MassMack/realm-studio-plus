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

import util from 'node:util';

export interface IObjectIdentifier {
  key: string;
  value: string;
  isPrimaryKey: boolean;
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

export const extractObjectIdentifier = (
  object: Realm.Object | null | undefined
): IObjectIdentifier | null => {
  if (!object || typeof object.isValid !== 'function' || !object.isValid()) {
    return null;
  }
  const schema = object.objectSchema();
  const record = object as unknown as { [property: string]: unknown };

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
      if (
        raw !== undefined &&
        raw !== null &&
        (typeof raw === 'string' ||
          typeof raw === 'number' ||
          typeof (raw as { toHexString?: unknown }).toHexString === 'function')
      ) {
        const str = String(raw);
        if (str.length > 0) {
          return {
            key: match,
            value: str,
            isPrimaryKey: false
          };
        }
      }
    }
  }

  for (const propName of propNames) {
    const propDef = schema.properties[propName] as Realm.ObjectSchemaProperty;
    if (
      propDef &&
      typeof propDef === 'object' &&
      (propDef.type === 'objectId' ||
        propDef.type === 'uuid' ||
        propDef.type === 'int' ||
        propDef.type === 'string')
    ) {
      const raw = record[propName];
      if (raw !== undefined && raw !== null) {
        const str = String(raw);
        if (str.length > 0 && str.length <= 64) {
          return {
            key: propName,
            value: str,
            isPrimaryKey: false
          };
        }
      }
    }
  }

  return null;
};

export const formatShortIdValue = (value: string, maxLen = 16): string => {
  if (value.length <= maxLen) {
    return value;
  }
  const head = Math.ceil((maxLen - 1) / 2);
  const tail = Math.floor((maxLen - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
};

export const displayObject = (
  object: Realm.Object | null,
  inspectOnMissingPk = false
) => {
  if (object) {
    const schema = object.objectSchema();
    const identifier = extractObjectIdentifier(object);
    if (identifier) {
      return `${schema.name} {${identifier.key} = ${identifier.value}}`;
    } else if (inspectOnMissingPk) {
      return util
        .inspect(object.toJSON(), false, 0)
        .replace('RealmObject', schema.name);
    } else {
      return schema.name;
    }
  } else {
    return 'null';
  }
};
