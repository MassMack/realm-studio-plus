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

import { app, nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

export function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.resolve(app.getAppPath(), 'resources', 'icon.png'),
    path.resolve(__dirname, '..', 'resources', 'icon.png'),
    path.resolve(process.cwd(), 'resources', 'icon.png')
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Ensures running via `electron .` / `npm start` displays the custom
 * Realm Studio Ultimate icon in the macOS Dock and About panel instead of Electron's default icon.
 */
export function applyCustomAppIcon(): string | undefined {
  const iconPath = resolveAppIconPath();
  if (!iconPath) {
    return undefined;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return undefined;
  }

  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(image);
    } catch {
      // ignore if dock API is unavailable
    }
  }

  try {
    app.setAboutPanelOptions({
      applicationName: app.name || 'Realm Studio Ultimate',
      applicationVersion: app.getVersion(),
      iconPath
    });
  } catch {
    // ignore on platforms that don't support iconPath in About panel
  }

  return iconPath;
}
