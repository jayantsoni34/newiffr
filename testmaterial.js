// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ---------- Config ----------
const PORT = process.env.PORT || 5000;
const IMG_MAX_WIDTH = 1200;          // site photos benefit from a bit more than 800
const IMG_MAX_HEIGHT = 1200;
const IMG_QUALITY = 72;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ---------- Mongo URI ----------
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://jayantsoni4382:js%40workdb@cluster0.jjjc03f.mongodb.net/attendanceDB?retryWrites=true&w=majority";

if (!MONGO_URI) {
  console.error("❌ MONGO_URI is not set");
  process.exit(1);
}

// ---------- Mongoose ----------
mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
  })
  .then(() => console.log("✅ MongoDB Atlas linked"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// ---------- GridFS (initialized after connection) ----------
let gridFSBucket = null;
mongoose.connection.once("open", () => {
  gridFSBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "complaintImages",
  });
  console.log("✅ GridFS bucket ready (complaintImages)");
});
mongoose.connection.on("error", (e) => console.error("Mongo runtime error:", e.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));

// ---------- Helpers ----------
const buildImageUrl = (req, fileId) => {
  if (!fileId) return "";
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/api/images/${fileId}`;
};

const compressImage = async (buffer) => {
  const out = await sharp(buffer)
    .rotate()
    .resize({
      width: IMG_MAX_WIDTH,
      height: IMG_MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: IMG_QUALITY })
    .toBuffer();
  console.log(
    `🖼️  Image: ${(buffer.length / 1024).toFixed(2)}KB → ${(out.length / 1024).toFixed(2)}KB`
  );
  return out;
};

const saveImageToGridFS = (buffer, complaintNo, fieldName) =>
  new Promise((resolve, reject) => {
    if (!gridFSBucket) return reject(new Error("GridFS not ready."));
    const filename = `complaint_${complaintNo}_${fieldName}_${Date.now()}.webp`;
    const upload = gridFSBucket.openUploadStream(filename, {
      contentType: "image/webp",
      metadata: { complaintNo, fieldName, uploadedAt: new Date() },
    });
    upload.on("error", reject);
    upload.on("finish", () => resolve(upload.id));
    upload.end(buffer);
  });

const deleteGridFSImage = async (fileId) => {
  if (!fileId || !gridFSBucket) return;
  try {
    await gridFSBucket.delete(new mongoose.Types.ObjectId(fileId));
    console.log("🗑️  GridFS image deleted:", String(fileId));
  } catch (e) {
    console.error("GridFS delete error:", e.message);
  }
};

// ---------- Readiness guard ----------
app.use((req, res, next) => {
  if (
    !gridFSBucket &&
    (req.path.startsWith("/api/complaints") || req.path.startsWith("/api/images"))
  ) {
    return res
      .status(503)
      .json({ success: false, message: "Storage not ready yet. Retry in 1–2s." });
  }
  next();
});

// ---------- Schema ----------
const ComplaintSchema = new mongoose.Schema(
  {
    modelName: { type: String, required: true },
    productSerialNo: { type: String, required: true },
    installationDate: { type: String, required: true },
    installationSite: { type: String, required: true },
    loadType: String,
    batteryBrand: String,
    batteryNo: String,
    failureDate: { type: String, required: true },
    faultCode: String,
    problemDescription: String,
    failedPcbBarcodeNo: String,
    technicianName: { type: String, required: true },
    complaintNo: { type: String, required: true },

    failedPcbBarcodeImage: { type: mongoose.Schema.Types.ObjectId, default: null },
    dcdbBoxSiteImage: { type: mongoose.Schema.Types.ObjectId, default: null },
    hybridInverterSerialStickerImage: { type: mongoose.Schema.Types.ObjectId, default: null },
    acdbBoxSiteImage: { type: mongoose.Schema.Types.ObjectId, default: null },
    hybridInverterLcdErrorImage: { type: mongoose.Schema.Types.ObjectId, default: null },
    pcbSerialNoImage: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);
ComplaintSchema.index({ complaintNo: 1 });
ComplaintSchema.index({ createdAt: -1 });
const Complaint = mongoose.model("Complaint", ComplaintSchema);

// ---------- Multer (memory storage → we push buffers to GridFS) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"));
  },
});

const imageFields = [
  { name: "failedPcbBarcodeImage", maxCount: 1 },
  { name: "dcdbBoxSiteImage", maxCount: 1 },
  { name: "hybridInverterSerialStickerImage", maxCount: 1 },
  { name: "acdbBoxSiteImage", maxCount: 1 },
  { name: "hybridInverterLcdErrorImage", maxCount: 1 },
  { name: "pcbSerialNoImage", maxCount: 1 },
];

// ---------- POST: create complaint ----------
app.post("/api/complaints", upload.fields(imageFields), async (req, res) => {
  const uploadedIds = []; // for rollback
  try {
    const complaintNo = (req.body.complaintNo || "").toString().trim();
    const imageIds = {};

    if (req.files) {
      for (const fieldName of Object.keys(req.files)) {
        const file = req.files[fieldName][0];
        const compressed = await compressImage(file.buffer);
        const id = await saveImageToGridFS(compressed, complaintNo || "NA", fieldName);
        uploadedIds.push(id);
        imageIds[fieldName] = id;
      }
    }

    const complaint = new Complaint({ ...req.body, ...imageIds });
    await complaint.save();

    // Convert stored ObjectIds → absolute URLs for the response
    const responseData = complaint.toObject();
    for (const f of Object.keys(imageIds)) {
      responseData[f] = buildImageUrl(req, imageIds[f]);
    }

    res.status(201).json({ success: true, data: responseData });
  } catch (err) {
    console.error("Complaint create error:", err.message);
    // Rollback every image we uploaded
    await Promise.all(uploadedIds.map((id) => deleteGridFSImage(id)));
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- GET: paginated list ----------
app.get("/api/complaints", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.complaintNo) filter.complaintNo = req.query.complaintNo.trim();
    if (req.query.technicianName) filter.technicianName = req.query.technicianName.trim();

    const [records, total] = await Promise.all([
      Complaint.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Complaint.countDocuments(filter),
    ]);

    const imageKeys = imageFields.map((f) => f.name);
    const data = records.map((r) => {
      const out = { ...r };
      for (const k of imageKeys) out[k] = buildImageUrl(req, r[k]);
      return out;
    });

    res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- GET: stream image from GridFS ----------
app.get("/api/images/:id", async (req, res) => {
  try {
    if (!gridFSBucket)
      return res.status(503).json({ success: false, message: "Image storage not ready." });
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ success: false, message: "Invalid image ID." });

    const fileId = new mongoose.Types.ObjectId(req.params.id);
    const file = await mongoose.connection.db
      .collection("complaintImages.files")
      .findOne({ _id: fileId }, { projection: { contentType: 1, length: 1 } });

    if (!file) return res.status(404).json({ success: false, message: "Image not found." });

    res.set("Content-Type", file.contentType || "image/webp");
    res.set("Content-Length", file.length);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Access-Control-Allow-Origin", "*");

    const stream = gridFSBucket.openDownloadStream(fileId);
    stream.on("error", (e) => {
      console.error("Image stream error:", e.message);
      if (!res.headersSent) res.status(404).end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error("Get image error:", err.message);
    if (!res.headersSent) res.status(400).json({ success: false, message: "Invalid image ID." });
  }
});

// ---------- DELETE: remove complaint + its images ----------
app.delete("/api/complaints/:id", async (req, res) => {
  try {
    const doc = await Complaint.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Record not found." });

    await Promise.all(
      imageFields.map((f) => deleteGridFSImage(doc[f.name]))
    );
    res.json({ success: true, message: "Complaint and images deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- Health ----------
app.get("/", (req, res) =>
  res.json({ status: "OK", message: "Complaint API running with GridFS" })
);

// ---------- Boot ----------
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
