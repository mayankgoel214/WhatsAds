/**
 * One-time script: create all required Supabase storage buckets as public.
 *
 * Run:
 *   cd /Users/lending/Autmn && npx tsx scripts/create-buckets.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Manual .env loader — avoids dotenv package dependency in scripts/
function loadEnv(envPath: string): void {
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf-8');
  } catch {
    console.error(`Could not read ${envPath}`);
    return;
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) process.env[key] = value;
  }
}

loadEnv(resolve('/Users/lending/Autmn/.env'));

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Matches Buckets constant in packages/storage/src/buckets.ts
const buckets = ['raw-images', 'processed-images', 'voice-notes', 'cutouts', 'videos'] as const;

async function main() {
  console.log(`Connecting to: ${supabaseUrl}\n`);

  for (const bucket of buckets) {
    const { data, error } = await supabase.storage.createBucket(bucket, {
      public: true,
    });
    if (error) {
      if (error.message.toLowerCase().includes('already exists')) {
        console.log(`${bucket}: already exists (skipped)`);
      } else {
        console.error(`${bucket}: ERROR — ${error.message}`);
      }
    } else {
      console.log(`${bucket}: created`);
    }
  }

  // Verify all buckets are present
  const { data: list, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    console.error('\nFailed to list buckets:', listError.message);
    process.exit(1);
  }
  console.log('\nAll buckets now present:');
  for (const b of list ?? []) {
    console.log(`  - ${b.name} (public: ${b.public})`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
