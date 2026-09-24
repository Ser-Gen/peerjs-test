// Images on the whiteboard: taking them from the clipboard, a file or a drop, and making them small enough to
// live in the board document, which every member keeps and every newcomer downloads.

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_SIDE = 2560; // px; a 4K screenshot is scaled to this
const TARGET_BYTES = 1024 * 1024;
const LIMIT_BYTES = 2 * 1024 * 1024; // what is still accepted when the target can't be reached
const MIN_SIDE = 320; // px; smaller than this it isn't worth keeping
const SHRINK = 0.75;

export class ImageError extends Error {
	/** @param {'large' | 'decode' | 'encode'} code */
	constructor(code) {
		super(code);
		this.code = code;
	}
}

const isImage = type => /^image\//i.test(type ?? '');

/** The image files in a paste or a drop. */
export function imageFiles(data) {
	const files = [...(data?.files ?? [])].filter(file => isImage(file.type));
	if (files.length) return files;
	return [...(data?.items ?? [])].filter(item => item.kind === 'file' && isImage(item.type)).map(item => item.getAsFile()).filter(Boolean);
}

/** The async Clipboard API: Android asks once for permission; plain http has none. */
export const canReadClipboard = () => typeof navigator.clipboard?.read === 'function';

/** The images on the system clipboard (empty when it holds none). */
export async function clipboardImages() {
	const images = [];
	for (const item of await navigator.clipboard.read()) {
		const type = item.types.find(isImage);
		if (type) images.push(await item.getType(type));
	}
	return images;
}

/** Decode what this device is adding. An SVG goes through an <img>, where it can't run anything. */
async function decodeSource(blob) {
	if (typeof createImageBitmap === 'function') {
		try {
			return await createImageBitmap(blob);
		} catch {
			// createImageBitmap refuses SVG; an <img> can still draw it
		}
	}
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		if (!img.naturalWidth || !img.naturalHeight) throw new Error('no size');
		return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
	} catch {
		URL.revokeObjectURL(url);
		throw new ImageError('decode');
	}
}

const toBlob = (canvas, type, quality) => new Promise(resolve => {
	try {
		canvas.toBlob(resolve, type, quality);
	} catch {
		resolve(null);
	}
});

function drawScaled(source, width, height, background = null) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new ImageError('encode');
	if (background) {
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, width, height);
	}
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(source.image ?? source, 0, 0, width, height);
	return canvas;
}

/**
 * An image made ready for the board: decoded and drawn again, which drops its metadata (a photo's location
 * among it) and applies its rotation, at most MAX_SIDE on its long side, and encoded to about 1 MB: PNG when
 * that is small enough (screenshots, drawings), else WebP, or JPEG where the browser can't write WebP, smaller
 * and smaller until it fits.
 * @returns {Promise<{data: Uint8Array, width: number, height: number, type: string}>}
 */
export async function prepareImage(blob) {
	if (blob.size > MAX_SOURCE_BYTES) throw new ImageError('large');
	const source = await decodeSource(blob);
	try {
		const width = source.width;
		const height = source.height;
		if (!width || !height) throw new ImageError('decode');
		const photo = /^image\/jpe?g$/i.test(blob.type);
		let scale = Math.min(1, MAX_SIDE / Math.max(width, height));
		for (;;) {
			const w = Math.max(1, Math.round(width * scale));
			const h = Math.max(1, Math.round(height * scale));
			const canvas = drawScaled(source, w, h);
			let best = photo ? null : await toBlob(canvas, 'image/png');
			if (!best || best.size > TARGET_BYTES) {
				// A browser that can't write WebP gives PNG back instead.
				let lossy = await toBlob(canvas, 'image/webp', 0.9);
				if (lossy?.type !== 'image/webp') lossy = await toBlob(drawScaled(source, w, h, '#ffffff'), 'image/jpeg', 0.88);
				if (lossy && (!best || lossy.size < best.size)) best = lossy;
			}
			if (!best) throw new ImageError('encode');
			const smallest = Math.max(w, h) * SHRINK < MIN_SIDE;
			if (best.size <= TARGET_BYTES || (smallest && best.size <= LIMIT_BYTES)) {
				return { data: new Uint8Array(await best.arrayBuffer()), width: w, height: h, type: best.type };
			}
			if (smallest) throw new ImageError('large');
			scale *= SHRINK;
		}
	} finally {
		source.close?.();
	}
}

/**
 * Decode an image from the board document for drawing. It came from a member, so nothing about it is trusted:
 * createImageBitmap reads only raster formats, and the fallback <img> gets a raster type, never SVG.
 */
export async function decodeImage(bytes) {
	if (typeof createImageBitmap === 'function') return createImageBitmap(new Blob([bytes]));
	const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
	const img = new Image();
	img.src = url;
	try {
		await img.decode();
	} finally {
		URL.revokeObjectURL(url);
	}
	return img;
}
