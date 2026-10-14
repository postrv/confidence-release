-- SPDX-License-Identifier: Apache-2.0
-- Additional tables in a NEW OWNED probe D1 database only.
CREATE TABLE probe_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),history_enabled INTEGER NOT NULL,consumer_gate TEXT NOT NULL);
INSERT INTO probe_state VALUES(1,0,'OPEN');
CREATE TABLE probe_controls(stage TEXT PRIMARY KEY,state TEXT NOT NULL,dispatches INTEGER NOT NULL,started_at INTEGER NOT NULL,result TEXT);
CREATE TABLE probe_invocations(id TEXT PRIMARY KEY,state TEXT NOT NULL,started_at INTEGER NOT NULL);
CREATE TABLE probe_deliveries(message_id TEXT NOT NULL,attempt INTEGER NOT NULL,event_id TEXT NOT NULL,event_digest TEXT NOT NULL,queue TEXT NOT NULL,timestamp INTEGER NOT NULL,action TEXT NOT NULL,delay_seconds INTEGER,observed_at INTEGER NOT NULL,PRIMARY KEY(message_id,attempt));
