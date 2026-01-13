/**
 * Tests for Demo mode command
 */

import type { CLIConfig } from '../types.js';

describe('Demo mode command', () => {
  describe('CLIConfig for demo mode', () => {
    it('should have correct demo mode configuration structure', () => {
      const demoConfig: CLIConfig = {
        mode: 'demo',
        port: 4001,
        noBrowser: false,
        agent: {
          type: 'mock',
        },
        judge: {
          type: 'mock',
        },
      };

      expect(demoConfig.mode).toBe('demo');
      expect(demoConfig.agent.type).toBe('mock');
      expect(demoConfig.judge.type).toBe('mock');
      expect(demoConfig.storage).toBeUndefined();
    });

    it('should support optional storage configuration', () => {
      const configWithStorage: CLIConfig = {
        mode: 'demo',
        port: 4001,
        noBrowser: false,
        storage: {
          endpoint: 'http://localhost:9200',
          username: 'admin',
          password: 'password',
        },
        agent: {
          type: 'mock',
        },
        judge: {
          type: 'mock',
        },
      };

      expect(configWithStorage.storage).toBeDefined();
      expect(configWithStorage.storage?.endpoint).toBe('http://localhost:9200');
    });

    it('should support traces configuration', () => {
      const configWithTraces: CLIConfig = {
        mode: 'demo',
        port: 4001,
        noBrowser: false,
        agent: {
          type: 'mock',
        },
        judge: {
          type: 'mock',
        },
        traces: {
          endpoint: 'http://localhost:9200',
          index: 'otel-v1-apm-span-*',
        },
      };

      expect(configWithTraces.traces).toBeDefined();
      expect(configWithTraces.traces?.index).toBe('otel-v1-apm-span-*');
    });
  });

  describe('Demo options', () => {
    interface DemoOptions {
      port: number;
      noBrowser: boolean;
    }

    it('should accept port and noBrowser options', () => {
      const options: DemoOptions = {
        port: 4001,
        noBrowser: false,
      };

      expect(options.port).toBe(4001);
      expect(options.noBrowser).toBe(false);
    });

    it('should support custom port', () => {
      const options: DemoOptions = {
        port: 8080,
        noBrowser: true,
      };

      expect(options.port).toBe(8080);
      expect(options.noBrowser).toBe(true);
    });
  });
});
