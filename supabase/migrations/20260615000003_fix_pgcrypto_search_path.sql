-- ============================================================
-- Fix BYOK key decryption: "function pgp_sym_decrypt(bytea, text) does not exist"
--
-- Root cause: the BYOK key functions (get_decrypted_llm_key, store_llm_key, and
-- any encrypt/decrypt helpers) run as SECURITY DEFINER with `SET search_path =
-- public`. On Supabase, the pgcrypto extension is installed in the **extensions**
-- schema, not public — so the unqualified pgp_sym_decrypt()/pgp_sym_encrypt()
-- calls cannot be resolved and the RPC throws "function ... does not exist",
-- silently degrading every org to the system LLM/embedding provider.
--
-- Fix (DB-only — the application code is correct):
--   1. Ensure pgcrypto is present in the `extensions` schema.
--   2. Add `extensions` to the search_path of every function whose body uses
--      pgp_sym_* (body-preserving ALTER — no function-definition drift). `public`
--      stays first so app tables/helpers still resolve unqualified; `extensions`
--      makes pgcrypto resolvable. Covers get_decrypted_llm_key, store_llm_key, and
--      any other pgp-using helpers regardless of name.
-- ============================================================

-- 1. Make sure pgcrypto exists in a schema we can reference. On Supabase the
--    `extensions` schema already exists; IF NOT EXISTS keeps this idempotent and
--    a no-op when pgcrypto is already installed there.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 2. Add `extensions` to the search_path of every public function that calls
--    pgp_sym_* — so the unqualified calls resolve wherever pgcrypto lives.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) ILIKE '%pgp_sym%'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions', fn.sig);
    RAISE NOTICE '[fix-pgcrypto] search_path patched on %', fn.sig;
  END LOOP;
END
$$;
