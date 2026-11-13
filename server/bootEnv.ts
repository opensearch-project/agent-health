/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * First import of `server/index.ts`: snapshot the SHELL environment, then load
 * `<cwd>/.env` — in that order, so later per-run `.env` re-reads
 * (lib/config/envReload.ts) can tell a shell export from a `.env` value.
 *
 * Why a module and not `import 'dotenv/config'` + a call: the server is
 * bundled by esbuild with packages external, so a bare `import 'dotenv/config'`
 * stays an EXTERNAL import and is evaluated before any bundled code —
 * including a snapshot call placed "before" it in source. Bundled modules are
 * evaluated in import order, so doing both steps here, as the entry's first
 * import, is what actually guarantees snapshot-then-dotenv.
 */

import { config as loadDotenv } from 'dotenv';
import { captureShellEnvSnapshot } from '../lib/config/envReload.js';

captureShellEnvSnapshot();
loadDotenv();
