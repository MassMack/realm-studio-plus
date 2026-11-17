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

import { inspectAndroidConnectionStatusAsync } from './android-finder';
import {
  ILiveRealmProcessStatus,
  inspectSimulatorAndDebugStatusAsync
} from './simulator-finder';

export type LiveConnectionSource =
  | 'ios-simulator'
  | 'android-adb'
  | 'local-debug'
  | 'none';

export interface ILiveSyncConnectionState {
  source: LiveConnectionSource;
  connected: boolean;
  isDebugging: boolean;
  isWatchingDisk: boolean;
  autoSyncSec: number;
  autoSyncStatus?: string | null;
  deviceName?: string;
  processName?: string;
  isEmulator?: boolean;
  lastSyncedAt?: number;
}

export type LiveSyncNotificationTone = 'success' | 'info' | 'warning';
export type LiveSyncNotificationAction = 'enable-android-sync' | 'reload';

export interface ILiveSyncNotification {
  id: string;
  category: 'connection' | 'synced';
  tone: LiveSyncNotificationTone;
  title: string;
  detail: string;
  timestamp: number;
  actionLabel?: string;
  actionType?: LiveSyncNotificationAction;
}

export interface ILiveSyncBadgePresentation {
  visible: boolean;
  color: LiveSyncNotificationTone | 'secondary';
  label: string;
  tooltip: string;
  spinning: boolean;
  pulse: boolean;
}

function formatSyncTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return 'now';
  }
}

/**
 * Inspects non-blockingly whether an open `.realm` file is connected to an
 * iOS Simulator, an Android ADB device/emulator, or an external local debug
 * process holding the database open.
 */
export async function probeLiveSyncState(
  realmPath: string,
  opts: {
    isWatchingDisk: boolean;
    autoSyncSec: number;
    autoSyncStatus?: string | null;
    lastSyncedAt?: number;
  }
): Promise<ILiveSyncConnectionState> {
  const [androidStatus, simAndProc] = await Promise.all([
    inspectAndroidConnectionStatusAsync(realmPath).catch(() => null),
    inspectSimulatorAndDebugStatusAsync(realmPath).catch(
      (): ILiveRealmProcessStatus => ({
        isIosSimulator: false
      })
    )
  ]);

  if (androidStatus?.isTracked) {
    return {
      source: 'android-adb',
      connected: androidStatus.isConnected,
      isDebugging: androidStatus.isAppRunning,
      isWatchingDisk: opts.isWatchingDisk,
      autoSyncSec: opts.autoSyncSec,
      autoSyncStatus: opts.autoSyncStatus,
      deviceName: androidStatus.deviceName || androidStatus.serial || 'Android',
      processName: androidStatus.pkg,
      isEmulator: androidStatus.isEmulator,
      lastSyncedAt: opts.lastSyncedAt
    };
  }

  if (simAndProc.isIosSimulator) {
    return {
      source: 'ios-simulator',
      connected: Boolean(simAndProc.isSimulatorBooted),
      isDebugging: Boolean(simAndProc.activeProcessName),
      isWatchingDisk: opts.isWatchingDisk,
      autoSyncSec: 0,
      deviceName: simAndProc.deviceName || 'iOS Simulator',
      processName: simAndProc.activeProcessName,
      isEmulator: true,
      lastSyncedAt: opts.lastSyncedAt
    };
  }

  if (simAndProc.activeProcessName) {
    return {
      source: 'local-debug',
      connected: true,
      isDebugging: true,
      isWatchingDisk: opts.isWatchingDisk,
      autoSyncSec: 0,
      processName: simAndProc.activeProcessName,
      lastSyncedAt: opts.lastSyncedAt
    };
  }

  return {
    source: 'none',
    connected: false,
    isDebugging: false,
    isWatchingDisk: opts.isWatchingDisk,
    autoSyncSec: opts.autoSyncSec,
    autoSyncStatus: opts.autoSyncStatus,
    lastSyncedAt: opts.lastSyncedAt
  };
}

