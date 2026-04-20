-- Migration: expand language default from 'hi' to 'hinglish'
-- Existing users who were set to 'hi' (the old Hinglish default) are
-- migrated to 'hinglish'. Pure Devanagari Hindi is now a distinct value.

UPDATE "users" SET "language" = 'hinglish' WHERE "language" = 'hi';

ALTER TABLE "users" ALTER COLUMN "language" SET DEFAULT 'hinglish';
