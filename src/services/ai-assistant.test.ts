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

import { askAiAssistant } from './ai-assistant';
import {
  getAiApiKey,
  getLocalModelRecommendation,
  isLocalAiEndpoint,
  isOllamaModelInstalled,
  isValidOllamaModelTag,
  pullOllamaModel,
  setAiApiKey,
  validateSafeHttpUrl
} from './ai';
import {
  getDefaultAndroidPullDir,
  getTrackedAndroidRealmInfo,
  pullAndroidRealmFile
} from './android-finder';
import {
  extractCandidateSearchTokens,
  findIncomingLinksForObject,
  searchAcrossRealm
} from './realm-search';
import { DEFAULT_AI_SETTINGS, settings } from './settings';
import { isSensitivePropertyName } from '../utils/realm-serialize';

const UserSchema: Realm.ObjectSchema = {
  name: 'User',
  primaryKey: 'id',
  properties: {
    id: 'string',
    displayName: 'string',
    email: 'string?',
    password: 'string?'
  }
};

const OrderSchema: Realm.ObjectSchema = {
  name: 'Order',
  primaryKey: 'orderId',
  properties: {
    orderId: 'string',
    userId: 'string',
    customer: 'User?',
    status: 'string',
    totalAmount: 'int',
    secretNote: 'string?'
  }
};

