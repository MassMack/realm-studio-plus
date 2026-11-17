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
import path from 'path';

import { resolveSharedUserDataDir } from '../utils/user-data-path';

const STORAGE_KEY = 'realm-studio-encryption-keys-v1';
const KEYS_FILE_NAME = 'encryption-keys.json';
const MAX_SAVED_KEYS = 25;
const HEX_128_REGEX = /^[a-fA-F0-9]{128}$/;

export interface ISavedEncryptionKey {
  key: string;
  label: string;
  updatedAt: number;
}

interface IEncryptionKeyStore {
  byPath: Record<string, string>;
  byFileName: Record<string, string>;
  savedKeys: ISavedEncryptionKey[];
}

function getDiskStorePath(): string {
  return path.join(resolveSharedUserDataDir(), KEYS_FILE_NAME);
}

function normalizeStore(parsed: Partial<IEncryptionKeyStore>): IEncryptionKeyStore {
  return {
    byPath:
      parsed.byPath && typeof parsed.byPath === 'object' ? parsed.byPath : {},
    byFileName:
      parsed.byFileName && typeof parsed.byFileName === 'object'
        ? parsed.byFileName
        : {},
    savedKeys: Array.isArray(parsed.savedKeys) ? parsed.savedKeys : []
  };
}

function writeDiskStore(data: IEncryptionKeyStore) {
  try {
    const filePath = getDiskStorePath();
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // ignore disk sync failures
  }
}

function readDiskStore(): IEncryptionKeyStore | null {
  try {
    const filePath = getDiskStorePath();
    if (fs.existsSync(filePath)) {
      const parsed = fs.readJsonSync(filePath) as Partial<IEncryptionKeyStore>;
      return normalizeStore(parsed);
    }
  } catch {
    // ignore
  }
  return null;
}

function readStore(): IEncryptionKeyStore {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const normalized = normalizeStore(
          JSON.parse(raw) as Partial<IEncryptionKeyStore>
        );
        // Backfill shared disk vault if missing so headless MCP can unlock files
        const diskPath = getDiskStorePath();
        if (!fs.existsSync(diskPath) && normalized.savedKeys.length > 0) {
          writeDiskStore(normalized);
        }
        return normalized;
      }
    } catch {
      // ignore
    }
  }

  return readDiskStore() ?? { byPath: {}, byFileName: {}, savedKeys: [] };
}

function writeStore(data: IEncryptionKeyStore) {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }
  writeDiskStore(data);
}

export function isValidHexEncryptionKey(key: string): boolean {
  return HEX_128_REGEX.test(key.trim());
}

export function getSavedEncryptionKeys(): ISavedEncryptionKey[] {
  return readStore().savedKeys;
}

export function getCandidateKeysForPath(filePath: string): string[] {
  const store = readStore();
  const candidates: string[] = [];
  const addCandidate = (k?: string) => {
    if (k && isValidHexEncryptionKey(k) && !candidates.includes(k)) {
      candidates.push(k);
    }
  };

  addCandidate(store.byPath[filePath]);
  addCandidate(store.byFileName[path.basename(filePath)]);
  for (const item of store.savedKeys) {
    addCandidate(item.key);
  }
  return candidates;
}

export function saveEncryptionKeyForPath(
  filePath: string,
  rawKey: string,
  customLabel?: string
) {
  const cleanKey = rawKey.trim();
  if (!isValidHexEncryptionKey(cleanKey)) {
    return;
  }
  const store = readStore();
  const fileName = path.basename(filePath);
  store.byPath[filePath] = cleanKey;
  store.byFileName[fileName] = cleanKey;

  const existing = store.savedKeys.find(
    (k) => k.key.toLowerCase() === cleanKey.toLowerCase()
  );
  const label = customLabel?.trim() || existing?.label || fileName;
  const filtered = store.savedKeys.filter(
    (k) => k.key.toLowerCase() !== cleanKey.toLowerCase()
  );
  store.savedKeys = [
    { key: cleanKey, label, updatedAt: Date.now() },
    ...filtered
  ].slice(0, MAX_SAVED_KEYS);

  writeStore(store);
}

export function removeSavedEncryptionKey(keyToRemove: string) {
  const store = readStore();
  const lower = keyToRemove.trim().toLowerCase();
  store.savedKeys = store.savedKeys.filter(
    (k) => k.key.toLowerCase() !== lower
  );
  for (const [p, k] of Object.entries(store.byPath)) {
    if (k.toLowerCase() === lower) {
      delete store.byPath[p];
    }
  }
  for (const [fn, k] of Object.entries(store.byFileName)) {
    if (k.toLowerCase() === lower) {
      delete store.byFileName[fn];
    }
  }
  writeStore(store);
}
