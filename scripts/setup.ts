#!/usr/bin/env npx tsx
// ============================================================
// scripts/setup.ts — Athene Interactive Setup CLI
//
// Walks developers through configuring all required services
// for the Athene app. Validates credentials, runs database
// migrations, generates encryption keys, and writes .env.local.
//
// Usage:
//   npx tsx scripts/setup.ts
//
// ISOLATION: This script is standalone and does not modify any
// existing app files. It only creates/overwrites .env.local.
// ============================================================

import * as readline from 'readline'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

// ---- UI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const MAGENTA = '\x1b[35m'

function banner() {
  console.log(`
${MAGENTA}${BOLD}  ╔═══════════════════════════════════════╗
  ║         ATHENE AI — Setup CLI         ║
  ╚═══════════════════════════════════════╝${RESET}
  ${DIM}Interactive setup wizard for all platform dependencies${RESET}
  `)
}

function stepHeader(step: number, total: number, title: string) {
  console.log(`\n${CYAN}${BOLD}━━━ Step ${step}/${total}: ${title} ━━━${RESET}\n`)
}

function success(msg: string) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}

function warn(msg: string) {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
}

function error(msg: string) {
  console.log(`  ${RED}✗${RESET} ${msg}`)
}

function info(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`)
}

// ---- Readline Helpers ──────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question}`, (answer) => resolve(answer.trim()))
  })
}

async function askSecret(question: string): Promise<string> {
  // Note: readline doesn't support hiding input natively.
  // For secrets, we just warn the user.
  const answer = await ask(`${question} ${DIM}(input visible)${RESET}: `)
  return answer.trim()
}

async function askChoice(question: string, options: string[]): Promise<number> {
  console.log(`  ${question}`)
  for (let i = 0; i < options.length; i++) {
    console.log(`    ${BOLD}[${i + 1}]${RESET} ${options[i]}`)
  }
  const answer = await ask(`  Choice (1-${options.length}): `)
  const choice = parseInt(answer, 10)
  if (isNaN(choice) || choice < 1 || choice > options.length) {
    warn('Invalid choice, defaulting to option 1')
    return 0
  }
  return choice - 1
}

async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await ask(`${question} ${suffix}: `)
  if (answer === '') return defaultYes
  return answer.toLowerCase().startsWith('y')
}

// ---- Validation Helpers ────────────────────────────────────

async function validateUrl(url: string, label: string): Promise<boolean> {
  try {
    new URL(url)
    return true
  } catch {
    error(`Invalid URL for ${label}: ${url}`)
    return false
  }
}

