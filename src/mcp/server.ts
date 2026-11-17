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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { listActiveRealmsPublic } from '../services/active-realms';
import {
  findAndroidRealmFiles,
  pullMatchingAndroidRealm,
  resolveAdbBinary
} from '../services/android-finder';
import {
  countRealmObjects,
  getRealmClassSchemas,
  inspectRealmOverview,
  listRecentRealmsHeadless,
  MAX_MCP_QUERY_LIMIT,
  queryRealmObjects
} from '../services/realm-inspector';
import { findSimulatorRealmFiles } from '../services/simulator-finder';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

function okJson(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function failText(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message
      }
    ]
  };
}

function wrapReadOnly<Args>(
  fn: (args: Args) => unknown | Promise<unknown>
): (
  args: Args
) => Promise<ReturnType<typeof okJson> | ReturnType<typeof failText>> {
  return async (args: Args) => {
    try {
      return okJson(await fn(args));
    } catch (err) {
      return failText(err);
    }
  };
}

export function createRealmMcpServer(version = '20.2.0'): McpServer {
  const server = new McpServer({
    name: 'realm-studio-plus',
    version
  });

  server.registerTool(
    'list_simulator_realms',
    {
      title: 'List iOS Simulator Realms',
      description:
        'Scan macOS CoreSimulator app containers and AppGroups for .realm database files. Booted simulators and most recently modified files appear first.',
      inputSchema: {
        bootedOnly: z
          .boolean()
          .optional()
          .describe('Only return files inside currently Booted simulators.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of files to return (default 20).')
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly(({ bootedOnly, limit }) => {
      const files = findSimulatorRealmFiles(undefined, { bootedOnly });
      const capped = files.slice(0, limit ?? 20).map((f) => ({
        path: f.path,
        deviceName: f.deviceName,
        deviceUdid: f.deviceUdid,
        isBooted: f.isBooted,
        isActiveInProcess: f.isActiveInProcess,
        activeProcessName: f.activeProcessName,
        isLatest: f.isLatest,
        sizeBytes: f.size,
        modifiedAt: new Date(f.mtimeMs).toISOString()
      }));
      return {
        totalFound: files.length,
        files: capped
      };
    })
  );

  server.registerTool(
    'list_android_realms',
    {
      title: 'List Android Device & Emulator Realms',
      description:
        'Scan all connected physical Android phones and running Android Emulators via ADB for .realm files inside debuggable apps (or rooted emulators).',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of files to return (default 20).')
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly(async ({ limit }) => {
      const adbBin = resolveAdbBinary();
      if (!adbBin) {
        throw new Error('Android Platform-Tools (adb) not found.');
      }
      const { devices, files } = await findAndroidRealmFiles(adbBin);
      return {
        devices,
        totalFound: files.length,
        files: files.slice(0, limit ?? 20).map((f) => ({
          ...f,
          modifiedAt: f.mtimeMs ? new Date(f.mtimeMs).toISOString() : ''
        }))
      };
    })
  );

  server.registerTool(
    'pull_android_realm',
    {
      title: 'Pull Realm File from Android Device / Emulator',
      description:
        'Pull a .realm file from a connected Android phone or Emulator via ADB to a local temp path so inspect_realm_overview and query_realm can read it. When arguments are omitted, automatically pulls the actively debugged or latest .realm file. Reuses the local copy if remote size & mtime are unchanged unless forceRefresh is true.',
      inputSchema: {
        serial: z
          .string()
          .optional()
          .describe('Optional ADB device/emulator serial.'),
        pkg: z
          .string()
          .optional()
          .describe('Optional Android package name (e.g. com.example.app).'),
        remoteRelPath: z
          .string()
          .optional()
          .describe(
            'Optional relative path or filename inside app sandbox (e.g. files/db/realm/default.realm).'
          ),
        forceRefresh: z
          .boolean()
          .optional()
          .describe(
            'Set true to force re-pulling even if local cached size and mtime match (default false).'
          )
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly(async ({ serial, pkg, remoteRelPath, forceRefresh }) => {
      const result = await pullMatchingAndroidRealm({
        serial,
        pkg,
        remoteRelPath,
        forceRefresh
      });
      return {
        path: result.path,
        reusedCache: result.reusedCache,
        durationMs: result.durationMs,
        deviceName: result.file.deviceName,
        serial: result.file.serial,
        isEmulator: result.file.isEmulator,
        pkg: result.file.pkg,
        remoteRelPath: result.file.remoteRelPath,
        isActiveInProcess: result.file.isActiveInProcess,
        isLatest: result.file.isLatest,
        sizeBytes: result.file.sizeBytes,
        modifiedAt: result.file.mtimeMs
          ? new Date(result.file.mtimeMs).toISOString()
          : ''
      };
    })
  );

  server.registerTool(
    'get_open_realms',
    {
      title: 'Get Currently Open Realms in Realm Studio Plus',
      description:
        'Return the .realm file(s) currently open in Realm Studio Plus (most recently focused window and active class first), plus recent files as fallback.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly(() => ({
      openWindows: listActiveRealmsPublic(),
      recentFiles: listRecentRealmsHeadless()
    }))
  );

  server.registerTool(
    'list_recent_realms',
    {
      title: 'List Recently Opened Realms',
      description:
        'List .realm files recently opened in Realm Studio Plus (from local app history).',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly(() => ({
      files: listRecentRealmsHeadless()
    }))
  );

  server.registerTool(
    'inspect_realm_overview',
    {
      title: 'Inspect Realm Overview',
      description:
        'Open a .realm file in strict read-only mode and return schemaVersion, file size, classes, primary keys, and row counts. Automatically uses the currently open Realm Studio Plus window and saved Vault/session key if path/key are omitted.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Absolute or ~/ path to the .realm file. Omit to inspect the Realm currently open in Realm Studio Plus.'
          ),
        encryptionKeyHex: z
          .string()
          .optional()
          .describe(
            'Optional 128-character hex encryption key (auto-uses unlocked session/Key Vault or REALM_ENCRYPTION_KEY env if omitted).'
          )
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly(({ path, encryptionKeyHex }) =>
      inspectRealmOverview({ path, encryptionKeyHex })
    )
  );

  server.registerTool(
    'get_class_schema',
    {
      title: 'Get Realm Class Schema',
      description:
        'Return detailed property definitions (type, objectType, optional, indexed, primaryKey) for one class or all classes. Defaults to the currently open Realm in Realm Studio Plus when path is omitted.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Absolute or ~/ path to the .realm file. Omit to inspect the Realm currently open in Realm Studio Plus.'
          ),
        className: z
          .string()
          .optional()
          .describe('Specific class name to inspect. Omit to return all classes.'),
        encryptionKeyHex: z
          .string()
          .optional()
          .describe('Optional 128-character hex encryption key.')
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly(({ path, className, encryptionKeyHex }) =>
      getRealmClassSchemas({ path, className, encryptionKeyHex })
    )
  );

  server.registerTool(
    'query_realm',
    {
      title: 'Query Realm Objects (RQL)',
      description: `Execute a read-only Realm Query Language (RQL) filter against a class and return serialized JSON rows (capped at ${MAX_MCP_QUERY_LIMIT} rows per call; sensitive fields masked by default). Omit path/className to query the currently open window & table in Realm Studio Plus.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Absolute or ~/ path to the .realm file. Omit to use the currently open Realm in Realm Studio Plus.'
          ),
        className: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Realm class name to query. Omit to use the currently active table in Realm Studio Plus.'
          ),
        query: z
          .string()
          .optional()
          .describe(
            'Optional RQL filter predicate (e.g. "age > 20 AND status == \'active\'"). Omit to return all rows.'
          ),
        sortBy: z
          .string()
          .optional()
          .describe('Optional property name or dotted keypath to sort by.'),
        descending: z
          .boolean()
          .optional()
          .describe('Sort descending when sortBy is specified (default false).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_MCP_QUERY_LIMIT)
          .optional()
          .describe(`Rows to return (1-${MAX_MCP_QUERY_LIMIT}, default 20).`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Starting row offset for pagination (default 0).'),
        includeSensitiveFields: z
          .boolean()
          .optional()
          .describe(
            'Set true only if you explicitly need unmasked token/password/secret fields (default false).'
          ),
        encryptionKeyHex: z
          .string()
          .optional()
          .describe('Optional 128-character hex encryption key.')
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly((args) => queryRealmObjects(args))
  );

  server.registerTool(
    'count_realm_objects',
    {
      title: 'Count Realm Objects',
      description:
        'Count objects in a Realm class matching an optional RQL query without returning row payloads. Omit path/className to count in the currently open Realm & class.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Absolute or ~/ path to the .realm file. Omit to use the currently open Realm in Realm Studio Plus.'
          ),
        className: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Realm class name to count. Omit to use the currently active table in Realm Studio Plus.'
          ),
        query: z.string().optional().describe('Optional RQL filter predicate.'),
        encryptionKeyHex: z
          .string()
          .optional()
          .describe('Optional 128-character hex encryption key.')
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    wrapReadOnly((args) => countRealmObjects(args))
  );

  return server;
}
