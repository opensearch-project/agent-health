/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-storage eval matrix × CloudWatch: TypeScript evals through the real
 * packaged CLI against a server on FILE storage whose traces come from the
 * CloudWatch observability backend — an unmodified `@aws-sdk/client-cloudwatch-logs`
 * signing its requests to a local CloudWatch Logs API stub that honours time
 * bounds like the service (tests/helpers/cloudWatchLogsStub.ts). The #640 route.
 * See tests/integration/cli/evalMatrix/evalMatrixSuite.ts for the matrix.
 */

import { describeEvalMatrix } from './evalMatrix/evalMatrixSuite';

describeEvalMatrix('CLI eval matrix — file storage × CloudWatch observability (.eval.ts)', { source: 'cloudwatch' });
