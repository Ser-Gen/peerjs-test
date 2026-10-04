import { h } from '../../ui/dom.js';
import { MAX_PLAYERS } from '../../tools/games/seats.js';
import { SWING, SwingMeter } from './swing.js';

const TRIGGER = 7; // the Motion pad's big button (Standard Gamepad RT)
const FULL = 1500; // °/s at the end of the meter
const ARROWS = { left: '← left', right: 'right →', up: '↑ up', down: '↓ down', twist: '↻ twist' };

/*
 * Swing test, a game module of the Games tool (app/tools/games/games.js): the players' phones are Motion pads, and
 * each player gets a meter with the speed of the phone's turn now, and the peak speed, strength and direction of
 * their last swing and their best (swing.js). It is there to try and tune the motion input. The trigger clears that
 * player's results.
 */

export default {
	id: 'swing',
	title: 'Swing test',
	about: 'Swing a phone like a racket and see how hard and which way. Join from each phone, hold it in landscape facing you, press Recenter, and swing; the trigger clears your numbers.',
	layout: 'motion',
	players: { min: 1, max: MAX_PLAYERS },
	thisDevice: false,
	wrapClass: 'swing-wrap',
	supported: () => true,
	mount: session => new SwingGame(session),
};

class SwingGame {
	constructor(session) {
		this.session = session;
		this.title = 'Swing test';
		this.meters = new Map(); // source → SwingMeter, so a player moved to another seat keeps their numbers
		this.quiet = new Map(); // source → the timer that ends a swing when its readings stop
		this.cards = session.seats.seats.map((_, seat) => this.buildCard(seat));
		this.el = h('div', { class: 'swing-board' }, ...this.cards.map(card => card.el));
		this.subs = [
			session.on('state', source => this.onState(source)),
			session.on('press', (source, index) => {
				if (index !== TRIGGER || session.paused) return;
				this.meter(source).reset();
				this.render(source);
			}),
			session.on('seats', () => this.renderAll()),
			session.on('status', () => this.renderAll()),
		];
		this.renderAll();
	}

	meter(source) {
		let meter = this.meters.get(source);
		if (!meter) this.meters.set(source, (meter = new SwingMeter()));
		return meter;
	}

	buildCard(seat) {
		const card = {
			seat,
			name: h('span', { class: 'swing-name' }),
			fill: h('div', { class: 'swing-fill' }),
			peak: h('div', { class: 'swing-peak', hidden: true }),
			speed: h('span', { class: 'swing-speed' }),
			last: h('p', { class: 'swing-last' }),
			best: h('p', { class: 'swing-best hint' }),
		};
		card.el = h('div', { class: 'swing-card', 'data-seat': seat },
			h('div', { class: 'swing-head' }, h('span', { class: 'dot' }), h('strong', {}, `Player ${seat + 1}`), card.name),
			h('div', { class: 'swing-meter', role: 'meter', 'aria-label': `Player ${seat + 1}: speed`, 'aria-valuemin': 0, 'aria-valuemax': FULL }, card.fill, card.peak),
			h('div', { class: 'swing-row' }, card.last, card.speed),
			card.best);
		return card;
	}

	onState(source) {
		const pad = this.session.pad(source);
		if (this.session.paused || !pad) return;
		const meter = this.meter(source);
		this.shown(source, meter.update(pad.quat, pad.t ?? pad.at));
		clearTimeout(this.quiet.get(source));
		this.quiet.set(source, setTimeout(() => this.shown(source, meter.idle()), SWING.gap));
	}

	/** A source's card after a reading, flashing when a swing ended. */
	shown(source, swing) {
		const card = this.render(source);
		if (swing && card) {
			card.el.classList.remove('hit');
			void card.el.offsetWidth; // start the flash again
			card.el.classList.add('hit');
		}
	}

	renderAll() {
		for (const card of this.cards) this.renderCard(card);
	}

	/** The card of the seat a source plays on, redrawn; null when it doesn't play. */
	render(source) {
		const seat = this.session.seats.seatOf(source);
		const card = this.cards[seat];
		if (!card) return null;
		this.renderCard(card);
		return card;
	}

	renderCard(card) {
		const session = this.session;
		const source = session.seats.seats[card.seat];
		const meter = source ? this.meter(source) : null;
		const pad = source && session.pad(source);
		card.el.classList.toggle('empty', !source);
		card.el.classList.toggle('away', Boolean(source && !pad));
		card.el.style.setProperty('--member', session.color(source) || 'transparent');
		card.name.textContent = source ? `${session.name(source)}${pad ? '' : ' (away)'}` : 'free';
		const speed = meter && !session.paused ? meter.speed : 0;
		card.fill.style.width = `${Math.min(100, (speed / FULL) * 100)}%`;
		card.el.querySelector('.swing-meter').setAttribute('aria-valuenow', String(Math.round(speed)));
		card.speed.textContent = source ? `${Math.round(speed)}°/s` : '';
		card.peak.hidden = !meter?.last;
		if (meter?.last) card.peak.style.left = `${Math.min(100, (meter.last.speed / FULL) * 100)}%`;
		if (!source) {
			card.last.textContent = 'Join from a phone to play here.';
			card.best.textContent = '';
		} else if (pad && !pad.quat) {
			card.last.textContent = 'No motion from this pad: open it as a Motion pad on a phone.';
			card.best.textContent = '';
		} else {
			const last = meter.last;
			card.last.textContent = last ? `${last.strength} · ${last.speed}°/s · ${ARROWS[last.direction]}` : 'Swing!';
			card.best.textContent = meter.best ? `Best ${meter.best.speed}°/s · ${meter.count} ${meter.count === 1 ? 'swing' : 'swings'}` : '';
		}
	}

	setPaused() {
		this.renderAll();
	}

	destroy() {
		for (const off of this.subs) off();
		for (const timer of this.quiet.values()) clearTimeout(timer);
	}
}
