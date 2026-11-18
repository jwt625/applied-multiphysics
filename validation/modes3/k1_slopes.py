# SPDX-License-Identifier: GPL-3.0-or-later
"""dn/dlambda at 1.55 um of the two Sellmeier fits used by the eo-modulator-atlas K1 reference (WO-65 ng_energy):
Si Salzberg-Villa / Tatian and SiO2 Malitson, coefficients as in eo-modulator-atlas engine/data/materials.json
(refractiveindex.info Si/nk/Salzberg.yml, SiO2/nk/Malitson.yml; wavelength as tabulated there). Exact derivative by
mpmath (40 digits). Output feeds sims/si-strip-te0-ng.yaml settings.dispersion.dndlambda (1/m).
Usage (from validation/): uv run python modes3/k1_slopes.py"""

import json

import mpmath as mp

mp.mp.dps = 40
SI = ([10.6684293, 0.0030434748, 1.54133408], [0.301516485, 1.13475115, 1104.0])
SIO2 = ([0.6961663, 0.4079426, 0.8974794], [0.0684043, 0.1162414, 9.896161])


def n(lam_um, bc):
    b, c = bc
    return mp.sqrt(1 + sum(mp.mpf(str(bi)) * lam_um**2 / (lam_um**2 - mp.mpf(str(ci)) ** 2) for bi, ci in zip(b, c)))


lam = mp.mpf("1.55")
out = {}
for name, bc in (("Si", SI), ("SiO2", SIO2)):
    out[name] = {"n": float(n(lam, bc)), "dn_dlambda_per_m": float(mp.diff(lambda x: n(x, bc), lam) * 1e6)}
print(json.dumps(out, indent=1))
