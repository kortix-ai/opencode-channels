import { describe, it, expect } from 'vitest';
import { parseCommand, fuzzyMatchModel, type ProviderWithModels } from '../src/command-parser.js';

// ─── parseCommand ───────────────────────────────────────────────────────────

describe('parseCommand', () => {
  // ── Reset commands ──────────────────────────────────────────────────────

  describe('reset commands', () => {
    it('parses "new session" as reset', () => {
      const result = parseCommand('new session');
      expect(result.type).toBe('reset');
      expect(result.remainingText).toBe('');
    });

    it('parses "reset" as reset', () => {
      const result = parseCommand('reset');
      expect(result.type).toBe('reset');
      expect(result.remainingText).toBe('');
    });

    it('is case insensitive for "New Session"', () => {
      const result = parseCommand('New Session');
      expect(result.type).toBe('reset');
    });

    it('is case insensitive for "RESET"', () => {
      const result = parseCommand('RESET');
      expect(result.type).toBe('reset');
    });

    it('handles leading/trailing whitespace', () => {
      const result = parseCommand('  reset  ');
      expect(result.type).toBe('reset');
    });
  });

  // ── Set model (tier) ───────────────────────────────────────────────────

  describe('set_model tier commands', () => {
    it('parses "use power" as set_model with power tier', () => {
      const result = parseCommand('use power');
      expect(result.type).toBe('set_model');
      expect(result.model).toEqual({ providerID: 'kortix', modelID: 'kortix/power' });
      expect(result.remainingText).toBe('');
    });

    it('parses "use basic" as set_model with basic tier', () => {
      const result = parseCommand('use basic');
      expect(result.type).toBe('set_model');
      expect(result.model).toEqual({ providerID: 'kortix', modelID: 'kortix/basic' });
    });

    it('is case insensitive for "Use Power"', () => {
      const result = parseCommand('Use Power');
      expect(result.type).toBe('set_model');
      expect(result.model).toEqual({ providerID: 'kortix', modelID: 'kortix/power' });
    });

    it('handles trailing whitespace for "use basic  "', () => {
      const result = parseCommand('use basic  ');
      expect(result.type).toBe('set_model');
      expect(result.model).toEqual({ providerID: 'kortix', modelID: 'kortix/basic' });
    });
  });

  // ── Set agent ─────────────────────────────────────────────────────────

  describe('set_agent commands', () => {
    it('parses "use agent myagent" as set_agent', () => {
      const result = parseCommand('use agent myagent');
      expect(result.type).toBe('set_agent');
      expect(result.agentName).toBe('myagent');
      expect(result.remainingText).toBe('');
    });

    it('is case insensitive for "Use Agent"', () => {
      const result = parseCommand('Use Agent coder');
      expect(result.type).toBe('set_agent');
      expect(result.agentName).toBe('coder');
    });

    it('preserves original casing of agent name', () => {
      const result = parseCommand('use agent MySpecialAgent');
      expect(result.type).toBe('set_agent');
      expect(result.agentName).toBe('MySpecialAgent');
    });

    it('handles trailing whitespace for "use agent foo  "', () => {
      const result = parseCommand('use agent foo  ');
      expect(result.type).toBe('set_agent');
      expect(result.agentName).toBe('foo');
    });
  });

  // ── Set model fuzzy ───────────────────────────────────────────────────

  describe('set_model_fuzzy commands', () => {
    it('parses "use claude-3" as set_model_fuzzy', () => {
      const result = parseCommand('use claude-3');
      expect(result.type).toBe('set_model_fuzzy');
      expect(result.modelQuery).toBe('claude-3');
      expect(result.remainingText).toBe('');
    });

    it('parses "use gpt-4o" as set_model_fuzzy', () => {
      const result = parseCommand('use gpt-4o');
      expect(result.type).toBe('set_model_fuzzy');
      expect(result.modelQuery).toBe('gpt-4o');
    });

    it('preserves casing in model query', () => {
      const result = parseCommand('use Claude-Sonnet');
      expect(result.type).toBe('set_model_fuzzy');
      expect(result.modelQuery).toBe('Claude-Sonnet');
    });

    it('trims whitespace from query', () => {
      const result = parseCommand('use  some-model  ');
      expect(result.type).toBe('set_model_fuzzy');
      expect(result.modelQuery).toBe('some-model');
    });
  });

  // ── None (no command matched) ─────────────────────────────────────────

  describe('none commands', () => {
    it('parses "hello world" as none', () => {
      const result = parseCommand('hello world');
      expect(result.type).toBe('none');
      expect(result.remainingText).toBe('hello world');
    });

    it('parses empty string as none', () => {
      const result = parseCommand('');
      expect(result.type).toBe('none');
      expect(result.remainingText).toBe('');
    });

    it('parses whitespace-only string as none', () => {
      const result = parseCommand('   ');
      expect(result.type).toBe('none');
      expect(result.remainingText).toBe('');
    });

    it('returns full text as remainingText for non-command input', () => {
      const result = parseCommand('what is the weather today?');
      expect(result.type).toBe('none');
      expect(result.remainingText).toBe('what is the weather today?');
    });
  });

  // ── Priority order ────────────────────────────────────────────────────

  describe('priority order', () => {
    it('reset takes priority over use: "reset" is not treated as fuzzy model', () => {
      const result = parseCommand('reset');
      expect(result.type).toBe('reset');
    });

    it('"use power" matches set_model before set_model_fuzzy', () => {
      const result = parseCommand('use power');
      expect(result.type).toBe('set_model');
    });

    it('"use agent x" matches set_agent before set_model_fuzzy', () => {
      const result = parseCommand('use agent x');
      expect(result.type).toBe('set_agent');
    });

    it('"use unknown-model" falls through to set_model_fuzzy', () => {
      const result = parseCommand('use unknown-model');
      expect(result.type).toBe('set_model_fuzzy');
    });
  });
});

