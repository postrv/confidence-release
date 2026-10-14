-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE inbox(id TEXT PRIMARY KEY, digest TEXT NOT NULL);
CREATE TABLE events(project_key TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, object_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_key,sequence));
CREATE TABLE watermarks(project_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
CREATE INDEX events_by_object ON events(project_key,object_id,sequence);
