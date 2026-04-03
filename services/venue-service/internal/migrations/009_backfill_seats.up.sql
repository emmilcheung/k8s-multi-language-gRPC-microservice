-- 009_backfill_seats.up.sql
-- Backfill seat rows for any sections that were created before seat auto-generation
-- was added to the CreateSection handler.  Idempotent: skips sections that already
-- have at least one seat row.

-- Seated sections: generate rowCount × columnCount seats labelled R{r}S{c}.
INSERT INTO seats (section_id, plan_id, seat_label, row_label, column_number, attributes)
SELECT
    s.id,
    s.plan_id,
    'R' || row_num || 'S' || col_num,
    'R' || row_num,
    col_num,
    '{}'::jsonb
FROM sections s
CROSS JOIN generate_series(1, s.row_count)    AS row_num
CROSS JOIN generate_series(1, s.column_count) AS col_num
WHERE s.type = 'seated'
  AND NOT EXISTS (SELECT 1 FROM seats WHERE section_id = s.id);

-- GA sections: generate columnCount capacity-marker seats labelled GA{i}.
INSERT INTO seats (section_id, plan_id, seat_label, row_label, column_number, attributes)
SELECT
    s.id,
    s.plan_id,
    'GA' || cap_num,
    'GA',
    cap_num,
    '{}'::jsonb
FROM sections s
CROSS JOIN generate_series(1, s.column_count) AS cap_num
WHERE s.type = 'ga'
  AND NOT EXISTS (SELECT 1 FROM seats WHERE section_id = s.id);
