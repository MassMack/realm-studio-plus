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

import { getRemote } from '../utils/electron-or-remote';
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

interface IEncryptedVaultEnvelope {
  encrypted: true;
  payload: string;
}

let inMemoryVault: IEncryptionKeyStore | null = null;

function getSafeStorage(): Electron.SafeStorage | null {
  try {
    const ss = (getRemote() as unknown as { safeStorage?: Electron.SafeStorage })
      .safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function') {
      return ss;
    }
  } catch {
    // ignore outside Electron renderer
  }
  return null;
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
  inMemoryVault = data;
  const ss = getSafeStorage();
  if (!ss || !ss.isEncryptionAvailable()) {
    // Do not write cleartext encryption keys to disk when OS Keychain encryption is unavailable
    return;
  }
  try {
    const filePath = getDiskStorePath();
    fs.ensureDirSync(path.dirname(filePath));
    const envelope: IEncryptedVaultEnvelope = {
      encrypted: true,
      payload: ss.encryptString(JSON.stringify(data)).toString('base64')
    };
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), {
      mode: 0o600
    });
    if (process.platform !== 'win32') {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {
    // ignore disk sync failures
  }
}

function readDiskStore(): IEncryptionKeyStore | null {
  try {
    const filePath = getDiskStorePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readJsonSync(filePath) as
      | Partial<IEncryptionKeyStore>
      | Partial<IEncryptedVaultEnvelope>;
    if (
      raw &&
      (raw as Partial<IEncryptedVaultEnvelope>).encrypted === true &&
      typeof (raw as Partial<IEncryptedVaultEnvelope>).payload === 'string'
    ) {
      const ss = getSafeStorage();
      if (!ss || !ss.isEncryptionAvailable()) {
        return null;
      }
      const decrypted = ss.decryptString(
        Buffer.from((raw as IEncryptedVaultEnvelope).payload, 'base64')
      );
      return normalizeStore(
        JSON.parse(decrypted) as Partial<IEncryptionKeyStore>
      );
    }

    // Migrate legacy plaintext disk file into encrypted OS Keychain storage if available
    const legacy = normalizeStore(raw as Partial<IEncryptionKeyStore>);
    if (legacy.savedKeys.length > 0 && getSafeStorage()?.isEncryptionAvailable()) {
      writeDiskStore(legacy);
    }
    return legacy;
  } catch {
    return null;
  }
}

function readStore(): IEncryptionKeyStore {
  if (inMemoryVault) {
    return inMemoryVault;
  }
  const disk = readDiskStore();
  if (disk) {
    inMemoryVault = disk;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    return disk;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const normalized = normalizeStore(
          JSON.parse(raw) as Partial<IEncryptionKeyStore>
        );
        inMemoryVault = normalized;
        if (normalized.savedKeys.length > 0) {
          writeDiskStore(normalized);
        }
        // Scrub legacy plaintext key cache from browser localStorage
        localStorage.removeItem(STORAGE_KEY);
        return normalized;
      }
    } catch {
      // ignore
    }
  }

  return { byPath: {}, byFileName: {}, savedKeys: [] };
}

function writeStore(data: IEncryptionKeyStore) {
  inMemoryVault = data;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
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
