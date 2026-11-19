
const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");

const extensionsByMimeType = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDir),
  filename: (_req, file, callback) => {
    callback(null, `${randomUUID()}${extensionsByMimeType[file.mimetype]}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!extensionsByMimeType[file.mimetype]) {
      return callback(Object.assign(
        new Error("Only JPEG, PNG, and WebP images are supported."),
        { status: 400 }
      ));
    }
    callback(null, true);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir));

function parseTags(value) {
  if (value === undefined || value === "") return [];

  if (typeof value !== "string") {
    throw Object.assign(
      new Error("tags must be a comma-separated string."),
      { status: 400 }
    );
  }

  const tags = [
    ...new Set(
      value.split(",")
        .map(tag => tag.trim().toLowerCase())
        .filter(Boolean)
    )
  ];

  if (tags.length > 20 || tags.some(tag => tag.length > 40)) {
    throw Object.assign(
      new Error("Provide up to 20 tags, each no longer than 40 characters."),
      { status: 400 }
    );
  }

  return tags;
}

function parseBoardIds(value) {
  if (value === undefined || value === null || value === "") return [];

  let values = value;

  if (typeof value === "string") {
    try {
      values = JSON.parse(value);
    } catch {
      throw Object.assign(
        new Error("boardIds must be a JSON array of board IDs."),
        { status: 400 }
      );
    }
  }

  if (!Array.isArray(values)) {
    throw Object.assign(
      new Error("boardIds must be an array."),
      { status: 400 }
    );
  }

  const ids = [...new Set(values.map(Number))];

  if (ids.length > 50 || ids.some(
    id => !Number.isSafeInteger(id) || id < 1
  )) {
    throw Object.assign(
      new Error("Provide up to 50 valid positive board IDs."),
      { status: 400 }
    );
  }

  return ids;
}

function paginationValue(value, fallback, maximum) {
  if (value === undefined) return fallback;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw Object.assign(
      new Error(`Value must be an integer from 1 to ${maximum}.`),
      { status: 400 }
    );
  }

  return parsed;
}

function positiveId(value, name = "ID") {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id < 1) {
    throw Object.assign(
      new Error(`${name} must be a positive integer.`),
      { status: 400 }
    );
  }

  return id;
}

async function assertBoardsExist(client, boardIds) {
  if (boardIds.length === 0) return;

  const result = await client.query(
    "SELECT id FROM boards WHERE id = ANY($1::bigint[])",
    [boardIds]
  );

  if (result.rowCount !== boardIds.length) {
    throw Object.assign(
      new Error("One or more selected boards do not exist."),
      { status: 400 }
    );
  }
}

async function removeUpload(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// CREATE BOARD
app.post("/api/boards", async (req, res, next) => {
  try {
    const name = typeof req.body.name === "string"
      ? req.body.name.trim()
      : "";

    const description = typeof req.body.description === "string"
      ? req.body.description.trim()
      : "";

    if (!name || name.length > 80) {
      return res.status(400).json({
        error: "Board name must contain between 1 and 80 characters."
      });
    }

    if (description.length > 500) {
      return res.status(400).json({
        error: "Board description must be 500 characters or fewer."
      });
    }

    const result = await pool.query(
      `INSERT INTO boards (name, description)
       VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, description, created_at`,
      [name, description]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        error: "A board with this name already exists."
      });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

// GET ALL BOARDS
app.get("/api/boards", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         b.id,
         b.name,
         b.description,
         b.created_at,
         COUNT(pb.photo_id)::integer AS photo_count
       FROM boards b
       LEFT JOIN photo_boards pb ON pb.board_id = b.id
       GROUP BY b.id
       ORDER BY b.name ASC`
    );

    res.json({ boards: result.rows });
  } catch (error) {
    next(error);
  }
});

