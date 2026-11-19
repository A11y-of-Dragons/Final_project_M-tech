
BEGIN;

CREATE TABLE IF NOT EXISTS boards (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
        CHECK (char_length(name) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS photo_boards (
    photo_id BIGINT NOT NULL
        REFERENCES photos(id) ON DELETE CASCADE,
    board_id BIGINT NOT NULL
        REFERENCES boards(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (photo_id, board_id)
);

CREATE INDEX IF NOT EXISTS photo_boards_board_id_idx
    ON photo_boards(board_id);

CREATE INDEX IF NOT EXISTS photo_boards_photo_id_idx
    ON photo_boards(photo_id);

COMMIT;
