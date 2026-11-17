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

import assert from 'assert';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import Realm from 'realm';

import {
  generateRealmQuery,
  parseGeneratedQueryResponse,
  serializeSchemaForAi
} from './ai';
import {
  computeSchemaFingerprint,
  indexProjectSourceDir,
  loadKnowledgeBaseForRealm,
  retrieveRelevantKbContext,
  sampleSafePropertyHints,
  saveKnowledgeBase
} from './ai-knowledge-base';
import { getRealmClassSchemas, inspectRealmOverview } from './realm-inspector';
import {
  formatRqlDateLiteral,
  getCurrentRqlTimestampHint,
  validateRqlAgainstRealm
} from './rql-reference';
import { DEFAULT_AI_SETTINGS, settings } from './settings';

const OrderItemSchema: Realm.ObjectSchema = {
  name: 'OrderItem',
  properties: {
    sku: 'string',
    qty: 'int'
  }
};

const CustomerOrderSchema: Realm.ObjectSchema = {
  name: 'CustomerOrder',
  primaryKey: 'orderId',
  properties: {
    orderId: 'string',
    status: 'string',
    email: 'string?',
    accessToken: 'string?',
    password: 'string?',
    freeNote: 'string?',
    amount: 'int',
    createdAt: 'date',
    tags: 'string[]',
    items: 'OrderItem[]'
  }
};