// UPLOAD PHOTO WITH OPTIONAL BOARDS AND TAGS
app.post("/api/photos", upload.single("image"), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      error: "An image file is required in the 'image' field."
    });
  }

  let client;

  try {
    const tags = parseTags(req.body.tags);
    const boardIds = parseBoardIds(req.body.boardIds);

    const caption = typeof req.body.caption === "string"
      ? req.body.caption.trim()
      : "";

    if (caption.length > 500) {
      throw Object.assign(
        new Error("Caption must be 500 characters or fewer."),
        { status: 400 }
      );
    }

    client = await pool.connect();
    await client.query("BEGIN");

    await assertBoardsExist(client, boardIds);

    const photoResult = await client.query(
      `INSERT INTO photos (filename, caption)
       VALUES ($1, $2)
       RETURNING id, filename, caption, created_at`,
      [req.file.filename, caption]
    );

    const photo = photoResult.rows[0];

    for (const name of tags) {
      const tagResult = await client.query(
        `INSERT INTO tags (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name]
      );

      await client.query(
        `INSERT INTO photo_tags (photo_id, tag_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [photo.id, tagResult.rows[0].id]
      );
    }

    for (const boardId of boardIds) {
      await client.query(
        `INSERT INTO photo_boards (photo_id, board_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [photo.id, boardId]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      ...photo,
      imageUrl: `/uploads/${encodeURIComponent(photo.filename)}`,
      tags,
      boardIds
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK");
    }

    try {
      await removeUpload(req.file.path);
    } catch (cleanupError) {
      console.error(
        "Could not remove uploaded file after a failed request:",
        cleanupError
      );
    }

    next(error);
  } finally {
    client?.release();
  }
});

// GET PHOTOS, OPTIONALLY FILTERED BY BOARD
app.get("/api/photos", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string"
      ? req.query.q.trim()
      : "";

    const tag = typeof req.query.tag === "string"
      ? req.query.tag.trim().toLowerCase()
      : "";

    const boardId = req.query.boardId
      ? positiveId(req.query.boardId, "boardId")
      : null;

    const page = paginationValue(req.query.page, 1, 1000000);
    const limit = paginationValue(req.query.limit, 20, 100);
    const offset = (page - 1) * limit;

    if (q.length > 200 || tag.length > 40) {
      return res.status(400).json({
        error: "Search text or tag is too long."
      });
    }

    const result = await pool.query(
      `SELECT
         p.id,
         p.filename,
         p.caption,
         p.created_at,

         COALESCE(
           array_agg(DISTINCT t.name)
             FILTER (WHERE t.name IS NOT NULL),
           ARRAY[]::text[]
         ) AS tags,

         COALESCE(
           array_agg(DISTINCT b.id)
             FILTER (WHERE b.id IS NOT NULL),
           ARRAY[]::bigint[]
         ) AS board_ids,

         COALESCE(
           array_agg(DISTINCT b.name)
             FILTER (WHERE b.name IS NOT NULL),
           ARRAY[]::text[]
         ) AS board_names

       FROM photos p

       LEFT JOIN photo_tags pt ON pt.photo_id = p.id
       LEFT JOIN tags t ON t.id = pt.tag_id

       LEFT JOIN photo_boards pb ON pb.photo_id = p.id
       LEFT JOIN boards b ON b.id = pb.board_id

       WHERE
         ($1 = '' OR p.caption ILIKE '%' || $1 || '%' OR EXISTS (
           SELECT 1
           FROM photo_tags search_pt
           JOIN tags search_t ON search_t.id = search_pt.tag_id
           WHERE search_pt.photo_id = p.id
             AND search_t.name ILIKE '%' || $1 || '%'
         ))

         AND ($2 = '' OR EXISTS (
           SELECT 1
           FROM photo_tags filter_pt
           JOIN tags filter_t ON filter_t.id = filter_pt.tag_id
           WHERE filter_pt.photo_id = p.id
             AND filter_t.name = $2
         ))

         AND ($3::bigint IS NULL OR EXISTS (
           SELECT 1
           FROM photo_boards filter_pb
           WHERE filter_pb.photo_id = p.id
             AND filter_pb.board_id = $3
         ))

       GROUP BY p.id
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $4 OFFSET $5`,
      [q, tag, boardId, limit, offset]
    );

    res.json({
      page,
      limit,
      boardId,
      photos: result.rows.map(photo => ({
        ...photo,
        imageUrl: `/uploads/${encodeURIComponent(photo.filename)}`
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET PHOTOS IN A PARTICULAR BOARD
app.get("/api/boards/:id/photos", async (req, res, next) => {
  try {
    const boardId = positiveId(req.params.id, "Board ID");

    const boardResult = await pool.query(
      "SELECT id, name, description FROM boards WHERE id = $1",
      [boardId]
    );

    if (boardResult.rowCount === 0) {
      return res.status(404).json({ error: "Board not found." });
    }

    // Reuse the gallery query with the selected board filter.
    req.query.boardId = String(boardId);

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const tag = typeof req.query.tag === "string"
      ? req.query.tag.trim().toLowerCase()
      : "";

    const page = paginationValue(req.query.page, 1, 1000000);
    const limit = paginationValue(req.query.limit, 20, 100);
    const offset = (page - 1) * limit;

    if (q.length > 200 || tag.length > 40) {
      return res.status(400).json({
        error: "Search text or tag is too long."
      });
    }

    const result = await pool.query(
      `SELECT
         p.id,
         p.filename,
         p.caption,
         p.created_at,
         COALESCE(
           array_agg(DISTINCT t.name)
             FILTER (WHERE t.name IS NOT NULL),
           ARRAY[]::text[]
         ) AS tags
       FROM photos p
       JOIN photo_boards pb ON pb.photo_id = p.id
       LEFT JOIN photo_tags pt ON pt.photo_id = p.id
       LEFT JOIN tags t ON t.id = pt.tag_id
       WHERE pb.board_id = $1
         AND ($2 = '' OR p.caption ILIKE '%' || $2 || '%' OR EXISTS (
           SELECT 1
           FROM photo_tags spt
           JOIN tags st ON st.id = spt.tag_id
           WHERE spt.photo_id = p.id
             AND st.name ILIKE '%' || $2 || '%'
         ))
         AND ($3 = '' OR EXISTS (
           SELECT 1
           FROM photo_tags fpt
           JOIN tags ft ON ft.id = fpt.tag_id
           WHERE fpt.photo_id = p.id
             AND ft.name = $3
         ))
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $4 OFFSET $5`,
      [boardId, q, tag, limit, offset]
    );

    res.json({
      board: boardResult.rows[0],
      page,
      limit,
      photos: result.rows.map(photo => ({
        ...photo,
        imageUrl: `/uploads/${encodeURIComponent(photo.filename)}`
      }))
    });
  } catch (error) {
    next(error);
  }
});

// ADD PHOTOS TO BOARDS
app.post("/api/photos/:id/boards", async (req, res, next) => {
  let client;

  try {
    const photoId = positiveId(req.params.id, "Photo ID");
    const boardIds = parseBoardIds(req.body.boardIds);

    if (boardIds.length === 0) {
      return res.status(400).json({
        error: "Select at least one board."
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const photoResult = await client.query(
      "SELECT id FROM photos WHERE id = $1",
      [photoId]
    );

    if (photoResult.rowCount === 0) {
      throw Object.assign(new Error("Photo not found."), { status: 404 });
    }

    await assertBoardsExist(client, boardIds);

    for (const boardId of boardIds) {
      await client.query(
        `INSERT INTO photo_boards (photo_id, board_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [photoId, boardId]
      );
    }

    await client.query("COMMIT");

    res.json({
      message: "Photo added to selected boards.",
      photoId,
      boardIds
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    next(error);
  } finally {
    client?.release();
  }
});

// REMOVE A PHOTO FROM A BOARD
app.delete(
  "/api/photos/:id/boards/:boardId",
  async (req, res, next) => {
    try {
      const photoId = positiveId(req.params.id, "Photo ID");
      const boardId = positiveId(req.params.boardId, "Board ID");

      const result = await pool.query(
        `DELETE FROM photo_boards
         WHERE photo_id = $1 AND board_id = $2`,
        [photoId, boardId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: "Photo-board association not found."
        });
      }

      res.json({
        message: "Photo removed from board. The original photo is preserved."
      });
    } catch (error) {
      next(error);
    }
  }
);

// ERROR HANDLER
app.use((error, _req, res, _next) => {
  const status =
    error instanceof multer.MulterError
      ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      : (error.status || 500);

  if (status >= 500) console.error(error);

  res.status(status).json({
    error: status >= 500 ? "Internal server error." : error.message
  });
});

// START SERVER
async function start() {
  await fs.mkdir(uploadDir, { recursive: true });

  const port = Number(process.env.PORT || 3000);

  app.listen(port, () => {
    console.log(`Photo API listening on port ${port}`);
  });
}

start().catch(error => {
  console.error("Could not start the server:", error);
  process.exitCode = 1;
});
