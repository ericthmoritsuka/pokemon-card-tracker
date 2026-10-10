// A canvas camera for the scanner's browser tests, with scenes of several
// cards anywhere in the frame: the phone in a holder over an open white box
// (Eric, 2026-10-09), cards falling in and piling up, a card larger than
// the guide or beside it, and a card running off the frame.
//
// sceneCamera runs in the page before any script (context.addInitScript):
// getUserMedia answers with a portrait canvas stream that draws
// window.scene every 40 ms. A scene is
//
//   {background: 'table' | 'box', cards: [{card: 'a' | 'b' | 'c', dx, dy,
//    size, angle}]}
//
// where each card is placed from the guide's centre, dx and dy and size
// being shares of the guide's height (size 1: as tall as the guide), angle
// in degrees, later cards on top. The guide is measured once, when it first
// shows, and the picture then stays put in the frame however the screen is
// laid out after (a tray tile or a note moving the guide), as a real
// camera's picture does; scene.reanchor measures it again. 'box' is a white box seen from above:
// a white floor, and grey walls running out to the frame's edges.
// window.scene can also be {kind: 'table'} (nothing). navigator.vibrate
// records each buzz in window.buzzes.
//
// The images are served at /__test-card.webp, /__test-card-b.webp, and
// /__test-card-c.webp (the test routes them).

export function sceneCamera({height, width}) {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	const cards = {a: new Image(), b: new Image(), c: new Image()};

	canvas.width = width;
	canvas.height = height;
	cards.a.src = '/__test-card.webp';
	cards.b.src = '/__test-card-b.webp';
	cards.c.src = '/__test-card-c.webp';
	window.buzzes = [];
	navigator.vibrate = (pattern) => {
		window.buzzes.push(pattern);

		return true;
	};
	window.scene = JSON.parse(sessionStorage.getItem('test-scene') || 'null') || {kind: 'table'};

	// The open box: the floor fills the middle, the walls run from its edges
	// out to the frame's, lit a little less than the floor.
	const drawBox = () => {
		const fx = width * 0.1;
		const fy = height * 0.12;

		ctx.fillStyle = '#d9d9d6';
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = '#cfcfcc';
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(fx, fy);
		ctx.lineTo(fx, height - fy);
		ctx.lineTo(0, height);
		ctx.fill();
		ctx.beginPath();
		ctx.moveTo(width, 0);
		ctx.lineTo(width - fx, fy);
		ctx.lineTo(width - fx, height - fy);
		ctx.lineTo(width, height);
		ctx.fill();
		ctx.fillStyle = '#f2f2ef';
		ctx.fillRect(fx, fy, width - fx * 2, height - fy * 2);
	};

	let anchor = null;

	const draw = () => {
		const scene = window.scene || {kind: 'table'};

		if (scene.background === 'box') {
			drawBox();
		}
		else {
			ctx.fillStyle = '#7a6250';
			ctx.fillRect(0, 0, width, height);
		}

		const guide = document.getElementById('scan-guide');
		const video = document.getElementById('scan-video');

		if (!scene.cards || !guide || guide.hidden || !video) {
			return;
		}

		// The guide's layout box, not its drawn one: the capture flash scales
		// the guide for a moment, and a real camera's picture does not follow.
		if (!anchor || scene.reanchor) {
			const stage = guide.offsetParent.getBoundingClientRect();
			const g = {height: guide.offsetHeight, left: stage.left + guide.offsetLeft, top: stage.top + guide.offsetTop, width: guide.offsetWidth};
			const v = video.getBoundingClientRect();
			const scale = Math.max(v.width / width, v.height / height);
			const offsetX = v.left + (v.width - width * scale) / 2;
			const offsetY = v.top + (v.height - height * scale) / 2;

			if (!g.height || !v.height) {
				return;
			}

			anchor = {cx: (g.left + g.width / 2 - offsetX) / scale, cy: (g.top + g.height / 2 - offsetY) / scale, gh: g.height / scale};
		}

		const {cx, cy, gh} = anchor;

		for (const placed of scene.cards) {
			const image = cards[placed.card || 'a'];

			if (!image.complete) {
				continue;
			}

			const ch = gh * (placed.size ?? 0.95);
			const cw = ch * 63 / 88;

			ctx.save();
			ctx.translate(cx + gh * (placed.dx || 0), cy + gh * (placed.dy || 0));
			ctx.rotate(((placed.angle ?? 0.6) * Math.PI) / 180);
			// The shadow a card casts on what is under it, under a lamp a
			// little to one side: on a pile it is what tells a card's silver
			// border from the light face of the card beneath.
			ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
			ctx.shadowBlur = gh * 0.008;
			ctx.shadowOffsetX = gh * 0.003;
			ctx.shadowOffsetY = gh * 0.004;
			ctx.drawImage(image, -cw / 2, -ch / 2, cw, ch);
			ctx.restore();
		}
	};

	draw();
	setInterval(draw, 40);

	// A new stream each time: leaving Scan stops the tracks of the last one.
	navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(25);
}
