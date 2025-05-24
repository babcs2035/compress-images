import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import { pipeline } from "node:stream/promises";
import cliProgress from "cli-progress";

// AWS S3 バケット情報
const BUCKET_NAME = "mf98-parrot-files-pro";
const REGION = "ap-northeast-1";
const ORIGINAL_DIR = "./original_images";
const OUTPUT_DIR = "./revised_images";

// Upload config
const UPLOAD_BUCKET = "mf98-parrot-images-optimized";

// S3 クライアント
const s3 = new S3Client({ region: REGION });

// デバッグ用フラグ
const DEBUG = false;

// ダウンロード＆画像情報取得（オリジナル保存）
async function downloadAndAnalyzeImage(key: string): Promise<{
  key: string;
  fileSize: number;
  width: number;
  height: number;
  originalPath: string;
}> {
  await fs.mkdir(ORIGINAL_DIR, { recursive: true });

  const possibleExts = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".avif"];
  let originalPath = "";
  let found = false;
  for (const ext of possibleExts) {
    const origCandidate = path.join(ORIGINAL_DIR, `${key}${ext}`);
    try {
      await fs.access(origCandidate);
      originalPath = origCandidate;
      found = true;
      break;
    } catch {
      // not found, continue
    }
  }

  if (found) {
    const stats = await fs.stat(originalPath);
    const image = sharp(originalPath);
    const metadata = await image.metadata();
    return {
      key,
      fileSize: stats.size,
      width: metadata.width || 0,
      height: metadata.height || 0,
      originalPath,
    };
  }

  // 一時ファイル名で保存（オリジナル）
  const tmpPath = path.join(ORIGINAL_DIR, `${key}.tmp`);
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  const response = await s3.send(command);
  const body = response.Body;

  const writeStream = await fs.open(tmpPath, "w");
  await pipeline(body as NodeJS.ReadableStream, writeStream.createWriteStream());
  await writeStream.close();

  // sharpでフォーマット判定
  const image = sharp(tmpPath);
  const metadata = await image.metadata();
  const format = metadata.format || "jpg";
  const ext = `.${format === "jpeg" ? "jpg" : format}`;
  originalPath = path.join(ORIGINAL_DIR, `${key}${ext}`);

  // オリジナル保存
  await fs.rename(tmpPath, originalPath);

  const stats = await fs.stat(originalPath);

  return {
    key,
    fileSize: stats.size,
    width: metadata.width || 0,
    height: metadata.height || 0,
    originalPath,
  };
}

// Upload file to S3
async function uploadFileToS3(localPath: string, key: string) {
  const fileData = await fs.readFile(localPath);
  const command = new PutObjectCommand({
    Bucket: UPLOAD_BUCKET,
    Key: key,
    Body: fileData,
    ContentType: "image/webp",
  });
  await s3.send(command);
}

// 実行メイン関数
async function main() {
  const response = await fetch("https://gogatsusai.jp/98/project/all");
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const responseData = await response.json();
  let allKeys = [];
  for (const project of responseData) {
    allKeys.push(project.project.icon);
    allKeys.push(...project.project.images);
  }
  // debug時は最初の10件のみ
  if (DEBUG) {
    allKeys = allKeys.slice(0, 10);
  }
  console.log(`🔍 Number of images to process: ${allKeys.length}\n`);
  const results: {
    key: string;
    fileSize: number;
    width: number;
    height: number;
    originalPath: string;
    filePath?: string;
    beforeResizeFileSize?: number;
  }[] = [];

  // cli-progressで進捗表示（ダウンロード＆情報取得）
  const bar = new cliProgress.SingleBar({
    format: 'Downloading |{bar}| {value}/{total} images',
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  bar.start(allKeys.length, 0);

  // 画像情報取得
  for (const key of allKeys) {
    try {
      const result = await downloadAndAnalyzeImage(key);
      results.push(result);
    } catch (err) {
      console.error(`❌ Error processing ${key}:`, err);
    }
    bar.increment();
  }
  bar.stop();
  console.log("✅ Download complete\n");

  // 加工用ディレクトリ作成
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // Progress bar for processing (resize/copy)
  const processBar = new cliProgress.SingleBar({
    format: 'Processing   |{bar}| {value}/{total} images',
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  processBar.start(results.length, 0);

  for (const r of results) {
    try {
      r.beforeResizeFileSize = await fs.stat(r.originalPath).then(s => s.size);
      // Always output as .webp
      r.filePath = path.join(OUTPUT_DIR, `${r.key}.webp`);
      if (r.width > 1024) {
        const image = sharp(r.originalPath);
        // Resize to width=1024, keep aspect ratio, and convert to webp
        await image.resize(1024).webp().toFile(r.filePath);
        r.fileSize = await fs.stat(r.filePath).then(s => s.size);
      } else {
        // Convert to webp without resizing
        await sharp(r.originalPath).webp().toFile(r.filePath);
        r.fileSize = await fs.stat(r.filePath).then(s => s.size);
      }
    } catch (err) {
      console.error(`❌ Error processing ${r.key}:`, err);
    }
    processBar.increment();
  }
  processBar.stop();
  console.log("✅ Image processing complete\n");

  // Upload processed images to another bucket
  const uploadBar = new cliProgress.SingleBar({
    format: 'Uploading    |{bar}| {value}/{total} images',
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  uploadBar.start(results.length, 0);

  for (const r of results) {
    try {
      const uploadKey = `${r.key}`;
      await uploadFileToS3(r.filePath!, uploadKey);
    } catch (err) {
      console.error(`❌ Error uploading ${r.key}:`, err);
    }
    uploadBar.increment();
  }
  uploadBar.stop();
  console.log("✅ Upload complete\n");

  // ファイルサイズ比較のみ出力
  console.log("📉 File size comparison:");
  const tableData = results.map(r => ({
    key: r.key,
    original: r.beforeResizeFileSize ? `${r.beforeResizeFileSize} bytes` : "-",
    revised: r.fileSize ? `${r.fileSize} bytes` : "-",
    reduction: (r.beforeResizeFileSize && r.fileSize && r.beforeResizeFileSize !== 0)
      ? `${(100 * (r.beforeResizeFileSize - r.fileSize) / r.beforeResizeFileSize).toFixed(1)} %`
      : "-"
  }));
  console.table(tableData);

  // Show total reduction
  const totalOriginal = results.reduce((sum, r) => sum + (r.beforeResizeFileSize || 0), 0);
  const totalRevised = results.reduce((sum, r) => sum + (r.fileSize || 0), 0);
  if (totalOriginal > 0) {
    const reduction = ((totalOriginal - totalRevised) / totalOriginal) * 100;
    console.log(
      `\nTotal original size: ${totalOriginal} bytes\n` +
      `Total revised size:  ${totalRevised} bytes\n` +
      `Total reduction:     ${reduction.toFixed(1)} %`
    );
  }
}

main().catch(console.error);
