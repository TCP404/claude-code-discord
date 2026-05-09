/**
 * .env file loader — reads environment variables from a .env file at CWD.
 * Only sets variables that aren't already defined (real env vars take precedence).
 *
 * @module core/env-loader
 */

export async function loadEnvFile(): Promise<void> {
  try {
    const envPath = `${Deno.cwd()}/.env`;
    const stat = await Deno.stat(envPath).catch(() => null);

    if (!stat?.isFile) return;

    const content = await Deno.readTextFile(envPath);
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();

      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (!Deno.env.get(key) && key && value) {
        Deno.env.set(key, value);
      }
    }

    console.log('✓ Loaded configuration from .env file');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Note: Could not load .env file: ${message}`);
  }
}
