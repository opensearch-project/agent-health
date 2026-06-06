// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Minimal local type stubs for the optional `@earendil-works/pi-coding-agent`
 * SDK used by the `agent` (trace) judge.
 *
 * pi is an **optionalDependency** — it ships native install scripts (koffi FFI,
 * photon-node wasm) that can fail to build on some platforms, so npm is allowed
 * to skip it without breaking `npm install @opensearch-project/agent-health`.
 * Because it can legitimately be absent, the code must NOT type-import it at
 * compile time (a statically-resolved `import type … from '@earendil-works/…'`
 * makes tsc require the package — breaking the build wherever the optional tree
 * didn't install, e.g. CI).
 *
 * These interfaces describe only the small surface the trace judge consumes;
 * the real module is loaded at runtime via a dynamic `import()` (see
 * `loadPiSdk`) and cast to {@link PiSdk}. Keep this in sync with the upstream
 * SDK if the consumed surface changes.
 */

/** A model entry from the pi model registry (provider + id is all we use). */
export interface PiModel {
  provider: string;
  id: string;
}

/** Result returned by a registered pi tool's `execute`. */
export interface PiToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
}

/** The subset of pi's ExtensionAPI used to register the run-scoped trace tools. */
export interface PiExtensionAPI {
  registerTool(def: {
    name: string;
    description: string;
    /** typebox TSchema — opaque here to avoid coupling the type. */
    parameters: unknown;
    execute: (toolCallId: string, args: any) => PiToolResult | Promise<PiToolResult>;
    /** Other pi tool-definition fields (label, promptSnippet, promptGuidelines, …). */
    [key: string]: unknown;
  }): void;
}

/** Factory pi calls with the ExtensionAPI to register tools. */
export type PiExtensionFactory = (pi: PiExtensionAPI) => void;

/** The subset of a pi agent session the judge drives. */
export interface PiSession {
  prompt(text: string): Promise<unknown>;
  messages: any[];
}

/** The subset of the pi SDK module the trace judge loads at runtime. */
export interface PiSdk {
  createAgentSession(opts: any): Promise<{ session: PiSession }>;
  SessionManager: { inMemory(): unknown };
  AuthStorage: { create(): unknown };
  ModelRegistry: { create(authStorage: unknown): { getAvailable(): Promise<PiModel[]> } };
  DefaultResourceLoader: new (opts: any) => { reload(): Promise<void> };
  getAgentDir(): string;
}