describe('Smart AI Assistant (ID Search, General Q&A & Capability Limits)', () => {
  let tmpRoot: string;
  let originalFetch: typeof fetch;
  let origEnvKbDir: string | undefined;
  let realm: Realm;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-assistant-test-'));
    origEnvKbDir = process.env.REALM_STUDIO_AI_KB_DIR;
    process.env.REALM_STUDIO_AI_KB_DIR = path.join(tmpRoot, 'kb');
    originalFetch = globalThis.fetch;
    settings.setAiSettings({ ...DEFAULT_AI_SETTINGS });

    realm = new Realm({
      inMemory: true,
      path: path.join(tmpRoot, 'test.realm'),
      schema: [UserSchema, OrderSchema]
    });
    realm.write(() => {
      const u1 = realm.create('User', {
        id: 'usr_9981',
        displayName: 'Max Boss',
        email: 'max@example.com',
        password: 'super-secret-password-usr_9981'
      });
      realm.create('Order', {
        orderId: 'ORD-5001',
        userId: 'usr_9981',
        customer: u1,
        status: 'ACTIVE',
        totalAmount: 1200,
        secretNote: 'VIP manual approval'
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setAiApiKey('gemini', '');
    if (realm && !realm.isClosed) {
      realm.close();
    }
    if (origEnvKbDir === undefined) {
      delete process.env.REALM_STUDIO_AI_KB_DIR;
    } else {
      process.env.REALM_STUDIO_AI_KB_DIR = origEnvKbDir;
    }
    fs.removeSync(tmpRoot);
  });

  it('extracts candidate ID tokens and finds matches + incoming links across classes while masking secrets', () => {
    const tokens = extractCandidateSearchTokens('id usr_9981 อยู่ตรงไหน');
    assert(tokens.includes('usr_9981'));

    const oidTokens = extractCandidateSearchTokens(
      'หา "65f0a1b2c3d4e5f601234567" ให้หน่อย'
    );
    assert(oidTokens.includes('65f0a1b2c3d4e5f601234567'));

    const schemas = Array.from(realm.schema);
    const hits = searchAcrossRealm(realm, schemas, 'usr_9981', {
      includeSerializedRow: true
    });

    assert.strictEqual(hits.length, 2);
    // Exact primaryKey class User ranks first
    assert.strictEqual(hits[0].className, 'User');
    assert.strictEqual(hits[0].samples[0].identifier?.value, 'usr_9981');
    // Sensitive password field is not included in matchedFields or serialized secret
    assert.strictEqual(hits[0].samples[0].matchedFields.includes('password'), false);
    assert.strictEqual(hits[0].samples[0].serialized?.password, '[MASKED]');

    assert.strictEqual(hits[1].className, 'Order');
    assert(hits[1].samples[0].matchedFields.includes('userId'));

    const links = findIncomingLinksForObject(
      schemas,
      'User',
      hits[0].samples[0].object
    );
    assert.deepStrictEqual(links, [
      { fromClass: 'Order', propName: 'customer', count: 1 }
    ]);
  });

  it('answers "where is this ID?" using native Ollama tool_calls and pre-search grounding', async () => {
    let callCount = 0;
    const seenToolBodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      seenToolBodies.push(body);

      if (callCount === 1) {
        assert(Array.isArray(body.tools) && body.tools.length >= 3);
        return new Response(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  function: {
                    name: 'search_realm_everywhere',
                    arguments: { query: 'usr_9981' }
                  }
                }
              ]
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content:
              'พบ id `usr_9981` อยู่ใน Class `User` (คอลัมน์ `id` ซึ่งเป็น Primary Key) และถูกอ้างอิงอยู่ใน Class `Order` (คอลัมน์ `userId` และ `customer`) จำนวน 1 รายการ'
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await askAiAssistant({
      prompt: 'id usr_9981 อยู่ตรงไหน',
      classes: Array.from(realm.schema),
      activeClassName: 'Order',
      realm
    });

    assert.strictEqual(result.mode, 'answer');
    assert.strictEqual(result.capabilityLimited, false);
    assert(result.answer.includes('User'));
    assert(result.toolsUsed.includes('search_realm_everywhere'));
    assert(result.hits.some((h) => h.className === 'User'));
    assert(result.hits.some((h) => h.className === 'Order'));
    // Second prompt turn received tool output from local Realm execution
    const secondMessages = seenToolBodies[1].messages as Array<{
      role: string;
      content: string;
    }>;
    assert(secondMessages.some((m) => m.role === 'tool'));
  });

  it('falls back seamlessly to JSON ReAct when a smaller local model rejects native tools', async () => {
    let calls = 0;

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body || '{}')) as {
        tools?: unknown[];
        format?: string;
      };

      if (calls === 1) {
        return new Response('registry.ollama.ai/tiny:1.5b does not support tools', {
          status: 400
        });
      }
      if (calls === 2) {
        assert.strictEqual(body.tools, undefined);
        assert.strictEqual(body.format, 'json');
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                action: 'tool',
                name: 'get_schema_overview',
                args: {}
              })
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              action: 'final',
              answer: 'ใน Realm มี 2 ตารางคือ User (1 แถว) และ Order (1 แถว)'
            })
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const res = await askAiAssistant({
      prompt: 'มี class อะไรบ้างใน database นี้',
      classes: Array.from(realm.schema),
      activeClassName: 'User',
      realm
    });

    assert.strictEqual(res.capabilityLimited, false);
    assert(res.toolsUsed.includes('get_schema_overview'));
    assert(res.answer.includes('User'));
  });

  it('honestly reports local AI capability limits while still returning verified on-device ID hits', async () => {
    globalThis.fetch = (async () => {
      // Simulate local AI failing to respond cleanly
      return new Response('Ollama internal error', { status: 500 });
    }) as typeof fetch;

    const res = await askAiAssistant({
      prompt: 'ช่วยเช็คให้หน่อย id usr_9981 อยู่ตรงไหน',
      classes: Array.from(realm.schema),
      activeClassName: 'Order',
      realm
    });

    assert.strictEqual(res.capabilityLimited, true);
    assert(res.limitationReason && res.limitationReason.includes('Local AI'));
    // Pre-search grounding still rescued real hits from Realm
    assert(res.hits.length >= 2);
    assert(res.answer.includes('User'));
    assert(res.answer.includes('usr_9981'));
  });

  it('self-corrects invalid RQL via propose_table_filter and protects row fields in cloud mode', async () => {
    // 1. Test propose_table_filter self-correction
    let step = 0;
    globalThis.fetch = (async () => {
      step += 1;
      if (step === 1) {
        return new Response(
          JSON.stringify({
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'p1',
                  function: {
                    name: 'propose_table_filter',
                    arguments: {
                      className: 'Order',
                      rql: 'totalAmount ==== 1200'
                    }
                  }
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (step === 2) {
        return new Response(
          JSON.stringify({
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'p2',
                  function: {
                    name: 'propose_table_filter',
                    arguments: {
                      className: 'Order',
                      rql: 'totalAmount >= 1000',
                      explanation: 'Orders of 1000 or more'
                    }
                  }
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          message: {
            content: 'เตรียมตัวกรอง `totalAmount >= 1000` ให้แล้ว (พบ 1 รายการ)'
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const rqlAssistant = await askAiAssistant({
      prompt: 'กรอง Order ที่ยอดตั้งแต่ 1000',
      classes: Array.from(realm.schema),
      activeClassName: 'Order',
      realm
    });
    assert.strictEqual(rqlAssistant.mode, 'rql');
    assert.strictEqual(
      rqlAssistant.suggestedQuery?.rql,
      'totalAmount >= 1000'
    );
    assert.strictEqual(rqlAssistant.suggestedQuery?.validated, true);
    assert.strictEqual(rqlAssistant.suggestedQuery?.matchedCount, 1);

    // 2. Test privacy guard with Cloud provider (Gemini must NOT receive user email/secretNote values)
    settings.setAiSettings({
      provider: 'gemini',
      model: 'gemini-2.5-flash'
    });
    setAiApiKey('gemini', 'test-key');
    let sentPayloadText = '';
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentPayloadText = String(init?.body || '');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'Found usr_9981 in User and Order.' }]
              }
            }
          ]
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const cloudRes = await askAiAssistant({
      prompt: 'where is id usr_9981',
      classes: Array.from(realm.schema),
      activeClassName: 'User',
      realm
    });
    assert(cloudRes.hits.length >= 2);
    assert(!sentPayloadText.includes('max@example.com'));
    assert(!sentPayloadText.includes('VIP manual approval'));
  });

  it('enforces URL/SSRF and model tag security validation for optional local AI pulls', async () => {
    // Blocks unsafe URL schemes
    assert.throws(() => validateSafeHttpUrl('file:///etc/passwd'));
    assert.throws(() => validateSafeHttpUrl('javascript:alert(1)'));

    // Blocks SSRF remote hosts for model pulling
    await assert.rejects(() =>
      pullOllamaModel({
        ollamaUrl: 'https://evil.example.com:11434',
        model: 'qwen3.5:9b'
      })
    );

    // Blocks path traversal / URL smuggling in model tags
    assert.strictEqual(isValidOllamaModelTag('../secret'), false);
    assert.strictEqual(isValidOllamaModelTag('qwen3?redirect=evil'), false);
    assert.strictEqual(isValidOllamaModelTag('qwen3.5:9b'), true);

    assert.strictEqual(isOllamaModelInstalled(['qwen2.5:7b'], 'qwen2.5:7b'), true);
    assert.strictEqual(isOllamaModelInstalled(['qwen3:latest'], 'qwen3'), true);
    assert.strictEqual(isOllamaModelInstalled(['qwen2.5:7b'], 'qwen3.5:9b'), false);

    const rec = getLocalModelRecommendation();
    assert.ok(rec.ramGb >= 1);
    assert.ok(rec.presets.some((p) => p.tag === rec.recommendedTag));

    // Streams NDJSON progress safely on localhost pull
    const events: Array<{ status: string; percent?: number }> = [];
    globalThis.fetch = (async () => {
      const ndjson = [
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'downloading', completed: 500, total: 1000 }),
        JSON.stringify({ status: 'success', completed: 1000, total: 1000 })
      ].join('\n');
      return new Response(ndjson, { status: 200 });
    }) as typeof fetch;

    await pullOllamaModel({
      ollamaUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      onProgress: (p) => events.push({ status: p.status, percent: p.percent })
    });
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[1].percent, 50);
    assert.strictEqual(events[2].percent, 100);
  });

  it('enforces loopback local-AI checks, session-only API key fallback, sensitive field masking, and Android pull path guards', async () => {
    // 1. Loopback-only enforcement for local AI privacy classification
    assert.strictEqual(
      isLocalAiEndpoint({ ...DEFAULT_AI_SETTINGS, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' }),
      true
    );
    assert.strictEqual(
      isLocalAiEndpoint({ ...DEFAULT_AI_SETTINGS, provider: 'ollama', ollamaUrl: 'http://evil.example.com:11434' }),
      false
    );
    assert.strictEqual(
      isLocalAiEndpoint({ ...DEFAULT_AI_SETTINGS, provider: 'openai', openaiBaseUrl: 'http://localhost:1234/v1' }),
      true
    );
    assert.strictEqual(
      isLocalAiEndpoint({
        ...DEFAULT_AI_SETTINGS,
        provider: 'openai',
        openaiBaseUrl: 'https://localhost.attacker.example/v1?q=127.0.0.1'
      }),
      false
    );

    // 2. API key never falls back to plaintext localStorage when safeStorage is unavailable
    const store = new Map<string, string>();
    const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        }
      }
    });
    try {
      setAiApiKey('openai', 'sk-session-only-test-999');
      assert.strictEqual(getAiApiKey('openai'), 'sk-session-only-test-999');
      const serialized = Array.from(store.values()).join('\n');
      assert.strictEqual(serialized.includes('sk-session-only-test-999'), false);
    } finally {
      setAiApiKey('openai', '');
      if (prevDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }

    // 3. Token-aware sensitive field masking catches camelCase/snake_case secrets
    for (const sensitive of ['api_key', 'private_key', 'jwtToken', 'pinCode', 'encryptionKey', 'otp', 'userPassword']) {
      assert.strictEqual(isSensitivePropertyName(sensitive), true, `${sensitive} should be masked`);
    }
    for (const safeField of ['displayName', 'totalAmount', 'orderStatus']) {
      assert.strictEqual(isSensitivePropertyName(safeField), false, `${safeField} should not be masked`);
    }

    // 4. Untrusted .meta.json outside getDefaultAndroidPullDir() is ignored, and ADB path traversal is rejected
    const outsideRealm = path.join(tmpRoot, 'untrusted.realm');
    fs.writeFileSync(outsideRealm, 'dummy');
    fs.writeFileSync(
      `${outsideRealm}.meta.json`,
      JSON.stringify({
        serial: 'emulator-5554',
        deviceName: 'Pixel',
        pkg: 'com.example.app',
        remoteRelPath: 'files/default.realm',
        accessMode: 'run-as',
        destDir: tmpRoot,
        pulledAt: Date.now()
      })
    );
    assert.ok(path.isAbsolute(getDefaultAndroidPullDir()));
    assert.strictEqual(getTrackedAndroidRealmInfo(outsideRealm), null);

    await assert.rejects(() =>
      pullAndroidRealmFile({
        adbBin: 'adb',
        destDir: tmpRoot,
        item: {
          serial: 'emulator-5554',
          deviceName: 'Pixel',
          isEmulator: true,
          pkg: 'com.example.app',
          remoteRelPath: '../etc/passwd.realm',
          accessMode: 'run-as',
          sizeBytes: 10,
          mtimeMs: 1,
          isAppRunning: false,
          isActiveInProcess: false,
          isLatest: true
        }
      })
    );
    await assert.rejects(() =>
      pullAndroidRealmFile({
        adbBin: 'adb',
        destDir: tmpRoot,
        item: {
          serial: 'emulator;id',
          deviceName: 'Pixel',
          isEmulator: true,
          pkg: 'com.example.app',
          remoteRelPath: 'files/default.realm',
          accessMode: 'run-as',
          sizeBytes: 10,
          mtimeMs: 1,
          isAppRunning: false,
          isActiveInProcess: false,
          isLatest: true
        }
      })
    );
    await assert.rejects(() =>
      pullAndroidRealmFile({
        adbBin: 'adb',
        destDir: tmpRoot,
        item: {
          serial: 'emulator-5554',
          deviceName: 'Pixel',
          isEmulator: true,
          pkg: 'com.bad pkg',
          remoteRelPath: 'files/default.realm',
          accessMode: 'run-as',
          sizeBytes: 10,
          mtimeMs: 1,
          isAppRunning: false,
          isActiveInProcess: false,
          isLatest: true
        }
      })
    );
  });
});
