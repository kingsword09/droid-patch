/**
 * Custom Model Manager
 * Manages custom models in ~/.factory/settings.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { styleText } from "node:util";
import { createInterface } from "node:readline/promises";

const FACTORY_DIR = join(homedir(), ".factory");
const SETTINGS_PATH = join(FACTORY_DIR, "settings.json");

export type Provider = "anthropic" | "openai" | "generic-chat-completion-api";

export interface CustomModel {
  model: string;
  id: string;
  baseUrl: string;
  apiKey: string;
  displayName: string;
  provider: Provider;
  index: number;
  noImageSupport: boolean;
}

interface FactorySettings {
  customModels?: CustomModel[];
  sessionDefaultSettings?: {
    model?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Generate model ID from displayName and index
 * Format: custom:{DisplayName}-{index} where spaces are replaced with -
 * This matches droid's buildCustomModelId function
 */
export function generateModelId(displayName: string, index: number): string {
  const normalized = displayName.trim().replace(/\s+/g, "-");
  return `custom:${normalized}-${index}`;
}

/**
 * Load settings.json
 */
export function loadSettings(): FactorySettings {
  if (!existsSync(SETTINGS_PATH)) {
    return {};
  }
  try {
    const content = readFileSync(SETTINGS_PATH, "utf-8");
    return JSON.parse(content) as FactorySettings;
  } catch {
    return {};
  }
}

/**
 * Save settings.json
 */
