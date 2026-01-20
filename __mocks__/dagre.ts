/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for dagre module used in tests
 * dagre is a browser-only graph layout library
 */

export const graphlib = {
  Graph: class MockGraph {
    private _nodes: Map<string, unknown> = new Map();
    private _edges: Map<string, unknown> = new Map();
    private _graphAttrs: Record<string, unknown> = {};

    setGraph(attrs: Record<string, unknown>) {
      this._graphAttrs = attrs;
    }

    setDefaultEdgeLabel(fn: () => unknown) {
      return fn;
    }

    setNode(id: string, attrs: unknown) {
      this._nodes.set(id, attrs);
    }

    setEdge(source: string, target: string, attrs?: unknown) {
      this._edges.set(`${source}-${target}`, attrs);
    }

    node(id: string) {
      return this._nodes.get(id) || { x: 0, y: 0, width: 100, height: 50 };
    }

    nodes() {
      return Array.from(this._nodes.keys());
    }

    edges() {
      return Array.from(this._edges.keys()).map((key) => {
        const [source, target] = key.split('-');
        return { v: source, w: target };
      });
    }
  },
};

export function layout(_graph: unknown) {
  // Mock layout - does nothing but allows tests to pass
}

export default {
  graphlib,
  layout,
};
