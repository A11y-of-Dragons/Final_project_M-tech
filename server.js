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
    throw Object.assign(new Error("tags must be a comma-separated string."), { status: 400 });
  }

  const tags = [...new Set(value.split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean))];

  if (tags.length > 20 || tags.some(tag => tag.length > 40)) {
    throw Object.assign(new Error("Provide up to 20 tags, each no longer than 40 characters."), {
      status: 400
    });
  }

  return tags;
}

function paginationValue(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw Object.assign(new Error(`Value must be an integer from 1 to ${maximum}.`), {
      status: 400
    });
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

app.post("/api/photos", upload.single("image"), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: "An image file is required in the 'image' field." });
  }

  let client;

  try {
    const tags = parseTags(req.body.tags);
    const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : "";

    if (caption.length > 500) {
      throw Object.assign(new Error("Caption must be 500 characters or fewer."), { status: 400 });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const photoResult = await client.query(
      "INSERT INTO photos (filename, caption) VALUES ($1, $2) RETURNING id, filename, caption, created_at",
      [req.file.filename, caption]
    );
    const photo = photoResult.rows[0];

    for (const name of tags) {
      const tagResult = await client.query(
        `INSERT INTO tags (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name]
      );

      await client.query(
        "INSERT INTO photo_tags (photo_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [photo.id, tagResult.rows[0].id]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      ...photo,
      imageUrl: `/uploads/${encodeURIComponent(photo.filename)}`,
      tags
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK");
    }
    try {
      await removeUpload(req.file.path);
    } catch (cleanupError) {
      console.error("Could not remove uploaded file after a failed request:", cleanupError);
    }
    next(error);
  } finally {
    client?.release();
  }
});

app.get("/api/photos", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const tag = typeof req.query.tag === "string" ? req.query.tag.trim().toLowerCase() : "";
    const page = paginationValue(req.query.page, 1, 1000000);
    const limit = paginationValue(req.query.limit, 20, 100);
    const offset = (page - 1) * limit;

    if (q.length > 200 || tag.length > 40) {
      return res.status(400).json({ error: "Search text or tag is too long." });
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
           WHERE search_pt.photo_id = p.id AND search_t.name ILIKE '%' || $1 || '%'
         ))
         AND ($2 = '' OR EXISTS (
           SELECT 1
           FROM photo_tags filter_pt
           JOIN tags filter_t ON filter_t.id = filter_pt.tag_id
           WHERE filter_pt.photo_id = p.id AND filter_t.name = $2
         ))
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $3 OFFSET $4`,
      [q, tag, limit, offset]
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

async function start() {
  await fs.mkdir(uploadDir, { recursive: true });

  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Photo API listening on port ${port}`));
}

start().catch(error => {
  console.error("Could not start the server:", error);
  process.exitCode = 1;
});