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

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function positiveId(value, label = "ID") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw httpError(`${label} must be a positive integer.`);
  }
  return id;
}

function parseTags(value) {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") {
    throw httpError("tags must be a comma-separated string.");
  }

  const tags = [...new Set(
    value.split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean)
  )];

  if (tags.length > 20 || tags.some(tag => tag.length > 40)) {
    throw httpError("Provide up to 20 tags, each no longer than 40 characters.");
  }
  return tags;
}

function paginationValue(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw httpError(`Value must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

async function removeUpload(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}


// Return every board, its photo count, and its latest photo thumbnail.

// -------------------- BOARDS --------------------

// Return every board, its photo count, and its latest photo thumbnail.
app.get("/api/boards", async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        b.id,
        b.name,
        b.created_at,
        COUNT(DISTINCT bp.photo_id)::int AS "photoCount",
        cover.filename AS "coverFilename"
      FROM boards b
      LEFT JOIN board_photos bp
        ON bp.board_id = b.id
      LEFT JOIN LATERAL (
        SELECT p.filename
        FROM board_photos cover_bp
        JOIN photos p ON p.id = cover_bp.photo_id
        WHERE cover_bp.board_id = b.id
        ORDER BY cover_bp.created_at DESC
        LIMIT 1
      ) cover ON TRUE
      GROUP BY b.id, cover.filename
      ORDER BY b.created_at DESC, b.id DESC
    `);

    res.json({
      boards: result.rows.map(board => ({
        ...board,
        coverUrl: board.coverFilename
          ? `/uploads/${encodeURIComponent(board.coverFilename)}`
          : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

// Create a board.
app.post("/api/boards", async (req, res, next) => {
  try {
    const name = typeof req.body.name === "string"
      ? req.body.name.trim()
      : "";

    if (!name) throw httpError("Board name is required.");
    if (name.length > 100) {
      throw httpError("Board name must be 100 characters or fewer.");
    }

    const result = await pool.query(
      `INSERT INTO boards (name)
       VALUES ($1)
       RETURNING id, name, created_at`,
      [name]
    );

    res.status(201).json({
      board: {
        ...result.rows[0],
        photoCount: 0,
        coverUrl: null
      }
    });
  } catch (error) {
    next(error);
  }
});

// Rename a board.
app.patch("/api/boards/:boardId", async (req, res, next) => {
  try {
    const boardId = positiveId(req.params.boardId, "Board ID");
    const name = typeof req.body.name === "string"
      ? req.body.name.trim()
      : "";

    if (!name) throw httpError("Board name is required.");
    if (name.length > 100) {
      throw httpError("Board name must be 100 characters or fewer.");
    }

    const result = await pool.query(
      `UPDATE boards
       SET name = $1
       WHERE id = $2
       RETURNING id, name, created_at`,
      [name, boardId]
    );

    if (!result.rowCount) throw httpError("Board not found.", 404);

    res.json({ board: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Deleting a board removes its membership rows, not the photos.
app.delete("/api/boards/:boardId", async (req, res, next) => {
  try {
    const boardId = positiveId(req.params.boardId, "Board ID");

    const result = await pool.query(
      "DELETE FROM boards WHERE id = $1",
      [boardId]
    );

    if (!result.rowCount) throw httpError("Board not found.", 404);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Add an existing photo to a board.
app.post("/api/boards/:boardId/photos/:photoId", async (req, res, next) => {
  try {
    const boardId = positiveId(req.params.boardId, "Board ID");
    const photoId = positiveId(req.params.photoId, "Photo ID");

    const result = await pool.query(
      `INSERT INTO board_photos (board_id, photo_id)
       SELECT b.id, p.id
       FROM boards b
       CROSS JOIN photos p
       WHERE b.id = $1 AND p.id = $2
       ON CONFLICT (board_id, photo_id) DO NOTHING
       RETURNING board_id, photo_id`,
      [boardId, photoId]
    );

    const exists = await pool.query(
      `SELECT
         EXISTS(SELECT 1 FROM boards WHERE id = $1) AS board_exists,
         EXISTS(SELECT 1 FROM photos WHERE id = $2) AS photo_exists`,
      [boardId, photoId]
    );

    if (!exists.rows[0].board_exists) {
      throw httpError("Board not found.", 404);
    }

    if (!exists.rows[0].photo_exists) {
      throw httpError("Photo not found.", 404);
    }

    res.status(result.rowCount ? 201 : 200).json({
      success: true,
      alreadyInBoard: result.rowCount === 0
    });
  } catch (error) {
    next(error);
  }
});

// Remove a photo from a board without deleting the photo.
app.delete("/api/boards/:boardId/photos/:photoId", async (req, res, next) => {
  try {
    const boardId = positiveId(req.params.boardId, "Board ID");
    const photoId = positiveId(req.params.photoId, "Photo ID");

    const result = await pool.query(
      "DELETE FROM board_photos WHERE board_id = $1 AND photo_id = $2",
      [boardId, photoId]
    );

    if (!result.rowCount) {
      throw httpError("That photo is not in this board.", 404);
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});


// -------------------- PHOTOS --------------------


app.post("/api/photos", upload.single("image"), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      error: "An image file is required in the 'image' field."
    });
  }

  let client;

  try {
    const tags = parseTags(req.body.tags);
    const caption = typeof req.body.caption === "string"
      ? req.body.caption.trim()
      : "";

    if (caption.length > 500) {
      throw httpError("Caption must be 500 characters or fewer.");
    }

    // Read the selected board IDs from the upload form.
    let boardIds = [];

    if (req.body.boardIds) {
      try {
        boardIds = JSON.parse(req.body.boardIds);
      } catch {
        throw httpError("Invalid board selection.");
      }

      if (!Array.isArray(boardIds)) {
        throw httpError("Board selection must be a list.");
      }

      boardIds = [...new Set(
        boardIds.map(id => positiveId(id, "Board ID"))
      )];
    }

    client = await pool.connect();
    await client.query("BEGIN");

    // Confirm that all selected boards exist.
    if (boardIds.length > 0) {
      const boardCheck = await client.query(
        "SELECT id FROM boards WHERE id = ANY($1::bigint[])",
        [boardIds]
      );

      if (boardCheck.rowCount !== boardIds.length) {
        throw httpError("One or more selected boards do not exist.", 404);
      }
    }

    // Save the photo.
    const photoResult = await client.query(
      `INSERT INTO photos (filename, caption)
       VALUES ($1, $2)
       RETURNING id, filename, caption, created_at`,
      [req.file.filename, caption]
    );

    const photo = photoResult.rows[0];

    // Save tags.
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

    // Add the uploaded photo to every selected board.
    for (const boardId of boardIds) {
      await client.query(
        `INSERT INTO board_photos (board_id, photo_id)
         VALUES ($1, $2)
         ON CONFLICT (board_id, photo_id) DO NOTHING`,
        [boardId, photo.id]
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
      console.error("Could not remove uploaded file:", cleanupError);
    }

    next(error);

  } finally {
    client?.release();
  }
});


app.get("/api/photos", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const tag = typeof req.query.tag === "string"
      ? req.query.tag.trim().toLowerCase()
      : "";
    const page = paginationValue(req.query.page, 1, 1000000);
    const limit = paginationValue(req.query.limit, 20, 100);
    const offset = (page - 1) * limit;
    const boardId = req.query.boardId === undefined || req.query.boardId === ""
      ? null
      : positiveId(req.query.boardId, "Board ID");

    if (q.length > 200 || tag.length > 40) {
      throw httpError("Search text or tag is too long.");
    }

    const result = await pool.query(
      `SELECT
         p.id,
         p.filename,
         p.caption,
         p.created_at,
         COALESCE(
           array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL),
           ARRAY[]::text[]
         ) AS tags
       FROM photos p
       LEFT JOIN photo_tags pt ON pt.photo_id = p.id
       LEFT JOIN tags t ON t.id = pt.tag_id
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
           WHERE filter_pt.photo_id = p.id AND filter_t.name = $2
         ))
         AND ($3::integer IS NULL OR EXISTS (
           SELECT 1
           FROM board_photos filter_bp
           WHERE filter_bp.photo_id = p.id AND filter_bp.board_id = $3
         ))
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $4 OFFSET $5`,
      [q, tag, boardId, limit, offset]
    );

    res.json({
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

// -------------------- ERROR HANDLING / STARTUP --------------------

app.use((error, _req, res, _next) => {
  const status = error instanceof multer.MulterError
    ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
    : (error.status || 500);

  if (status >= 500) console.error(error);
  res.status(status).json({
    error: status >= 500 ? "Internal server error." : error.message
  });
});

async function start() {
  await fs.mkdir(uploadDir, { recursive: true });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Photo API listening on port ${port}`));
}

start().catch(error => {
  console.error("Could not start the server:", error);
  process.exitCode = 1;
});
