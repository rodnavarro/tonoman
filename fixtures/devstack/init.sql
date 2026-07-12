-- Seeded into Postgres via the bind-mounted entrypoint dir (proves the broker
-- rewrote this file's host path correctly). If you can SELECT this row, the bind
-- mount landed.
CREATE TABLE IF NOT EXISTS devstack_marker (note text);
INSERT INTO devstack_marker (note) VALUES ('bind-mount + init.sql ran via the Tonoman broker');