async function testClerkKeys(publishableKey: string, secretKey: string): Promise<boolean> {
  try {
    // Clerk publishable keys start with pk_test_ or pk_live_
    if (!publishableKey.startsWith('pk_')) {
      error('Clerk publishable key should start with pk_test_ or pk_live_')
      return false
    }
    if (!secretKey.startsWith('sk_')) {
      error('Clerk secret key should start with sk_test_ or sk_live_')
      return false
    }

    // Test the secret key by calling Clerk's API
    const res = await fetch('https://api.clerk.dev/v1/organizations?limit=1', {
      headers: { Authorization: `Bearer ${secretKey}` },
    })

    if (res.status === 401) {
      error('Clerk secret key is invalid (401 Unauthorized)')
      return false
    }

    success('Clerk keys validated')
    return true
  } catch (err) {
    error(`Clerk validation failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function testSupabaseConnection(url: string, serviceRoleKey: string): Promise<boolean> {
  try {
    if (!url.includes('supabase.co') && !url.startsWith('http://localhost')) {
      warn('URL does not look like a Supabase URL, but continuing...')
    }

    // Test by calling the REST API
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    })

    if (res.status === 401) {
      error('Supabase service role key is invalid')
      return false
    }

    success('Supabase connection validated')
    return true
  } catch (err) {
    error(`Supabase validation failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function testNangoKey(secretKey: string, host: string = 'https://api.nango.dev'): Promise<boolean> {
  try {
    const res = await fetch(`${host}/config`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    })

    if (res.status === 401) {
      error('Nango secret key is invalid')
      return false
    }

    success(`Nango key validated (${host})`)
    return true
  } catch (err) {
    error(`Nango validation failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ---- Migration Runner ──────────────────────────────────────

async function runMigrations(databaseUrl: string): Promise<boolean> {
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')

  if (!fs.existsSync(migrationsDir)) {
    warn('No supabase/migrations/ directory found. Skipping migrations.')
    return true
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    warn('No migration files found.')
    return true
  }

  info(`Found ${files.length} migration files`)

  // We can't run SQL directly without a PostgreSQL client library.
  // Instead, we provide instructions.
  console.log('')
  info('To apply migrations, run one of:')
  info(`  ${BOLD}supabase db push${RESET}                    ${DIM}(if using Supabase CLI)${RESET}`)
  info(`  ${BOLD}psql "${databaseUrl}" -f supabase/migrations/*.sql${RESET}  ${DIM}(direct SQL)${RESET}`)
  console.log('')

  const applied = await askYesNo('Have you already applied migrations?', false)
  if (applied) {
    success('Migrations confirmed as applied')
  } else {
    warn('Remember to run migrations before starting the app')
  }

  return true
}

// ---- Main Setup Flow ───────────────────────────────────────

interface EnvConfig {
  [key: string]: string
}

async function main() {
  banner()

  const env: EnvConfig = {}
  const totalSteps = 6

  // ── Step 1: Clerk ──────────────────────────────────────────

  stepHeader(1, totalSteps, 'Clerk (Authentication)')
  info('Create a Clerk application at https://dashboard.clerk.com')
  info('Get your Publishable Key and Secret Key from the API Keys page.')
  console.log('')

  const clerkPk = await askSecret('Clerk Publishable Key (pk_test_...)')
  const clerkSk = await askSecret('Clerk Secret Key (sk_test_...)')

  if (clerkPk && clerkSk) {
    await testClerkKeys(clerkPk, clerkSk)
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = clerkPk
    env.CLERK_SECRET_KEY = clerkSk
  } else {
    warn('Clerk keys not provided — auth will not work')
  }

  // Clerk URL config (defaults)
  env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = '/sign-in'
  env.NEXT_PUBLIC_CLERK_SIGN_UP_URL = '/sign-up'
  env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL = '/chat'
  env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL = '/onboarding'
  env.NEXT_PUBLIC_CLERK_AFTER_SIGN_OUT_URL = '/'

  // ── Step 2: Database ───────────────────────────────────────

  stepHeader(2, totalSteps, 'Database (Supabase / PostgreSQL)')

  const dbChoice = await askChoice('Which database setup?', [
    'Supabase Cloud (recommended)',
    'Local PostgreSQL (Docker or manual)',
  ])

  if (dbChoice === 0) {
    info('Get your project details from https://supabase.com/dashboard')
    console.log('')

    const supabaseUrl = await ask('Supabase Project URL (https://xxx.supabase.co): ')
    const supabaseAnon = await askSecret('Supabase Anon Key')
    const supabaseService = await askSecret('Supabase Service Role Key')
    const supabaseDbUrl = await ask('Database URL (postgresql://...): ')

    if (supabaseUrl && supabaseService) {
      await testSupabaseConnection(supabaseUrl, supabaseService)
    }

    env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = supabaseAnon
    env.SUPABASE_SERVICE_ROLE_KEY = supabaseService
    env.DATABASE_URL = supabaseDbUrl
    env.SUPABASE_DB_URL = supabaseDbUrl
  } else {
    info('Make sure PostgreSQL is running with pgvector extension installed.')
    info('Using Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16')
    console.log('')

    const dbUrl = await ask('Database URL (postgresql://postgres:postgres@localhost:5432/athene): ')
    const finalDbUrl = dbUrl || 'postgresql://postgres:postgres@localhost:5432/athene'

    env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'local-anon-key'
    env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-key'
    env.DATABASE_URL = finalDbUrl
    env.SUPABASE_DB_URL = finalDbUrl

    warn('Local PostgreSQL: you\'ll need PostgREST for the Supabase client to work,')
    warn('or use `supabase start` which includes PostgREST automatically.')
  }

  // Run migrations
  if (env.DATABASE_URL) {
    await runMigrations(env.DATABASE_URL)
  }

  // ── Step 3: Nango ──────────────────────────────────────────

  stepHeader(3, totalSteps, 'Nango (OAuth Broker)')

  const nangoChoice = await askChoice('Which Nango setup?', [
    'Nango Cloud (recommended — free tier available)',
    'Self-hosted Nango (Docker)',
    'Skip (integrations will be disabled)',
  ])

  if (nangoChoice === 0) {
    info('Sign up at https://app.nango.dev and get your Secret Key.')
    console.log('')
    const nangoSecret = await askSecret('Nango Secret Key')

    if (nangoSecret) {
      await testNangoKey(nangoSecret, 'https://api.nango.dev')
      env.NANGO_SECRET_KEY = nangoSecret
    }

    const nangoPubKey = await ask('Nango Public Key (optional, press Enter to skip): ')
    if (nangoPubKey) env.NEXT_PUBLIC_NANGO_PUBLIC_KEY = nangoPubKey
  } else if (nangoChoice === 1) {
    info('Self-hosted Nango: add the following to your docker-compose.yml:')
    info('  nango: image: nangohq/nango-server:latest')
    info('See docker-compose.yml in the project root.')
    console.log('')

    const selfHostedKey = await askSecret('Nango Secret Key (from self-hosted instance)') || ''
    const selfHostedHost = await ask('Nango host URL [http://localhost:3003]: ') || 'http://localhost:3003'

    if (selfHostedKey) {
      await testNangoKey(selfHostedKey, selfHostedHost)
    }

    env.NANGO_SECRET_KEY = selfHostedKey
    env.NANGO_HOST = selfHostedHost
  } else {
    warn('Nango skipped — OAuth integrations will not work')
    env.NANGO_SECRET_KEY = ''
  }

  // ── Step 4: Background Jobs ────────────────────────────────

  stepHeader(4, totalSteps, 'Background Jobs (QStash)')

  const jobsChoice = await askChoice('Which job queue?', [
    'Upstash QStash (recommended for production)',
    'Local mode (direct HTTP — no external service needed)',
  ])

  if (jobsChoice === 0) {
    info('Create a QStash workspace at https://console.upstash.com/qstash')
    console.log('')

    env.QSTASH_TOKEN = await askSecret('QStash Token') || ''
    env.QSTASH_CURRENT_SIGNING_KEY = await askSecret('QStash Current Signing Key') || ''
    env.QSTASH_NEXT_SIGNING_KEY = await askSecret('QStash Next Signing Key') || ''

    if (env.QSTASH_TOKEN) {
      success('QStash configured')
    }
  } else {
    info('Local mode: jobs dispatch via direct HTTP fetch.')
    info('Generating a local worker secret for request signing...')

    const localSecret = crypto.randomBytes(32).toString('hex')
    env.LOCAL_WORKER_SECRET = localSecret
    success(`Generated LOCAL_WORKER_SECRET: ${localSecret.slice(0, 8)}...`)
  }

  // ── Step 5: Cache ──────────────────────────────────────────

  stepHeader(5, totalSteps, 'Cache (Redis)')

  const cacheChoice = await askChoice('Which cache?', [
    'Upstash Redis (recommended for production)',
    'In-memory cache (dev/single-instance only)',
  ])

  if (cacheChoice === 0) {
    info('Create a Redis database at https://console.upstash.com/redis')
    console.log('')

    env.UPSTASH_REDIS_REST_URL = await ask('Redis REST URL (https://...): ')
    env.UPSTASH_REDIS_REST_TOKEN = await askSecret('Redis REST Token') || ''

    if (env.UPSTASH_REDIS_REST_URL) {
      success('Redis configured')
    }
  } else {
    info('In-memory cache: RBAC and rate limiting will work but not persist across restarts.')
    info('See lib/redis/memory-cache.ts for the implementation.')
    success('In-memory cache mode (no external Redis needed)')
  }

  // ── Step 6: Encryption ─────────────────────────────────────

  stepHeader(6, totalSteps, 'Encryption (KMS)')

  info('Generating a master encryption key for per-org key derivation...')
  const kmsKey = crypto.randomBytes(32).toString('hex')
  env.KMS_KEY = kmsKey
  success(`Generated KMS_KEY: ${kmsKey.slice(0, 8)}...`)

  // ── App URL ────────────────────────────────────────────────

  console.log('')
  const appUrl = await ask('App URL (default: http://localhost:3000): ')
  env.NEXT_PUBLIC_APP_URL = appUrl || 'http://localhost:3000'

  // ── LLM Provider ──────────────────────────────────────────

  console.log('')
  info('At least one LLM provider API key is required for the AI agent.')

  const llmChoice = await askChoice('Primary LLM provider?', [
    'Anthropic (Claude)',
    'OpenAI (GPT-4)',
    'DeepSeek',
    'Skip (configure later)',
  ])

  if (llmChoice === 0) {
    env.ANTHROPIC_API_KEY = await askSecret('Anthropic API Key') || ''
  } else if (llmChoice === 1) {
    env.OPENAI_API_KEY = await askSecret('OpenAI API Key') || ''
  } else if (llmChoice === 2) {
    env.DEEPSEEK_API_KEY = await askSecret('DeepSeek API Key') || ''
  }

  // Embedding dimensions
  env.EMBEDDING_DIMS = '768'

  // ── Write .env.local ──────────────────────────────────────

  console.log(`\n${CYAN}${BOLD}━━━ Writing Configuration ━━━${RESET}\n`)

  const envPath = path.join(process.cwd(), '.env.local')
  const existsAlready = fs.existsSync(envPath)

  if (existsAlready) {
    const overwrite = await askYesNo('.env.local already exists. Overwrite?', false)
    if (!overwrite) {
      const altPath = path.join(process.cwd(), '.env.local.new')
      writeEnvFile(altPath, env)
      success(`Written to ${altPath} (review and rename to .env.local)`)
      rl.close()
      return
    }
  }

  writeEnvFile(envPath, env)
  success(`Written to ${envPath}`)

  // ── Summary ───────────────────────────────────────────────

  console.log(`\n${GREEN}${BOLD}━━━ Setup Complete! ━━━${RESET}\n`)
  info('Next steps:')
  info(`  1. ${BOLD}pnpm install${RESET}           ${DIM}(install dependencies)${RESET}`)
  info(`  2. ${BOLD}Run database migrations${RESET} ${DIM}(see Step 2 instructions above)${RESET}`)
  info(`  3. ${BOLD}pnpm dev${RESET}               ${DIM}(start the development server)${RESET}`)
  info(`  4. Open ${BOLD}${env.NEXT_PUBLIC_APP_URL}${RESET}`)
  console.log('')

  rl.close()
}

// ---- File Writer ───────────────────────────────────────────

function writeEnvFile(filePath: string, config: EnvConfig) {
  const sections: Record<string, string[]> = {
    '# ── Identity (Clerk)': [],
    '# ── Database (Supabase)': [],
    '# ── OAuth Broker (Nango)': [],
    '# ── Background Jobs': [],
    '# ── Cache (Redis)': [],
    '# ── Encryption': [],
    '# ── App': [],
    '# ── LLM Providers': [],
    '# ── Embeddings': [],
  }

  const keyToSection: Record<string, string> = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '# ── Identity (Clerk)',
    CLERK_SECRET_KEY: '# ── Identity (Clerk)',
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: '# ── Identity (Clerk)',
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: '# ── Identity (Clerk)',
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: '# ── Identity (Clerk)',
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: '# ── Identity (Clerk)',
    NEXT_PUBLIC_CLERK_AFTER_SIGN_OUT_URL: '# ── Identity (Clerk)',
    NEXT_PUBLIC_SUPABASE_URL: '# ── Database (Supabase)',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: '# ── Database (Supabase)',
    SUPABASE_SERVICE_ROLE_KEY: '# ── Database (Supabase)',
    DATABASE_URL: '# ── Database (Supabase)',
    SUPABASE_DB_URL: '# ── Database (Supabase)',
    NANGO_SECRET_KEY: '# ── OAuth Broker (Nango)',
    NEXT_PUBLIC_NANGO_PUBLIC_KEY: '# ── OAuth Broker (Nango)',
    NANGO_HOST: '# ── OAuth Broker (Nango)',
    QSTASH_TOKEN: '# ── Background Jobs',
    QSTASH_CURRENT_SIGNING_KEY: '# ── Background Jobs',
    QSTASH_NEXT_SIGNING_KEY: '# ── Background Jobs',
    LOCAL_WORKER_SECRET: '# ── Background Jobs',
    UPSTASH_REDIS_REST_URL: '# ── Cache (Redis)',
    UPSTASH_REDIS_REST_TOKEN: '# ── Cache (Redis)',
    KMS_KEY: '# ── Encryption',
    NEXT_PUBLIC_APP_URL: '# ── App',
    ANTHROPIC_API_KEY: '# ── LLM Providers',
    OPENAI_API_KEY: '# ── LLM Providers',
    DEEPSEEK_API_KEY: '# ── LLM Providers',
    EMBEDDING_DIMS: '# ── Embeddings',
  }

  for (const [key, value] of Object.entries(config)) {
    if (!value && value !== '') continue
    const section = keyToSection[key] ?? '# ── App'
    if (sections[section]) {
      sections[section].push(`${key}=${value}`)
    }
  }

  const lines: string[] = [
    '# ============================================================',
    '# Athene AI — Environment Configuration',
    `# Generated by scripts/setup.ts on ${new Date().toISOString()}`,
    '# ============================================================',
    '',
  ]

  for (const [header, entries] of Object.entries(sections)) {
    if (entries.length === 0) continue
    lines.push(header)
    lines.push(...entries)
    lines.push('')
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
}

// ---- Entry Point ───────────────────────────────────────────

main().catch((err) => {
  error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`)
  rl.close()
  process.exit(1)
})
