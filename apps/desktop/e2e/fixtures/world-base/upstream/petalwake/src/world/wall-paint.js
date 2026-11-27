// Flat wall swatches painted at metre-scale UVs. Keep the strokes small in
// number and close to the base value so the masonry and lighting read first.
const PLASTER = {
  plaster: ['#eee7d8', '#e8e1d3', '#f4ecdc', '#eee3d1'],
  'apartment-plaster': ['#b0afaa', '#a9a8a4', '#b6b5ae', '#b3b0a6'],
};

const COURSES = {
  masonry: { rows: 6, cols: 5, face: ['#b5a58b', '#bcad94', '#c2b39b'], grout: '#a99a82', bevel: .09 },
  ashlar: { rows: 6, cols: 4, face: ['#cbbda5', '#d3c6ae', '#dbceb8'], grout: '#bfb198', bevel: .035 },
  brick: { rows: 10, cols: 6, face: ['#9b6e59', '#a67864', '#ac7f6b'], grout: '#977564', bevel: .025 },
  'apartment-tile': { rows: 12, cols: 6, face: ['#dddcd3', '#e6e4db', '#eceae1'], grout: '#cfcdc4', bevel: .025 },
};

function wash(g, color, x, y, width, height) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x, y);
  g.quadraticCurveTo(x + width * .23, y - height * .10, x + width * .43, y - height * .27);
  g.quadraticCurveTo(x + width * .75, y - height * .22, x + width, y - height * .38);
  g.lineTo(x + width * .87, y + height * .09);
  g.quadraticCurveTo(x + width * .62, y + height * .15, x + width * .33, y + height * .31);
  g.quadraticCurveTo(x + width * .10, y + height * .27, x, y);
  g.fill();
}

function plaster(g, [base, shade, light, warm]) {
  g.fillStyle = base;
  g.fillRect(0, 0, 1, 1);
  wash(g, shade, .13, .61, .44, .085);
  wash(g, shade, .48, .59, .14, .028);
  wash(g, light, .16, .22, .31, .047);
  wash(g, light, .49, .21, .09, .023);
  wash(g, warm, .66, .85, .25, .062);
}

function courses(g, { rows, cols, face, grout, bevel }) {
  g.fillStyle = grout;
  g.fillRect(0, 0, 1, 1);
  for (let row = 0; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      const tile = (col + cols) % cols;
      const w = 1 / cols, h = 1 / rows;
      const left = (col + (row % 2) * .5) * w + .012 * w, top = row * h + .026 * h;
      const right = left + .976 * w, bottom = top + .948 * h;
      const corner = bevel * Math.min(w, h);
      const tone = (tile * 5 + row * 7 + tile * row) % face.length;
      g.fillStyle = face[tone];
      g.beginPath();
      g.moveTo(left + corner, top);
      g.lineTo(right - corner, top);
      g.lineTo(right, top + corner);
      g.lineTo(right, bottom - corner * 2);
      g.lineTo(right - corner * 2, bottom);
      g.lineTo(left + corner, bottom);
      g.lineTo(left, bottom - corner);
      g.lineTo(left, top + corner * 1.5);
      g.fill();
      if (bevel >= .035 && (tile + row * 3) % 4 === 0) {
        wash(g, face[(tone + 1) % face.length], left + w * .16, top + h * .36, w * .57, h * .17);
      }
    }
  }
}

export function paintWallTile(kind, size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.scale(size, size);
  if (kind in PLASTER) plaster(g, PLASTER[kind]);
  else courses(g, COURSES[kind]);
  return canvas;
}
