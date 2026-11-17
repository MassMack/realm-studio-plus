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
import os from 'os';
import path from 'path';

export function getAppUserDataCandidates(): string[] {
  const home = os.homedir();
  const names = ['Realm Studio Plus', 'realm-studio-plus'];
  if (process.platform === 'darwin') {
    return names.map((n) =>
      path.join(home, 'Library/Application Support', n)
    );
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
    return names.map((n) => path.join(appData, n));
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return names.map((n) => path.join(configHome, n));
}

export function resolveSharedUserDataDir(): string {
  try {
    if (process.versions?.electron) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electronOrRemote = require('./electron-or-remote') as {
        getElectronOrRemote: () => { app?: { getPath?: (name: string) => string } };
      };
      const electronApp = electronOrRemote.getElectronOrRemote().app;
      if (electronApp && typeof electronApp.getPath === 'function') {
        return electronApp.getPath('userData');
      }
    }
  } catch {
    // Running headless in standalone Node (e.g. MCP server)
  }

  const candidates = getAppUserDataCandidates();
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return candidates[0];
}
