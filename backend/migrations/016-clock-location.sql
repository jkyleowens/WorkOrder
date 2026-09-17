-- Where a clock event happened, so billed hours carry a jobsite location.
--
-- Nullable on purpose, and deliberately not enforced: location can be refused,
-- unavailable indoors, or simply absent on an entry typed in later from the
-- office. Recording hours must never depend on it.
ALTER TABLE timesheets ADD COLUMN clock_latitude NUMERIC(9,6);
ALTER TABLE timesheets ADD COLUMN clock_longitude NUMERIC(9,6);
-- Metres. A fix with a 2 km radius is not evidence of anything, so the reader
-- needs to see how precise the device claimed to be.
ALTER TABLE timesheets ADD COLUMN clock_accuracy_m NUMERIC(8,1);
ALTER TABLE timesheets ADD CONSTRAINT timesheets_clock_location CHECK (
  (clock_latitude IS NULL) = (clock_longitude IS NULL)
  AND (clock_latitude IS NULL OR clock_latitude BETWEEN -90 AND 90)
  AND (clock_longitude IS NULL OR clock_longitude BETWEEN -180 AND 180)
  AND (clock_accuracy_m IS NULL OR clock_accuracy_m >= 0)
);
