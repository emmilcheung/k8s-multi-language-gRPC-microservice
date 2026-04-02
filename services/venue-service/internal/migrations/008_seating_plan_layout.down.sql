-- 008_seating_plan_layout.down.sql
ALTER TABLE seating_plans
    DROP COLUMN IF EXISTS layout_json;
