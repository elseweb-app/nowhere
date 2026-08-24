// Common local endpoints this extension can auto-detect (task brief: "automatically
// detect common local endpoints when possible"). A custom endpoint is always allowed
// too — see src/providers/openai-compatible.js — this list is only a shortlist of
// likely defaults, never the only option.

export const PROVIDER_PRESETS = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434' },
  { id: 'lm-studio', label: 'LM Studio', baseUrl: 'http://localhost:1234' },
]

export const CUSTOM_PROVIDER_ID = 'custom'
