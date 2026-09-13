-- Existing duration-only records retain unknown clock times.
ALTER TABLE timesheets ADD COLUMN start_time TIME(0);
ALTER TABLE timesheets ADD COLUMN end_time TIME(0);
ALTER TABLE timesheets ADD CONSTRAINT timesheets_clock_times CHECK (
  (start_time IS NULL AND end_time IS NULL) OR
  (start_time IS NOT NULL AND end_time IS NOT NULL
   AND start_time < end_time
   AND hours = round(extract(epoch FROM (end_time - start_time)) / 3600, 2))
);