// ─── fuzzyMatchModel ────────────────────────────────────────────────────────

describe('fuzzyMatchModel', () => {
  const providers: ProviderWithModels[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-haiku', name: 'Claude 3 Haiku' },
      ],
    },
  ];

  // ── Exact match ─────────────────────────────────────────────────────────

  describe('exact match', () => {
    it('matches exact model id', () => {
      const result = fuzzyMatchModel('gpt-4o', providers);
      expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    });

    it('matches exact model name (case insensitive)', () => {
      const result = fuzzyMatchModel('GPT-4o', providers);
      expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    });

    it('matches exact model name by display name', () => {
      const result = fuzzyMatchModel('Claude 3.5 Sonnet', providers);
      expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-3-5-sonnet' });
    });

    it('exact match takes priority over prefix match', () => {
      // "gpt-4o" exactly matches first, not "gpt-4o-mini"
      const result = fuzzyMatchModel('gpt-4o', providers);
      expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    });
  });

  // ── Prefix match ────────────────────────────────────────────────────────

  describe('prefix match', () => {
    it('matches model id by prefix', () => {
      const result = fuzzyMatchModel('gpt-4o-m', providers);
      expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o-mini' });
    });

    it('matches model name by prefix', () => {
      const result = fuzzyMatchModel('Claude 3 H', providers);
      expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-3-haiku' });
    });

    it('is case insensitive for prefix', () => {
      const result = fuzzyMatchModel('CLAUDE-3-H', providers);
      expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-3-haiku' });
    });
  });

  // ── Substring match ─────────────────────────────────────────────────────

  describe('substring match', () => {
    it('matches model id by substring', () => {
      const result = fuzzyMatchModel('sonnet', providers);
      expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-3-5-sonnet' });
    });

    it('matches model name by substring', () => {
      const result = fuzzyMatchModel('Mini', providers);
      expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o-mini' });
    });

    it('matches substring case insensitively', () => {
      const result = fuzzyMatchModel('HAIKU', providers);
      expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-3-haiku' });
    });
  });

  // ── No match ────────────────────────────────────────────────────────────

  describe('no match', () => {
    it('returns null when no model matches', () => {
      const result = fuzzyMatchModel('nonexistent-model', providers);
      expect(result).toBeNull();
    });

    it('returns null for empty providers array', () => {
      const result = fuzzyMatchModel('gpt-4o', []);
      expect(result).toBeNull();
    });

    it('returns null for empty query with no matching model', () => {
      // Empty string is a prefix/substring of everything, so it would match
      // the first model. Let's test with something truly non-matching:
      const result = fuzzyMatchModel('zzz-no-match', providers);
      expect(result).toBeNull();
    });

    it('returns null when providers have no models', () => {
      const emptyProviders: ProviderWithModels[] = [
        { id: 'empty', name: 'Empty Provider', models: [] },
      ];
      const result = fuzzyMatchModel('anything', emptyProviders);
      expect(result).toBeNull();
    });
  });

  // ── Match order ─────────────────────────────────────────────────────────

  describe('match order (exact > prefix > substring)', () => {
    it('prefers exact match over prefix match', () => {
      const customProviders: ProviderWithModels[] = [
        {
          id: 'p1',
          name: 'P1',
          models: [
            { id: 'gpt-4o-extended', name: 'GPT-4o Extended' },
            { id: 'gpt-4o', name: 'GPT-4o' },
          ],
        },
      ];
      // "gpt-4o" is an exact match on the second model, not just a prefix of the first
      const result = fuzzyMatchModel('gpt-4o', customProviders);
      expect(result).toEqual({ providerID: 'p1', modelID: 'gpt-4o' });
    });

    it('prefers prefix match over substring match', () => {
      const customProviders: ProviderWithModels[] = [
        {
          id: 'p1',
          name: 'P1',
          models: [
            { id: 'x-sonnet-extra', name: 'X Sonnet Extra' }, // substring match for "sonnet"
            { id: 'sonnet-fast', name: 'Sonnet Fast' },       // prefix match for "sonnet"
          ],
        },
      ];
      const result = fuzzyMatchModel('sonnet', customProviders);
      // Prefix match on "sonnet-fast" should win over substring match on "x-sonnet-extra"
      expect(result).toEqual({ providerID: 'p1', modelID: 'sonnet-fast' });
    });
  });
});
