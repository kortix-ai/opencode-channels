export type CommandType = 'reset' | 'set_model' | 'set_model_fuzzy' | 'set_agent' | 'none';

export interface ParsedCommand {
  type: CommandType;
  remainingText: string;
  model?: { providerID: string; modelID: string };
  agentName?: string;
  modelQuery?: string;
}

const MODEL_TIERS: Record<string, { providerID: string; modelID: string }> = {
  power: { providerID: 'kortix', modelID: 'kortix/power' },
  basic: { providerID: 'kortix', modelID: 'kortix/basic' },
};

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'new session' || lower === 'reset') {
    return { type: 'reset', remainingText: '' };
  }

  const modelMatch = lower.match(/^use\s+(power|basic)\s*$/);
  if (modelMatch) {
    const tier = modelMatch[1] as keyof typeof MODEL_TIERS;
    return {
      type: 'set_model',
      remainingText: '',
      model: MODEL_TIERS[tier],
    };
  }

  const agentMatch = trimmed.match(/^use\s+agent\s+(\S+)\s*$/i);
  if (agentMatch) {
    return {
      type: 'set_agent',
      remainingText: '',
      agentName: agentMatch[1],
    };
  }

  const fuzzyMatch = trimmed.match(/^use\s+(.+)\s*$/i);
  if (fuzzyMatch) {
    const query = fuzzyMatch[1].trim();
    return {
      type: 'set_model_fuzzy',
      remainingText: '',
      modelQuery: query,
    };
  }

  return { type: 'none', remainingText: trimmed };
}

export interface ProviderWithModels {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

export function fuzzyMatchModel(
  query: string,
  providers: ProviderWithModels[],
): { providerID: string; modelID: string } | null {
  const q = query.toLowerCase();

  // Exact match
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.id.toLowerCase() === q || model.name.toLowerCase() === q) {
        return { providerID: provider.id, modelID: model.id };
      }
    }
  }

  // Prefix match
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.id.toLowerCase().startsWith(q) || model.name.toLowerCase().startsWith(q)) {
        return { providerID: provider.id, modelID: model.id };
      }
    }
  }

  // Substring match
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q)) {
        return { providerID: provider.id, modelID: model.id };
      }
    }
  }

  return null;
}
