-- Migration: 002_add_roles
-- Adds a roles column to the users table for role-based access control.
-- Stored as a JSON array with a safe default of empty array (no roles).
-- Backward-compatible: existing users will have roles = '[]'.

ALTER TABLE users
ADD COLUMN roles JSON NOT NULL DEFAULT '[]';


