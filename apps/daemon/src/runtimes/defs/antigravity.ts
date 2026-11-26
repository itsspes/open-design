import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_MODEL_OPTION } from './shared.js';
import { agentCapabilities } from '../capabilities.js';
import { getRememberedLiveModels } from '../models.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const ANTIGRAVITY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';
const ANTIGRAVITY_MODEL_FLAG = '--model';
const ANTIGRAVITY_EFFORT_FLAG = '--effort';
const ANTIGRAVITY_DISABLE_SLASH_COMMANDS_FLAG = '--disable-slash-commands';

const ANTIGRAVITY_STREAM_JSON_ARGS = [
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
] as const;

export function encodeAntigravityStdinPrompt(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

// Durable fallback catalog for when `agy models` cannot run (signed out,
// offline, or pre-`models` builds). Transient/retiring models are left to
// live `agy models` discovery.
const ANTIGRAVITY_FALLBACK_MODELS: RuntimeModelOption[] = [
  DEFAULT_MODEL_OPTION,
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
  { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
  { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
  { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
  { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
  { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
  { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' },
  { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
];

// Display labels persisted by older OpenDesign versions mapped to their
// canonical slugs so saved user selections survive shared validation.
const ANTIGRAVITY_LEGACY_LABEL_SLUGS: Record<string, string> = {
  'Gemini 3.1 Pro (High)': 'gemini-3.1-pro-high',
  'Gemini 3.1 Pro (Low)': 'gemini-3.1-pro-low',
  'Gemini 3.5 Flash (High)': 'gemini-3.5-flash-high',
  'Gemini 3.5 Flash (Medium)': 'gemini-3.5-flash-medium',
  'Gemini 3.5 Flash (Low)': 'gemini-3.5-flash-low',
  'Claude Sonnet 4.6 (Thinking)': 'claude-sonnet-4-6',
  'Claude Opus 4.6 (Thinking)': 'claude-opus-4-6-thinking',
  'Claude Sonnet 5.5 (Thinking)': 'claude-sonnet-5-5',
  'Claude Opus 5.5 (Thinking)': 'claude-opus-5-5',
  'GPT-OSS 120B (Medium)': 'gpt-oss-120b-medium',
};

const ANTIGRAVITY_MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ANTIGRAVITY_MODEL_ROW =
  /^([a-z0-9][a-z0-9._-]*-[a-z0-9._-]*)(?:\t+|\s{2,}|\s+)(\S.*)$/;

// Parses `agy models` stdout into OpenDesign picker options (`{ id: slug, label }`).
// Strips ANSI escape sequences and spinner carriage returns (`\r⠋ Fetching...`)
// so the first row is preserved under both pipes and PTY/ConPTY environments.
export function parseAntigravityModelsOutput(
  stdout: string,
): RuntimeModelOption[] | null {
  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine
      .replace(/\r+$/, '')
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/^[\s\S]*\r/, '')
      .trim();
    if (!line || /^Fetching available models/i.test(line)) continue;
    const match = ANTIGRAVITY_MODEL_ROW.exec(line);
    if (!match) continue;
    const id = match[1];
    const label = match[2]?.trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models.length > 1 ? models : null;
}

export const parseAntigravityModels = parseAntigravityModelsOutput;

function antigravityLabelForSlug(slug: string): string | null {
  const live = getRememberedLiveModels('antigravity').find(
    (model) => model.id === slug,
  );
  if (live) return live.label;
  const fallback = ANTIGRAVITY_FALLBACK_MODELS.find(
    (model) => model.id === slug,
  );
  if (fallback) return fallback.label;
  for (const [label, legacySlug] of Object.entries(
    ANTIGRAVITY_LEGACY_LABEL_SLUGS,
  )) {
    if (legacySlug === slug) return label;
  }
  return null;
}

export function resolveAntigravityModelSlug(
  model: string | null | undefined,
): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed || trimmed === DEFAULT_MODEL_OPTION.id) return null;
  if (ANTIGRAVITY_MODEL_SLUG.test(trimmed)) return trimmed;
  const legacy = ANTIGRAVITY_LEGACY_LABEL_SLUGS[trimmed];
  if (legacy) return legacy;
  const live = getRememberedLiveModels('antigravity').find(
    (entry) => entry.label === trimmed,
  );
  if (live) return live.id;
  const fallback = ANTIGRAVITY_FALLBACK_MODELS.find(
    (entry) => entry.label === trimmed,
  );
  return fallback?.id ?? null;
}

export type AntigravityModelPlan =
  | { mode: 'default' }
  | { mode: 'argv'; slug: string }
  | { mode: 'settings'; label: string };

// Single source of truth for how a model pick is delivered to `agy`:
//   - 'default'  : leave agy's own TUI selection untouched
//   - 'argv'     : pass `--model <slug>` (no shared settings.json write or lock)
//   - 'settings' : write display label to settings.json (for pre-`--model` builds)
export function resolveAntigravityModelPlan(
  model: string | null | undefined,
  caps: Record<string, boolean> | undefined = agentCapabilities.get('antigravity'),
): AntigravityModelPlan {
  if (typeof model !== 'string') return { mode: 'default' };
  const trimmed = model.trim();
  if (!trimmed || trimmed === DEFAULT_MODEL_OPTION.id) return { mode: 'default' };
  const slug = resolveAntigravityModelSlug(trimmed);
  if (slug && caps?.modelFlag) {
    return { mode: 'argv', slug };
  }
  const label = slug ? antigravityLabelForSlug(slug) : trimmed;
  return label ? { mode: 'settings', label } : { mode: 'default' };
}

export function resolveAntigravitySettingsLabel(
  model: string | null | undefined,
): string | null {
  const plan = resolveAntigravityModelPlan(model);
  return plan.mode === 'settings' ? plan.label : null;
}

const ANTIGRAVITY_SETTINGS_PATH = join(
  homedir(),
  '.gemini',
  'antigravity-cli',
  'settings.json',
);

export function writeAntigravityModelSelection(
  label: string,
  settingsPath: string = ANTIGRAVITY_SETTINGS_PATH,
): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON — rewrite from scratch so next spawn starts cleanly.
    }
  }
  existing.model = label;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

let antigravityLockChain: Promise<void> = Promise.resolve();

export async function acquireAntigravityModelLock(): Promise<() => void> {
  const previous = antigravityLockChain;
  let release: () => void = () => {};
  antigravityLockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

export function _resetAntigravityModelLockForTests(): void {
  antigravityLockChain = Promise.resolve();
}

export interface WaitForAgyModelOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  abortSignal?: AbortSignal;
}

export async function waitForAgyToReadModel(
  logFilePath: string,
  expectedModel: string,
  options: WaitForAgyModelOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readFile =
    options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const now = options.now ?? Date.now;
  const abortSignal = options.abortSignal;
  if (abortSignal?.aborted) return false;
  const escaped = expectedModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `Propagating selected model override to backend: label="${escaped}"`,
  );
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (abortSignal?.aborted) return false;
    try {
      const content = await readFile(logFilePath);
      if (pattern.test(content)) return true;
    } catch {
      // Log file may not have appeared yet; keep polling.
    }
    if (now() >= deadline) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  return false;
}

export const antigravityAgentDef = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  capabilityFlags: {
    [ANTIGRAVITY_SKIP_PERMISSIONS_FLAG]: 'skipPermissions',
    [ANTIGRAVITY_MODEL_FLAG]: 'modelFlag',
    [ANTIGRAVITY_EFFORT_FLAG]: 'effortFlag',
    [ANTIGRAVITY_DISABLE_SLASH_COMMANDS_FLAG]: 'disableSlashCommands',
  },
  listModels: {
    args: ['models'],
    timeoutMs: 15_000,
    parse: parseAntigravityModelsOutput,
    infersAuthStatus: true,
  },
  fallbackModels: ANTIGRAVITY_FALLBACK_MODELS,
  normalizeModelId: (modelId: string) =>
    resolveAntigravityModelSlug(modelId) ?? modelId.trim(),
  buildArgs: (
    _prompt,
    _imagePaths,
    _extra = [],
    options = {},
    runtimeContext = {},
  ) => {
    const caps = agentCapabilities.get('antigravity');
    const modelPlan = resolveAntigravityModelPlan(options.model, caps);
    if (modelPlan.mode === 'settings') {
      writeAntigravityModelSelection(
        modelPlan.label,
        runtimeContext.antigravitySettingsPath,
      );
    }
    const args: string[] = [];
    if (runtimeContext.agentLogFilePath) {
      args.push('--log-file', runtimeContext.agentLogFilePath);
    }
    if (modelPlan.mode === 'argv') {
      args.push(ANTIGRAVITY_MODEL_FLAG, modelPlan.slug);
    }
    if (caps?.skipPermissions) {
      args.push(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
    }
    if (caps?.effortFlag && options.reasoning && modelPlan.mode === 'default') {
      args.push(ANTIGRAVITY_EFFORT_FLAG, options.reasoning);
    }
    if (caps?.disableSlashCommands) {
      args.push(ANTIGRAVITY_DISABLE_SLASH_COMMANDS_FLAG);
    }
    args.push(...ANTIGRAVITY_STREAM_JSON_ARGS);
    return args;
  },
  promptViaStdin: true,
  encodeStdinPrompt: encodeAntigravityStdinPrompt,
  streamFormat: 'json-event-stream',
  eventParser: 'antigravity',
  installUrl: 'https://antigravity.google/cli',
  docsUrl: 'https://antigravity.google/docs/cli-overview',
} satisfies RuntimeAgentDef;
