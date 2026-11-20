-- Run this once against the same PostgreSQL database used by the photo app.
-- This assumes photos.id is an INTEGER (for example, SERIAL).

CREATE TABLE IF NOT EXISTS boards (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_photos (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (board_id, photo_id)
);

CREATE INDEX IF NOT EXISTS board_photos_photo_id_idx
  ON board_photos(photo_id);

CREATE INDEX IF NOT EXISTS board_photos_board_added_idx
  ON board_photos(board_id, added_at DESC);
