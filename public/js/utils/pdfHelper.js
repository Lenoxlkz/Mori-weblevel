import { CapacitorHttp } from "../utils/index.js";

let pdfLibPromise = null;

export async function ensurePdfLib() {
  if (window.PDFLib?.PDFDocument) return window.PDFLib;
  if (!pdfLibPromise) {
    pdfLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "js/vendor/pdf-lib.min.js";
      script.onload = () => resolve(window.PDFLib);
      script.onerror = () => {
        pdfLibPromise = null;
        reject(new Error("Failed to load pdf-lib.min.js"));
      };
      document.head.appendChild(script);
    });
  }
  return pdfLibPromise;
}

/**
 * Converts an array of image URLs into a PDF Uint8Array using pdf-lib (already included in Mori).
 * @param {string[]} imageUrls - Array of image URLs to combine into PDF.
 * @returns {Promise<Uint8Array>} Raw PDF binary Uint8Array
 */
export async function convertImagesToPdf(imageUrls) {
  if (!imageUrls || imageUrls.length === 0) {
    throw new Error("No images provided for PDF generation.");
  }

  await ensurePdfLib();

  if (!window.PDFLib || !window.PDFLib.PDFDocument) {
    throw new Error("pdf-lib is not available.");
  }

  const { PDFDocument } = window.PDFLib;
  const pdfDoc = await PDFDocument.create();

  for (const url of imageUrls) {
    try {
      let arrayBuffer;
      if (window.Capacitor?.isNativePlatform?.() && CapacitorHttp) {
        const res = await CapacitorHttp.get({
          url,
          responseType: "arraybuffer",
        });
        if (res && res.data) {
          const binaryStr = atob(res.data);
          const len = binaryStr.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          arrayBuffer = bytes.buffer;
        }
      }

      if (!arrayBuffer) {
        try {
          const resp = await fetch(url);
          if (resp.ok) arrayBuffer = await resp.arrayBuffer();
        } catch (_) {}
      }

      if (!arrayBuffer && window.location?.protocol?.startsWith("http")) {
        const proxyResp = await fetch("/api/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, method: "GET", responseType: "arraybuffer" }),
        });
        if (proxyResp.ok) {
          const p = await proxyResp.json();
          if (p.isBase64 && typeof p.data === "string") {
            const bin = atob(p.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            arrayBuffer = bytes.buffer;
          }
        }
      }

      let image;
      try {
        image = await pdfDoc.embedJpg(arrayBuffer);
      } catch (jpgErr) {
        try {
          image = await pdfDoc.embedPng(arrayBuffer);
        } catch (pngErr) {
          // Fallback via HTML Canvas if raw bytes are not standard JPG/PNG
          const canvasData = await new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              const canvas = document.createElement("canvas");
              canvas.width = img.naturalWidth || img.width || 800;
              canvas.height = img.naturalHeight || img.height || 1000;
              const ctx = canvas.getContext("2d");
              ctx.fillStyle = "#FFFFFF";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0);

              const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
              const base64 = dataUrl.split(",")[1];
              const binaryStr = atob(base64);
              const len = binaryStr.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }
              resolve(bytes.buffer);
            };
            img.onerror = reject;
            img.src = url;
          });
          image = await pdfDoc.embedJpg(canvasData);
        }
      }

      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
    } catch (e) {
      console.warn("Failed to embed image into PDF:", url, e);
    }
  }

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}
