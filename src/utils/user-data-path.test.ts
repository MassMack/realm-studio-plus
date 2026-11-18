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

import { getAppUserDataCandidates } from './user-data-path';

describe('user-data-path candidates', () => {
  it('prioritizes Realm Studio Ultimate paths while retaining Realm Studio Plus fallback', () => {
    const candidates = getAppUserDataCandidates();
    const basenames = candidates.map((dir) => path.basename(dir));

    assert.deepStrictEqual(basenames, [
      'Realm Studio Ultimate',
      'realm-studio-ultimate',
      'Realm Studio Plus',
      'realm-studio-plus'
    ]);
  });
});
