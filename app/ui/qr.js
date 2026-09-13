/* global QRCode */

/** Draw `text` as a QR code into `el` (vendor/qrcode.js). Rendered large and scaled down by CSS for sharpness. */
export function renderQR(el, text) {
	el.replaceChildren();
	new QRCode(el, {
		text,
		width: 512,
		height: 512,
		colorDark: '#000000',
		colorLight: '#ffffff',
		correctLevel: QRCode.CorrectLevel.M,
	});
	el.removeAttribute('title');
	el.querySelector('img')?.setAttribute('alt', '');
}
