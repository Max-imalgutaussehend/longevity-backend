-- Normalize existing email addresses: trim whitespace and convert to lowercase
-- Fixes Issue #87: Case-sensitive email lookup fails after mobile autocapitalization
UPDATE "users" SET "email" = lower(trim("email")) WHERE "email" != lower(trim("email"));
