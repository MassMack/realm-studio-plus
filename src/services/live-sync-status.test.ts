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
import path from 'path';

import {
  buildLiveSyncBadge,
  createDataSyncedNotification,
  evaluateLiveSyncTransition,
  ILiveSyncConnectionState
} from './live-sync-status';
import {
  extractSimulatorDeviceUdidFromPath,
  parseLsofOpenRealmProcesses
} from './simulator-finder';

describe('Live Simulator & Debug Sync Status + Notifications', () => {
  it('extracts CoreSimulator device UDIDs strictly inside the simulator root', () => {
    const fakeRoot = '/tmp/CoreSimulator/Devices';
    const udid = 'A1B2C3D4-E5F6-4789-ABCD-0123456789EF';
    assert.strictEqual(
      extractSimulatorDeviceUdidFromPath(
        path.join(
          fakeRoot,
          udid,
          'data/Containers/Data/Application/1234/Documents/default.realm'
        ),
        fakeRoot
      ),
      udid
    );
    assert.strictEqual(
      extractSimulatorDeviceUdidFromPath(
        path.join(fakeRoot, '../outside/default.realm'),
        fakeRoot
      ),
      null
    );
    assert.strictEqual(
      extractSimulatorDeviceUdidFromPath(
        '/tmp/CoreSimulator/Devices/not-a-udid/default.realm',
        fakeRoot
      ),
      null
    );
  });

  it('parses lsof open file descriptors while ignoring Realm Studio and self PIDs', () => {
    const realmPath = '/tmp/sim/default.realm';
    const candidateMap = new Map<string, string>([
      [realmPath, realmPath],
      [`${realmPath}.lock`, realmPath]
    ]);
    const rawLsof = [
      'p999',
      'cRealm\\x20Studio\\x20Plus',
      `n${realmPath}`,
      'p1234',
      'cRunner',
      `n${realmPath}.lock`,
      'p555',
      'cMyApp',
      `n${realmPath}`
    ].join('\n');

    const active = parseLsofOpenRealmProcesses(rawLsof, candidateMap, '555');
    assert.strictEqual(active.get(realmPath), 'Runner');
  });

  it('formats live sync badges for iOS Simulator, Android Emulator, and Local Debug sessions', () => {
    const simState: ILiveSyncConnectionState = {
      source: 'ios-simulator',
      connected: true,
      isDebugging: true,
      isWatchingDisk: true,
      autoSyncSec: 0,
      deviceName: 'iPhone 16 Pro',
      processName: 'MyFlutterApp',
      lastSyncedAt: 1700000000000
    };
    const simBadge = buildLiveSyncBadge(simState);
    assert.strictEqual(simBadge.visible, true);
    assert.strictEqual(simBadge.color, 'success');
    assert.strictEqual(simBadge.pulse, true);
    assert.ok(simBadge.label.includes('iPhone 16 Pro'));
    assert.ok(simBadge.label.includes('MyFlutterApp'));

    const androidState: ILiveSyncConnectionState = {
      source: 'android-adb',
      connected: true,
      isDebugging: true,
      isWatchingDisk: true,
      autoSyncSec: 5,
      autoSyncStatus: 'Checking...',
      deviceName: 'Pixel 8',
      processName: 'com.example.app',
      isEmulator: true
    };
    const androidBadge = buildLiveSyncBadge(androidState);
    assert.strictEqual(androidBadge.visible, true);
    assert.strictEqual(androidBadge.spinning, true);
    assert.ok(androidBadge.label.includes('Android Emu: Pixel 8'));
    assert.ok(androidBadge.label.includes('Sync 5s'));

    const localDebugBadge = buildLiveSyncBadge({
      source: 'local-debug',
      connected: true,
      isDebugging: true,
      isWatchingDisk: true,
      autoSyncSec: 0,
      processName: 'node'
    });
    assert.strictEqual(localDebugBadge.visible, true);
    assert.strictEqual(localDebugBadge.color, 'info');
    assert.ok(localDebugBadge.label.includes('node'));

    assert.strictEqual(
      buildLiveSyncBadge({
        source: 'none',
        connected: false,
        isDebugging: false,
        isWatchingDisk: true,
        autoSyncSec: 0
      }).visible,
      false
    );
  });

  it('emits non-spammy notifications only on state transitions and live data syncs', () => {
    const connectedSim: ILiveSyncConnectionState = {
      source: 'ios-simulator',
      connected: true,
      isDebugging: false,
      isWatchingDisk: true,
      autoSyncSec: 0,
      deviceName: 'iPhone 16 Pro'
    };

    const onConnect = evaluateLiveSyncTransition(null, connectedSim, 1000);
    assert.ok(onConnect);
    assert.strictEqual(onConnect.tone, 'success');
    assert.ok(onConnect.title.includes('iOS Simulator'));

    // Repeating identical poll produces no duplicate notification
    assert.strictEqual(
      evaluateLiveSyncTransition(connectedSim, connectedSim, 2000),
      null
    );

    // App process attaching to the simulator DB notifies once
    const debuggingSim: ILiveSyncConnectionState = {
      ...connectedSim,
      isDebugging: true,
      processName: 'Runner'
    };
    const onDebugStart = evaluateLiveSyncTransition(
      connectedSim,
      debuggingSim,
      3000
    );
    assert.ok(onDebugStart);
    assert.ok(onDebugStart.detail.includes('Runner'));

    // Android connected with Auto Sync off suggests 1-click Auto Sync action
    const androidConnect = evaluateLiveSyncTransition(
      null,
      {
        source: 'android-adb',
        connected: true,
        isDebugging: true,
        isWatchingDisk: true,
        autoSyncSec: 0,
        deviceName: 'Pixel 8',
        processName: 'com.demo.app',
        isEmulator: true
      },
      4000
    );
    assert.ok(androidConnect);
    assert.strictEqual(androidConnect.actionType, 'enable-android-sync');

    // Disconnecting triggers warning toast
    const onDisconnect = evaluateLiveSyncTransition(
      debuggingSim,
      { ...debuggingSim, connected: false, isDebugging: false },
      5000
    );
    assert.ok(onDisconnect);
    assert.strictEqual(onDisconnect.tone, 'warning');

    // Live data sync reload notification
    const syncedToast = createDataSyncedNotification(debuggingSim, 6000);
    assert.ok(syncedToast);
    assert.strictEqual(syncedToast.category, 'synced');
    assert.ok(syncedToast.detail.includes('iPhone 16 Pro'));
  });
});
