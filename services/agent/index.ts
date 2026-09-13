/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** @deprecated AG-UI protocol helpers now live with `connectors/agui`. */
export { AGUIToTrajectoryConverter, computeTrajectoryFromRawEvents } from '../../connectors/agui/aguiConverter';
export { SSEClient, consumeSSEStream } from '../../connectors/agui/sseStream';
export { buildAgentPayload, buildMultiTurnPayload } from '../../connectors/agui/payloadBuilder';
