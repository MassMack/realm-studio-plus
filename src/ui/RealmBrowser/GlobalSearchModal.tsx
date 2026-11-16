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

import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader
} from 'reactstrap';
import Realm from 'realm';

import { ClassFocussedHandler } from '.';
import { extractObjectIdentifier, IObjectIdentifier } from './display';

export interface IGlobalSearchModalProps {
  classes: Realm.ObjectSchema[];
  isOpen: boolean;
  onClassFocussed: ClassFocussedHandler;
  realm?: Realm;
  toggle: () => void;
}

interface ISearchSample {
  object: Realm.Object;
  identifier: IObjectIdentifier | null;
  preview: string;
}

interface IClassSearchResult {
  className: string;
  count: number;
  samples: ISearchSample[];
}

const MAX_SAMPLES_PER_CLASS = 5;

function buildObjectPreview(
  obj: Realm.Object,
  schema: Realm.ObjectSchema,
  queryLower: string
): string {
  const record = obj as unknown as Record<string, unknown>;
  const snippets: string[] = [];
  for (const key of Object.keys(schema.properties)) {
    if (key === schema.primaryKey) {
      continue;
    }
    const val = record[key];
    if (
      val !== null &&
      val !== undefined &&
      (typeof val === 'string' ||
        typeof val === 'number' ||
        typeof val === 'boolean')
    ) {
      const str = String(val);
      if (str.toLowerCase().includes(queryLower) || snippets.length < 3) {
        snippets.push(
          `${key}: ${str.length > 40 ? `${str.slice(0, 40)}…` : str}`
        );
      }
    }
    if (snippets.length >= 4) {
      break;
    }
  }
  return snippets.join('  •  ');
}

function searchAcrossRealm(
  realm: Realm,
  classes: Realm.ObjectSchema[],
  rawQuery: string
): IClassSearchResult[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return [];
  }
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
      if (!prop || typeof prop !== 'object' || prop.type === 'list') {
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
        const sampleCount = Math.min(matched.length, MAX_SAMPLES_PER_CLASS);
        const samples: ISearchSample[] = [];
        for (let i = 0; i < sampleCount; i++) {
          const obj = matched[i];
          samples.push({
            object: obj,
            identifier: extractObjectIdentifier(obj),
            preview: buildObjectPreview(obj, schema, lower)
          });
        }
        results.push({
          className: schema.name,
          count: matched.length,
          samples
        });
      }
    } catch {
      // ignore
    }
  }

  return results;
}

export const GlobalSearchModal = ({
  classes,
  isOpen,
  onClassFocussed,
  realm,
  toggle
}: IGlobalSearchModalProps) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen]);

  if (!isOpen || !realm) {
    return null;
  }

  const searchResults = searchAcrossRealm(realm, classes, query);
  const totalMatches = searchResults.reduce((sum, r) => sum + r.count, 0);

  return (
    <Modal isOpen={isOpen} toggle={toggle} size="lg">
      <ModalHeader toggle={toggle}>
        <i className="fa fa-search" aria-hidden="true" /> Global Search Across
        All Classes
      </ModalHeader>
      <ModalBody>
        <div className="RealmBrowser__GlobalSearchInputWrap">
          <Input
            type="text"
            innerRef={(el) => {
              inputRef.current = el;
            }}
            placeholder="Type text, number, ObjectId, or UUID to search across every class..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query.trim() ? (
            <div className="RealmBrowser__GlobalSearchSummary">
              Found <strong>{totalMatches.toLocaleString()}</strong> matching
              records across <strong>{searchResults.length}</strong> classes
            </div>
          ) : null}
        </div>

        <div className="RealmBrowser__GlobalSearchResults">
          {searchResults.map((group) => (
            <div
              key={group.className}
              className="RealmBrowser__GlobalSearchGroup"
            >
              <div
                className="RealmBrowser__GlobalSearchGroupHeader"
                onClick={() => {
                  onClassFocussed(group.className);
                  toggle();
                }}
              >
                <strong>{group.className}</strong>
                <Badge color="primary">
                  {group.count.toLocaleString()} matches
                </Badge>
              </div>
              <div className="RealmBrowser__GlobalSearchGroupItems">
                {group.samples.map((sample, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="RealmBrowser__GlobalSearchItem"
                    onClick={() => {
                      onClassFocussed(group.className, sample.object);
                      toggle();
                    }}
                  >
                    {sample.identifier ? (
                      <span className="RealmBrowser__NavBar__CrumbId">
                        <span className="RealmBrowser__NavBar__CrumbIdKey">
                          {sample.identifier.key}:
                        </span>
                        <span className="RealmBrowser__NavBar__CrumbIdVal">
                          {sample.identifier.value}
                        </span>
                      </span>
                    ) : (
                      <span className="RealmBrowser__NavBar__CrumbId">
                        Match #{idx + 1}
                      </span>
                    )}
                    <span className="RealmBrowser__GlobalSearchPreview">
                      {sample.preview || 'Click to jump to record'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {query.trim() && searchResults.length === 0 ? (
            <div className="RealmBrowser__GlobalSearchEmpty">
              No records matching &#34;{query.trim()}&#34; in any class.
            </div>
          ) : null}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button color="secondary" size="sm" onClick={toggle}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
