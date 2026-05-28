-- Add last_extracted_hash column to documents table for KG extraction dedup
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_extracted_hash text;