export function saveSettings(settings: FactorySettings): void {
  if (!existsSync(FACTORY_DIR)) {
    mkdirSync(FACTORY_DIR, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/**
 * Rebuild all model IDs and indexes based on their array position
 * This is necessary because droid uses array index as part of the ID
 */
function rebuildModelIds(models: CustomModel[]): CustomModel[] {
  return models.map((model, index) => ({
    ...model,
    id: generateModelId(model.displayName, index),
    index,
    noImageSupport: model.noImageSupport ?? false,
  }));
}

/**
 * Update default model reference if needed
 */
function updateDefaultModelRef(
  settings: FactorySettings,
  oldId: string,
  newId: string,
): void {
  if (settings.sessionDefaultSettings?.model === oldId) {
    settings.sessionDefaultSettings.model = newId;
  }
}

/**
 * Add a custom model at specified index (or end if not specified)
 */
export function addModel(
  modelName: string,
  displayName: string,
  baseUrl: string,
  apiKey: string,
  provider: Provider,
  insertIndex?: number,
): { success: boolean; model: CustomModel; message: string } {
  const settings = loadSettings();

  if (!settings.customModels) {
    settings.customModels = [];
  }

  // Determine insert position
  const actualIndex = insertIndex ?? settings.customModels.length;
  if (actualIndex < 0 || actualIndex > settings.customModels.length) {
    return {
      success: false,
      model: {} as CustomModel,
      message: `Invalid index ${actualIndex}. Valid range: 0-${settings.customModels.length}`,
    };
  }

  const newModel: CustomModel = {
    model: modelName,
    id: "", // Will be set by rebuildModelIds
    baseUrl,
    apiKey,
    displayName,
    provider,
    index: 0, // Will be set by rebuildModelIds
    noImageSupport: false,
  };

  // Insert at specified position
  settings.customModels.splice(actualIndex, 0, newModel);

  // Rebuild all IDs
  settings.customModels = rebuildModelIds(settings.customModels);

  const insertedModel = settings.customModels[actualIndex];

  saveSettings(settings);

  return {
    success: true,
    model: insertedModel,
    message: `Added model "${displayName}" at index ${actualIndex} with ID "${insertedModel.id}"`,
  };
}

/**
 * Remove a custom model by index, ID, or displayName
 */
export function removeModel(
  identifier: string,
): { success: boolean; removed?: CustomModel; message: string; updatedModels?: { oldId: string; newId: string; displayName: string }[] } {
  const settings = loadSettings();

  if (!settings.customModels || settings.customModels.length === 0) {
    return {
      success: false,
      message: "No custom models configured",
    };
  }

  let index: number;

  // Try to parse as index number first
  const numericIndex = parseInt(identifier, 10);
  if (!isNaN(numericIndex) && numericIndex >= 0 && numericIndex < settings.customModels.length) {
    index = numericIndex;
  } else {
    // Find by ID or displayName
    index = settings.customModels.findIndex(
      (m) => m.id === identifier || m.displayName === identifier,
    );
  }

  if (index === -1) {
    return {
      success: false,
      message: `Model "${identifier}" not found. Use index (0-${settings.customModels.length - 1}), ID, or display name.`,
    };
  }

  // Store old IDs for tracking updates
  const oldIds = settings.customModels.map((m) => ({ id: m.id, displayName: m.displayName }));
  const removed = settings.customModels.splice(index, 1)[0];
  const oldDefaultId = settings.sessionDefaultSettings?.model;

  // Rebuild all IDs
  settings.customModels = rebuildModelIds(settings.customModels);

  // Track which models had their IDs updated
  const updatedModels: { oldId: string; newId: string; displayName: string }[] = [];
  for (let i = index; i < settings.customModels.length; i++) {
    const oldInfo = oldIds[i + 1]; // +1 because we removed one
    const newModel = settings.customModels[i];
    if (oldInfo && oldInfo.id !== newModel.id) {
      updatedModels.push({
        oldId: oldInfo.id,
        newId: newModel.id,
        displayName: newModel.displayName,
      });
    }
  }

  // Update default model reference if needed
  if (oldDefaultId) {
    if (oldDefaultId === removed.id) {
      // Default was the removed model, clear it
      delete settings.sessionDefaultSettings!.model;
    } else {
      // Check if default model's ID was updated
      const updatedDefault = updatedModels.find((u) => u.oldId === oldDefaultId);
      if (updatedDefault) {
        settings.sessionDefaultSettings!.model = updatedDefault.newId;
      }
    }
  }

  saveSettings(settings);

  return {
    success: true,
    removed,
    message: `Removed model "${removed.displayName}" (was at index ${index})`,
    updatedModels,
  };
}

/**
 * List all custom models
 */
export function listModels(): CustomModel[] {
  const settings = loadSettings();
  return settings.customModels || [];
}

/**
 * Get current default model
 */
export function getDefaultModel(): string | undefined {
  const settings = loadSettings();
  return settings.sessionDefaultSettings?.model;
}

/**
 * Print models list with detailed info
 */
export function printModelsList(): void {
  const models = listModels();
  const defaultModel = getDefaultModel();

  console.log(styleText("cyan", "═".repeat(60)));
  console.log(styleText(["cyan", "bold"], "  Custom Models"));
  console.log(styleText("cyan", "═".repeat(60)));
  console.log();

  if (models.length === 0) {
    console.log(styleText("gray", "  No custom models configured."));
    console.log();
    console.log(styleText("gray", "  Add one with: npx droid-patch add-model"));
  } else {
    console.log(styleText("white", `  Found ${models.length} model(s):`));
    console.log();

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const isDefault = model.id === defaultModel;
      const defaultMark = isDefault ? styleText("green", " [DEFAULT]") : "";
      const indexMark = styleText("gray", `[${i}]`);

      console.log(
        `  ${indexMark} ${styleText(["cyan", "bold"], model.displayName)}${defaultMark}`,
      );
      console.log(styleText("gray", `      ID:       ${model.id}`));
      console.log(styleText("gray", `      Model:    ${model.model}`));
      console.log(styleText("gray", `      Provider: ${model.provider}`));
      console.log(styleText("gray", `      Base URL: ${model.baseUrl}`));
      console.log(styleText("gray", `      API Key:  ${model.apiKey.substring(0, 8)}...`));
      console.log();
    }
  }

  console.log(styleText("gray", `  Settings file: ${SETTINGS_PATH}`));
  console.log();
}

/**
 * Interactive prompt helper using readline/promises
 */
async function prompt(question: string, defaultValue?: string): Promise<string> {
  const defaultHint = defaultValue ? ` (${defaultValue})` : "";
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${question}${defaultHint}: `);
    return answer.trim() || defaultValue || "";
  } finally {
    rl.close();
  }
}

/**
 * Interactive prompt for selecting from options
 */
async function promptSelect(question: string, options: string[]): Promise<string> {
  console.log(question);
  options.forEach((opt, i) => {
    console.log(styleText("cyan", `  ${i + 1}. ${opt}`));
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("Select (number): ");
    const idx = parseInt(answer.trim(), 10) - 1;
    if (idx >= 0 && idx < options.length) {
      return options[idx];
    }
    return options[0];
  } finally {
    rl.close();
  }
}

/**
 * Interactive mode for adding a model
 */
export async function addModelInteractive(insertIndex?: number): Promise<void> {
  console.log(styleText("cyan", "═".repeat(60)));
  console.log(styleText(["cyan", "bold"], "  Add Custom Model (Interactive)"));
  console.log(styleText("cyan", "═".repeat(60)));
  console.log();

  const models = listModels();
  if (models.length > 0) {
    console.log(styleText("gray", `Current models: ${models.length}`));
    models.forEach((m, i) => {
      console.log(styleText("gray", `  [${i}] ${m.displayName}`));
    });
    console.log();
  }

  const displayName = await prompt("Display name (e.g., 'Opus [proxy]')");
  if (!displayName) {
    console.log(styleText("red", "Display name is required"));
    return;
  }

  const modelName = await prompt("Model name (e.g., 'claude-sonnet-4-20250514')");
  if (!modelName) {
    console.log(styleText("red", "Model name is required"));
    return;
  }

  const baseUrl = await prompt("Base URL (e.g., 'http://127.0.0.1:20002/droid')");
  if (!baseUrl) {
    console.log(styleText("red", "Base URL is required"));
    return;
  }

  const apiKey = await prompt("API Key");
  if (!apiKey) {
    console.log(styleText("red", "API Key is required"));
    return;
  }

  const provider = (await promptSelect("Provider:", [
    "anthropic",
    "openai",
    "generic-chat-completion-api",
  ])) as Provider;

  let actualIndex = insertIndex;
  if (actualIndex === undefined && models.length > 0) {
    const indexStr = await prompt(`Insert at index (0-${models.length})`, String(models.length));
    actualIndex = parseInt(indexStr, 10);
    if (isNaN(actualIndex) || actualIndex < 0 || actualIndex > models.length) {
      actualIndex = models.length;
    }
  }

  console.log();
  const result = addModel(modelName, displayName, baseUrl, apiKey, provider, actualIndex);

  if (result.success) {
    console.log(styleText("green", `[+] ${result.message}`));
    console.log();
    console.log(styleText("white", "Model details:"));
    console.log(styleText("gray", `  ID: ${result.model.id}`));
    console.log(styleText("gray", `  Display Name: ${result.model.displayName}`));
    console.log(styleText("gray", `  Model: ${result.model.model}`));
    console.log(styleText("gray", `  Provider: ${result.model.provider}`));
    console.log(styleText("gray", `  Base URL: ${result.model.baseUrl}`));
  } else {
    console.log(styleText("red", `Error: ${result.message}`));
  }
}