describe('Local AI Upgrade (RQL Reference, Domain KB & Self-Correction)', () => {
  let tmpRoot: string;
  let originalFetch: typeof fetch;
  let origEnvKbDir: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-studio-ai-test-'));
    origEnvKbDir = process.env.REALM_STUDIO_AI_KB_DIR;
    process.env.REALM_STUDIO_AI_KB_DIR = path.join(tmpRoot, 'kb');
    originalFetch = globalThis.fetch;
    settings.setAiSettings({ ...DEFAULT_AI_SETTINGS });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (origEnvKbDir === undefined) {
      delete process.env.REALM_STUDIO_AI_KB_DIR;
    } else {
      process.env.REALM_STUDIO_AI_KB_DIR = origEnvKbDir;
    }
    fs.removeSync(tmpRoot);
  });

  it('validates real Realm v20 RQL queries and diagnoses common syntax errors', () => {
    const realm = new Realm({
      inMemory: true,
      path: path.join(tmpRoot, 'validate.realm'),
      schema: [CustomerOrderSchema, OrderItemSchema]
    });
    try {
      realm.write(() => {
        realm.create('CustomerOrder', {
          orderId: 'ord-1',
          status: 'ACTIVE',
          amount: 500,
          createdAt: new Date('2026-06-15T10:00:00Z'),
          tags: ['vip'],
          items: [{ sku: 'SKU-1', qty: 3 }]
        });
      });

      const bareDate = validateRqlAgainstRealm(
        realm,
        'CustomerOrder',
        'createdAt >= 2026-01-01'
      );
      assert.strictEqual(bareDate.valid, false);
      assert(bareDate.correctionHint?.includes('YYYY-MM-DD@HH:MM:SS'));

      const utcDate = validateRqlAgainstRealm(
        realm,
        'CustomerOrder',
        'createdAt >= 2026-01-01@00:00:00'
      );
      assert.strictEqual(utcDate.valid, true);
      assert.strictEqual(utcDate.matchedCount, 1);

      const bareSort = validateRqlAgainstRealm(
        realm,
        'CustomerOrder',
        'SORT(amount DESC)'
      );
      assert.strictEqual(bareSort.valid, false);
      assert(bareSort.correctionHint?.includes('TRUEPREDICATE'));

      const validSort = validateRqlAgainstRealm(
        realm,
        'CustomerOrder',
        'TRUEPREDICATE SORT(amount DESC) LIMIT(5)'
      );
      assert.strictEqual(validSort.valid, true);

      const badPrimitiveSubquery = validateRqlAgainstRealm(
        realm,
        'CustomerOrder',
        'SUBQUERY(tags, $t, $t == "vip").@count > 0'
      );
      assert.strictEqual(badPrimitiveSubquery.valid, false);
      assert(badPrimitiveSubquery.correctionHint?.includes('ANY'));

      const validObjectSubquery = validateRqlAgainstRealm(
        realm,
        'CustomerOrder',
        'SUBQUERY(items, $x, $x.qty > 2).@count > 0'
      );
      assert.strictEqual(validObjectSubquery.valid, true);
      assert.strictEqual(validObjectSubquery.matchedCount, 1);
    } finally {
      realm.close();
    }
  });

  it('formats RQL date literals in UTC cleanly', () => {
    const d = new Date('2026-11-17T06:05:04Z');
    assert.strictEqual(formatRqlDateLiteral(d), '2026-11-17@06:05:04');
    const hint = getCurrentRqlTimestampHint(d);
    assert(hint.includes('2026-11-17@06:05:04'));
  });

  it('samples only non-PII low-cardinality enum values on-device', () => {
    const realm = new Realm({
      inMemory: true,
      path: path.join(tmpRoot, 'pii.realm'),
      schema: [CustomerOrderSchema, OrderItemSchema]
    });
    try {
      realm.write(() => {
        for (let i = 0; i < 15; i++) {
          realm.create('CustomerOrder', {
            orderId: `ord-${i}`,
            status: i % 2 === 0 ? 'ACTIVE' : 'SUSPENDED',
            email: `user${i}@example.com`,
            accessToken: `tok-${i}`,
            password: `pw-${i}`,
            freeNote: `unique customer note number ${i}`,
            amount: (i % 3) + 1,
            createdAt: new Date(),
            tags: [],
            items: []
          });
        }
      });

      const hints = sampleSafePropertyHints(realm, 'CustomerOrder');
      const hintNames = hints.map((h) => h.propertyName);

      assert(hintNames.includes('status'));
      assert(hintNames.includes('amount'));
      assert(!hintNames.includes('orderId')); // primaryKey excluded
      assert(!hintNames.includes('email')); // PII field excluded
      assert(!hintNames.includes('accessToken')); // sensitive field excluded
      assert(!hintNames.includes('password')); // sensitive field excluded
      assert(!hintNames.includes('freeNote')); // high cardinality (>10 distinct) excluded

      const statusHint = hints.find((h) => h.propertyName === 'status')!;
      assert.deepStrictEqual(
        statusHint.values.slice().sort(),
        ['ACTIVE', 'SUSPENDED']
      );
    } finally {
      realm.close();
    }
  });

  it('persists KB by schema fingerprint across dynamic paths and indexes source models', () => {
    const srcDir = path.join(tmpRoot, 'mobile-src');
    fs.ensureDirSync(path.join(srcDir, 'models'));
    fs.ensureDirSync(path.join(srcDir, 'node_modules', 'ignored'));

    fs.writeFileSync(
      path.join(srcDir, 'models', 'CustomerOrder.swift'),
      [
        '/// Represents status codes stored in Realm',
        'enum OrderStatus: String {',
        '  case active = "ACTIVE"',
        '  case suspended = "SUSPENDED"',
        '}',
        'class CustomerOrder: Object {',
        '  @Persisted var status: String = ""',
        '}'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(srcDir, 'node_modules', 'ignored', 'Noise.swift'),
      'class CustomerOrder {}'
    );

    const classes = [CustomerOrderSchema, OrderItemSchema];
    const hash = computeSchemaFingerprint(classes);
    assert.strictEqual(hash.length, 12);

    const { symbols } = indexProjectSourceDir(srcDir, classes);
    assert(symbols.some((s) => s.name === 'OrderStatus'));
    assert(symbols.some((s) => s.name === 'CustomerOrder'));
    assert(!symbols.some((s) => s.filePath.includes('node_modules')));

    const saved = saveKnowledgeBase({
      ...loadKnowledgeBaseForRealm('/tmp/sim-uuid-1/default.realm', classes),
      projectNotes: 'ACTIVE status means billable customer',
      sourceDir: srcDir,
      indexedSymbols: symbols,
      classes: {
        CustomerOrder: {
          description: 'Customer billing orders',
          properties: { status: 'Billing state: ACTIVE | SUSPENDED' }
        }
      }
    });
    assert(saved.id.includes(hash));

    // Load from a completely different container UUID path with same schema
    const reloaded = loadKnowledgeBaseForRealm(
      '/tmp/sim-uuid-99/default.realm',
      classes
    );
    assert.strictEqual(
      reloaded.projectNotes,
      'ACTIVE status means billable customer'
    );
    assert.strictEqual(
      reloaded.classes.CustomerOrder.properties?.status,
      'Billing state: ACTIVE | SUSPENDED'
    );

    const retrieved = retrieveRelevantKbContext({
      kb: reloaded,
      prompt: 'หาลูกค้าที่ status active',
      activeClassName: 'CustomerOrder',
      classes
    });
    assert(retrieved.codeSnippets.some((s) => s.name === 'OrderStatus'));
  });

  it('runs self-healing RQL retry loop with Ollama format=json & num_ctx', async () => {
    const realm = new Realm({
      inMemory: true,
      path: path.join(tmpRoot, 'selfheal.realm'),
      schema: [CustomerOrderSchema, OrderItemSchema]
    });

    const recordedBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      recordedBodies.push(body);

      const content =
        callCount === 1
          ? '<think>thinking...</think>{"query":"createdAt >= 2026-01-01","explanation":"Orders in 2026"}'
          : JSON.stringify({
              query: 'createdAt >= 2026-01-01@00:00:00 AND status ==[c] "ACTIVE"',
              explanation: 'Orders from 2026 with active status'
            });

      return new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as typeof fetch;

    try {
      realm.write(() => {
        realm.create('CustomerOrder', {
          orderId: 'o1',
          status: 'ACTIVE',
          amount: 100,
          createdAt: new Date('2026-05-01T00:00:00Z'),
          tags: [],
          items: []
        });
      });

      const res = await generateRealmQuery({
        prompt: 'หาออเดอร์ active ตั้งแต่ต้นปี 2026',
        classes: [CustomerOrderSchema, OrderItemSchema],
        activeClassName: 'CustomerOrder',
        realm
      });

      assert.strictEqual(callCount, 2);
      assert.strictEqual(res.validated, true);
      assert.strictEqual(res.attempts, 2);
      assert.strictEqual(res.matchedCount, 1);
      assert.strictEqual(
        res.query,
        'createdAt >= 2026-01-01@00:00:00 AND status ==[c] "ACTIVE"'
      );

      // Verify Ollama structured output + num_ctx + retry feedback prompt
      assert.strictEqual(recordedBodies[0].format, 'json');
      assert.strictEqual(
        (recordedBodies[0].options as { num_ctx?: number }).num_ctx,
        8192
      );
      const retryMessages = recordedBodies[1].messages as Array<{
        role: string;
        content: string;
      }>;
      const lastMsg = retryMessages[retryMessages.length - 1];
      assert.strictEqual(lastMsg.role, 'user');
      assert(lastMsg.content.includes('YYYY-MM-DD@HH:MM:SS'));
    } finally {
      realm.close();
    }
  });

  it('strips think tags cleanly in parseGeneratedQueryResponse', () => {
    const parsed = parseGeneratedQueryResponse(
      '<think>let me think</think>\n```json\n{"query":"status == \\"OK\\"","explanation":"ok"}\n```'
    );
    assert.strictEqual(parsed.query, 'status == "OK"');
    assert.strictEqual(parsed.explanation, 'ok');
  });

  it('serializes schema with related classes, backlinks, and KB notes', () => {
    const kb = saveKnowledgeBase({
      ...loadKnowledgeBaseForRealm('/tmp/demo.realm', [
        CustomerOrderSchema,
        OrderItemSchema
      ]),
      classes: {
        OrderItem: {
          properties: { sku: 'Product SKU code' }
        }
      }
    });
    const text = serializeSchemaForAi(
      [CustomerOrderSchema, OrderItemSchema],
      'OrderItem',
      { knowledgeBase: kb, objectCounts: { OrderItem: 12, CustomerOrder: 4 } }
    );
    assert(text.includes('Class OrderItem [ACTIVE CLASS]'));
    assert(text.includes('@links.CustomerOrder.items'));
    assert(text.includes('Product SKU code'));
    assert(text.includes('Class CustomerOrder'));
  });

  it('enriches MCP overview and get_class_schema with Domain KB descriptions', () => {
    const realmFile = path.join(tmpRoot, 'mcp-kb.realm');
    const r = new Realm({
      path: realmFile,
      schema: [CustomerOrderSchema, OrderItemSchema]
    });
    const schemas = Array.from(r.schema);
    r.close();

    saveKnowledgeBase({
      ...loadKnowledgeBaseForRealm(realmFile, schemas),
      projectNotes: 'Enterprise order database',
      classes: {
        CustomerOrder: {
          description: 'Primary order entity',
          properties: {
            status: 'Order lifecycle state (ACTIVE/SUSPENDED)'
          }
        }
      }
    });

    const overview = inspectRealmOverview({ path: realmFile });
    assert.strictEqual(overview.knowledgeBaseNotes, 'Enterprise order database');
    const orderOverview = overview.classes.find((c) => c.name === 'CustomerOrder');
    assert.strictEqual(orderOverview?.description, 'Primary order entity');

    const detail = getRealmClassSchemas({
      path: realmFile,
      className: 'CustomerOrder'
    });
    assert.strictEqual(detail.classes[0].description, 'Primary order entity');
    const statusProp = detail.classes[0].properties.find((p) => p.name === 'status');
    assert.strictEqual(
      statusProp?.description,
      'Order lifecycle state (ACTIVE/SUSPENDED)'
    );
  });
});