export function buildLiveSyncBadge(
  state: ILiveSyncConnectionState | null
): ILiveSyncBadgePresentation {
  if (!state || state.source === 'none') {
    return {
      visible: false,
      color: 'secondary',
      label: '',
      tooltip: '',
      spinning: false,
      pulse: false
    };
  }

  const syncTimeNote = state.lastSyncedAt
    ? ` Last synced at ${formatSyncTime(state.lastSyncedAt)}.`
    : '';

  if (state.source === 'android-adb') {
    const kindLabel = state.isEmulator ? 'Android Emu' : 'Android';
    const device = state.deviceName || 'ADB';
    const busy =
      state.autoSyncStatus === 'Checking...' ||
      state.autoSyncStatus === 'Pulling update...';
    if (state.autoSyncSec > 0) {
      const debugPart = state.isDebugging ? ' · Debug' : '';
      return {
        visible: true,
        color: state.connected ? 'success' : 'warning',
        label: `${kindLabel}: ${device}${debugPart} · Sync ${state.autoSyncSec}s${state.autoSyncStatus ? ` (${state.autoSyncStatus})` : ''}`,
        tooltip: `Connected to ${kindLabel} (${device})${state.processName ? ` · App ${state.processName}` : ''}.${syncTimeNote} Click to configure ADB Auto Sync.`,
        spinning: busy,
        pulse: state.connected && !busy
      };
    }
    if (state.connected) {
      return {
        visible: true,
        color: state.isDebugging ? 'info' : 'secondary',
        label: state.isDebugging
          ? `${kindLabel}: ${device} · Debugging (Sync Off)`
          : `${kindLabel}: ${device} · Connected (Sync Off)`,
        tooltip: `${kindLabel} (${device}) is online${state.processName ? ` (${state.processName}${state.isDebugging ? ' running' : ''})` : ''}. Click to enable 5s/10s/30s ADB Auto Sync.`,
        spinning: false,
        pulse: state.isDebugging
      };
    }
    return {
      visible: true,
      color: 'warning',
      label: `${kindLabel}: ${device} · Offline`,
      tooltip: `ADB device "${device}" is currently offline. Click to manage ADB Auto Sync or pull again.`,
      spinning: false,
      pulse: false
    };
  }

  if (state.source === 'ios-simulator') {
    const dev = state.deviceName || 'iOS Simulator';
    if (state.connected && state.isDebugging) {
      return {
        visible: true,
        color: 'success',
        label: `iOS Sim: ${dev} · Debug (${state.processName || 'App'}) · Live`,
        tooltip: `Booted iOS Simulator (${dev}) with active app "${state.processName}". File watcher syncs changes automatically.${syncTimeNote} Click to reload now.`,
        spinning: false,
        pulse: true
      };
    }
    if (state.connected) {
      return {
        visible: true,
        color: 'success',
        label: `iOS Sim: ${dev} · Live Sync`,
        tooltip: `Connected to booted iOS Simulator (${dev}). Auto-reloading whenever Realm updates on disk.${syncTimeNote} Click to reload now.`,
        spinning: false,
        pulse: true
      };
    }
    return {
      visible: true,
      color: 'secondary',
      label: `iOS Sim: ${dev} · Shutdown`,
      tooltip: `iOS Simulator (${dev}) is not booted right now.${syncTimeNote} Click to re-check or reload.`,
      spinning: false,
      pulse: false
    };
  }

  // local-debug
  return {
    visible: true,
    color: 'info',
    label: `Debug Connected (${state.processName || 'Process'}) · Live Sync`,
    tooltip: `External process "${state.processName}" currently has this Realm database open. File watcher will auto-sync updates.${syncTimeNote} Click to reload now.`,
    spinning: false,
    pulse: true
  };
}

/**
 * Produces a concise toast notification when a simulator/device/debug session
 * connects, starts debugging, or disconnects. Returns null when state is
 * unchanged so polling never spams the user.
 */
