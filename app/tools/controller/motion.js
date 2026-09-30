/*
 * The phone's orientation as a quaternion [x, y, z, w], in the frame of the screen as it is held (landscape
 * included). AbsoluteOrientationSensor at 60 Hz where there is one (Android Chrome), else the deviceorientation
 * event, turned by the screen's angle. Recenter keeps the current orientation as the one that reads as none.
 */

const DEG = Math.PI / 180;

export const multiply = (a, b) => [
	a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
	a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
	a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
	a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export const conjugate = q => [-q[0], -q[1], -q[2], q[3]];

/** deviceorientation's alpha, beta, gamma (degrees, Z-X'-Y'') as a quaternion. */
export function fromEuler(alpha, beta, gamma) {
	const [x, y, z] = [(beta || 0) * DEG / 2, (gamma || 0) * DEG / 2, (alpha || 0) * DEG / 2];
	const [cx, cy, cz, sx, sy, sz] = [Math.cos(x), Math.cos(y), Math.cos(z), Math.sin(x), Math.sin(y), Math.sin(z)];
	return [
		sx * cy * cz - cx * sy * sz,
		cx * sy * cz + sx * cy * sz,
		cx * cy * sz + sx * sy * cz,
		cx * cy * cz - sx * sy * sz,
	];
}

/** A turn of `angle` degrees about the screen's z axis (out of the screen). */
const aboutZ = angle => [0, 0, Math.sin(-angle * DEG / 2), Math.cos(-angle * DEG / 2)];

const screenAngle = () => screen.orientation?.angle ?? (typeof window.orientation === 'number' ? window.orientation : 0);

export class Motion {
	/** @param {(quat: number[]) => void} onChange called with the recentered orientation, up to 60 times a second */
	constructor(onChange) {
		this.onChange = onChange;
		this.raw = null;
		this.reference = null;
		this.sensor = null;
		this.source = null; // 'sensor' | 'event' | null while there is none
		this.stopped = false;
		this.onEvent = event => {
			if (event.alpha == null && event.beta == null && event.gamma == null) return;
			this.source ??= 'event';
			this.update(multiply(fromEuler(event.alpha, event.beta, event.gamma), aboutZ(screenAngle())));
		};
	}

	/** Start reading; resolves with the source used, or null when this device has none (or said no). */
	async start() {
		if (typeof AbsoluteOrientationSensor === 'function') {
			try {
				const granted = await Promise.all(['accelerometer', 'gyroscope', 'magnetometer'].map(name =>
					navigator.permissions?.query({ name }).then(r => r.state !== 'denied', () => true) ?? true));
				if (granted.every(Boolean) && !this.stopped) {
					const sensor = new AbsoluteOrientationSensor({ frequency: 60, referenceFrame: 'screen' });
					await new Promise((resolve, reject) => {
						sensor.addEventListener('activate', resolve, { once: true });
						sensor.addEventListener('error', event => reject(event.error), { once: true });
						sensor.addEventListener('reading', () => {
							if (sensor.quaternion) this.update([...sensor.quaternion]);
						});
						sensor.start();
					});
					if (this.stopped) {
						sensor.stop();
						return null;
					}
					this.sensor = sensor;
					this.source = 'sensor';
					return this.source;
				}
			} catch {
				// no sensor after all (not allowed, or not on this device): try the event
			}
		}
		if (this.stopped || typeof DeviceOrientationEvent !== 'function') return null;
		// iOS asks first; Android doesn't have the function.
		if (typeof DeviceOrientationEvent.requestPermission === 'function') {
			const answer = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
			if (answer !== 'granted') return null;
		}
		window.addEventListener('deviceorientation', this.onEvent);
		return 'event';
	}

	update(q) {
		if (this.stopped) return;
		this.raw = q;
		this.onChange(this.value());
	}

	/** The orientation relative to the last Recenter. */
	value() {
		if (!this.raw) return null;
		return this.reference ? multiply(conjugate(this.reference), this.raw) : this.raw;
	}

	recenter() {
		if (!this.raw) return;
		this.reference = this.raw;
		this.onChange(this.value());
	}

	stop() {
		this.stopped = true;
		this.sensor?.stop();
		this.sensor = null;
		window.removeEventListener('deviceorientation', this.onEvent);
	}
}
