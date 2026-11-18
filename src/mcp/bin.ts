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

import { createRealmMcpServer } from './server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main() {
  const server = createRealmMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Realm Studio Ultimate MCP server running on stdio (read-only)');

  // Realm's native C++ runtime can keep libuv handles alive after files are
  // closed; exit explicitly when the MCP client closes stdin to avoid zombies.
  const shutdown = () => {
    setTimeout(() => process.exit(0), 50).unref();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting Realm Studio Ultimate MCP server:', err);
  process.exit(1);
});
