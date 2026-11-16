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

if (process.type !== 'renderer') {
  throw new Error('This is only supposed to be loaded from a renderer');
}

// Mixpanel telemetry is disabled to eliminate synchronous @electron/remote IPC,
// external network requests, global document click listeners, and the legacy
// settings.json deletion bug. A no-op shim preserves caller compatibility.
const noop = (..._args: unknown[]) => undefined;

export const mixpanel = {
  init: noop,
  disable: noop,
  register: noop,
  identify: noop,
  track: noop,
  people: {
    set: noop
  }
};
