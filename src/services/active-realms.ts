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

const ACTIVE_REALMS_FILE = 'active-realms.json';

export interface IActiveRealmSession {
  id: string;
  pid: number;
  path: string;
  activeClassName?: string;
  schemaVersion?: number;
  openedAt: number;
  focusedAt: number;
  encryptionKeyHex?: string;
}

export interface IActiveRealmPublicInfo {
  id: string;
  path: string;
  activeClassName: string | null;
  schemaVersion: number | null;
  openedAt: string;
  focusedAt: string;
  hasSessionKey: boolean;
  exists: boolean;
}

function getActiveRealmsFilePath(): string {
  return path.join(resolveSharedUserDataDir(), ACTIVE_REALMS_FILE);
}

function isProcessAlive(pid: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means process exists under another user context; ESRCH means dead
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readRawSessions(): IActiveRealmSession[] {
  try {
    const filePath = getActiveRealmsFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const parsed = fs.readJsonSync(filePath) as {
      sessions?: IActiveRealmSession[];
    };
    if (!parsed || !Array.isArray(parsed.sessions)) {
      return [];
    }
    return parsed.sessions.filter(
      (s) =>
        !!s &&
        typeof s.id === 'string' &&
        typeof s.path === 'string' &&
        isProcessAlive(s.pid)
    );
  } catch {
    return [];
  }
}

function writeRawSessions(sessions: IActiveRealmSession[]) {
  try {
    const filePath = getActiveRealmsFilePath();
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(
      filePath,
      JSON.stringify({ sessions }, null, 2),
      { mode: 0o600 }
    );
  } catch {
    // ignore
  }
}

export function registerOpenRealmSession(params: {
  id: string;
  path: string;
  activeClassName?: string;
  schemaVersion?: number;
  encryptionKeyHex?: string;
}) {
  const now = Date.now();
  const existing = readRawSessions().filter((s) => s.id !== params.id);
  const next: IActiveRealmSession = {
    id: params.id,
    pid: process.pid,
    path: params.path,
    activeClassName: params.activeClassName,
    schemaVersion: params.schemaVersion,
    openedAt: now,
    focusedAt: now,
    encryptionKeyHex: params.encryptionKeyHex
  };
  writeRawSessions([next, ...existing]);
}

export function updateOpenRealmSession(
  id: string,
  patch: Partial<
    Pick<
      IActiveRealmSession,
      'activeClassName' | 'focusedAt' | 'schemaVersion' | 'encryptionKeyHex'
    >
  >
) {
  const sessions = readRawSessions();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0) {
    return;
  }
  sessions[idx] = {
    ...sessions[idx],
    ...patch
  };
  writeRawSessions(sessions);
}

export function unregisterOpenRealmSession(id: string) {
  const sessions = readRawSessions().filter((s) => s.id !== id);
  writeRawSessions(sessions);
}

export function listActiveRealmSessions(): IActiveRealmSession[] {
  return readRawSessions().sort((a, b) => b.focusedAt - a.focusedAt);
}

export function listActiveRealmsPublic(): IActiveRealmPublicInfo[] {
  return listActiveRealmSessions().map((s) => ({
    id: s.id,
    path: s.path,
    activeClassName: s.activeClassName || null,
    schemaVersion:
      typeof s.schemaVersion === 'number' ? s.schemaVersion : null,
    openedAt: new Date(s.openedAt).toISOString(),
    focusedAt: new Date(s.focusedAt).toISOString(),
    hasSessionKey: !!s.encryptionKeyHex,
    exists: fs.existsSync(s.path)
  }));
}
