/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-storage eval matrix × CloudWatch, in the browser: the run the real CLI
 * started on a FILE-storage server reading traces from CloudWatch (an
 * unmodified AWS SDK against a local CloudWatch Logs API stub) is viewed and
 * re-run in the UI. See tests/e2e/helpers/fileStorageEvalMatrixUi.ts.
 */

import { describeFileStorageEvalMatrixUi } from './helpers/fileStorageEvalMatrixUi';

describeFileStorageEvalMatrixUi('file storage × CloudWatch: CLI run in the inspector, Traces tab, Re-run', { source: 'cloudwatch' });
