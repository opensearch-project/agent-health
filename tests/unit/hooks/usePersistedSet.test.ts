/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, act } from '@testing-library/react';
import { usePersistedSet } from '@/hooks/usePersistedSet';

describe('usePersistedSet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('initialization', () => {
    it('returns an empty Set by default', () => {
      const { result } = renderHook(() => usePersistedSet<string>('set:empty'));
      expect(result.current[0]).toBeInstanceOf(Set);
      expect(result.current[0].size).toBe(0);
    });

    it('honors the supplied default value', () => {
      const { result } = renderHook(() => usePersistedSet<string>('set:default', ['a', 'b']));
      expect(Array.from(result.current[0]).sort()).toEqual(['a', 'b']);
    });

    it('hydrates from localStorage when a value exists', () => {
      localStorage.setItem('agent-health:set:hydrate', JSON.stringify(['x', 'y', 'z']));
      const { result } = renderHook(() => usePersistedSet<string>('set:hydrate'));
      expect(Array.from(result.current[0]).sort()).toEqual(['x', 'y', 'z']);
    });

    it('falls back to default when stored data is corrupted', () => {
      localStorage.setItem('agent-health:set:corrupt', 'not-json{{{');
      const { result } = renderHook(() => usePersistedSet<string>('set:corrupt', ['fallback']));
      expect(Array.from(result.current[0])).toEqual(['fallback']);
    });
  });

  describe('updates', () => {
    it('persists adds and deletes through the functional updater', () => {
      const { result } = renderHook(() => usePersistedSet<string>('set:fn'));

      act(() => {
        result.current[1](prev => {
          const n = new Set(prev);
          n.add('alpha');
          n.add('beta');
          return n;
        });
      });
      expect(Array.from(result.current[0]).sort()).toEqual(['alpha', 'beta']);
      expect(JSON.parse(localStorage.getItem('agent-health:set:fn')!).sort()).toEqual(['alpha', 'beta']);

      act(() => {
        result.current[1](prev => {
          const n = new Set(prev);
          n.delete('alpha');
          return n;
        });
      });
      expect(Array.from(result.current[0])).toEqual(['beta']);
      expect(JSON.parse(localStorage.getItem('agent-health:set:fn')!)).toEqual(['beta']);
    });

    it('accepts a direct Set as the new value', () => {
      const { result } = renderHook(() => usePersistedSet<string>('set:direct'));

      act(() => {
        result.current[1](new Set(['one', 'two']));
      });
      expect(Array.from(result.current[0]).sort()).toEqual(['one', 'two']);
    });

    it('clears the Set when set to an empty Set', () => {
      localStorage.setItem('agent-health:set:clear', JSON.stringify(['a', 'b']));
      const { result } = renderHook(() => usePersistedSet<string>('set:clear'));
      expect(result.current[0].size).toBe(2);

      act(() => {
        result.current[1](new Set());
      });
      expect(result.current[0].size).toBe(0);
      expect(JSON.parse(localStorage.getItem('agent-health:set:clear')!)).toEqual([]);
    });
  });

  describe('referential stability', () => {
    it('returns the same Set instance across renders if the contents have not changed', () => {
      const { result, rerender } = renderHook(() => usePersistedSet<string>('set:stability', ['x']));
      const first = result.current[0];
      rerender();
      const second = result.current[0];
      expect(second).toBe(first);
    });

    it('returns a new Set instance after a mutation', () => {
      const { result } = renderHook(() => usePersistedSet<string>('set:mutate'));
      const first = result.current[0];
      act(() => {
        result.current[1](prev => {
          const n = new Set(prev);
          n.add('new');
          return n;
        });
      });
      expect(result.current[0]).not.toBe(first);
      expect(result.current[0].has('new')).toBe(true);
    });
  });
});
