// SPDX-License-Identifier: GPL-3.0-or-later
// Reproducible conversion for materials/air.yaml (DevLog-013): Lemmon et al. 2000, JPCRD 29, 331, Table A2,
// 0.101325 MPa isobar (journal p.366-367), molar density (mol/dm3) and cp (J/(mol K)) -> kg/m3 and J/(kg K) with
// the molar mass of the paper (journal p.334, constants for air: M = 28.9586 +- 0.0002 g/mol). Rounded to the significant digits of
// the source columns (density 5, cp 4).
const M = 28.9586; // g/mol
const rows: Array<[number, number, number, number]> = [ // T K, rho mol/dm3, cp J/(mol K), w m/s (transcribed)
  [200, 0.061079, 29.16, 283.4], [210, 0.058147, 29.15, 290.5], [220, 0.055486, 29.14, 297.4], [230, 0.053059, 29.13, 304.1],
  [240, 0.050836, 29.13, 310.7], [250, 0.048793, 29.13, 317.1], [260, 0.046908, 29.13, 323.4], [270, 0.045164, 29.13, 329.6],
  [280, 0.043546, 29.13, 335.6], [290, 0.042040, 29.14, 341.5], [300, 0.040634, 29.15, 347.4], [310, 0.039320, 29.16, 353.1],
  [320, 0.038089, 29.18, 358.7], [330, 0.036932, 29.19, 364.2], [340, 0.035844, 29.21, 369.7], [350, 0.034818, 29.23, 375.0],
  [360, 0.033850, 29.26, 380.3], [370, 0.032933, 29.28, 385.4], [380, 0.032066, 29.31, 390.5], [390, 0.031243, 29.34, 395.5],
  [400, 0.030461, 29.38, 400.5], [450, 0.027074, 29.58, 424.2], [500, 0.024365, 29.83, 446.4], [550, 0.022149, 30.13, 467.3],
  [600, 0.020303, 30.45, 487.1],
];
const sig = (v: number, n: number): number => Number(v.toPrecision(n));
console.log(`xs: [${rows.map((r) => r[0]).join(', ')}]`);
console.log(`rho kg/m3: [${rows.map((r) => sig(r[1] * M, 5)).join(', ')}]`);
console.log(`cp J/(kg K): [${rows.map((r) => sig(r[2] / M * 1000, 4)).join(', ')}]`);
console.log(`c m/s: [${rows.map((r) => r[3]).join(', ')}]`);
