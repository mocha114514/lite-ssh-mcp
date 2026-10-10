import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LiteSshError } from '../core/errors.js';
import { EMPTY_CONFIG_TEXT, EXAMPLE_CONFIG_TEXT } from './templates.js';
import { ensurePrivateDirectory, requirePrivatePath, unlinkOwnedFile, type PrivateObjectIdentity } from '../platform/permissions.js';

export interface ConfigurationInitialization {
  configCreated: boolean;
  exampleCreated: boolean;
}

/**
 * Normal stdio startup only; constructors/help/version remain filesystem-free.
 * Existing paths are checked as metadata, never opened or parsed here. Actual
 * credentials are still read freshly by ConfigStore when a tool needs them.
 */
export async function ensureConfigurationFiles(configPath: string): Promise<ConfigurationInitialization> {
  const directory = path.dirname(configPath);
  try {
    await ensurePrivateDirectory(directory);
    const configCreated = await publishIfAbsent(configPath, EMPTY_CONFIG_TEXT);
    const exampleCreated = await publishIfAbsent(path.join(directory, 'config.example.json'), EXAMPLE_CONFIG_TEXT);
    return { configCreated, exampleCreated };
  } catch (error) {
    if (error instanceof LiteSshError && error.code === 'CONFIG_INIT_FAILED') throw error;
    // Report an actionable startup failure without exposing config contents or
    // private-key paths. Any already-created complete file remains valid.
    throw new LiteSshError('CONFIG_INIT_FAILED', 'Could not create the initial configuration files. Check the configuration directory and its permissions.');
  }
}

/**
 * Publish a fully written file with an exclusive hard-link operation. Plain wx
 * on the destination prevents overwrites but exposes an empty/partial file to
 * a concurrent startup. rename would overwrite an existing user configuration.
 * link provides both atomic visibility and create-only semantics on supported
 * filesystems; failure is reported rather than falling back to an unsafe write.
 */
async function publishIfAbsent(destination: string, content: string): Promise<boolean> {
  try {
    await fs.lstat(destination); // Metadata only: never read credentials during bootstrap.
    await requirePrivatePath(destination, 'file');
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomBytes(6).toString('hex')}.init.tmp`);
  // Only a successfully acquired wx file is ours to close/remove.
  const handle = await fs.open(temporary, 'wx', 0o600);
  let identity: PrivateObjectIdentity | undefined;
  let closed = false;
  try {
    identity = await handle.stat({ bigint: true });
    await requirePrivatePath(temporary, 'file', true, handle);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
    try {
      await fs.link(temporary, destination);
      return true;
    } catch (error) {
      // Another instance/user won the race: preserve its file verbatim.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await requirePrivatePath(destination, 'file');
        return false;
      }
      throw error;
    }
  } finally {
    try { if (!closed) await handle.close(); }
    finally {
      if (identity) await unlinkOwnedFile(temporary, identity);
      else {
        throw new LiteSshError('CONFIG_INIT_FAILED', 'Could not identify an initialization temporary. Its handle was closed; no uncertain name was deleted.', {
          cleanupComplete: false, possibleResidualPaths: [temporary]
        });
      }
    } // Never unlink a replacement name or stale-file sweep.
  }
}