export function evaluateLiveSyncTransition(
  prev: ILiveSyncConnectionState | null,
  next: ILiveSyncConnectionState,
  now = Date.now()
): ILiveSyncNotification | null {
  if (next.source === 'none') {
    if (prev && prev.connected && prev.source !== 'none') {
      const target =
        prev.deviceName || prev.processName || 'Debug session';
      return {
        id: `conn-${now}`,
        category: 'connection',
        tone: 'warning',
        title: 'Debug / Sync Session Disconnected',
        detail: `${target} closed the Realm file or went offline.`,
        timestamp: now
      };
    }
    return null;
  }

  const becameConnected = (!prev || !prev.connected || prev.source !== next.source) && next.connected;
  if (becameConnected) {
    if (next.source === 'ios-simulator') {
      return {
        id: `conn-${now}`,
        category: 'connection',
        tone: 'success',
        title: 'Syncing with iOS Simulator',
        detail: `${next.deviceName || 'iOS Simulator'} is booted${next.isDebugging && next.processName ? ` and debugging "${next.processName}"` : ''} — changes auto-sync live.`,
        timestamp: now
      };
    }
    if (next.source === 'android-adb') {
      const targetKind = next.isEmulator ? 'Android Emulator' : 'Android Device';
      const targetName = next.deviceName || 'ADB';
      if (next.autoSyncSec > 0) {
        return {
          id: `conn-${now}`,
          category: 'connection',
          tone: 'success',
          title: `Syncing with ${targetKind}`,
          detail: `${targetName}${next.isDebugging && next.processName ? ` · ${next.processName} debugging` : ''} — polling updates every ${next.autoSyncSec}s.`,
          timestamp: now
        };
      }
      return {
        id: `conn-${now}`,
        category: 'connection',
        tone: 'info',
        title: `${targetKind} Connected`,
        detail: `${targetName}${next.isDebugging && next.processName ? ` · "${next.processName}" is debugging` : ''}. Turn on Auto Sync to pull updates automatically.`,
        timestamp: now,
        actionLabel: 'Auto Sync (5s)',
        actionType: 'enable-android-sync'
      };
    }
    return {
      id: `conn-${now}`,
      category: 'connection',
      tone: 'info',
      title: 'Debug Process Connected',
      detail: `"${next.processName}" has this Realm file open — live file sync is active.`,
      timestamp: now
    };
  }

  if (prev && prev.connected && !prev.isDebugging && next.isDebugging) {
    return {
      id: `conn-${now}`,
      category: 'connection',
      tone: 'success',
      title: 'Active Debug Session Detected',
      detail: `${next.processName || 'App'} started on ${next.deviceName || 'this Realm'} — live changes will sync automatically.`,
      timestamp: now
    };
  }

  if (prev && prev.connected && !next.connected) {
    const label =
      next.source === 'android-adb'
        ? `${next.isEmulator ? 'Android Emulator' : 'Android Device'} (${next.deviceName || 'ADB'})`
        : next.deviceName || next.processName || 'Simulator';
    return {
      id: `conn-${now}`,
      category: 'connection',
      tone: 'warning',
      title: 'Simulator / Device Offline',
      detail: `${label} disconnected. Showing last synced snapshot.`,
      timestamp: now
    };
  }

  return null;
}

export function createDataSyncedNotification(
  state: ILiveSyncConnectionState | null,
  now = Date.now()
): ILiveSyncNotification | null {
  const timeStr = formatSyncTime(now);
  if (!state || state.source === 'none') {
    if (!state?.isWatchingDisk) {
      return null;
    }
    return {
      id: `sync-${now}`,
      category: 'synced',
      tone: 'success',
      title: 'Synced Live Update',
      detail: `Reloaded updated Realm data from disk at ${timeStr}.`,
      timestamp: now
    };
  }

  if (state.source === 'ios-simulator') {
    return {
      id: `sync-${now}`,
      category: 'synced',
      tone: 'success',
      title: 'Synced with iOS Simulator',
      detail: `Updated from ${state.deviceName || 'iOS Simulator'}${state.processName ? ` (${state.processName})` : ''} at ${timeStr}.`,
      timestamp: now
    };
  }

  if (state.source === 'android-adb') {
    return {
      id: `sync-${now}`,
      category: 'synced',
      tone: 'success',
      title: `Synced with ${state.isEmulator ? 'Android Emulator' : 'Android Device'}`,
      detail: `Pulled latest data from ${state.deviceName || 'ADB'} at ${timeStr}.`,
      timestamp: now
    };
  }

  return {
    id: `sync-${now}`,
    category: 'synced',
    tone: 'success',
    title: 'Synced from Debug Session',
    detail: `Reloaded changes from "${state.processName || 'external process'}" at ${timeStr}.`,
    timestamp: now
  };
}
