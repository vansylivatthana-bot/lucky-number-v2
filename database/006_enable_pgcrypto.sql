-- Lucky Number V2 — compatibility repair for existing test deployments.
-- Safe to run repeatedly. Required by the verifiable-draw SHA-256 digest() call.
create extension if not exists pgcrypto;
