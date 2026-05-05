// File preview generation for different file types
import { existsSync } from "node:fs";
import { extname, basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { MessageContent } from "../discord/types.ts";

export interface PreviewResult {
  type: 'inline_file' | 'embed' | 'button';
  content: MessageContent;
}

/**
 * Generates an inline preview for supported file types.
 * Returns null if the file cannot be previewed (caller should use button fallback).
 */
export async function generatePreview(filePath: string): Promise<PreviewResult | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  const ext = extname(filePath).toLowerCase().slice(1); // remove leading dot
  const fileName = basename(filePath);

  // Check file size
  const stats = await stat(filePath);
  const fileSizeBytes = stats.size;

  // Images: inline if under 10MB
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    if (fileSizeBytes < 10 * 1024 * 1024) {
      return {
        type: 'inline_file',
        content: {
          files: [{
            path: filePath,
            name: fileName,
          }],
        },
      };
    }
    return null; // Too large
  }

  // PDF: Try to convert first page to PNG on macOS
  if (ext === 'pdf') {
    return await previewPdf(filePath, fileName);
  }

  // Code files: show first 20 lines as embed
  const codeExts = ['ts', 'js', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'sql', 'json', 'yaml', 'yml', 'toml', 'md', 'html', 'css', 'rb', 'swift', 'kt'];
  if (codeExts.includes(ext)) {
    if (fileSizeBytes > 100 * 1024) {
      return null; // Skip large files
    }
    return await previewCode(filePath, fileName, ext);
  }

  // CSV: parse first 5 rows into markdown table
  if (ext === 'csv') {
    if (fileSizeBytes > 50 * 1024) {
      // For large CSVs, just show row count
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      return {
        type: 'embed',
        content: {
          embeds: [{
            title: `📊 ${fileName}`,
            description: `CSV file with ${lines.length} rows`,
            color: 0x3498db,
          }],
        },
      };
    }
    return await previewCsv(filePath, fileName);
  }

  // Other file types: return null (caller uses button fallback)
  return null;
}

/**
 * Preview PDF by attempting to convert first page to PNG using sips (macOS).
 * Falls back to text embed with filename if conversion fails.
 */
async function previewPdf(filePath: string, fileName: string): Promise<PreviewResult> {
  try {
    // Try to use sips to convert first page
    const process = new Deno.Command("sips", {
      args: ["-s", "format", "png", filePath, "--out", "/tmp/pdf-preview.png"],
      stdout: "null",
      stderr: "null",
    });
    const result = await process.output();

    if (result.success && existsSync("/tmp/pdf-preview.png")) {
      return {
        type: 'inline_file',
        content: {
          embeds: [{
            title: `📄 ${fileName} (first page)`,
            color: 0xe74c3c,
          }],
          files: [{
            path: "/tmp/pdf-preview.png",
            name: "preview.png",
          }],
        },
      };
    }
  } catch {
    // Fall through to text embed
  }

  // Fallback: text embed
  return {
    type: 'embed',
    content: {
      embeds: [{
        title: `📄 ${fileName}`,
        description: "PDF file (preview not available)",
        color: 0xe74c3c,
      }],
    },
  };
}

/**
 * Preview code file by showing first 20 lines in a fenced code block.
 */
async function previewCode(filePath: string, fileName: string, ext: string): Promise<PreviewResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const preview = lines.slice(0, 20).join('\n');
    const hasMore = lines.length > 20;

    const description = `\`\`\`${ext}\n${preview}\n\`\`\`${hasMore ? `\n\n...and ${lines.length - 20} more lines` : ''}`;

    return {
      type: 'embed',
      content: {
        embeds: [{
          title: `📝 ${fileName}`,
          description: description.slice(0, 4096), // Discord embed description limit
          color: 0x95a5a6,
        }],
      },
    };
  } catch {
    return {
      type: 'embed',
      content: {
        embeds: [{
          title: `📝 ${fileName}`,
          description: "Code file (preview failed)",
          color: 0x95a5a6,
        }],
      },
    };
  }
}

/**
 * Preview CSV by parsing first 5 rows into a markdown table.
 */
async function previewCsv(filePath: string, fileName: string): Promise<PreviewResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const rows = lines.slice(0, 5).map(parseCsvLine);

    if (rows.length === 0) {
      return {
        type: 'embed',
        content: {
          embeds: [{
            title: `📊 ${fileName}`,
            description: "Empty CSV file",
            color: 0x3498db,
          }],
        },
      };
    }

    const table = csvToMarkdownTable(rows);
    const totalRows = lines.length;
    const description = `${table}\n\nTotal rows: ${totalRows}`;

    return {
      type: 'embed',
      content: {
        embeds: [{
          title: `📊 ${fileName}`,
          description: description.slice(0, 4096), // Discord embed limit
          color: 0x3498db,
        }],
      },
    };
  } catch {
    return {
      type: 'embed',
      content: {
        embeds: [{
          title: `📊 ${fileName}`,
          description: "CSV file (preview failed)",
          color: 0x3498db,
        }],
      },
    };
  }
}

/**
 * Convert CSV rows to a markdown table.
 */
function csvToMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';

  const colCount = rows[0].length;
  const header = rows[0].map(cell => cell.slice(0, 20)).join(' | '); // Truncate cells
  const separator = Array(colCount).fill('---').join(' | ');
  const body = rows.slice(1).map(row =>
    row.map(cell => cell.slice(0, 20)).join(' | ')
  ).join('\n');

  return `${header}\n${separator}\n${body}`;
}

/**
 * Parse a CSV line into an array of fields.
 * Simple implementation that handles quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current.trim());
  return fields;
}
